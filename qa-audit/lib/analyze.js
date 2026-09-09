/**
 * analyze.js — Turns raw per-page capture (trace metrics + request log) into the
 * result object consumed by the HTML/CSV renderers and by scripts/trend-report.js.
 *
 * Rule order, wording and thresholds mirror the historical reports so that a
 * 2026-08-11 audit is directly comparable with 2026-07-22 and 2026-08-05.
 */

const {
  THRESHOLDS, BUDGET, CATEGORY_LABELS, CATEGORY_ORDER,
  SCRIPT_RECOMMENDATIONS, hostOf, isFirstParty, categorizeUrl, rate, detectTags,
} = require('./catalog');
const { shortenScript } = require('./trace');

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

// --- Friction points --------------------------------------------------------

function buildFrictionPoints(m, ctx) {
  const fps = [];
  const lt = m.longTasks;
  const lth = m.layoutThrashing;

  // 1. Long task coun
  if (lt.count > THRESHOLDS.longTaskCount.poor) {
    fps.push({
      severity: 'critical', category: 'long-tasks',
      summary: `${lt.count} long tasks detected (>${THRESHOLDS.longTaskCount.poor} threshold)`,
      evidence: `Max: ${lt.maxMs}ms, Avg: ${lt.avgMs}ms, P95: ${lt.p95Ms}ms`,
      recommendation: 'Break up heavy synchronous work. Use requestIdleCallback or Web Workers for non-UI computation. Profile specific scripts causing long tasks.',
    });
  } else if (lt.count > THRESHOLDS.longTaskCount.good) {
    fps.push({
      severity: 'high', category: 'long-tasks',
      summary: `${lt.count} long tasks detected`,
      evidence: `Max: ${lt.maxMs}ms, Avg: ${lt.avgMs}ms`,
      recommendation: 'Identify and optimize the heaviest scripts. Consider code splitting or deferring non-critical work.',
    });
  }

  // 2. Worst single long task
  if (lt.maxMs > THRESHOLDS.worstLongTask.poor) {
    fps.push({
      severity: 'critical', category: 'long-tasks',
      summary: `Single task blocking main thread for ${lt.maxMs}ms`,
      evidence: `Any task >${THRESHOLDS.worstLongTask.poor}ms severely impacts INP and responsiveness`,
      recommendation: 'This is likely a heavy script evaluation or synchronous data processing. Identify via heaviestScripts and chunk the work.',
    });
  }

  // 3. Timer flood
  if (m.timerFired > THRESHOLDS.timerFired.poor) {
    fps.push({
      severity: 'critical', category: 'timer-flood',
      summary: `${m.timerFired} TimerFire events — extremely excessive timer activity`,
      evidence: `Threshold: ${THRESHOLDS.timerFired.poor}. Common in analytics/tracking SDKs with aggressive polling.`,
      recommendation: 'Audit setInterval/setTimeout usage. Analytics SDKs (Criteo, GTM tags, etc.) often create timer floods. Consider removing or throttling aggressive timers.',
    });
  } else if (m.timerFired > THRESHOLDS.timerFired.good) {
    fps.push({
      severity: 'high', category: 'timer-flood',
      summary: `${m.timerFired} TimerFire events — high timer activity`,
      evidence: `Threshold: ${THRESHOLDS.timerFired.good}`,
      recommendation: 'Review timer-heavy scripts. Consolidate polling intervals and debounce where possible.',
    });
  }

  // 4. Layout thrashing
  if (lth.recalcStyles > THRESHOLDS.styleRecalc.poor) {
    fps.push({
      severity: 'critical', category: 'layout-thrashing',
      summary: `${lth.recalcStyles} style recalculations + ${lth.layouts} forced layouts`,
      evidence: `Threshold: ${THRESHOLDS.styleRecalc.poor} recalcs. Indicates forced synchronous layout (read-write DOM loops).`,
      recommendation: 'Batch DOM reads before writes. Use transform/opacity for animations instead of layout-triggering properties. Look for loops that read offsetHeight then modify styles.',
    });
  } else if (lth.recalcStyles > THRESHOLDS.styleRecalc.good) {
    fps.push({
      severity: 'high', category: 'layout-thrashing',
      summary: `${lth.recalcStyles} style recalculations detected`,
      evidence: `Layouts: ${lth.layouts}`,
      recommendation: 'Minimize forced reflows. Use CSS containment and batch DOM mutations via DocumentFragment or requestAnimationFrame.',
    });
  }

  // 5. Third-party share
  const pct = ctx.thirdPartyPct;
  if (pct > THRESHOLDS.thirdPartyPct.poor) {
    const top = ctx.topDomains.slice(0, 4).map((d) => `${d.domain}(${d.requests})`).join(', ');
    fps.push({
      severity: 'critical', category: 'third-party',
      summary: `${pct}% of requests are third-party (${m.thirdPartyRequests}/${m.networkRequests})`,
      evidence: `Top: ${top}`,
      recommendation: 'Evaluate necessity of each third-party. Defer non-critical scripts. Use resource hints (preconnect) for essential ones. Consider removing low-value tracking pixels.',
    });
  } else if (pct > THRESHOLDS.thirdPartyPct.good) {
    fps.push({
      severity: 'high', category: 'third-party',
      summary: `${pct}% of requests are third-party`,
      evidence: `${m.thirdPartyRequests} third-party requests out of ${m.networkRequests} total`,
      recommendation: 'Audit third-party scripts for performance impact. Lazy-load non-essential ones after user interaction.',
    });
  }

  // 6. GC pressure
  if (m.gcEvents > THRESHOLDS.gcEvents.poor) {
    fps.push({
      severity: 'high', category: 'gc-pressure',
      summary: `${m.gcEvents} garbage collection events — high memory churn`,
      evidence: `Threshold: ${THRESHOLDS.gcEvents.poor}. Frequent GC pauses block the main thread.`,
      recommendation: 'Reduce short-lived object allocations. Reuse objects/arrays in hot loops. Pool DOM elements instead of creating/destroying.',
    });
  } else if (m.gcEvents > THRESHOLDS.gcEvents.good) {
    fps.push({
      severity: 'medium', category: 'gc-pressure',
      summary: `${m.gcEvents} GC events detected`,
      evidence: `Threshold: ${THRESHOLDS.gcEvents.good}`,
      recommendation: 'Monitor memory allocation patterns. Consider object pooling for frequently created/destroyed items.',
    });
  }

  // 7. Script evaluation
  if (m.scriptEval > THRESHOLDS.scriptEval.poor) {
    const heaviest = ctx.heaviestScripts.slice(0, 3).map((s) => `${s.script}(${s.totalMs}ms)`).join(', ');
    fps.push({
      severity: 'high', category: 'script-eval',
      summary: `${m.scriptEval} script evaluations — excessive JS parsing/compilation`,
      evidence: heaviest ? `Heaviest: ${heaviest}` : `Threshold: ${THRESHOLDS.scriptEval.poor}`,
      recommendation: 'Code-split and lazy-load non-critical bundles. Defer scripts that are not needed for initial render. Consider smaller alternatives for heavy libraries.',
    });
  } else if (m.scriptEval > THRESHOLDS.scriptEval.good) {
    fps.push({
      severity: 'medium', category: 'script-eval',
      summary: `${m.scriptEval} script evaluations`,
      evidence: `Threshold: ${THRESHOLDS.scriptEval.good}`,
      recommendation: 'Review bundle size and script loading strategy. Defer non-critical scripts.',
    });
  }

  // 8. Network bloa
  if (m.networkRequests > THRESHOLDS.totalRequests.poor) {
    fps.push({
      severity: 'high', category: 'network-bloat',
      summary: `${m.networkRequests} total network requests`,
      evidence: `Threshold: ${THRESHOLDS.totalRequests.poor}. High request count increases DNS/TCP overhead and contention.`,
      recommendation: 'Combine requests where possible. Use HTTP/2 multiplexing. Remove duplicate tracking pixels. Audit for redundant API calls.',
    });
  } else if (m.networkRequests > THRESHOLDS.totalRequests.good) {
    fps.push({
      severity: 'medium', category: 'network-bloat',
      summary: `${m.networkRequests} total network requests`,
      evidence: `Threshold: ${THRESHOLDS.totalRequests.good}`,
      recommendation: 'Consider request consolidation and lazy-loading of below-fold resources.',
    });
  }

  // Stable sort by severity — preserves the rule order within each tier.
  return fps
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity]) || (a.i - b.i))
    .map((x) => x.f);
}

