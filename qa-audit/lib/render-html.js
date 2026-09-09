/**
 * render-html.js — Per-store audit report.
 *
 * Reproduces the exact section order, table columns, CSS and chart configuration
 * of the reports under reportesaproducir/20260722/html/, so a report generated
 * today can be diffed section-by-section against a July one.
 */

const { BUDGET, CATEGORY_EMOJI, CATEGORY_LABELS, hostOf } = require('./catalog');

const CSS = `*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#333;background:#f0f2f5;padding:20px}
.wrap{max-width:1200px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.15);overflow:hidden}
h1{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:28px 35px;font-size:1.8em;margin:0}
h1+p{background:#f8f9fa;padding:14px 35px;border-bottom:1px solid #e0e0e0;color:#555;font-size:.95em;margin:0}
.content{padding:25px 35px 35px}
h2{font-size:1.4em;color:#667eea;margin:28px 0 14px;padding-bottom:6px;border-bottom:2px solid #eee}
h3{font-size:1.1em;color:#444;margin:20px 0 10px}
table{width:100%;border-collapse:collapse;margin:12px 0 22px;font-size:.9em;border-radius:6px;overflow:hidden}
th{background:#667eea;color:#fff;padding:11px 14px;text-align:left}
td{padding:10px 14px;border-bottom:1px solid #e9ecef}
tr:nth-child(even){background:#f8f9fa}
tr:hover{background:#eef1f7}
.row-overall{background:#f0f0f0}
.val-good{color:#28a745;font-weight:700}
.val-needs{color:#e6a817;font-weight:700}
.val-poor{color:#dc3545;font-weight:700}
.val-critical{color:#dc3545;font-weight:700}
.val-high{color:#fd7e14;font-weight:700}
.val-medium{color:#e6a817;font-weight:700}
.script-name{font-family:'Courier New',monospace;font-size:.85em;word-break:break-all}
.badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:.8em;font-weight:600}
.badge-critical{background:#f8d7da;color:#721c24}
.badge-high{background:#fff3cd;color:#856404}
.badge-medium{background:#d4edda;color:#155724}
.badge-low{background:#e2e3e5;color:#383d41}
.pill-fp{display:inline-block;padding:2px 10px;border-radius:12px;font-size:.75em;font-weight:700;background:#dc3545;color:#fff}
.pill-tp{display:inline-block;padding:2px 10px;border-radius:12px;font-size:.75em;font-weight:700;background:#fd7e14;color:#fff}
code{background:#f0f0f0;padding:2px 6px;border-radius:4px;font-size:.88em}
ol,ul{margin:10px 0 18px 28px}
li{margin-bottom:4px}
hr{border:none;border-top:1px solid #e0e0e0;margin:24px 0}
p{margin:6px 0}
strong{color:#333}
.blocker-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:15px;margin:15px 0}
.blocker-card{border-radius:8px;padding:15px;border:1px solid #e0e0e0}
.blocker-fp{border-left:4px solid #dc3545;background:#fff5f5}
.blocker-tp{border-left:4px solid #fd7e14;background:#fff8f0}
.blocker-card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.blocker-total{font-size:.85em;color:#666;background:#f0f0f0;padding:2px 8px;border-radius:10px}
.blocker-list{list-style:none;margin:0;padding:0}
.blocker-list li{padding:5px 0;border-bottom:1px solid #f0f0f0;display:flex;justify-content:space-between;align-items:center;font-size:.88em}
.blocker-list li:last-child{border-bottom:none}
.chart-container{position:relative;height:400px;margin:15px 0 30px;padding:20px;background:#f8f9fa;border-radius:8px;overflow:hidden}
footer{text-align:center;padding:18px 35px;color:#999;font-size:.8em;border-top:1px solid #eee;margin-top:10px}`;

const TAG_CATEGORY_COLOR = {
  'Advertising': '#dc3545',
  'Analytics & Tracking': '#6f42c1',
  'Social Media & Pixels': '#0d6efd',
  'CDN / Fonts / Media': '#6c757d',
  'Security / CAPTCHA': '#198754',
  'Consent Management': '#198754',
};

