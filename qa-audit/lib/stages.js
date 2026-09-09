/**
 * stages.js — Journey stage extraction shared by the comparison and executive
 * summary reports.
 *
 * Stage times are matched by URL shape rather than by the CSV `page_type` column, so
 * the same matcher works across capture runs that labelled page types differently.
 */

const fs = require('fs');
const path = require('path');
const P = require('./paths');

const STAGES = [
  { key: 'homepage', label: 'Homepage' },
  { key: 'login', label: 'Login', caveat: 'login' },
  { key: 'search', label: 'Search' },
  { key: 'pdp', label: 'PDP' },
  { key: 'cart', label: 'Cart' },
  { key: 'email', label: 'Email', caveat: 'shell' },
  { key: 'shipping', label: 'Shipping', caveat: 'shell' },
  { key: 'payment', label: 'Payment', caveat: 'shell' },
];

/** Checkout average = mean of Email + Shipping + Payment, as the July report defined it. */
const CHECKOUT_AVG_OF = ['email', 'shipping', 'payment'];

/**
 * Stage list for the session experiment. Adds Profile, which the authenticated run
 * measures as a real step; the historical GET-only comparison keeps STAGES unchanged
 * so its output stays byte-comparable with prior runs.
 */
const STAGES_FULL = [
  { key: 'homepage', label: 'Homepage' },
  { key: 'search', label: 'Search' },
  { key: 'pdp', label: 'PDP' },
  { key: 'login', label: 'Login' },
  { key: 'cart', label: 'Cart' },
  { key: 'email', label: 'Email' },
  { key: 'profile', label: 'Profile' },
  { key: 'shipping', label: 'Shipping' },
  { key: 'payment', label: 'Payment' },
];

const COUNTRIES = {
  GT: { name: 'Guatemala', flag: '🇬🇹', color: '#dd6b20' },
  CR: { name: 'Costa Rica', flag: '🇨🇷', color: '#38a169' },
  SV: { name: 'El Salvador', flag: '🇸🇻', color: '#2b6cb0' },
  HN: { name: 'Honduras', flag: '🇭🇳', color: '#d53f8c' },
  NI: { name: 'Nicaragua', flag: '🇳🇮', color: '#805ad5' },
};
const COUNTRY_ORDER = ['GT', 'CR', 'SV', 'HN', 'NI'];

/**
 * Journey step name → comparison stage. Steps absent here (add-to-cart, login-submit)
 * are interactions rather than stages the historical reports measured.
 */
/**
 * Steps that exist for analysis and must never become a comparison column.
 *
 * `payment-screen` measures the payment screen once the funnel reaches it — real, but
 * newer than the four dates already published. Letting it fall through to the URL
 * matcher would file it under `payment` and quietly redefine that stage.
 */
const ANALYSIS_ONLY = new Set(['payment-screen']);

const STEP_TO_STAGE = {
  homepage: 'homepage',
  search: 'search',
  pdp: 'pdp',
  'login-page': 'login',
  cart: 'cart',
  email: 'email',
  profile: 'profile',
  shipping: 'shipping',
  payment: 'payment',
};

/**
 * Is this value a stall, or is this storefront simply slow here?
 *
 * An absolute ceiling could not tell those apart, and got it wrong in a way worth
 * recording: Walmart NI's payment step reads a median of 136s across 38 readings — that
 * is its behaviour, reproducible to within a few seconds — and a flat 120s limit deleted
 * it every single time, hiding the worst payment step in the chain. Meanwhile a genuine
 * stall (Walmart GT's search at 1,034s against its own 7s median) needs to go.
 *
 * So the judgement is made against the store's own history for that stage, which is the
 * only population where "unusual" means anything. A value is a stall when it is both far
 * above what this store normally does there and large in absolute terms — the second
 * condition keeps a fast stage's ordinary jitter from being called a stall.
 */
function isHang(base, storeId, stage, secs) {
  const med = base[storeId] && base[storeId][stage];
  if (!med) return false;
  return secs >= hangFloor() && secs > med * hangFactor();
}

function hangFactor() { return cfgNum('hangFactor', 5); }
function hangFloor() { return cfgNum('hangFloorSeconds', 60); }

