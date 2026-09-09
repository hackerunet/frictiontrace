/**
 * catalog.js — Shared knowledge base for the CAM performance audit.
 *
 * Every threshold, category label, recommendation string and tag pattern here was
 * derived from the historical audits in reportesaproducir/ (20260714 … 20260805) so
 * that newly generated reports are scored with exactly the same criteria as the
 * existing ones. Do not "improve" the numbers without regenerating history.
 */

// --- Severity thresholds (derived empirically from 460 historical page audits) ---
// good: value <= good | needs_improvement: good < value <= poor | poor: value > poor
const THRESHOLDS = {
  longTaskCount: { good: 10, poor: 50, label: 'Long Tasks Count', unit: 'tasks' },
  worstLongTask: { good: 100, poor: 500, label: 'Worst Long Task', unit: 'ms' },
  timerFired: { good: 500, poor: 2000, label: 'Timer Fire Events', unit: 'events' },
  styleRecalc: { good: 200, poor: 800, label: 'Style Recalculations', unit: 'events' },
  gcEvents: { good: 10, poor: 30, label: 'Garbage Collection', unit: 'events' },
  scriptEval: { good: 50, poor: 150, label: 'Script Evaluations', unit: 'evals' },
  totalRequests: { good: 150, poor: 300, label: 'Network Requests', unit: 'requests' },
  thirdPartyPct: { good: 30, poor: 60, label: 'Third-Party Request %', unit: '%' },
};

// --- Performance budget constants (see "Metodología" section of the report) ---
const BUDGET = {
  maxResponseTimeMs: 200,
  pageWeightBudgetKB: 1500,
  jsCriticalBudgetKB: 170,
  ttiBudgetMs: 5000,
  parallelism: 6,
  bandwidth4G_KBs: 1600,
  bandwidth3G_KBs: 200,
  rtt4G_ms: 50,
  rtt3G_ms: 150,
  avgPayloadKB: 31, // HTTP Archive 2024 median, used as fallback
};

// --- Third-party categories -------------------------------------------------
const CATEGORY_LABELS = {
  ads: 'Advertising',
  analytics: 'Analytics & Tracking',
  social: 'Social Media & Pixels',
  cdn: 'CDN / Fonts / Media',
  captcha: 'Security / CAPTCHA',
  other: 'Other Third-Party',
};

const CATEGORY_EMOJI = {
  ads: '📺',
  analytics: '📊',
  social: '📱',
  cdn: '☁️',
  captcha: '🔒',
  other: '🔗',
};

const CATEGORY_ORDER = ['ads', 'other', 'social', 'analytics', 'cdn', 'captcha'];

const SCRIPT_RECOMMENDATIONS = {
  'first-party': 'Code-split this bundle. Defer non-critical modules. Consider Web Workers for heavy computation.',
  captcha: 'Load CAPTCHA scripts only on pages that need them (forms, checkout). Use lazy/invisible mode where possible.',
  cdn: 'Evaluate if this script is necessary. Consider deferring or removing it.',
  ads: 'Consider lazy-loading ad scripts after user interaction or below-the-fold visibility. Use async/defer attributes.',
  social: 'Defer social pixels until after first user interaction. Use facade patterns for embedded widgets.',
  analytics: 'Load analytics asynchronously. Defer non-essential tracking until after page interactive. Evaluate if all tags are still needed.',
  other: 'Evaluate if this script is necessary. Consider deferring or removing it.',
};

/**
 * VTEX-owned infrastructure is treated as FIRST-party: it is the platform serving
 * the storefront, not an external tag. This matches how `topDomains.isThirdParty`
 * was computed in the historical reports (walmartcr.vtexassets.com → first-party).
 */
const VTEX_HOST_PATTERNS = [
  /\.vtexassets\.com$/,
  /\.vteximg\.com\.br$/,
  /\.myvtex\.com$/,
  /(^|\.)vtex\.com$/,
  /(^|\.)vtex\.com\.br$/,
  /(^|\.)vtexpayments\.com\.br$/,
  /(^|\.)vtexcommercestable\.com\.br$/,
];

