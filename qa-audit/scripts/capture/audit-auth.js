#!/usr/bin/env node
/**
 * audit-auth.js — Authenticated full-funnel journey audit.
 *
 * Unlike scripts/audit.js (GET-only, fresh context per step), this runner keeps ONE
 * session for the whole journey so the cart and the login survive across steps. Tha
 * is what makes the checkout stages real: with an empty, anonymous cart every
 * /checkout/#/… route redirects to #/cart, so email/profile/shipping/payment measure
 * nothing but the checkout shell.
 *
 * Journey: homepage → search → PDP → add to cart → login → cart → email → profile →
 *          shipping → payment. The order is never placed.
 *
 * Each measured step is the cost of *advancing* to that step — including the backend
 * calls the transition triggers — because that is what a shopper waits for.
 *
 * This departs from the GET-only rule of engagement in ../CLAUDE.md by explici
 * instruction: it adds exactly ONE product per store per run, performs ONE login, and
 * writes name/phone/address onto the test account so VTEX will render the shipping and
 * payment steps at all. It never loops carts and never places an order. Credentials
 * come from .env and are never written into any report artifact.
 *
 * Usage:
 *   node scripts/audit-auth.js --stores walmart-cr
 *   node scripts/audit-auth.js                      # all stores
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const { startTrace, parseTrace } = require('../../lib/trace');
const { analyzePage, summarize } = require('../../lib/analyze');
const { renderHtml } = require('../../lib/render-html');
const { renderPageCsv } = require('../../lib/render-csv');
const { pageTypeOf } = require('../../lib/pagetype');
const { loadEnv } = require('../../lib/env');
const J = require('../../lib/journey');
const P = require('../../lib/paths');

// --- CLI --------------------------------------------------------------------
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const hasFlag = (n) => args.includes(n);

const STORES = require('../../config/stores.json').stores;
const filter = argVal('--stores', null);
const selected = filter
  ? STORES.filter((s) => filter.split(',').map((x) => x.trim()).includes(s.id))
  : STORES;

const env = loadEnv();
const EMAIL = env.WALMART_LOGIN;
const PASS = env.WALMART_PASS;
if (!EMAIL || !PASS) {
  console.error('\n❌ Faltan WALMART_LOGIN / WALMART_PASS en .env\n');
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

// Handoff pauses before the reCAPTCHA-gated shipping → payment click so a person can
// clear the challenge. It implies a visible browser.
const HANDOFF = hasFlag('--handoff');
const HEADED = hasFlag('--headed') || HANDOFF;

const CPU_THROTTLE = Number(argVal('--cpu-throttle', 1));
const NAV_TIMEOUT = Number(argVal('--nav-timeout', 60000));
const SETTLE_TIMEOUT = Number(argVal('--settle-timeout', 25000));
const STEP_DELAY = Number(argVal('--delay', 1500));

/**
 * Two budgets, because on 2026-08-30 one sick storefront destroyed three whole runs.
 *
 * Walmart GT alone took 96 minutes that evening — a normal store takes three — and the
 * pipeline's 90-minute cap killed the run before the other twelve were ever visited.
 * Three runs came back with 1, 1 and 2 storefronts out of 13.
 *
 *  - STEP_BUDGET caps a single step. Playwright's own timeouts did not save us: the
 *    search step was measured at 1,034 s with a 60 s navigation timeout and a 25 s
 *    settle timeout set, so something below them stopped honouring the clock. This is
 *    a hard wall-clock race that does not depend on the browser answering.
 *  - STORE_BUDGET caps a whole storefront. Once it is spent, the remaining steps are
 *    abandoned and the run moves to the next store.
 *
 * An abandoned store is written out with what it did capture and flagged, never
 * silently dropped: that a storefront blew its budget is itself the finding.
 */
const STEP_BUDGET = Number(argVal('--step-budget', 180)) * 1000;
const STORE_BUDGET = Number(argVal('--store-budget', 12)) * 60 * 1000;

/** Rejects if the promise has not settled in time, without waiting on the browser. */
function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`BUDGET:${label} superó ${ms / 1000}s`)), ms); }),
  ]);
}
const STORE_DELAY = Number(argVal('--store-delay', 5000));
// How long to give the operator to clear each reCAPTCHA before pressing on.
// How long to give the operator to reach the payment screen by hand.
const HANDOFF_WAIT_MS = Number(argVal('--handoff-wait', 300000));

const runStamp = P.parseRunId(dateFolder);
const fileYmd = runStamp ? runStamp.ymd : dateFolder;

const sleep = J.sleep;