function cfgNum(key, dflt) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(P.PROJECT_ROOT, 'config', 'pipeline.json'), 'utf8'));
    const v = cfg.series && cfg.series[key];
    return typeof v === 'number' ? v : dflt;
  } catch { return dflt; }
}

/**
 * Median seconds per store and stage over the measured era, built once.
 *
 * Read raw — no stall rule applied — because this is what the rule is judged against.
 */
let _baseline = null;
function stageBaseline(stores) {
  if (_baseline) return _baseline;
  const acc = {};
  for (const r of P.listRuns()) {
    if (r.id < rulesEffectiveFrom() || !P.hasCaptures(r.dir)) continue;
    const dir = path.join(r.dir, 'json');
    for (const file of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      if (!Array.isArray(d.results)) continue;
      const store = matchStore(hostOfAudit(d), stores);
      if (!store) continue;
      const log = Array.isArray(d.stepLog) ? d.stepLog : null;
      d.results.forEach((x, i) => {
        const step = log && log[i] && log[i].step;
        if (step && ANALYSIS_ONLY.has(step)) return;
        const st = (step && STEP_TO_STAGE[step]) || stageOf(x.url);
        if (!st) return;
        ((acc[store.id] = acc[store.id] || {})[st] = acc[store.id][st] || []).push(x.navigationTimeMs / 1000);
      });
    }
  }
  _baseline = {};
  for (const [id, stages] of Object.entries(acc)) {
    _baseline[id] = {};
    for (const [st, xs] of Object.entries(stages)) {
      const v = xs.slice().sort((a, b) => a - b);
      _baseline[id][st] = v[Math.floor(v.length / 2)];
    }
  }
  return _baseline;
}

/** Kept for the config note and for reporting what the old absolute rule would do. */
function hangCeiling() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(P.PROJECT_ROOT, 'config', 'pipeline.json'), 'utf8'));
    const v = cfg.series && cfg.series.hangCeilingSeconds;
    return typeof v === 'number' ? v : 120;
  } catch { return 120; }
}

/**
 * Steps dropped as hangs, so a report can say so instead of quietly losing them.
 *
 * De-duplicated by run+store+stage: a report reads the same run several times — once
 * per comparison column, again while checking coverage — and a plain push counted one
 * stall three times. A figure in a published note has to be the number of incidents,
 * not the number of times the file was opened.
 */
const droppedHangs = [];
const seenHangs = new Set();

/**
 * What was captured, what was used, and why the rest was not.
 *
 * Quality control at the level of the single reading, never the run. A step that failed
 * in the 08:00 capture says nothing about the same step at 15:00, and discarding the
 * whole execution over one bad navigation would throw away good measurements — on
 * 2026-08-24 Walmart GT lost five steps in one run and the day still stands on the two
 * that worked.
 *
 * Counted per run+store+stage so that reading the same capture several times, which the
 * reports do, cannot inflate the tally.
 */
const calidad = {
  lecturas: 0,
  usadas: 0,
  descartadas: { error: 0, cuelgue: 0, carritoVacio: 0, pagoNoAlcanzado: 0 },
  motivos: {
    error: 'La navegación falló y quedó registrado el error',
    cuelgue: 'Duración muy por encima de lo que esa tienda hace en ese paso',
    carritoVacio: 'Checkout medido sin producto en el carrito',
    pagoNoAlcanzado: 'El recorrido no llegó a la pantalla de pago',
  },
};
const vistas = new Set();
function anotar(runDir, storeId, stage, motivo) {
  const k = runDir + '|' + storeId + '|' + stage;
  if (vistas.has(k)) return;
  vistas.add(k);
  calidad.lecturas++;
  if (motivo) calidad.descartadas[motivo]++; else calidad.usadas++;
}

/** First run id a later-added rule may act on. Everything older is settled. */
function rulesEffectiveFrom() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(P.PROJECT_ROOT, 'config', 'pipeline.json'), 'utf8'));
    return (cfg.series && cfg.series.rulesEffectiveFrom) || '20260821';
  } catch { return '20260821'; }
}

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/**
 * Human label for a run id — "20260812" → "Agosto 12", "20260821-0600" → "Agosto 21 06:00".
 * Derived rather than hard-coded so a report never claims a date the data isn't from.
 * The hour is part of the label because the pipeline runs three times a day and two
 * columns from the same date would otherwise be indistinguishable.
 */