// --- Performance budget -----------------------------------------------------

function buildPerformanceBudget(totalRequests) {
  const avgPayloadKB = BUDGET.avgPayloadKB;
  const maxPayload4G = Math.round(BUDGET.bandwidth4G_KBs * (BUDGET.maxResponseTimeMs - BUDGET.rtt4G_ms) / 1000);
  const maxPayload3G = Math.round(BUDGET.bandwidth3G_KBs * (BUDGET.maxResponseTimeMs - BUDGET.rtt3G_ms) / 1000);
  const timePerReq4G = Math.round((avgPayloadKB / BUDGET.bandwidth4G_KBs) * 1000 + BUDGET.rtt4G_ms);
  const timePerReq3G = Math.round((avgPayloadKB / BUDGET.bandwidth3G_KBs) * 1000 + BUDGET.rtt3G_ms);
  const maxFromWeight = Math.floor(BUDGET.pageWeightBudgetKB / avgPayloadKB);
  const maxFromTime4G = Math.floor((BUDGET.ttiBudgetMs * BUDGET.parallelism) / timePerReq4G);
  const maxFromTime3G = Math.floor((BUDGET.ttiBudgetMs * BUDGET.parallelism) / timePerReq3G);
  const max4G = Math.min(maxFromWeight, maxFromTime4G);
  const max3G = Math.min(maxFromWeight, maxFromTime3G);
  const bottleneck = (m, w) => (m === w ? 'page-weight' : 'response-time');
  const over4G = Math.max(0, totalRequests - max4G);
  const over3G = Math.max(0, totalRequests - max3G);
  const ok = over4G === 0 && over3G === 0;

  return {
    label: 'Performance Budget',
    rating: ok ? 'GOOD' : 'POOR',
    emoji: ok ? '🟢' : '🔴',
    actual: {
      totalRequests,
      estimatedPageWeightKB: totalRequests * avgPayloadKB,
      avgPayloadKB,
      estimatedRequestTimeMs: timePerReq4G,
      timePerReq4G_MS: timePerReq4G,
      timePerReq3G_MS: timePerReq3G,
    },
    budget: {
      maxResponseTimeMs: BUDGET.maxResponseTimeMs,
      pageWeightBudgetKB: BUDGET.pageWeightBudgetKB,
      jsCriticalBudgetKB: BUDGET.jsCriticalBudgetKB,
      ttiBudgetMs: BUDGET.ttiBudgetMs,
      parallelism: BUDGET.parallelism,
    },
    limits: {
      maxPayloadPerRequest4G_KB: maxPayload4G,
      maxPayloadPerRequest3G_KB: maxPayload3G,
      maxRequests4G: max4G,
      maxRequests3G: max3G,
      maxRequestsFromWeight: maxFromWeight,
      maxRequestsFromTime4G: maxFromTime4G,
      maxRequestsFromTime3G: maxFromTime3G,
      bottleneck4G: bottleneck(max4G, maxFromWeight),
      bottleneck3G: bottleneck(max3G, maxFromWeight),
    },
    verdict: {
      requestsOverBudget4G: over4G,
      requestsOverBudget3G: over3G,
      recommendation: ok
        ? 'Within budget on both 4G and 3G profiles.'
        : `Reduce ${over4G} requests (4G) / ${over3G} requests (3G). Limits: ≤${max4G} (4G, ${bottleneck(max4G, maxFromWeight)}-limited) / ≤${max3G} (3G, ${bottleneck(max3G, maxFromWeight)}-limited). Max ${maxPayload4G} KB/req (4G) or ${maxPayload3G} KB/req (3G) for <${BUDGET.maxResponseTimeMs}ms response.`,
    },
  };
}