/** Script-URL matcher used to attribute main-thread CPU to a tag. */
const TAG_SCRIPT_MATCHERS = {
  'Google Tag Manager': /googletagmanager\.com\/gtm\.js/,
  'Google Analytics 4': /googletagmanager\.com\/gtag\/|google-analytics\.com/,
  'Google Publisher Tag': /securepubads\.g\.doubleclick\.net\/(tag\/js\/gpt|pagead\/managed\/js\/gpt)/,
  'Facebook Pixel': /connect\.facebook\.net/,
  'TikTok Pixel': /analytics\.tiktok\.com/,
  'Google reCAPTCHA': /\/recaptcha\//,
  'Cookiebot': /cookiebot\.com/,
  'Google Maps': /maps\.googleapis\.com/,
  'Criteo': /criteo\.(com|net)/,
};

const RATING_CLASS = { GOOD: 'val-good', NEEDS_IMPROVEMENT: 'val-needs', POOR: 'val-poor', CRITICAL: 'val-poor' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Page label used in headings, the timeline chart and the budget table.
 * Query strings are dropped — the July reports label the search step `/pollo`
 * and the VTEX ID step `/account/login`, keeping only pathname + hash.
 */
function pathOf(url) {
  try {
    const u = new URL(url);
    return (u.pathname + u.hash) || '/';
  } catch { return url; }
}

function fmtEsDate(iso) {
  return new Date(iso).toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
}

// --- Section builders -------------------------------------------------------

function execSummarySection(audit) {
  const s = audit.summary;
  const overall = audit.results[0]?.severityRatings?.overall || { emoji: '⚪', rating: 'N/A' };
  return `<h2>Executive Summary</h2><table><tr><th>Metric</th><th>Value</th></tr>` +
    `<tr><td>Total Friction Points</td><td><strong>${s.totalFrictionPoints}</strong></td></tr>` +
    `<tr><td>Critical</td><td class="val-critical">${s.criticalCount}</td></tr>` +
    `<tr><td>High</td><td class="val-high">${s.highCount}</td></tr>` +
    `<tr><td>Medium</td><td class="val-medium">${s.mediumCount}</td></tr>` +
    `<tr><td>Top Issue</td><td>${esc(s.topIssue)}</td></tr>` +
    `<tr><td>Overall Verdict</td><td><strong>${overall.emoji} ${overall.rating}</strong></td></tr>` +
    `</table>`;
}

function consolidatedTags(audit) {
  const agg = new Map();
  const cpuByTag = new Map();

  for (const r of audit.results) {
    for (const t of r.tagOwnership || []) {
      const key = t.name + '|' + t.id;
      if (!agg.has(key)) agg.set(key, { ...t, requests: 0 });
      agg.get(key).requests += t.requests || 0;
    }
    for (const [name, re] of Object.entries(TAG_SCRIPT_MATCHERS)) {
      for (const b of r.performanceBlockers || []) {
        if (re.test(b.fullUrl)) cpuByTag.set(name, (cpuByTag.get(name) || 0) + b.mainThreadMs);
      }
    }
  }

  const rows = [...agg.values()].sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));
  let html = `<hr><h2>🏷️ Tag &amp; Pixel Ownership (Consolidado)</h2><table>` +
    `<tr><th>Tag/Pixel</th><th>Category</th><th>ID</th><th>Total Requests</th><th>CPU Impact</th></tr>`;
  for (const t of rows) {
    const cpu = Math.round(cpuByTag.get(t.name) || 0);
    const color = TAG_CATEGORY_COLOR[t.category] || '#6c757d';
    const cpuCell = cpu > 0
      ? `<td class="val-poor">${cpu}ms</td>`
      : `<td class="val-good">—</td>`;
    html += `<tr><td><strong>${esc(t.name)}</strong></td>` +
      `<td><span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:.75em;font-weight:700;background:${color};color:#fff">${esc(t.category)}</span></td>` +
      `<td><code>${esc(t.id)}</code></td><td><strong>${t.requests}</strong></td>${cpuCell}</tr>`;
  }
  return html + `</table>`;
}

