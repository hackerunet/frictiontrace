#!/usr/bin/env node
/**
 * audit.js — Playwright customer-journey performance audit for the CAM storefronts.
 *
 * Walks a fixed 12-step journey per domain with a cold browser cache on every step,
 * captures a Chrome DevTools timeline trace + the full request log, and writes
 * json/ + csv/ + html/ artifacts into an audit folder named YYYYMMDD.
 *
 * Rules of engagement (see CLAUDE.md):
 *   - GET-only. No orderForm mutation, nothing is ever added to a cart.
 *   - Sequential, throttled. This is a measurement, not a load test.
 *   - Identifies itself with an X-Diagnostics-Client header.
 *
 * Usage:
 *   node scripts/audit.js                            # all stores, today's folder
 *   node scripts/audit.js --stores walmart-cr,paiz-g
 *   node scripts/capture/audit.js --run 20260821-0600 --out /tmp/scratch
 *   node scripts/audit.js --headed --stores walmart-cr
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const { startTrace, parseTrace } = require('../../lib/trace');
const { analyzePage, summarize } = require('../../lib/analyze');
const { renderHtml } = require('../../lib/render-html');
const { renderPageCsv } = require('../../lib/render-csv');
const P = require('../../lib/paths');

// --- CLI --------------------------------------------------------------------
const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const hasFlag = (name) => args.includes(name);

const STORES = require('../../config/stores.json').stores;
const storeFilter = argVal('--stores', null);
const selected = storeFilter
  ? STORES.filter((s) => storeFilter.split(',').map((x) => x.trim()).includes(s.id))
  : STORES;

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
// One folder per execution, identified by date AND hour: the pipeline runs three times
// a day, so a bare date would make three captures overwrite each other. --date is kept
// as an alias for re-capturing into an existing historical folder.
const dateFolder = argVal('--run', argVal('--date', P.newRunId(now)));
const outDir = argVal('--out', null)
  ? path.resolve(argVal('--out'), dateFolder)
  : P.runDirPath(dateFolder);

const HEADED = hasFlag('--headed');
const NAV_TIMEOUT_MS = Number(argVal('--nav-timeout', 60000));
const SETTLE_TIMEOUT_MS = Number(argVal('--settle-timeout', 30000));
const PAGE_DELAY_MS = Number(argVal('--delay', 1500));
const STORE_DELAY_MS = Number(argVal('--store-delay', 5000));
const CPU_THROTTLE = Number(argVal('--cpu-throttle', 1));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Journey definition -----------------------------------------------------
/**
 * The 11 steps audited in July 2026, plus the PDP step added in August.
 * `dynamic` steps resolve their URL at runtime from an earlier step.
 */
function journeyFor(domain) {
  const base = `https://${domain}`;
  return [
    { key: 'homepage', pageType: 'homepage', url: `${base}/` },
    { key: 'search', pageType: 'search', url: `${base}/pollo?_q=pollo&map=ft`, extract: 'pdp' },
    { key: 'pdp', pageType: 'pdp', dynamic: 'pdp' },
    { key: 'cart', pageType: 'cart', url: `${base}/checkout/#/cart` },
    { key: 'email', pageType: 'checkout-email', url: `${base}/checkout/#/email` },
    // July labelled this step from its hash fragment, not its path — kept identical
    // so the CSV column values line up across dates.
    { key: 'login', pageType: 'checkout-orderform', url: `${base}/login?returnUrl=/checkout/#/orderform`, extract: 'authLanding' },
    { key: 'authLanding', pageType: 'login', dynamic: 'authLanding' },
    { key: 'checkout', pageType: 'checkout', url: `${base}/checkout/` },
    { key: 'orderform', pageType: 'checkout-orderform', url: `${base}/checkout/#/orderform` },
    { key: 'profile', pageType: 'checkout-profile', url: `${base}/checkout/#/profile` },
    { key: 'shipping', pageType: 'checkout-shipping', url: `${base}/checkout/#/shipping` },
    { key: 'payment', pageType: 'checkout-payment', url: `${base}/checkout/#/payment` },
  ];
}

// --- Single page capture ----------------------------------------------------