// --- Severity ratings -------------------------------------------------------

function buildSeverityRatings(m, thirdPartyPct) {
  const mk = (key, value) => {
    const r = rate(key, value);
    return { value, rating: r.rating, emoji: r.emoji, label: THRESHOLDS[key].label, unit: THRESHOLDS[key].unit };
  };

  const ratings = {
    longTaskCount: mk('longTaskCount', m.longTasks.count),
    worstLongTask: mk('worstLongTask', m.longTasks.maxMs),
    timerFired: mk('timerFired', m.timerFired),
    styleRecalc: mk('styleRecalc', m.layoutThrashing.recalcStyles),
    gcEvents: mk('gcEvents', m.gcEvents),
    scriptEval: mk('scriptEval', m.scriptEval),
    totalRequests: mk('totalRequests', m.networkRequests),
    thirdPartyPct: mk('thirdPartyPct', thirdPartyPct),
  };

  ratings.performanceBudget = buildPerformanceBudget(m.networkRequests);

  const keys = Object.keys(THRESHOLDS);
  const poor = keys.filter((k) => ratings[k].rating === 'POOR').length;
  const needs = keys.filter((k) => ratings[k].rating === 'NEEDS_IMPROVEMENT').length;

  let overall;
  if (poor >= 2) {
    overall = { rating: 'CRITICAL', emoji: '🔴', label: 'Overall Performance', summary: 'Critical performance problems detected. Immediate action needed.' };
  } else if (poor >= 1 || needs >= 3) {
    overall = { rating: 'POOR', emoji: '🟠', label: 'Overall Performance', summary: 'Significant performance issues. Action recommended.' };
  } else if (needs >= 1) {
    overall = { rating: 'NEEDS_IMPROVEMENT', emoji: '🟡', label: 'Overall Performance', summary: 'Minor performance issues. Review recommended.' };
  } else {
    overall = { rating: 'GOOD', emoji: '🟢', label: 'Overall Performance', summary: 'Performance within acceptable thresholds.' };
  }
  ratings.overall = overall;
  return ratings;
}