function folderLabel(folder) {
  const m = String(folder).match(/^(\d{4})(\d{2})(\d{2})(?:-(\d{2})(\d{2}))?/);
  if (!m) return String(folder);
  const name = MONTHS_ES[Number(m[2]) - 1] || m[2];
  const day = name.charAt(0).toUpperCase() + name.slice(1) + ' ' + Number(m[3]);
  return m[4] ? `${day} ${m[4]}:${m[5]}` : day;
}

/** Compact form for delta headers — "20260812" → "Ago12", "20260821-0600" → "Ago21·06h". */
function folderShort(folder) {
  const m = String(folder).match(/^(\d{4})(\d{2})(\d{2})(?:-(\d{2})(\d{2}))?/);
  if (!m) return String(folder);
  const name = MONTHS_ES[Number(m[2]) - 1] || m[2];
  const day = name.charAt(0).toUpperCase() + name.slice(1, 3) + Number(m[3]);
  return m[4] ? `${day}·${m[4]}h` : day;
}

function stageOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const p = u.pathname, h = u.hash, q = u.search;

  if (h.includes('/cart')) return 'cart';
  if (h.includes('/email')) return 'email';
  if (h.includes('/profile')) return 'profile';
  if (h.includes('/shipping')) return 'shipping';
  if (h.includes('/payment')) return 'payment';
  // The login step redirects to VTEX ID, so the recorded URL is often /account/login.
  if (p.startsWith('/login') || p.startsWith('/account/login')) return 'login';
  if (/(_q=|map=ft)/.test(q)) return 'search';
  if (/\/p$/.test(p)) return 'pdp';
  if (p === '/' || p === '') return 'homepage';
  return null;
}

function hostOfAudit(data) {
  try { return new URL(data.startUrl || data.results[0].url).hostname; } catch { return ''; }
}

function matchStore(host, stores) {
  return stores.find((s) => host === s.domain
    || host === s.domain.replace(/^www\./, '')
    || host.endsWith('.' + s.domain.replace(/^www\./, '')));
}

/**
 * Reads one run's audit JSONs → { storeId: { stage: seconds } }.
 * Files whose audit contains a single trace-import result carry no per-stage
 * breakdown and are skipped; callers fall back to a published baseline for those.
 */