function navigationTimeline(audit) {
  const labels = audit.results.map((r) => pathOf(r.url));
  const secs = audit.results.map((r) => Number((r.navigationTimeMs / 1000).toFixed(1)));
  const colors = secs.map((s) => (s <= 2.5 ? '#28a745' : s <= 5 ? '#e6a817' : '#dc3545'));
  return `<hr><h2>📈 Navigation Timeline</h2><div class="chart-container"><canvas id="navChart"></canvas></div>` +
    `<script src="https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js"></script>` +
    `<script>
new Chart(document.getElementById('navChart'), {
  type: 'line',
  data: {
    labels: ${JSON.stringify(labels)},
    datasets: [{
      label: 'Load Time (s)',
      data: ${JSON.stringify(secs)},
      borderColor: '#667eea',
      backgroundColor: 'rgba(102,126,234,0.1)',
      fill: true,
      tension: 0.3,
      pointBackgroundColor: ${JSON.stringify(colors)},
      pointRadius: 6,
      pointHoverRadius: 8,
    }, {
      label: 'Baseline 2.5s (Core Web Vitals - Good)',
      data: ${JSON.stringify(secs.map(() => 2.5))},
      borderColor: '#28a745',
      borderDash: [10, 5],
      borderWidth: 3,
      pointRadius: 0,
      fill: false,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: 'bottom', labels: { padding: 20, font: { size: 13 } } } },
    scales: {
      y: { beginAtZero: true, title: { display: true, text: 'Seconds' }, grid: { color: '#e0e0e0' } },
      x: { ticks: { maxRotation: 45, font: { size: 11 } } }
    }
  }
});
</script>`;
}

function performanceBudgetSection(audit) {
  let html = `<hr><h2>📐 Performance Budget (Web Vitals)</h2>` +
    `<p><strong>Fórmula:</strong> <code>maxPayload/request = bandwidth × (maxResponseTime - RTT)</code><br>` +
    `<strong>Referencia:</strong> INP &lt; 200ms | Page Weight &lt; 1,500 KB | JS Critical &lt; 170 KB</p><table>` +
    `<tr><th>Page</th><th>Requests</th><th>Max Requests (4G)</th><th>Max Requests (3G)</th>` +
    `<th>Max Payload/Req (4G)</th><th>Max Payload/Req (3G)</th><th>Status</th></tr>`;

  let worst = null;
  for (const r of audit.results) {
    const b = r.severityRatings.performanceBudget;
    const l = b.limits, v = b.verdict;
    if (!worst || v.requestsOverBudget4G > worst.verdict.requestsOverBudget4G) worst = b;
    const cls = v.requestsOverBudget4G > 0 ? 'val-poor' : 'val-good';
    const s4 = v.requestsOverBudget4G > 0 ? `🔴 ${v.requestsOverBudget4G} over` : '🟢 OK';
    const s3 = v.requestsOverBudget3G > 0 ? `🔴 ${v.requestsOverBudget3G} over` : '🟢 OK';
    html += `<tr><td>${esc(pathOf(r.url))}</td><td><strong>${r.metrics.networkRequests}</strong></td>` +
      `<td>${l.maxRequests4G} <small>(${l.bottleneck4G})</small></td>` +
      `<td>${l.maxRequests3G} <small>(${l.bottleneck3G})</small></td>` +
      `<td>${l.maxPayloadPerRequest4G_KB} KB</td><td>${l.maxPayloadPerRequest3G_KB} KB</td>` +
      `<td class="${cls}">${s4} / ${s3}</td></tr>`;
  }
  html += `</table><p><strong>Veredicto:</strong> ${esc(worst ? worst.verdict.recommendation : '—')}</p>`;
  return html;
}