async function capturePage(browser, storeHost, url, step) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: 'es-419',
    extraHTTPHeaders: { 'X-Diagnostics-Client': 'walmart-cam-qa-audit/1.0 (internal performance diagnostics)' },
    serviceWorkers: 'allow',
  });

  const requests = [];
  const startedAt = new Map();

  context.on('request', (req) => {
    startedAt.set(req, Date.now());
    requests.push({ url: req.url(), resourceType: req.resourceType(), failed: false, timingMs: 0, _req: req });
  });
  const finish = (req, failed) => {
    const rec = requests.find((r) => r._req === req);
    if (!rec) return;
    rec.failed = failed;
    rec.timingMs = Date.now() - (startedAt.get(req) || Date.now());
  };
  context.on('requestfinished', (req) => finish(req, false));
  context.on('requestfailed', (req) => finish(req, true));

  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  // Optional CPU throttling, off by default.
  //
  // Do NOT enable this to "match" the July 2026 baseline. That run happened on a VDI,
  // and a VDI is not what anyone shops from — calibrating to it would reproduce an
  // artefact of the capture environment rather than any user's experience. The goal is
  // a real shopper, so the machine runs unconstrained.
  //
  // `--cpu-throttle 4` remains available for a deliberate mid-tier-mobile profile
  // (the Lighthouse default), which is a different question and a defensible one.
  if (CPU_THROTTLE > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  }

  const tracer = await startTrace(browser);
  const t0 = Date.now();
  let error = null;
  let extracted = null;
  let landedUrl = url;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    landedUrl = page.url();

    if (step.extract === 'pdp') {
      extracted = await page.evaluate(() => {
        const links = [...document.querySelectorAll('a[href]')]
          .map((a) => a.href)
          .filter((h) => /\/p(\?|#|$)/.test(h));
        return links[0] || null;
      }).catch(() => null);
    } else if (step.extract === 'authLanding') {
      extracted = landedUrl !== url ? landedUrl : null;
    }
  } catch (e) {
    error = e.message;
  }

  const navigationTimeMs = Date.now() - t0;
  const events = await tracer.stop();
  await context.close().catch(() => {});

  const trace = parseTrace(events);
  for (const r of requests) delete r._req;

  return { url, landedUrl, navigationTimeMs, requests, trace, error, extracted };
}

// --- Store audit ------------------------------------------------------------

async function auditStore(browser, store) {
  const domain = store.domain;
  console.log(`\n🏬 ${store.label} — https://${domain}`);
  const steps = journeyFor(domain);
  const resolved = {};
  const results = [];
  const visitedUrls = [];
  const pageTypes = [];
  const sessionStart = Date.now();

  for (const step of steps) {
    let url = step.url;
    if (step.dynamic) {
      url = resolved[step.dynamic];
      if (!url) { console.log(`   ⏭  ${step.key}: omitido (no se pudo resolver la URL)`); continue; }
    }

    process.stdout.write(`   • ${step.key.padEnd(12)} `);
    const cap = await capturePage(browser, domain, url, step);
    if (cap.extracted && step.extract) resolved[step.extract] = cap.extracted;

    const result = analyzePage({
      url,
      navigationTimeMs: cap.navigationTimeMs,
      storeHost: domain,
      requests: cap.requests,
      trace: cap.trace,
      error: cap.error,
    });

    results.push(result);
    visitedUrls.push(url);
    pageTypes.push(step.pageType);

    const m = result.metrics;
    console.log(
      `${(cap.navigationTimeMs / 1000).toFixed(1).padStart(5)}s  ` +
      `req=${String(m.networkRequests).padStart(4)}  3p=${String(m.thirdPartyRequests).padStart(3)}  ` +
      `LT=${String(m.longTasks.count).padStart(3)}(max ${m.longTasks.maxMs}ms)  ` +
      `friction=${result.frictionPoints.length}` + (cap.error ? `  ⚠ ${cap.error.split('\n')[0].slice(0, 60)}` : '')
    );

    await sleep(PAGE_DELAY_MS);
  }

  return {
    auditDate: new Date().toISOString(),
    mode: 'interactive',
    startUrl: `https://${domain}/`,
    visitedUrls,
    ownedUrls: visitedUrls,
    excludedUrls: [],
    sessionDurationMs: Date.now() - sessionStart,
    captureProfile: {
      tool: 'walmart-cam-qa-audit (Playwright + Chrome DevTools trace)',
      cpuThrottlingRate: CPU_THROTTLE,
      network: 'unthrottled',
      cachePerStep: 'cold (fresh browser context)',
      settle: `domcontentloaded + networkidle (max ${SETTLE_TIMEOUT_MS}ms)`,
      viewport: '1366x768',
    },
    results,
    summary: summarize(results),
    _pageTypes: pageTypes,
    _store: store,
  };
}

// --- Folder-level artifacts -------------------------------------------------

