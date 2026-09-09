/**
 * render-csv.js — Per-store journey CSV, identical column layout to the 20260722
 * exports so historical and new runs can be concatenated without transformation.
 */

const CSV_HEADER = [
  'store', 'page_url', 'page_type', 'navigation_time_ms', 'timer_fired',
  'long_tasks_count', 'long_tasks_max_ms', 'long_tasks_avg_ms', 'long_tasks_p95_ms',
  'recalc_styles', 'forced_layouts', 'script_eval', 'function_calls', 'gc_events',
  'network_requests', 'third_party_requests', 'xhr_calls',
  'friction_total', 'friction_critical', 'friction_high', 'friction_medium',
].join(',');

function esc(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function renderPageCsv(store, audit, pageTypes) {
  const lines = [CSV_HEADER];
  audit.results.forEach((r, i) => {
    const m = r.metrics;
    const fps = r.frictionPoints;
    lines.push([
      store.domain,
      r.url,
      pageTypes[i] || 'other',
      r.navigationTimeMs,
      m.timerFired,
      m.longTasks.count, m.longTasks.maxMs, m.longTasks.avgMs, m.longTasks.p95Ms,
      m.layoutThrashing.recalcStyles, m.layoutThrashing.layouts,
      m.scriptEval, m.functionCalls, m.gcEvents,
      m.networkRequests, m.thirdPartyRequests, m.xhrCalls,
      fps.length,
      fps.filter((f) => f.severity === 'critical').length,
      fps.filter((f) => f.severity === 'high').length,
      fps.filter((f) => f.severity === 'medium').length,
    ].map(esc).join(','));
  });
  return lines.join('\n') + '\n';
}

module.exports = { renderPageCsv, CSV_HEADER };
