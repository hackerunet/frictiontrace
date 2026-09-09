#!/usr/bin/env node
/**
 * interactive.js — Attended journey capture.
 *
 * Opens a real browser and hands it to you. You drive the full customer journey —
 * log in, add a product, walk the checkout to the payment step — and this scrip
 * records everything: a continuous Chrome DevTools trace plus the full request log,
 * automatically split into one measured page per navigation (hash changes included,
 * which is what the checkout SPA does).
 *
 * Nothing is automated against production and no credentials are read: you perform
 * the login yourself. Stop before confirming the order.
 *
 * Usage:
 *   node scripts/interactive.js --store walmart-cr
 *   node scripts/interactive.js --store walmart-gt --cpu-throttle 1
 *
 * Controls (in this terminal):
 *   Enter  → force a step boundary (use after an in-page action like "add to cart"
 *            that does not change the URL)
 *   f      → finish, write the report artifacts and close
 *   Ctrl+C → same as f
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const { startTrace, parseTrace } = require('../../lib/trace');
const { analyzePage, summarize } = require('../../lib/analyze');
const { renderHtml } = require('../../lib/render-html');
const { renderPageCsv } = require('../../lib/render-csv');
const { pageTypeOf } = require('../../lib/pagetype');
const P = require('../../lib/paths');

// --- CLI --------------------------------------------------------------------
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const STORES = require('../../config/stores.json').stores;
const store = STORES.find((s) => s.id === argVal('--store', ''));
if (!store) {
  console.error(`\nFalta --store. Disponibles:\n  ${STORES.map((s) => s.id).join('\n  ')}\n`);
  process.exit(1);
}

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
// One folder per execution, identified by date AND hour: the pipeline runs three times
// a day, so a bare date would make three captures overwrite each other. --date is kept
// as an alias for re-capturing into an existing historical folder.
const dateFolder = argVal('--run', argVal('--date', P.newRunId(now)));
const outDir = argVal('--out', null)
  ? path.resolve(argVal('--out'), dateFolder)
  : P.runDirPath(dateFolder);
const CPU_THROTTLE = Number(argVal('--cpu-throttle', 1));
const SETTLE_MS = Number(argVal('--settle', 2500));

const slug = store.domain.replace(/\./g, '-');
const runStamp = P.parseRunId(dateFolder);
const fileYmd = runStamp ? runStamp.ymd : dateFolder;
const stamp = `${fileYmd}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

// --- State ------------------------------------------------------------------
/** Each step: { url, startWall, endWall, marker } — trace events are sliced by marker. */
const steps = [];
const requests = [];
let stepSeq = 0;
let finishing = false;

function openStep(url) {
  const prev = steps[steps.length - 1];
  if (prev && !prev.endWall) prev.endWall = Date.now();
  const marker = `QAAUDIT_STEP_${stepSeq++}`;
  steps.push({ url, startWall: Date.now(), endWall: null, marker });
  return steps[steps.length - 1];
}