function bucketSection(audit) {
  const first = audit.results[0];
  if (!first) return '';
  const ba = first.bucketAttribution;
  let html = `<hr><h2>Bucket Attribution: <code>${esc(pathOf(first.url))}</code></h2>`;

  html += `<h3>🔴 Bucket A — Frontend/Config (Controllable)</h3>` +
    `<p>Your team can fix these. ~<strong>${ba.A.cpuPct}%</strong> of CPU time.</p>`;
  if (ba.A.items.length) {
    html += `<table><tr><th>Script</th><th>Main Thread (ms)</th><th>Recommendation</th></tr>`;
    for (const it of ba.A.items) {
      html += `<tr><td class="script-name">${esc(it.script)}</td><td>${it.ms}ms</td><td>${esc(it.recommendation)}</td></tr>`;
    }
    html += `</table>`;
  } else {
    html += `<p>No first-party scripts exceeded the attribution threshold on this page.</p>`;
  }
  html += `<p><strong>Code patterns to search:</strong></p><ul>`;
  for (const p of ba.A.codeSearchPatterns) {
    html += `<li><code>${esc(p.pattern)}</code> → ${esc(p.reason)}</li>`;
  }
  html += `</ul>`;

  html += `<h3>🟠 Bucket B — Third-Party Scripts (Partially Controllable)</h3>` +
    `<p>~<strong>${ba.B.cpuPct}%</strong> of CPU time.</p>`;
  if (ba.B.items.length) {
    html += `<table><tr><th>Script</th><th>Main Thread (ms)</th><th>Category</th><th>Recommendation</th></tr>`;
    for (const it of ba.B.items) {
      html += `<tr><td class="script-name">${esc(it.script)}</td><td>${it.ms}ms</td><td>${esc(it.category)}</td><td>${esc(it.recommendation)}</td></tr>`;
    }
    html += `</table>`;
  }

  html += `<h3>⚪ Bucket C — Infrastructure (Not Controllable)</h3>` +
    `<p>CDN, TTFB, origin server. Requires platform intervention.</p>`;
  return html;
}

function thirdPartyAllPages(audit) {
  const byCat = new Map();
  for (const r of audit.results) {
    const label = pathOf(r.url);
    for (const c of r.thirdPartyAnalysis || []) {
      if (!byCat.has(c.category)) byCat.set(c.category, { category: c.category, label: c.label, requests: 0, cpu: 0, domains: new Set(), pages: [] });
      const e = byCat.get(c.category);
      e.requests += c.totalRequests;
      e.cpu += c.estimatedCpuMs;
      for (const d of c.domains) e.domains.add(d);
      e.pages.push(`${label} (${c.totalRequests})`);
    }
  }
  const rows = [...byCat.values()].sort((a, b) => b.requests - a.requests);
  let html = `<hr><h2>🌐 Third-Party Analysis by Category (All Pages)</h2><table>` +
    `<tr><th>Category</th><th>Total Requests</th><th>CPU (ms)</th><th>Impact</th><th>Domains</th><th>Pages Breakdown</th></tr>`;
  for (const c of rows) {
    const impact = c.cpu >= 1000 || c.requests >= 300 ? 'HIGH' : c.cpu >= 300 || c.requests >= 100 ? 'MEDIUM' : 'LOW';
    const badge = impact === 'HIGH' ? 'badge-high' : impact === 'MEDIUM' ? 'badge-medium' : 'badge-low';
    html += `<tr><td>${CATEGORY_EMOJI[c.category] || '🔗'} ${esc(c.label)}</td>` +
      `<td><strong>${c.requests}</strong></td><td>~${Math.round(c.cpu)}ms</td>` +
      `<td><span class="badge ${badge}">${impact}</span></td>` +
      `<td class="script-name">${esc([...c.domains].join(', '))}</td>` +
      `<td>${esc(c.pages.join(', '))}</td></tr>`;
  }
  return html + `</table>`;
}

