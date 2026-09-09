#!/usr/bin/env node
/**
 * prune-runs.js — Reclaims disk from old captures without touching the evidence
 * anything still depends on.
 *
 * A run costs about 32 MB, of which roughly 22 MB is the per-request network dump.
 * At three runs a day that is ~2.9 GB a month, so something has to give eventually —
 * but a capture is the only reason a report can be regenerated without hitting
 * production again, so deletion is deliberate, opt-in and guarded:
 *
 *   - Runs inside the active comparison series are never touched.
 *   - Pinned baselines are never touched.
 *   - The read-only archives are never touched; only reports/runs is writable here.
 *   - Nothing is deleted without --apply. The default is a report of what would go.
 *
 * --network-only is the setting to reach for first: it drops the request dumps and
 * keeps the audit JSON, which is what every report actually reads. That recovers
 * about 70% of the space and still leaves each run regenerable.
 *
 * Usage:
 *   node bin/prune-runs.js                       # what would be pruned
 *   node bin/prune-runs.js --network-only --apply
 *   node bin/prune-runs.js --keep 30 --apply
 */

const fs = require('fs');
const path = require('path');
const P = require('../lib/paths');
const Series = require('../lib/series');

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const hasFlag = (n) => args.includes(n);

const cfg = Series.loadPipelineConfig();
const KEEP = Number(argVal('--keep', (cfg.retention && cfg.retention.keepRuns) || 90));
const NETWORK_ONLY = hasFlag('--network-only');
const APPLY = hasFlag('--apply');

// The series is a list of DAYS, so protection is by day: pruning 20260821-0600 because
// the series says "20260821" would silently drop one of the three readings behind a
// published figure. Every run of a protected day is protected.
const protectedDays = new Set([
  ...Series.resolveSeries(null),
  ...((cfg.series && (cfg.series.baselineDays || cfg.series.baselineRuns)) || []),
]);
const isProtected = (run) => protectedDays.has(run.ymd);

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { try { total += fs.statSync(f).size; } catch {} }
    }
  };
  try { walk(dir); } catch {}
  return total;
}

const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB';

// Only runs under the writable root are candidates. The archives hold the July and
// August baselines and are treated as immutable input.
const own = P.listRuns().filter((r) => r.root === P.RUNS_DIR);
const candidates = own.slice(0, Math.max(0, own.length - KEEP));

const plan = candidates
  .filter((r) => {
    if (isProtected(r)) { console.log(`   🔒 ${r.id} — su día está en la serie activa, se conserva`); return false; }
    return true;
  })
  .map((r) => {
    const netDir = path.join(r.dir, 'network');
    const target = NETWORK_ONLY ? netDir : r.dir;
    return { ...r, target, exists: fs.existsSync(target), bytes: fs.existsSync(target) ? dirSize(target) : 0 };
  })
  .filter((r) => r.exists && r.bytes > 0);

console.log(`\n🧹 Poda de corridas — raíz ${P.RUNS_DIR}`);
console.log(`   Corridas propias: ${own.length} · se conservan las ${KEEP} más recientes`);
console.log(`   Modo: ${NETWORK_ONLY ? 'solo volcados de red' : 'corrida completa'} · ${APPLY ? 'APLICANDO' : 'simulación'}\n`);

if (!plan.length) {
  console.log('   Nada que podar.\n');
  process.exit(0);
}

let freed = 0;
for (const r of plan) {
  freed += r.bytes;
  console.log(`   ${APPLY ? '🗑' : '·'} ${r.id.padEnd(15)} ${mb(r.bytes).padStart(10)}  ${path.relative(P.RUNS_DIR, r.target) || '(completa)'}`);
  if (APPLY) fs.rmSync(r.target, { recursive: true, force: true });
}

console.log(`\n   ${APPLY ? 'Liberado' : 'Se liberaría'}: ${mb(freed)}`);
if (!APPLY) console.log('   Repetí con --apply para borrar.\n'); else console.log('');