/** Ordered rules: first match wins. */
const DOMAIN_CATEGORY_RULES = [
  // Security / CAPTCHA is matched on the full URL before the CDN rules, because
  // reCAPTCHA is served from www.google.com and www.gstatic.com.
  { cat: 'captcha', url: /\/recaptcha\// },
  { cat: 'captcha', host: /^(www\.)?recaptcha\.net$/ },

  { cat: 'ads', host: /(^|\.)doubleclick\.net$/ },
  { cat: 'ads', host: /(^|\.)googlesyndication\.com$/ },
  { cat: 'ads', host: /^adservice\.google\./ },
  { cat: 'ads', host: /(^|\.)criteo\.(com|net)$/ },
  { cat: 'ads', host: /(^|\.)adnxs\.com$/ },
  { cat: 'ads', host: /(^|\.)pubmatic\.com$/ },
  { cat: 'ads', host: /(^|\.)rubiconproject\.com$/ },
  { cat: 'ads', host: /(^|\.)openx\.net$/ },
  { cat: 'ads', host: /(^|\.)adtrafficquality\.google$/ },
  { cat: 'ads', host: /^www\.googletagservices\.com$/ },
  { cat: 'ads', host: /^www\.googleadservices\.com$/ },

  { cat: 'analytics', host: /^www\.googletagmanager\.com$/ },
  { cat: 'analytics', host: /(^|\.)google-analytics\.com$/ },
  { cat: 'analytics', host: /^analytics\.google\.com$/ },
  { cat: 'analytics', host: /(^|\.)hotjar\.(com|io)$/ },
  { cat: 'analytics', host: /(^|\.)clarity\.ms$/ },
  { cat: 'analytics', host: /(^|\.)newrelic\.com$/ },

  { cat: 'social', host: /(^|\.)facebook\.(net|com)$/ },
  { cat: 'social', host: /(^|\.)tiktok\.com$/ },
  { cat: 'social', host: /(^|\.)tiktokw\.us$/ },
  { cat: 'social', host: /(^|\.)pinterest\.com$/ },
  { cat: 'social', host: /(^|\.)pinimg\.com$/ },
  { cat: 'social', host: /(^|\.)linkedin\.com$/ },
  { cat: 'social', host: /(^|\.)twitter\.com$/ },

  { cat: 'cdn', host: /(^|\.)gstatic\.com$/ },
  { cat: 'cdn', host: /^fonts\.googleapis\.com$/ },
  { cat: 'cdn', host: /^maps\.googleapis\.com$/ },
  { cat: 'cdn', host: /(^|\.)jsdelivr\.net$/ },
  { cat: 'cdn', host: /(^|\.)cdnjs\.cloudflare\.com$/ },
  { cat: 'cdn', host: /(^|\.)unpkg\.com$/ },
  { cat: 'cdn', host: /^storage\.googleapis\.com$/ },
  { cat: 'cdn', host: /(^|\.)cdnfonts\.com$/ },
  { cat: 'cdn', host: /(^|\.)onlinewebfonts\.com$/ },
];

/**
 * Tag & pixel ownership detectors. Each returns { name, category, idLabel, id }
 * or null. Order matters only for readability — ids are deduplicated downstream.
 */
const TAG_DETECTORS = [
  {
    name: 'Google Tag Manager', category: 'Analytics & Tracking', idLabel: 'Container ID',
    match: (u) => /googletagmanager\.com\/gtm\.js/.test(u) && param(u, 'id'),
  },
  {
    name: 'Google Analytics 4', category: 'Analytics & Tracking', idLabel: 'Measurement ID',
    match: (u) => /googletagmanager\.com\/gtag\/js/.test(u) && startsWith(param(u, 'id'), 'G-'),
  },
  {
    name: 'Google Ads Conversion', category: 'Advertising', idLabel: 'Conversion ID',
    match: (u) => /googletagmanager\.com\/gtag\//.test(u) && startsWith(param(u, 'id'), 'AW-'),
  },
  {
    name: 'DoubleClick Floodlight', category: 'Advertising', idLabel: 'Config ID',
    match: (u) => /googletagmanager\.com\/gtag\//.test(u) && startsWith(param(u, 'id'), 'DC-'),
  },
  {
    name: 'DoubleClick Counter', category: 'Advertising', idLabel: 'Floodlight ID',
    match: (u) => (u.match(/^https?:\/\/(\d+)\.fls\.doubleclick\.net\//) || [])[1] || null,
  },
  {
    name: 'Google Publisher Tag', category: 'Advertising', idLabel: 'GPT',
    match: (u) => /securepubads\.g\.doubleclick\.net\/(tag\/js\/gpt|pagead\/managed\/js\/gpt)/.test(u)
      ? 'GPT (Google Publisher Tag)' : null,
  },
  {
    name: 'Facebook Pixel', category: 'Social Media & Pixels', idLabel: 'Pixel ID',
    match: (u) => (u.match(/connect\.facebook\.net\/signals\/config\/(\d+)/) || [])[1]
      || (u.match(/facebook\.com\/tr\/?\?[^#]*\bid=(\d+)/) || [])[1] || null,
  },
  {
    name: 'TikTok Pixel', category: 'Social Media & Pixels', idLabel: 'SDK ID',
    match: (u) => param(u, 'sdkid')
      || (u.match(/analytics\.tiktok\.com\/i18n\/pixel\/static\/main\.([A-Za-z0-9_-]+)\.js/) || [])[1] || null,
  },
  {
    name: 'Google reCAPTCHA', category: 'Security / CAPTCHA', idLabel: 'Site Key',
    match: (u) => (/\/recaptcha\//.test(u) ? (param(u, 'k') || param(u, 'render')) : null),
  },
  {
    name: 'Cookiebot', category: 'Consent Management', idLabel: 'Domain Group ID',
    match: (u) => {
      if (!/cookiebot\.com/.test(u)) return null;
      const cbid = param(u, 'cbid');
      return cbid ? decodeURIComponent(cbid).replace(/[{}]/g, '') : null;
    },
  },
  {
    name: 'Google Maps', category: 'CDN / Fonts / Media', idLabel: 'API Key',
    match: (u) => (/maps\.googleapis\.com\/maps\/api/.test(u) ? param(u, 'key') : null),
  },
  {
    name: 'Criteo', category: 'Advertising', idLabel: 'Subdomain',
    match: (u) => {
      const m = u.match(/^https?:\/\/(?:[a-z0-9]+\.)*?([a-z0-9]+)\.criteo\.(?:com|net)\//);
      return m ? m[1] : null;
    },
  },
];

function param(url, name) {
  const m = url.match(new RegExp('[?&;]' + name + '=([^&;#]+)'));
  return m ? m[1] : null;
}

function startsWith(value, prefix) {
  return value && value.startsWith(prefix) ? value : null;
}

// --- Public helpers ---------------------------------------------------------

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** First-party = the storefront host itself, its bare/apex form, or VTEX infra. */
function isFirstParty(url, storeHost) {
  const host = hostOf(url);
  if (!host) return true;
  if (!storeHost) return false;
  const apex = storeHost.replace(/^www\./, '');
  if (host === storeHost || host === apex || host.endsWith('.' + apex)) return true;
  return VTEX_HOST_PATTERNS.some((re) => re.test(host));
}

function categorizeUrl(url) {
  const host = hostOf(url);
  for (const rule of DOMAIN_CATEGORY_RULES) {
    if (rule.url && rule.url.test(url)) return rule.cat;
    if (rule.host && rule.host.test(host)) return rule.cat;
  }
  return 'other';
}

function rate(metric, value) {
  const t = THRESHOLDS[metric];
  if (!t) return { rating: 'GOOD', emoji: '🟢' };
  if (value <= t.good) return { rating: 'GOOD', emoji: '🟢' };
  if (value <= t.poor) return { rating: 'NEEDS_IMPROVEMENT', emoji: '🟡' };
  return { rating: 'POOR', emoji: '🔴' };
}

function detectTags(urls) {
  const found = new Map(); // key -> tag
  for (const url of urls) {
    for (const det of TAG_DETECTORS) {
      let id = null;
      try { id = det.match(url); } catch { id = null; }
      if (!id) continue;
      const key = det.name + '|' + id;
      if (!found.has(key)) {
        found.set(key, {
          name: det.name,
          category: det.category,
          idLabel: det.idLabel,
          id: String(id),
          sampleUrl: url,
          requests: 0,
        });
      }
      found.get(key).requests++;
    }
  }
  return [...found.values()];
}

module.exports = {
  THRESHOLDS,
  BUDGET,
  CATEGORY_LABELS,
  CATEGORY_EMOJI,
  CATEGORY_ORDER,
  SCRIPT_RECOMMENDATIONS,
  hostOf,
  isFirstParty,
  categorizeUrl,
  rate,
  detectTags,
};