function pageDetail(r) {
  const m = r.metrics;
  let html = `<h3>📄 ${esc(pathOf(r.url))}</h3>` +
    `<p><strong>Requests:</strong> ${m.networkRequests} | <strong>Third-Party:</strong> ${m.thirdPartyRequests} | ` +
    `<strong>Long Tasks:</strong> ${m.longTasks.count} (max ${m.longTasks.maxMs}ms) | <strong>Timers:</strong> ${m.timerFired}</p>`;

  // Severity ratings
  html += `<details open><summary><strong>Severity Ratings</strong></summary><table>` +
    `<tr><th>Metric</th><th>Value</th><th>Rating</th></tr>`;
  for (const key of ['longTaskCount', 'worstLongTask', 'timerFired', 'styleRecalc', 'gcEvents', 'scriptEval', 'totalRequests', 'thirdPartyPct']) {
    const x = r.severityRatings[key];
    if (!x) continue;
    const unit = x.unit === '%' ? '%' : ' ' + x.unit;
    html += `<tr><td>${esc(x.label)}</td><td><strong>${x.value}${unit}</strong></td>` +
      `<td class="${RATING_CLASS[x.rating]}">${x.emoji} ${x.rating}</td></tr>`;
  }
  const ov = r.severityRatings.overall;
  html += `<tr class="row-overall"><td><strong>Overall</strong></td><td>—</td>` +
    `<td class="${RATING_CLASS[ov.rating]}"><strong>${ov.emoji} ${ov.rating}</strong></td></tr></table></details>`;

  // Tags on this page
  if ((r.tagOwnership || []).length) {
    html += `<table><tr><th>Tag</th><th>ID</th><th>Requests</th><th>CPU</th></tr>`;
    for (const t of r.tagOwnership) {
      let cpu = 0;
      const re = TAG_SCRIPT_MATCHERS[t.name];
      if (re) for (const b of r.performanceBlockers || []) if (re.test(b.fullUrl)) cpu += b.mainThreadMs;
      html += `<tr><td>${esc(t.name)}</td><td><code>${esc(t.id)}</code></td><td>${t.requests}</td>` +
        `<td>${cpu > 0 ? Math.round(cpu) + 'ms' : '—'}</td></tr>`;
    }
    html += `</table>`;
  }

  // Blockers
  const blockers = r.performanceBlockers || [];
  if (blockers.length) {
    html += `<details><summary><strong>Performance Blockers (${blockers.length})</strong></summary><table>` +
      `<tr><th>Script</th><th>ms</th><th>Type</th></tr>`;
    for (const b of blockers) {
      html += `<tr><td class="script-name">${esc(b.script)}</td><td>${b.mainThreadMs}ms</td>` +
        `<td><span class="${b.isThirdParty ? 'pill-tp' : 'pill-fp'}">${b.isThirdParty ? 'Third-Party' : 'First-Party'}</span></td></tr>`;
    }
    html += `</table></details>`;
  }

  // Third-party categories
  const cats = r.thirdPartyAnalysis || [];
  if (cats.length) {
    html += `<details><summary><strong>Third-Party Categories (${cats.length})</strong></summary><table>` +
      `<tr><th>Category</th><th>Requests</th><th>CPU</th></tr>`;
    for (const c of cats) {
      html += `<tr><td>${CATEGORY_EMOJI[c.category] || '🔗'} ${esc(c.label)}</td><td>${c.totalRequests}</td><td>~${c.estimatedCpuMs}ms</td></tr>`;
    }
    html += `</table></details>`;
  }

  return html;
}

function actionItems(audit) {
  let fpCount = 0, fpMs = 0;
  const catMs = {};
  const patterns = new Set();

  for (const r of audit.results) {
    for (const b of r.performanceBlockers || []) {
      if (b.isThirdParty) catMs[b.category] = (catMs[b.category] || 0) + b.mainThreadMs;
      else { fpCount++; fpMs += b.mainThreadMs; }
    }
    for (const p of r.bucketAttribution?.A?.codeSearchPatterns || []) patterns.add(p.reason);
  }

  const items = [
    `<strong>Code-split first-party scripts (${fpCount})</strong> → save ~${Math.round(fpMs)}ms`,
    `<strong>Lazy-load reCAPTCHA</strong> → save ~${Math.round(catMs.captcha || 0)}ms`,
    `<strong>Defer social pixels</strong> → save ~${Math.round(catMs.social || 0)}ms`,
    `<strong>Reduce analytics tags</strong> → save ~${Math.round(catMs.analytics || 0)}ms`,
    `<strong>Fix code patterns</strong> → ${esc([...patterns].join('; '))}`,
  ];
  return `<hr><h2>🎯 Top 5 Action Items</h2><ol>` + items.map((i) => `<li>${i}</li>`).join('') + `</ol>`;
}