// --- Bucket attribution -----------------------------------------------------

function buildBucketAttribution(blockers, m) {
  const fp = blockers.filter((b) => !b.isThirdParty);
  const tp = blockers.filter((b) => b.isThirdParty);
  const cpuFP = fp.reduce((a, b) => a + b.mainThreadMs, 0);
  const cpuTP = tp.reduce((a, b) => a + b.mainThreadMs, 0);
  const total = cpuFP + cpuTP;
  const pct = (v) => (total > 0 ? Math.round((v / total) * 100) : 0);

  const patterns = [];
  if (m.timerFired > THRESHOLDS.timerFired.good) {
    patterns.push({ pattern: 'setInterval|setTimeout', reason: `${m.timerFired} TimerFire events detected — look for aggressive polling` });
  }
  if (m.layoutThrashing.recalcStyles > THRESHOLDS.styleRecalc.good) {
    patterns.push({ pattern: 'offsetHeight|offsetWidth|getBoundingClientRect|getComputedStyle', reason: `${m.layoutThrashing.recalcStyles} style recalculations — look for read-write DOM loops` });
  }
  patterns.push({ pattern: 'content:\\s*url\\(', reason: 'CSS content:url() causes layout shifts (CLS). Use inline SVG or <img> instead.' });
  if (m.longTasks.maxMs > THRESHOLDS.worstLongTask.poor) {
    patterns.push({ pattern: 'MutationObserver|querySelectorAll', reason: `Worst long task: ${m.longTasks.maxMs}ms — look for heavy DOM queries in loops` });
  }

  return {
    A: {
      label: 'Frontend/Config (Controllable)',
      description: 'First-party code, CSS, polling loops, layout patterns. YOUR team can fix these.',
      cpuMs: cpuFP,
      cpuPct: pct(cpuFP),
      items: fp.map((b) => ({ script: b.script, ms: b.mainThreadMs, recommendation: b.recommendation })),
      codeSearchPatterns: patterns,
    },
    B: {
      label: 'Third-Party Scripts (Partially Controllable)',
      description: 'External scripts loaded by the page. Can be deferred, lazy-loaded, or removed.',
      cpuMs: cpuTP,
      cpuPct: pct(cpuTP),
      items: tp.map((b) => ({ script: b.script, ms: b.mainThreadMs, category: b.categoryLabel, recommendation: b.recommendation })),
    },
    C: {
      label: 'Infrastructure (Not Controllable)',
      description: 'CDN, TTFB, origin server. Requires platform-level changes.',
      note: 'TTFB and CDN issues are detected via HAR timing but require VTEX platform intervention.',
    },
  };
}