function readRunDir(runDir, stores) {
  // Rules added today do not reach back. A run captured before the effective date is
  // read exactly as it was measured.
  const runId = path.basename(runDir);
  const applyRules = String(runId) >= String(rulesEffectiveFrom());
  const base = applyRules ? stageBaseline(stores) : null;
  const dir = path.join(runDir, 'json');
  const out = {};
  if (!fs.existsSync(dir)) return out;

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
    if (!Array.isArray(data.results) || data.results.length < 2) continue;

    const store = matchStore(hostOfAudit(data), stores);
    if (!store) continue;

    const stages = out[store.id] || (out[store.id] = {});
    const log = Array.isArray(data.stepLog) ? data.stepLog : null;
    const cp = data.captureProfile || {};

    /**
     * Two kinds of value must never reach a report as if they were measurements:
     *
     *  - Checkout stages captured with an empty cart. VTEX collapses the whole funnel
     *    back to #/cart, so the number is the cart shell wearing another stage's name.
     *  - The payment step when the run never reached #/payment. Its duration is the
     *    instrumentation timing out against the reCAPTCHA gate — ~59s every time,
     *    which would read as a catastrophic regression instead of missing data.
     */
    const cartless = cp.cartItems === 0;
    const noPayment = cp.reachedPayment === false;
    // How the payment step was reached — by script or with an operator's help — does
    // not disqualify the measurement; only a step that never reached the screen does.
    const CHECKOUT = new Set(['cart', 'email', 'profile', 'shipping', 'payment']);
    const invalid = (stage) =>
      (cartless && CHECKOUT.has(stage)) || (noPayment && stage === 'payment');

    data.results.forEach((r, i) => {
      // Prefer the step the journey *asked for* over the URL it landed on. With a live
      // session VTEX skips steps it already has data for — requesting #/email lands on
      // #/profile — and attributing by landing URL would silently drop that stage and
      // make it incomparable with the historical runs, which labelled by request.
      const entry = log && log[i];
      const step = entry && entry.step;
      if (step && ANALYSIS_ONLY.has(step)) return;
      /**
       * A navigation that failed is not a page that loaded instantly.
       *
       * A step whose action threw records the few milliseconds before it gave up —
       * net::ERR_FAILED, a missing form field, a landing on chrome-error:// — and the
       * extractor was reading those tens of milliseconds as a measurement. Across the
       * fortnight that is 51 readings entering the averages as near-zero, a bias that can
       * only invent improvements. The capture already records the error; it just was not
       * being consulted.
       */
      const stTmp = (step && STEP_TO_STAGE[step]) || stageOf(r.url);
      if (!stTmp) return;
      if (entry && entry.error) { anotar(runDir, store.id, stTmp, 'error'); return; }
      const st = stTmp;
      if (invalid(st)) {
        anotar(runDir, store.id, st, cartless && CHECKOUT.has(st) ? 'carritoVacio' : 'pagoNoAlcanzado');
        return;
      }
      const secs = r.navigationTimeMs / 1000;
      if (base && isHang(base, store.id, st, secs)) {
        anotar(runDir, store.id, st, 'cuelgue');
        const key = runDir + '|' + store.id + '|' + st;
        if (!seenHangs.has(key)) {
          seenHangs.add(key);
          droppedHangs.push({ store: store.id, stage: st, seconds: secs, dir: runDir });
        }
        return;
      }
      anotar(runDir, store.id, st, null);
      // First occurrence wins: the journey revisits some routes later in the flow and
      // we want the first (cold) hit of each stage.
      if (stages[st] === undefined) stages[st] = secs;
    });
  }
  return out;
}

/** Same, addressed by run id — resolved across the runs dir and the read-only archives. */
function readRun(runId, stores) {
  const dir = P.resolveRun(runId);
  return dir ? readRunDir(dir, stores) : {};
}

/** Legacy call shape: an explicit reports root plus a folder name underneath it. */
function readFolder(reportsDir, folder, stores) {
  return readRunDir(path.join(reportsDir, folder), stores);
}

/**
 * Failed-request rate for a capture, read from the audit JSON.
 *
 * Uses `harAnalysis.failedRequests` against `metrics.networkRequests`, which every
 * generation of the capture tool has recorded — unlike the `network/` dumps, which
 * only the recent runs produce. Same source for every date keeps the comparison fair.
 */
function failureRateFromRunDir(runDir) {
  const dir = path.join(runDir, 'json');
  if (!fs.existsSync(dir)) return null;
  let total = 0, failed = 0, pages = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(d.results) || d.results.length < 2) continue;
    for (const r of d.results) {
      total += (r.metrics && r.metrics.networkRequests) || 0;
      failed += (r.harAnalysis && r.harAnalysis.failedRequests) || 0;
      pages++;
    }
  }
  return total ? { total, failed, pages, pct: (failed / total) * 100 } : null;
}

function failureRateFromRun(runId) {
  const dir = P.resolveRun(runId);
  return dir ? failureRateFromRunDir(dir) : null;
}

function failureRateFromJson(reportsDir, folder) {
  return failureRateFromRunDir(path.join(reportsDir, folder));
}