function actualVsIdeal(audit) {
  const rs = audit.results;
  const n = rs.length || 1;
  const reqs = rs.map((r) => r.metrics.networkRequests);
  const avgReq = Math.round(reqs.reduce((a, b) => a + b, 0) / n);
  const maxReq = Math.max(...reqs, 0);
  const pageWeight = avgReq * BUDGET.avgPayloadKB;
  const navAvg = rs.reduce((a, r) => a + r.navigationTimeMs, 0) / n / 1000;
  const worstLT = Math.max(...rs.map((r) => r.metrics.longTasks.maxMs), 0);
  const timerAvg = Math.round(rs.reduce((a, r) => a + r.metrics.timerFired, 0) / n);
  const tpTotal = rs.reduce((a, r) => a + r.metrics.thirdPartyRequests, 0);
  const tpCpu = Math.round(rs.reduce((a, r) => a + (r.performanceBlockers || []).filter((b) => b.isThirdParty).reduce((x, b) => x + b.mainThreadMs, 0), 0));
  const maxFromWeight = Math.floor(BUDGET.pageWeightBudgetKB / BUDGET.avgPayloadKB);
  const t4 = Math.round((BUDGET.avgPayloadKB / BUDGET.bandwidth4G_KBs) * 1000 + BUDGET.rtt4G_ms);
  const t3 = Math.round((BUDGET.avgPayloadKB / BUDGET.bandwidth3G_KBs) * 1000 + BUDGET.rtt3G_ms);

  const row = (metric, actual, ideal, gap, status) =>
    `<tr><td>${metric}</td><td><strong>${actual}</strong></td><td>${ideal}</td><td>${gap}</td><td>${status}</td></tr>`;

  return `<hr><h2>📊 Actual vs Ideal (Resumen)</h2><table>` +
    `<tr><th>Metric</th><th>Actual</th><th>Ideal (Web Vitals)</th><th>Gap</th><th>Status</th></tr>` +
    row('Requests/page (avg)', `${avgReq} req`, '≤ 48 req', `+${Math.max(0, avgReq - maxFromWeight)} req`, avgReq > maxFromWeight ? '🔴' : '🟢') +
    row('Requests/page (max)', `${maxReq} req`, '≤ 48 req', `+${Math.max(0, maxReq - maxFromWeight)} req`, maxReq > maxFromWeight ? '🔴' : '🟢') +
    row('Page Weight (est.)', `${pageWeight} KB`, '1500 KB', `+${Math.max(0, pageWeight - BUDGET.pageWeightBudgetKB)} KB`, pageWeight > BUDGET.pageWeightBudgetKB ? '🔴' : '🟢') +
    row('JS Critical Path', '—', '&lt; 170 KB', '—', '⚪') +
    row('Navigation Time (avg)', `${navAvg.toFixed(1)}s`, '&lt; 2.5s (LCP Good)', `+${Math.max(0, navAvg - 2.5).toFixed(1)}s`, navAvg > 2.5 ? '🔴' : '🟢') +
    row('Worst Long Task', `${worstLT}ms`, '&lt; 50ms', `+${Math.max(0, worstLT - 50)}ms`, worstLT > 50 ? '🔴' : '🟢') +
    row('Timer Events/page (avg)', `${timerAvg}`, '&lt; 500', `+${Math.max(0, timerAvg - 500)}`, timerAvg > 2000 ? '🔴' : timerAvg > 500 ? '🟡' : '🟢') +
    row('Third-Party Requests (total)', `${tpTotal}`, '&lt; 30% of total', `${n} pages`, '📊') +
    row('Third-Party CPU (total)', `${tpCpu}ms`, '&lt; 500ms/page', `+${Math.max(0, tpCpu - 500 * n)}ms`, tpCpu > 500 * n ? '🔴' : '🟢') +
    row('Max Payload/Req (4G)', `${BUDGET.avgPayloadKB} KB avg`, '&lt; 240 KB', 'OK', '🟢') +
    row('Max Payload/Req (3G)', `${BUDGET.avgPayloadKB} KB avg`, '&lt; 10 KB', `+${BUDGET.avgPayloadKB - 10} KB`, '🔴') +
    row('Time/Request (4G est.)', `${t4}ms`, '&lt; 200ms', t4 < 200 ? 'OK' : `+${t4 - 200}ms`, t4 < 200 ? '🟢' : '🔴') +
    row('Time/Request (3G est.)', `${t3}ms`, '&lt; 200ms', t3 < 200 ? 'OK' : `+${t3 - 200}ms`, t3 < 200 ? '🟢' : '🔴') +
    row('TTI Budget', `${navAvg.toFixed(1)}s`, '&lt; 5s', `+${Math.max(0, navAvg - 5).toFixed(1)}s`, navAvg > 5 ? '🔴' : '🟢') +
    row('Friction Points (total)', `${audit.summary.totalFrictionPoints}`, '0', `${audit.summary.totalFrictionPoints} issues`, audit.summary.totalFrictionPoints > 0 ? '🔴' : '🟢') +
    `</table>`;
}