function writeFolderArtifacts(dir, audits) {
  const rows = ['Date,Store ID,Domain,Country,Pages,Nav Time Avg (ms),Total Requests,Third-Party Requests,Third-Party %,Long Tasks,Worst Long Task (ms),Friction Total,Friction Critical,Friction High,Friction Medium'];
  const crossReference = [];
  const execSummary = [];

  for (const a of audits) {
    const s = a._store;
    const pages = a.results.length;
    const navAvg = pages ? Math.round(a.results.reduce((x, r) => x + r.navigationTimeMs, 0) / pages) : 0;
    const totalReq = a.results.reduce((x, r) => x + r.metrics.networkRequests, 0);
    const tpReq = a.results.reduce((x, r) => x + r.metrics.thirdPartyRequests, 0);
    const lt = a.results.reduce((x, r) => x + r.metrics.longTasks.count, 0);
    const worst = a.results.reduce((x, r) => Math.max(x, r.metrics.longTasks.maxMs), 0);
    const pct = totalReq ? Math.round((tpReq / totalReq) * 100) : 0;

    rows.push([
      a.auditDate.slice(0, 10), s.id, s.domain, s.country, pages, navAvg, totalReq, tpReq, pct, lt, worst,
      a.summary.totalFrictionPoints, a.summary.criticalCount, a.summary.highCount, a.summary.mediumCount,
    ].join(','));

    crossReference.push({
      store: { id: s.id, domain: s.domain, country: s.country, gtmContainer: s.gtmContainer },
      date: a.auditDate.slice(0, 10),
      sources: { audits: [{ path: `json/${slugFor(s.domain)}.json`, date: a.auditDate, urlCount: pages }] },
      metrics: { navAvgMs: navAvg, totalRequests: totalReq, thirdPartyRequests: tpReq, thirdPartyPct: pct },
      alignment: { hasAuditData: true, hasCatchpointData: false, hasGTMData: false, dateMatch: null, score: 1, complete: true },
    });

    execSummary.push({
      storeId: s.id, label: s.label, domain: s.domain, country: s.country,
      pages, navAvgMs: navAvg, totalRequests: totalReq, thirdPartyPct: pct,
      friction: a.summary, worstLongTaskMs: worst,
    });
  }

  fs.writeFileSync(path.join(dir, 'csv', 'metrics.csv'), rows.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'cross-reference.json'),
    JSON.stringify({ crossReference, summary: { stores: crossReference.length, generatedAt: new Date().toISOString() } }, null, 2));
  fs.writeFileSync(path.join(dir, 'executive-summary.json'),
    JSON.stringify({ date: new Date().toISOString(), stores: execSummary }, null, 2));
}

function slugFor(domain) {
  return domain.replace(/\./g, '-');
}

function stamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// --- Main -------------------------------------------------------------------

(async () => {
  for (const sub of ['json', 'csv', 'html']) fs.mkdirSync(path.join(outDir, sub), { recursive: true });

  console.log(`\n📊 Auditoría de performance — ${selected.length} tienda(s)`);
  console.log(`   Salida: ${outDir}`);
  console.log(`   Journey: 12 pasos por dominio · caché fría por paso · GET-only\n`);

  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });

  const audits = [];
  for (const store of selected) {
    try {
      const audit = await auditStore(browser, store);
      audits.push(audit);

      const ts = stamp(new Date());
      const base = `${slugFor(store.domain)}-${ts}`;
      const pageTypes = audit._pageTypes;
      const clean = { ...audit };
      delete clean._pageTypes; delete clean._store;

      fs.writeFileSync(path.join(outDir, 'json', `${base}.json`), JSON.stringify(clean, null, 2));
      fs.writeFileSync(path.join(outDir, 'csv', `${base}.csv`), renderPageCsv(store, audit, pageTypes));
      fs.writeFileSync(path.join(outDir, 'html', `${base}.html`), renderHtml(store, clean));
      console.log(`   ✅ ${base}.{json,csv,html}`);
    } catch (e) {
      console.error(`   ❌ ${store.id}: ${e.message}`);
    }
    await sleep(STORE_DELAY_MS);
  }

  await browser.close();

  if (audits.length) {
    writeFolderArtifacts(outDir, audits);
    console.log(`\n📁 Artefactos de carpeta: metrics.csv · cross-reference.json · executive-summary.json`);
  }
  console.log(`\n✔ Listo — ${audits.length}/${selected.length} tiendas auditadas en ${outDir}\n`);
})();