(async () => {
  fs.mkdirSync(path.join(outDir, 'json'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'csv'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'html'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'network'), { recursive: true });

  console.log(`\n🖐  Captura interactiva — ${store.label} (${store.domain})`);
  console.log(`   CPU throttling: ${CPU_THROTTLE}x${CPU_THROTTLE === 4 ? ' (calibrado contra el baseline de julio)' : ''}`);
  console.log(`   Salida: ${outDir}\n`);
  console.log(`   Recorré el journey completo en el navegador que se abre:`);
  console.log(`     home → buscar → PDP → agregar 1 producto → login → carrito → email → envío → pago`);
  console.log(`   ⚠  NO confirmes la compra.\n`);
  console.log(`   Enter = marcar paso manualmente (p.ej. después de "Agregar al carrito")`);
  console.log(`   f + Enter = terminar y generar el reporte\n`);

  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const ctx = await browser.newContext({ viewport: null, locale: 'es-419' });
  const page = await ctx.newPage();

  if (CPU_THROTTLE > 1) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  }

  const startedAt = new Map();
  ctx.on('request', (req) => {
    startedAt.set(req, Date.now());
    requests.push({ url: req.url(), method: req.method(), resourceType: req.resourceType(), wall: Date.now(), failed: false, status: null, timingMs: 0, _req: req });
  });
  const settle = (req, failed, status) => {
    const rec = requests.find((r) => r._req === req);
    if (!rec) return;
    rec.failed = failed;
    rec.status = status;
    rec.timingMs = Date.now() - (startedAt.get(req) || Date.now());
  };
  ctx.on('requestfinished', async (req) => {
    const r = await req.response().catch(() => null);
    settle(req, false, r ? r.status() : null);
  });
  ctx.on('requestfailed', (req) => settle(req, true, null));

  // Every main-frame navigation starts a new measured page. This fires on hash
  // changes too, which is exactly how the VTEX checkout SPA moves between steps.
  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame() || finishing) return;
    const url = frame.url();
    if (!url || url === 'about:blank') return;
    const step = openStep(url);
    await page.evaluate((m) => { try { console.timeStamp(m); } catch {} }, step.marker).catch(() => {});
    console.log(`   ▶ paso ${steps.length}: ${pageTypeOf(url).padEnd(22)} ${url.slice(0, 88)}`);
  });

  const tracer = await startTrace(browser);
  await page.goto(`https://${store.domain}/`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});

  // --- Terminal controls ---
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const done = new Promise((resolve) => {
    rl.on('line', async (line) => {
      const cmd = line.trim().toLowerCase();
      if (cmd === 'f' || cmd === 'fin' || cmd === 'q') { resolve(); return; }
      const step = openStep(page.url());
      await page.evaluate((m) => { try { console.timeStamp(m); } catch {} }, step.marker).catch(() => {});
      console.log(`   ▶ paso ${steps.length} (manual): ${page.url().slice(0, 88)}`);
    });
    process.on('SIGINT', () => resolve());
  });

  await done;
  finishing = true;
  rl.close();

  console.log(`\n⏳ Cerrando traza y procesando ${steps.length} paso(s)...`);
  if (steps.length) steps[steps.length - 1].endWall = Date.now();
  const events = await tracer.stop();
  await browser.close().catch(() => {});
  for (const r of requests) delete r._req;

  // --- Map wall-clock step boundaries onto the trace clock -------------------
  // console.timeStamp() emits a TimeStamp event carrying our marker, giving exac
  // boundaries in trace time. If those are missing we fall back to a linear offset.
  const markerTs = new Map();
  for (const e of events) {
    if (e.name !== 'TimeStamp') continue;
    const msg = e.args && e.args.data && (e.args.data.message || e.args.data.name);
    if (msg && markerTs.get(msg) === undefined) markerTs.set(msg, e.ts);
  }

  let offset = null; // traceTs = wall*1000 + offse
  const anchored = steps.filter((s) => markerTs.has(s.marker));
  if (anchored.length) {
    offset = anchored.reduce((a, s) => a + (markerTs.get(s.marker) - s.startWall * 1000), 0) / anchored.length;
  } else {
    const first = events.filter((e) => e.ph === 'X' && typeof e.ts === 'number').reduce((m, e) => Math.min(m, e.ts), Infinity);
    if (isFinite(first) && steps.length) offset = first - steps[0].startWall * 1000;
  }
  const toTrace = (wall) => (offset == null ? null : wall * 1000 + offset);

  // --- Build one result per step --------------------------------------------
  const results = [];
  const pageTypes = [];
  const networkDump = [];

  for (const s of steps) {
    const endWall = s.endWall || Date.now();
    const t0 = markerTs.get(s.marker) ?? toTrace(s.startWall);
    const t1 = toTrace(endWall);

    const slice = (t0 == null || t1 == null)
      ? []
      : events.filter((e) => typeof e.ts === 'number' && e.ts >= t0 && e.ts < t1);
    // thread_name metadata carries no useful ts; keep it so long-task filtering works.
    const meta = events.filter((e) => e.name === 'thread_name');
    const trace = parseTrace(slice.concat(meta));

    const stepReqs = requests.filter((r) => r.wall >= s.startWall && r.wall < endWall);

    results.push(analyzePage({
      url: s.url,
      navigationTimeMs: endWall - s.startWall,
      storeHost: store.domain,
      requests: stepReqs,
      trace,
    }));
    pageTypes.push(pageTypeOf(s.url));
    networkDump.push({
      url: s.url,
      pageType: pageTypeOf(s.url),
      durationMs: endWall - s.startWall,
      requests: stepReqs.map((r) => ({ url: r.url, method: r.method, type: r.resourceType, status: r.status, ms: r.timingMs, failed: r.failed })),
    });
  }

  const audit = {
    auditDate: new Date().toISOString(),
    mode: 'interactive-attended',
    startUrl: `https://${store.domain}/`,
    visitedUrls: steps.map((s) => s.url),
    ownedUrls: steps.map((s) => s.url),
    excludedUrls: [],
    sessionDurationMs: steps.length ? (steps[steps.length - 1].endWall - steps[0].startWall) : 0,
    captureProfile: {
      tool: 'walmart-cam-qa-audit interactive (Playwright + Chrome DevTools trace)',
      driver: 'human-operated session',
      cpuThrottlingRate: CPU_THROTTLE,
      network: 'unthrottled',
      cachePerStep: 'shared session (cart + auth preserved across steps)',
      authenticated: true,
      cartMutated: 'one product added by the operator; purchase not completed',
      viewport: 'maximized',
    },
    results,
    summary: summarize(results),
  };

  const base = `${slug}-${stamp}`;
  fs.writeFileSync(path.join(outDir, 'json', `${base}.json`), JSON.stringify(audit, null, 2));
  fs.writeFileSync(path.join(outDir, 'csv', `${base}.csv`), renderPageCsv(store, audit, pageTypes));
  fs.writeFileSync(path.join(outDir, 'html', `${base}.html`), renderHtml(store, audit));
  fs.writeFileSync(path.join(outDir, 'network', `${base}.json`), JSON.stringify(networkDump, null, 2));

  console.log(`\n✅ ${steps.length} pasos capturados — ${audit.summary.totalFrictionPoints} friction points`);
  for (let i = 0; i < results.length; i++) {
    const m = results[i].metrics;
    console.log(`   ${String(i + 1).padStart(2)}. ${pageTypes[i].padEnd(22)} ${(results[i].navigationTimeMs / 1000).toFixed(1).padStart(6)}s  req=${String(m.networkRequests).padStart(4)}  xhr=${String(m.xhrCalls).padStart(3)}  LT=${String(m.longTasks.count).padStart(3)}(max ${m.longTasks.maxMs}ms)`);
  }
  console.log(`\n📁 ${path.join(outDir, 'json', base + '.json')}`);
  console.log(`   + csv/ + html/ + network/ (log completo de requests por paso)\n`);
  process.exit(0);
})();