const METHODOLOGY = `<hr><h2>📚 Metodología, Fórmulas y Fuentes</h2>
<h3>Constantes Utilizadas</h3><table><tr><th>Constante</th><th>Valor</th><th>Fuente</th></tr>
<tr><td>Page Weight Budget</td><td>1,500 KB (compressed)</td><td>web.dev/performance-budgets-101</td></tr>
<tr><td>JS Critical Path Budget</td><td>170 KB (mobile)</td><td>web.dev/performance-budgets-101</td></tr>
<tr><td>INP Good Threshold</td><td>&lt; 200ms</td><td>web.dev/articles/inp</td></tr>
<tr><td>LCP Good Threshold</td><td>&lt; 2.5s</td><td>web.dev/articles/lcp</td></tr>
<tr><td>TTI Budget</td><td>&lt; 5s</td><td>web.dev/articles/tti</td></tr>
<tr><td>Long Task Threshold</td><td>&gt; 50ms</td><td>W3C Long Tasks API</td></tr>
<tr><td>4G Bandwidth</td><td>1,600 KB/s (~12.8 Mbps)</td><td>OpenSignal Global Report</td></tr>
<tr><td>3G Bandwidth</td><td>200 KB/s (~1.6 Mbps)</td><td>web.dev baseline</td></tr>
<tr><td>RTT (4G)</td><td>50ms</td><td>Chrome UX Report median</td></tr>
<tr><td>RTT (3G)</td><td>150ms</td><td>Chrome UX Report median</td></tr>
<tr><td>HTTP/2 Parallelism</td><td>6 streams</td><td>RFC 7540 default</td></tr>
<tr><td>Avg Payload (fallback)</td><td>31 KB</td><td>HTTP Archive 2024 median</td></tr>
<tr><td>Timer Fire Warning</td><td>&gt; 500 events</td><td>DevTools empirical</td></tr>
<tr><td>Style Recalc Warning</td><td>&gt; 200 events</td><td>DevTools empirical</td></tr>
<tr><td>Third-Party % Warning</td><td>&gt; 30%</td><td>Lighthouse resource-summary</td></tr></table>
<h3>Fórmulas</h3><pre><code>1. Max Payload Per Request:
   maxPayload = bandwidth × (maxResponseTime - RTT)
   4G: 1600 KB/s × (200ms - 50ms) = 240 KB
   3G: 200 KB/s × (200ms - 150ms) = 10 KB

2. Max Requests (Weight Constraint):
   maxRequests_weight = pageBudget / avgPayload
   = 1500 KB / 31 KB = 48 requests

3. Max Requests (Time Constraint):
   timePerRequest = (avgPayload / bandwidth) + RTT
   maxRequests_time = (TTI_budget × parallelism) / timePerRequest
   4G: (5000ms × 6) / 69ms = 434 requests
   3G: (5000ms × 6) / 305ms = 98 requests

4. Effective Max Requests = min(weight, time):
   4G: min(48, 434) = 48 (weight-limited)
   3G: min(48, 98) = 48 (weight-limited)

5. Third-Party % = thirdPartyRequests / totalRequests × 100

6. Severity Rating:
   GOOD: value ≤ good threshold
   NEEDS_IMPROVEMENT: good &lt; value ≤ poor threshold
   POOR: value &gt; poor threshold
</code></pre>
<h3>Fuentes</h3><ol>
<li><strong>Core Web Vitals</strong> — <a href="https://web.dev/articles/vitals">web.dev/articles/vitals</a></li>
<li><strong>Performance Budgets 101</strong> — <a href="https://web.dev/articles/performance-budgets-101">web.dev/articles/performance-budgets-101</a></li>
<li><strong>INP Metric</strong> — <a href="https://web.dev/articles/inp">web.dev/articles/inp</a></li>
<li><strong>LCP Metric</strong> — <a href="https://web.dev/articles/lcp">web.dev/articles/lcp</a></li>
<li><strong>Lighthouse Resource Summary</strong> — <a href="https://developer.chrome.com/docs/lighthouse/performance/resource-summary">developer.chrome.com</a></li>
<li><strong>HTTP Archive</strong> — <a href="https://httparchive.org/reports/page-weight">httparchive.org/reports/page-weight</a></li>
<li><strong>W3C Long Tasks API</strong> — <a href="https://w3c.github.io/longtasks/">w3c.github.io/longtasks</a></li>
<li><strong>Chrome DevTools Tracing</strong> — <a href="https://developer.chrome.com/docs/devtools/performance">developer.chrome.com/docs/devtools/performance</a></li>
<li><strong>RFC 7540 (HTTP/2)</strong> — <a href="https://www.rfc-editor.org/rfc/rfc7540">rfc-editor.org/rfc/rfc7540</a></li>
<li><strong>OpenSignal Mobile Report</strong> — <a href="https://www.opensignal.com/reports">opensignal.com/reports</a></li>
</ol>`;