function checkoutAvg(stages) {
  const vals = CHECKOUT_AVG_OF.map((k) => stages && stages[k]).filter((v) => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/** Mean of a stage across every store that has a value for it. */
function averageAcross(rows, key, index) {
  const vals = rows.map((r) => r[key] && r[key][index]).filter((v) => v != null && !Number.isNaN(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

module.exports = {
  STAGES, STAGES_FULL, ANALYSIS_ONLY, CHECKOUT_AVG_OF, COUNTRIES, COUNTRY_ORDER, folderLabel, folderShort,
  stageOf, readRunDir, readRun, readFolder, checkoutAvg, hangCeiling, droppedHangs, calidad,
  failureRateFromRunDir, failureRateFromRun, failureRateFromJson,
  averageAcross, matchStore, hostOfAudit,
};

// --- Day aggregation ---------------------------------------------------------
//
// The pipeline captures three times a day, and a comparison column is a DAY, not an
// execution. One reading is a sample of a noisy process: a slow CDN moment, a
// mid-morning promo, an unlucky garbage collection. Three readings averaged give a
// midpoint that can be trusted to describe the day, and — more usefully — a *spread*
// that says whether the three agreed.
//
// The spread is the part that validates the data. It is measured within one store, on
// one day, under one method: the only population where a difference can be read as
// something other than two different businesses or two different measuring regimes.

/** Runs belonging to one calendar day, oldest first, minus any excluded ids. */
function runsOfDay(ymd, { exclude = new Set() } = {}) {
  return P.listRuns()
    .filter((r) => r.ymd === String(ymd) && !exclude.has(r.id) && P.hasCaptures(r.dir))
    .map((r) => r.id);
}

/** Calendar days with at least one usable run, oldest first. */
function listDays({ exclude = new Set() } = {}) {
  const days = new Map();
  for (const r of P.listRuns()) {
    if (exclude.has(r.id) || !P.hasCaptures(r.dir)) continue;
    if (!days.has(r.ymd)) days.set(r.ymd, []);
    days.get(r.ymd).push(r.id);
  }
  return [...days.entries()]
    .map(([ymd, runs]) => ({ ymd, runs }))
    .sort((a, b) => a.ymd.localeCompare(b.ymd));
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }

function medianOf(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * One day's readings per store and stage, with everything needed to judge them.
 *
 * @returns { storeId: { stage: { value, n, min, max, spread, readings, runs } } }
 *   `spread` is (max − min) / value: the relative disagreement between the day's
 *   readings. It is 0 for a single reading, which is honest — one reading cannot
 *   disagree with itself, and that is exactly what makes it weaker evidence.
 */
function readDayDetail(ymd, stores, { exclude = new Set(), aggregate = 'mean' } = {}) {
  const runIds = runsOfDay(ymd, { exclude });
  const agg = aggregate === 'median' ? medianOf : mean;
  const acc = {};

  for (const runId of runIds) {
    const byStore = readRun(runId, stores);
    for (const [storeId, stages] of Object.entries(byStore)) {
      const store = acc[storeId] || (acc[storeId] = {});
      for (const [stage, v] of Object.entries(stages)) {
        if (v == null || Number.isNaN(v)) continue;
        (store[stage] || (store[stage] = [])).push({ runId, v });
      }
    }
  }

  const out = {};
  for (const [storeId, stages] of Object.entries(acc)) {
    out[storeId] = {};
    for (const [stage, samples] of Object.entries(stages)) {
      const xs = samples.map((s) => s.v);
      const value = agg(xs);
      const min = Math.min(...xs), max = Math.max(...xs);
      out[storeId][stage] = {
        value,
        n: xs.length,
        min,
        max,
        spread: value > 0 ? (max - min) / value : 0,
        readings: xs,
        runs: samples.map((s) => s.runId),
      };
    }
  }
  return out;
}

/** The same aggregation flattened to { storeId: { stage: seconds } }, as reports use. */
function readDay(ymd, stores, opts = {}) {
  const detail = readDayDetail(ymd, stores, opts);
  const out = {};
  for (const [storeId, stages] of Object.entries(detail)) {
    out[storeId] = {};
    for (const [stage, d] of Object.entries(stages)) out[storeId][stage] = d.value;
  }
  return out;
}

/** Failure rate for a whole day, pooling every run's requests. */
function failureRateFromDay(ymd, { exclude = new Set() } = {}) {
  let total = 0, failed = 0, pages = 0, runs = 0;
  for (const runId of runsOfDay(ymd, { exclude })) {
    const r = failureRateFromRun(runId);
    if (!r) continue;
    total += r.total; failed += r.failed; pages += r.pages; runs++;
  }
  return total ? { total, failed, pages, runs, pct: (failed / total) * 100 } : null;
}

module.exports.runsOfDay = runsOfDay;
module.exports.listDays = listDays;
module.exports.readDay = readDay;
module.exports.readDayDetail = readDayDetail;
module.exports.failureRateFromDay = failureRateFromDay;