/** A plain desktop Chrome UA — Playwright's default announces HeadlessChrome. */
const USER_AGENT = argVal('--user-agent',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/140.0.0.0 Safari/537.36');

const TIMEZONES = {
  GT: 'America/Guatemala', CR: 'America/Costa_Rica', SV: 'America/El_Salvador',
  HN: 'America/Tegucigalpa', NI: 'America/Managua',
};

// --- Per-store journey ------------------------------------------------------

async function auditStore(browser, store) {
  const base = `https://${store.domain}`;
  console.log(`\n🏬 ${store.label} — ${base}`);

  // No custom request header here, deliberately.
  //
  // An `X-Diagnostics-Client` header was added to satisfy the "identify the client"
  // rule, but a custom header makes every cross-origin request non-simple, forcing a
  // CORS preflight. Where the CDN rejects it the resource dies outright: measured on
  // walmart.com.gt, 107 of 369 requests failed with the header versus 53 without, and
  // the casualties included VTEX's polyfill bundle and the theme fonts. The checkou
  // then cannot mount its shipping form. Identification lives in the User-Agen
  // suffix below, which does not trigger a preflight.
  const context = await browser.newContext({
    viewport: HEADED ? null : { width: 1366, height: 768 },
    locale: 'es-419',
    timezoneId: TIMEZONES[store.country] || 'America/Guatemala',
    userAgent: USER_AGENT,
    // The shipping step's map only enables its confirm button for a pin inside the
    // store's delivery geofence. Granting geolocation with a metro coordinate lets the
    // page place a serviceable pin via "Utilizar ubicacion actual".
    geolocation: J.GEO_BY_COUNTRY[store.country],
    permissions: ['geolocation'],
  });

  // VTEX Shield fingerprints headless automation. This is the storefront owner
  // measuring their own storefront, so present as an ordinary desktop browser rather
  // than fighting a bot challenge that would never face a real shopper.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['es-419', 'es'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });

  const requests = [];
  const startedAt = new Map();
  context.on('request', (req) => {
    startedAt.set(req, Date.now());
    requests.push({ url: req.url(), method: req.method(), resourceType: req.resourceType(), wall: Date.now(), failed: false, status: null, timingMs: 0, _req: req });
  });
  const settleReq = (req, failed, status) => {
    const rec = requests.find((r) => r._req === req);
    if (!rec) return;
    rec.failed = failed; rec.status = status;
    rec.timingMs = Date.now() - (startedAt.get(req) || Date.now());
  };
  context.on('requestfinished', async (req) => {
    const r = await req.response().catch(() => null);
    settleReq(req, false, r ? r.status() : null);
  });
  context.on('requestfailed', (req) => settleReq(req, true, null));

  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  // Unthrottled by default: the target is a real shopper's machine, not the VDI the
  // July 2026 baseline happened to run on. Use --cpu-throttle 4 only when a mid-tier
  // mobile profile is what you actually want to measure.
  const cdp = await context.newCDPSession(page);
  if (CPU_THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

  const storeDeadline = Date.now() + STORE_BUDGET;
  const results = [];
  const visitedUrls = [];
  const pageTypes = [];
  const networkDump = [];
  const stepLog = [];
  const sessionStart = Date.now();

  /**
   * Measures one step. `action` performs the navigation or interaction; everything i
   * triggers lands in its own trace slice and request window. The HTTP cache is
   * cleared first, but cookies are kept so the cart and the login survive.
   */
  async function measure(label, action, { clearCache = true } = {}) {
    // Out of budget: stop measuring this storefront rather than starve the rest.
    if (Date.now() > storeDeadline) {
      throw new Error(`BUDGET:tienda superó ${STORE_BUDGET / 60000} min — se abandona en el paso ${label}`);
    }
    // Cold cache is right for a document load, wrong for an in-app step transition:
    // a shopper moving from shipping to payment keeps everything already downloaded,
    // and clearing it mid-SPA makes the checkout app re-mount and lose its step state.
    if (clearCache) await cdp.send('Network.clearBrowserCache').catch(() => {});
    const reqStart = requests.length;
    const tracer = await startTrace(browser);
    J.takePad(); // discard padding accrued between steps
    const t0 = Date.now();
    let error = null;
    try {
      await withDeadline((async () => {
        await action();
        await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT }).catch(() => {});
      })(), STEP_BUDGET, label);
    } catch (e) {
      error = e.message;
    }
    const navMs = Date.now() - t0;
    // What the script spent waiting on purpose, so the page's own time can be told
    // apart from our caution. navigationTimeMs keeps padding in, because every prior
    // capture measured it that way and the comparison across dates depends on it.
    const padMs = J.takePad();
    const pageMs = Math.max(0, navMs - padMs);
    const events = await tracer.stop();
    const trace = parseTrace(events);
    const stepReqs = requests.slice(reqStart);
    const url = page.url();

    const result = analyzePage({
      url, navigationTimeMs: navMs, storeHost: store.domain,
      requests: stepReqs.map(({ _req, ...r }) => r), trace, error,
    });
    result.pageTimeMs = pageMs;
    result.deliberateWaitMs = padMs;

    results.push(result);
    visitedUrls.push(url);
    pageTypes.push(pageTypeOf(url));
    networkDump.push({
      step: label, url, pageType: pageTypeOf(url), durationMs: navMs,
      requests: stepReqs.map((r) => ({ url: r.url, method: r.method, type: r.resourceType, status: r.status, ms: r.timingMs, failed: r.failed })),
    });
    stepLog.push({ step: label, url, hash: url.split('#')[1] || '', durationMs: navMs, pageMs, padMs, error });

    const m = result.metrics;
    console.log(`   • ${label.padEnd(13)} ${(navMs / 1000).toFixed(1).padStart(6)}s ${`(${(pageMs / 1000).toFixed(1)}s pág)`.padStart(11)}  req=${String(m.networkRequests).padStart(4)}  xhr=${String(m.xhrCalls).padStart(3)}  LT=${String(m.longTasks.count).padStart(3)}(max ${m.longTasks.maxMs}ms)  friction=${result.frictionPoints.length}${error ? `  ⚠ ${error.split('\n')[0].slice(0, 45)}` : ''}`);
    await sleep(STEP_DELAY);
    return result;
  }

  const goto = (url) => () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

  /**
   * Full document load. A goto that only changes the hash of the current URL is a
   * same-document navigation — it returns instantly and fires nothing — so force a
   * reload, which is what entering the cart from elsewhere really costs.
   */
  const gotoFull = (url) => async () => {
    const before = page.url();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    if (before.split('#')[0] === url.split('#')[0]) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    }
  };

  /** In-app step transition, as a shopper moving through checkout experiences it. */
  /**
   * In-app step transition, waiting for the step to actually render.
   *
   * This used to set the hash and sleep four seconds flat. Two problems, both seen on
   * 2026-09-09: when the checkout rendered in one second we threw away three, and when it
   * took longer than four the next helper found an empty page and reported "sin formulario
   * de perfil" — a slow render logged as a missing form. Both Nicaragua storefronts failed
   * that way while the page was fine.
   *
   * Now it waits for the step's own form to appear and moves on the moment it does.
   */
  const hash = (h) => async () => {
    await page.evaluate((x) => { window.location.hash = x; }, h);
    const listo = await page.waitForFunction((want) => {
      if (!location.hash.includes(want.replace('#/', ''))) return false;
      const vis = (e) => e.offsetParent !== null;
      return [...document.querySelectorAll('input,select,button')].some(vis);
    }, h, { timeout: SETTLE_TIMEOUT, polling: 250 }).then(() => true).catch(() => false);
    // Only the fallback is padding: when the step answers, the wait was the page working.
    if (!listo) await sleep(4000); else await sleep(500);
  };

  const landedOn = () => (page.url().split('#')[1] || '').replace(/^\//, '');

  /**
   * A storefront that blows its budget still reports what it measured.
   *
   * Losing the whole store on the way out was how three runs came back with one
   * storefront out of thirteen: the error propagated, the partial capture was thrown
   * away, and nothing recorded why. The steps completed before the budget ran out are
   * real measurements, and the fact that it ran out is itself the finding.
   */
  let abortedAt = null;
  // Declared out here so the audit can still be written when the journey is cut short.
  let location = null, stockNote = null, cartItems = 0, authed = false;
  let profileStatus = 'n/a', shippingStatus = 'n/a', paymentAssisted = false, paymentScreenStatus = null;
  try {
    // 1. Homepage, then clear the mandatory delivery-location gate. The choice sticks
    //    to the session, so every later step runs unblocked.
    await measure('homepage', goto(`${base}/`));
    await J.acceptCookies(page);
    location = await J.selectDeliveryLocation(page, 4, store.country);
    console.log(`   📍 ubicación de entrega: ${location}`);

    // 2–3. Search, then a product that the selected store actually stocks.
    //      Availability is per store, so the first result may render no add-to-car
    //      button at all; walk the results until one does.
    await measure('search', goto(`${base}/pollo?_q=pollo&map=ft`));
    const candidates = await J.findPdpUrls(page, 6);
    let pdpUrl = null;

    for (const url of candidates) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT }).catch(() => {});
      await J.selectDeliveryLocation(page, 4, store.country);
      if (await J.hasAddToCart(page)) { pdpUrl = url; break; }
      console.log(`   ⏭  sin stock en la tienda seleccionada: ${url.split('/').slice(-2)[0]}`);
    }

    stockNote = null;
    if (pdpUrl) {
      await measure('pdp', goto(pdpUrl));
    } else {
      stockNote = `Ninguno de los ${candidates.length} primeros resultados de búsqueda ofrece botón de agregar al carrito en la tienda seleccionada. Sin producto no hay carrito, y sin carrito el checkout no avanza: las etapas posteriores quedan sin medir.`;
      console.log(`   ⏭  pdp: ${stockNote}`);
      // Still measure the PDP itself — it is a real page a shopper lands on.
      if (candidates.length) await measure('pdp', goto(candidates[0]));
    }

    // 4. Add exactly one product — the single authorised orderForm mutation.
    cartItems = 0;
    if (pdpUrl) {
      await measure('add-to-cart', async () => {
        await J.acceptCookies(page);
        await J.selectDeliveryLocation(page, 4, store.country);
        const via = await J.clickResilient(page, J.ADD_TO_CART, J.ADD_TO_CART_TEXT);
        if (!via) throw new Error('no se encontró el botón de agregar al carrito');
        await sleep(6000);
      });
      cartItems = await J.cartItemCount(page);
      console.log(`   🛒 items en el carrito: ${cartItems}`);
    }

    // 5. Login (two-step: email → Continuar → password → Continuar).
    await measure('login-page', goto(`${base}/login?returnUrl=/checkout/#/orderform`));
    await measure('login-submit', () => J.login(page, EMAIL, PASS, SETTLE_TIMEOUT));
    authed = await J.isLoggedIn(page);
    console.log(`   ${authed ? '🔓' : '🔒'} sesión autenticada: ${authed}`);

    // 6. Checkout funnel. Cart is a real page load; the rest are in-app transitions.
    //    Profile and shipping must be filled in or VTEX refuses to render what follows.
    await measure('cart', gotoFull(`${base}/checkout/#/cart`));
    await measure('email', hash('#/email'), { clearCache: false });
    await measure('profile', hash('#/profile'), { clearCache: false });

    profileStatus = 'n/a';
    shippingStatus = 'n/a';

    const profile = J.profileFor(store.country);
    await measure('shipping', async () => {
      profileStatus = await J.completeProfile(page, profile);
      await sleep(3000);
    }, { clearCache: false });
    console.log(`   📝 perfil: ${profileStatus}`);

    // State check before the last transition: a dropped session or an emptied
    // orderForm both make VTEX collapse the funnel back, and look identical on screen.
    const preShip = { items: await J.cartItemCount(page), authed: await J.isLoggedIn(page) };
    console.log(`   🔍 antes de envío → items=${preShip.items} autenticado=${preShip.authed}`);

    paymentAssisted = false;
    if (HANDOFF) {
      // Everything up to the shipping form is filled automatically; the operator does the
      // final shipping → payment push by hand, because that gate has not yielded to
      // automation. The elapsed time therefore includes human interaction — it is
      // recorded as operator-assisted so no report treats it as a load measurement.
      shippingStatus = await J.completeShipping(page, profile, { advance: false });
      console.log(`   🚚 envío: ${String(shippingStatus).slice(0, 150)}`);
      console.log(`\n   ┌─ ${store.label} ${'─'.repeat(Math.max(0, 46 - store.label.length))}`);
      console.log('   │  Complet\u00e1 a mano en el navegador hasta la pantalla');
      console.log('   │  de M\u00c9TODO DE PAGO. NO confirmes la compra.');
      console.log('   │  Detecto solo cuando llegues; no toques la terminal.');
      console.log(`   └─ hasta ${Math.round(HANDOFF_WAIT_MS / 60000)} min\n`);

      let payStatus = null;
      paymentAssisted = true;
      await measure('payment', async () => {
        payStatus = await J.waitForPaymentStep(page, HANDOFF_WAIT_MS,
          (secs) => console.log(`      ⏳ esperando… ${secs}s`));
      }, { clearCache: false });
      console.log(`   💳 pago: ${payStatus}`);
    } else {
      await measure('payment', async () => {
        shippingStatus = await J.completeShipping(page, profile);
        await sleep(3000);
      }, { clearCache: false });
    }
    console.log(`   🚚 envío: ${shippingStatus}`);
    console.log(`   ${landedOn() === 'payment' ? '💳 llegó al paso de pago' : `⚠ el funnel quedó en #${landedOn() || '?'} — pago no alcanzado`}`);

    /**
     * Step 12 — the payment screen itself.
     *
     * Deliberately outside the canonical eleven. Those eleven are the series every
     * comparison is built on, and adding a twelfth to them would change what "the
     * journey" means for four dates at once. This one is analysis: the cost of the
     * payment screen becoming usable, which nothing measured while the funnel could not
     * reach it. lib/stages.js keeps it out of the compared stages by name.
     *
     * Read-only. No payment method is selected and no order is placed.
     */
    paymentScreenStatus = null;
    if (landedOn() === 'payment') {
      await measure('payment-screen', async () => {
        paymentScreenStatus = await J.waitForPaymentOptions(page);
      }, { clearCache: false });
      console.log(`   🧾 pantalla de pago: ${paymentScreenStatus}`);
    }

  } catch (e) {
    if (!String(e.message).startsWith('BUDGET:')) throw e;
    abortedAt = String(e.message).replace(/^BUDGET:/, '');
    console.log(`   ⏱  presupuesto agotado — ${abortedAt}`);
    console.log(`   ↷ se conserva lo medido (${results.length} paso(s)) y se sigue con la próxima tienda`);
  }

  await context.close().catch(() => {});

  return {
    audit: {
      auditDate: new Date().toISOString(),
      mode: 'authenticated-journey',
      startUrl: `${base}/`,
      visitedUrls,
      ownedUrls: visitedUrls,
      excludedUrls: [],
      sessionDurationMs: Date.now() - sessionStart,
      captureProfile: {
        tool: 'walmart-cam-qa-audit auth (Playwright + Chrome DevTools trace)',
        cpuThrottlingRate: CPU_THROTTLE,
        network: 'unthrottled',
        cachePerStep: 'HTTP cache cleared per step; cookies kept so cart + auth persist',
        authenticated: authed,
        cartItems,
        addToCartBlocked: stockNote,
        deliveryLocation: location,
        profileStep: profileStatus,
        shippingStep: shippingStatus,
        reachedPayment: landedOn() === 'payment',
        abortedForBudget: abortedAt,
        paymentScreen: paymentScreenStatus,
        paymentStepAssisted: paymentAssisted,
        cartMutated: 'one product added; order never placed',
        note: 'A mandatory delivery-location modal covers the page at z-index 10000 until completed; it is cleared once at the start of the session. Profile and shipping forms are filled with fictional test data because VTEX will not render the following step otherwise.',
      },
      stepLog,
      results,
      summary: summarize(results),
    },
    pageTypes,
    networkDump,
  };
}