// --- Entry point ------------------------------------------------------------

function renderHtml(store, audit) {
  const domain = store.domain;
  const sessionSec = Math.round((audit.sessionDurationMs || 0) / 1000);

  let body = execSummarySection(audit);
  body += consolidatedTags(audit);
  body += navigationTimeline(audit);
  body += performanceBudgetSection(audit);
  body += bucketSection(audit);
  body += thirdPartyAllPages(audit);

  body += `<hr><h2>📄 Detailed Analysis by Page</h2>`;
  body += audit.results.map(pageDetail).join('<hr>');

  body += actionItems(audit);
  body += `<hr><h2>Pages Audited</h2><ol>` +
    audit.visitedUrls.map((u) => `<li><code>${esc(u)}</code></li>`).join('') + `</ol>`;
  const cp = audit.captureProfile || {};
  body += `<hr><h2>Notes</h2><ul>` +
    `<li>Report generated automatically by walmart-cam-qa-audit (Playwright + Chrome DevTools trace).</li>` +
    `<li>Browser cache cleared before each page audit (fresh context per step).</li>` +
    `<li>Interactive journey mode, GET-only — no cart mutation, no orderForm POST.</li>` +
    `<li>Client identified via X-Diagnostics-Client header.</li>` +
    (cp.cpuThrottlingRate > 1
      ? `<li><strong>CPU throttling: ${cp.cpuThrottlingRate}x</strong> (Lighthouse mobile profile), applied to keep long-task and GC magnitudes comparable with the July 2026 baseline, which was captured on a slower host. Network was not throttled.</li>`
      : `<li>No CPU throttling applied — absolute timings are not comparable with the July 2026 baseline.</li>`) +
    `<li>Long tasks are counted on renderer main threads only (<code>CrRendererMain</code>).</li></ul>`;
  body += actualVsIdeal(audit);
  body += METHODOLOGY;

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Performance Audit — ${esc(domain)}</title>
<style>
${CSS}
</style></head><body><div class="wrap"><h1>📊 Performance Audit Report — ${esc(domain)}</h1>` +
    `<p><strong>Date:</strong> ${fmtEsDate(audit.auditDate)} | <strong>Mode:</strong> Interactive Journey | ` +
    `<strong>Session:</strong> ${sessionSec}s | <strong>Pages:</strong> ${audit.results.length}</p>` +
    `<div class="content">${body}</div>` +
    `<footer>Generated by walmart-cam-qa-audit — ${esc(audit.auditDate)}</footer></div></body></html>`;
}

module.exports = { renderHtml, pathOf, CSS };