// --- Main entry point -------------------------------------------------------

/**
 * @param {object} page  { url, navigationTimeMs, storeHost, requests[], trace{}, error? }
 *   requests: [{ url, resourceType, failed, timingMs, fromCache }]
 */
function analyzePage(page) {
  const { metrics: traceMetrics, topLongTasks, heaviestScripts: rawScripts } = page.trace;
  const storeHost = page.storeHost;
  const requests = page.requests || [];

  // --- Network aggregation ---
  const domainCounts = new Map();
  let thirdPartyRequests = 0;
  let xhrCalls = 0;
  let failedRequests = 0;
  let totalTimeMs = 0;
  const categoryCounts = new Map();

  for (const r of requests) {
    const host = hostOf(r.url);
    if (!host) continue;
    const first = isFirstParty(r.url, storeHost);
    if (!domainCounts.has(host)) domainCounts.set(host, { domain: host, requests: 0, isThirdParty: !first, isNavigationDomain: host === storeHost });
    domainCounts.get(host).requests++;
    if (!first) {
      thirdPartyRequests++;
      const cat = categorizeUrl(r.url);
      categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
    }
    if (r.resourceType === 'xhr' || r.resourceType === 'fetch') xhrCalls++;
    if (r.failed) failedRequests++;
    totalTimeMs += r.timingMs || 0;
  }

  const metrics = {
    timerFired: traceMetrics.timerFired,
    longTasks: traceMetrics.longTasks,
    layoutThrashing: traceMetrics.layoutThrashing,
    scriptEval: traceMetrics.scriptEval,
    functionCalls: traceMetrics.functionCalls,
    gcEvents: traceMetrics.gcEvents,
    parseHTML: traceMetrics.parseHTML,
    paint: traceMetrics.paint,
    compositeLayers: traceMetrics.compositeLayers,
    networkRequests: requests.length,
    thirdPartyRequests,
    xhrCalls,
  };

  const thirdPartyPct = metrics.networkRequests > 0
    ? Math.round((thirdPartyRequests / metrics.networkRequests) * 100) : 0;

  const topDomains = [...domainCounts.values()].sort((a, b) => b.requests - a.requests).slice(0, 15);

  // --- Scripts & blockers ---
  const heaviestScripts = rawScripts.map((s) => ({
    script: shortenScript(s.fullUrl),
    fullUrl: s.fullUrl,
    totalMs: s.totalMs,
  }));

  const performanceBlockers = heaviestScripts.map((s) => {
    const first = isFirstParty(s.fullUrl, storeHost);
    const cat = first ? 'first-party' : categorizeUrl(s.fullUrl);
    const label = first ? 'First-Party (Your Code)' : CATEGORY_LABELS[cat];
    let severity = 'low';
    if (s.totalMs >= 500) severity = 'critical';
    else if (s.totalMs >= 100) severity = 'high';
    else if (s.totalMs >= 50) severity = 'medium';
    return {
      script: s.script,
      fullUrl: s.fullUrl,
      mainThreadMs: s.totalMs,
      domain: hostOf(s.fullUrl),
      isThirdParty: !first,
      category: cat,
      categoryLabel: label,
      severity,
      recommendation: SCRIPT_RECOMMENDATIONS[cat] || SCRIPT_RECOMMENDATIONS.other,
    };
  });

  // --- Third-party analysis by category ---
  const cpuByCategory = new Map();
  for (const b of performanceBlockers) {
    if (!b.isThirdParty) continue;
    cpuByCategory.set(b.category, (cpuByCategory.get(b.category) || 0) + b.mainThreadMs);
  }
  const domainsByCategory = new Map();
  for (const d of domainCounts.values()) {
    if (!d.isThirdParty) continue;
    const sample = requests.find((r) => hostOf(r.url) === d.domain);
    const cat = sample ? categorizeUrl(sample.url) : 'other';
    if (!domainsByCategory.has(cat)) domainsByCategory.set(cat, []);
    domainsByCategory.get(cat).push(d.domain);
  }

  const thirdPartyAnalysis = [...new Set([...categoryCounts.keys(), ...cpuByCategory.keys()])]
    .map((cat) => {
      const totalRequests = categoryCounts.get(cat) || 0;
      const estimatedCpuMs = Math.round(cpuByCategory.get(cat) || 0);
      let impact = 'low';
      if (estimatedCpuMs >= 300 || totalRequests >= 100) impact = 'high';
      else if (estimatedCpuMs >= 100 || totalRequests >= 30) impact = 'medium';
      return {
        category: cat,
        label: CATEGORY_LABELS[cat],
        domains: domainsByCategory.get(cat) || [],
        totalRequests,
        estimatedCpuMs,
        impact,
      };
    })
    .sort((a, b) => b.totalRequests - a.totalRequests);

  // --- Tag ownership ---
  const tagOwnership = detectTags(requests.map((r) => r.url))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    .map((t) => ({ name: t.name, category: t.category, idLabel: t.idLabel, id: t.id, sampleUrl: t.sampleUrl, requests: t.requests }));

  const ctx = { thirdPartyPct, topDomains, heaviestScripts };
  const frictionPoints = page.error
    ? [{
        severity: 'critical', category: 'navigation-error',
        summary: `Failed to load: ${page.error}`,
        evidence: page.error,
        recommendation: 'Check URL accessibility and authentication state',
      }]
    : buildFrictionPoints(metrics, ctx);

  const vtexRequests = requests.filter((r) => /vtex/i.test(hostOf(r.url))).length;

  return {
    url: page.url,
    navigationTimeMs: page.navigationTimeMs,
    metrics,
    frictionPoints,
    severityRatings: buildSeverityRatings(metrics, thirdPartyPct),
    bucketAttribution: buildBucketAttribution(performanceBlockers, metrics),
    thirdPartyAnalysis,
    performanceBlockers,
    tagOwnership,
    harAnalysis: {
      totalRequests: requests.length,
      failedRequests,
      totalTimeMs: Math.round(totalTimeMs),
      vtex: {
        requests: vtexRequests,
        totalMs: 0,
        pctOfTotal: requests.length ? Math.round((vtexRequests / requests.length) * 100) : 0,
      },
      thirdParty: {
        requests: thirdPartyRequests,
        totalMs: 0,
        pctOfTotal: thirdPartyPct,
      },
      topDomains: topDomains.slice(0, 10),
      categories: thirdPartyAnalysis.map((c) => ({ category: c.category, requests: c.totalRequests })),
    },
    topDomains,
    topLongTasks,
    heaviestScripts,
  };
}

function summarize(results) {
  let total = 0, critical = 0, high = 0, medium = 0;
  let topIssue = '—';
  let worstSeverity = 99;
  for (const r of results) {
    for (const f of r.frictionPoints) {
      total++;
      if (f.severity === 'critical') critical++;
      else if (f.severity === 'high') high++;
      else if (f.severity === 'medium') medium++;
      if (SEVERITY_RANK[f.severity] < worstSeverity) { worstSeverity = SEVERITY_RANK[f.severity]; topIssue = f.summary; }
    }
  }
  return { totalFrictionPoints: total, criticalCount: critical, highCount: high, mediumCount: medium, topIssue };
}

module.exports = { analyzePage, summarize, CATEGORY_ORDER };