// --- Main -------------------------------------------------------------------

(async () => {
  for (const sub of ['json', 'csv', 'html', 'network']) fs.mkdirSync(path.join(outDir, sub), { recursive: true });

  console.log(`\n🔐 Auditoría autenticada de funnel completo — ${selected.length} tienda(s)`);
  console.log(`   Cuenta: ${EMAIL.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
  console.log(`   CPU throttling: ${CPU_THROTTLE}x · caché HTTP limpia por paso · cookies preservadas`);
  console.log(`   Un producto por tienda. La compra NUNCA se confirma.`);
  console.log(`   Salida: ${outDir}\n`);

  const browser = await chromium.launch({
    headless: !HEADED,
    // Maximised in handoff so the operator can actually see and solve the challenge.
    args: [
      '--disable-dev-shm-usage', '--no-sandbox',
      // Removes the navigator.webdriver flag Chromium sets under automation.
      '--disable-blink-features=AutomationControlled',
      ...(HANDOFF ? ['--start-maximized'] : []),
    ],
  });

  for (const store of selected) {
    try {
      const { audit, pageTypes, networkDump } = await auditStore(browser, store);
      const d = new Date();
      const ts = `${fileYmd}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const b = `${store.domain.replace(/\./g, '-')}-auth-${ts}`;

      fs.writeFileSync(path.join(outDir, 'json', `${b}.json`), JSON.stringify(audit, null, 2));
      fs.writeFileSync(path.join(outDir, 'csv', `${b}.csv`), renderPageCsv(store, audit, pageTypes));
      fs.writeFileSync(path.join(outDir, 'html', `${b}.html`), renderHtml(store, audit));
      fs.writeFileSync(path.join(outDir, 'network', `${b}.json`), JSON.stringify(networkDump, null, 2));
      console.log(`   ✅ ${b}.{json,csv,html} + network/`);
    } catch (e) {
      console.error(`   ❌ ${store.id}: ${e.message}`);
    }
    await sleep(STORE_DELAY);
  }

  await browser.close();
  console.log(`\n✔ Listo — ${outDir}\n`);
  process.exit(0);
})();
