#!/usr/bin/env node
/**
 * run-all.js — The single entry point the scheduler calls.
 *
 * Everything the pipeline does, in the order it must happen, with one place to look
 * when a scheduled execution goes wrong. Running the scripts by hand still works; this
 * exists so the *order* is not something a person has to remember at 06:00.
 *
 * Why this order:
 *
 *   1. capture       Hits production and writes reports/runs/<runId>/. Nothing
 *                    downstream has anything to say until this has run.
 *   2. comparativo   Per-stage comparison across the run series.
 *   3. consolidado   One figure per store, same series — kept next to comparativo
 *                    because a reader who sees different series in the two documents
 *                    has no way to reconcile them.
 *   4. ejecutivos    Per-store and consolidated executive summaries, same series.
 *   5. tendencias    Scans every run on every root, so it must come after the new
 *                    capture exists or the newest point would be missing.
 *   6. impacto       Release-impact analysis. It cites the comparison reports and links
 *                    to them as evidence, so it has to be rebuilt in the same pass:
 *                    generated hours apart, the two quote different numbers for the same
 *                    day and the link stops being a check.
 *   7. impacto-ejec  The stakeholder one-pager, which reads the verdicts the previous
 *                    step wrote — hence after it, never before.
 *   6. index         The portal linking all of the above; last, because it reports on
 *                    what the earlier steps actually produced.
 *
 * Failure policy: a failed step does not abort the rest. Capture can fail against one
 * storefront — or entirely — and the derived reports are still worth regenerating from
 * the runs already on disk. Every outcome lands in reports/run-status.json, which is
 * what a monitor should read.
 *
 * Usage:
 *   node bin/run-all.js                      # full pipeline, new run id
 *   node bin/run-all.js --skip-capture       # regenerate reports from existing runs
 *   node bin/run-all.js --only tendencias    # one step
 *   node bin/run-all.js --stores walmart-cr  # capture a subset
 *   node bin/run-all.js --dry-run            # print the plan, touch nothing
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const P = require('../lib/paths');
const Series = require('../lib/series');

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const hasFlag = (n) => args.includes(n);

const cfg = Series.loadPipelineConfig();
const RUN_ID = argVal('--run', P.newRunId());
const DRY = hasFlag('--dry-run');
const SKIP_CAPTURE = hasFlag('--skip-capture');
const STORES = argVal('--stores', null);
const ONLY = (argVal('--only', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const SKIP = (argVal('--skip', '') || '').split(',').map((x) => x.trim()).filter(Boolean);

const NODE = process.execPath;
const R = (...p) => path.join(P.PROJECT_ROOT, ...p);

/** The pipeline. Order is the contract; `id` is what --only/--skip address. */
const STEPS = [
  {
    id: 'capture',
    title: 'Captura del customer journey (13 tiendas, autenticado)',
    script: R('scripts', 'capture', 'audit-auth.js'),
    args: () => [
      '--run', RUN_ID,
      ...(cfg.capture && cfg.capture.args ? cfg.capture.args : []),
      ...(STORES ? ['--stores', STORES] : []),
    ],
    timeoutMs: ((cfg.capture && cfg.capture.timeoutMinutes) || 90) * 60_000,
    skip: () => SKIP_CAPTURE && 'omitida por --skip-capture',
  },
  {
    id: 'comparativo',
    title: 'Comparativo por etapa — 13 tiendas',
    script: R('scripts', 'reports', 'comparativo.js'),
  },
  {
    id: 'consolidado',
    title: 'Comparativo consolidado — una cifra por tienda',
    script: R('scripts', 'reports', 'comparativo-consolidado.js'),
  },
  {
    id: 'ejecutivos',
    title: 'Resúmenes ejecutivos — 13 tiendas + consolidado',
    script: R('scripts', 'reports', 'resumen-ejecutivo.js'),
  },
  {
    id: 'tendencias',
    title: 'Trend report — histórico completo',
    script: R('scripts', 'reports', 'trend-report.js'),
  },
  {
    id: 'impacto',
    title: 'Impacto de liberaciones — sustentación',
    script: R('scripts', 'reports', 'impacto-liberaciones.js'),
  },
  {
    id: 'impacto-ejecutivo',
    title: 'Impacto de liberaciones — resumen ejecutivo',
    script: R('scripts', 'reports', 'ejecutivo-liberaciones.js'),
  },
  {
    id: 'index',
    title: 'Portal de reportes',
    script: R('scripts', 'reports', 'index.js'),
    args: () => ['--run', RUN_ID],
  },
];

// --- Lock -------------------------------------------------------------------

/**
 * One execution at a time. A capture takes the better part of an hour; if one hangs,
 * the next scheduled firing must not start a second browser fleet against production
 * on top of it.
 */
const LOCK = path.join(P.LOGS_DIR, 'pipeline.lock');

function acquireLock() {
  fs.mkdirSync(P.LOGS_DIR, { recursive: true });
  if (fs.existsSync(LOCK)) {
    const prev = Number(fs.readFileSync(LOCK, 'utf8').trim());
    let alive = false;
    try { process.kill(prev, 0); alive = true; } catch { alive = false; }
    if (alive) {
      console.error(`\n⛔ Ya hay una ejecución en curso (pid ${prev}). Nada que hacer.\n`);
      process.exit(3);
    }
    console.warn(`⚠ Lock huérfano de un pid muerto (${prev}); se reclama.`);
  }
  fs.writeFileSync(LOCK, String(process.pid));
}

function releaseLock() {
  try { if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK); } catch {}
}

// --- Run --------------------------------------------------------------------

function selected(step) {
  if (ONLY.length && !ONLY.includes(step.id)) return 'no está en --only';
  if (SKIP.includes(step.id)) return 'en --skip';
  return step.skip ? step.skip() : null;
}

function runStep(step, logStream) {
  const argv = [step.script, ...(step.args ? step.args() : [])];
  const started = Date.now();
  const res = spawnSync(NODE, argv, {
    cwd: P.PROJECT_ROOT,
    encoding: 'utf8',
    timeout: step.timeoutMs || 15 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  const ms = Date.now() - started;
  const out = (res.stdout || '') + (res.stderr || '');
  logStream.write(`\n${'='.repeat(78)}\n### ${step.id} — ${step.title}\n$ node ${argv.map((a) => path.basename(a)).join(' ')}\n${'='.repeat(78)}\n${out}\n`);

  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  const ok = !res.error && res.status === 0;
  return {
    id: step.id,
    title: step.title,
    ok,
    exitCode: res.status,
    durationMs: ms,
    error: timedOut ? `excedió ${Math.round((step.timeoutMs || 900000) / 60000)} min`
      : res.error ? res.error.message : (ok ? null : `salida ${res.status}`),
    // The last few lines are what a person actually reads in a status ping.
    tail: out.trim().split('\n').slice(-6).join('\n'),
  };
}

(function main() {
  P.ensureLayout();

  const plan = STEPS.map((s) => ({ step: s, skipped: selected(s) }));

  console.log(`\n🕒 Pipeline QA Walmart CAM — corrida ${RUN_ID}`);
  console.log(`   Raíz de reportes: ${P.REPORTS_ROOT}`);
  console.log(`   Serie comparada:  ${Series.resolveSeries(null).join(' → ') || '(vacía)'}\n`);
  for (const { step, skipped } of plan) {
    console.log(`   ${skipped ? '⊘' : '•'} ${step.id.padEnd(12)} ${skipped ? `(${skipped})` : step.title}`);
  }

  if (DRY) { console.log('\n--dry-run: no se ejecutó nada.\n'); return; }

  acquireLock();
  process.on('exit', releaseLock);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { releaseLock(); process.exit(130); });
  }

  const logFile = path.join(P.LOGS_DIR, `run-${RUN_ID}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  logStream.write(`# Pipeline ${RUN_ID} — iniciado ${new Date().toISOString()}\n`);

  const results = [];
  const t0 = Date.now();
  const statusFile = path.join(P.REPORTS_ROOT, 'run-status.json');

  /**
   * Written after every step, not just at the end. The `index` step runs inside this
   * pipeline and renders the status banner, so a status file written only on completion
   * would make the portal permanently one execution out of date. `complete` is what
   * tells a reader whether they are looking at a finished run or one in flight.
   */
  const writeStatus = (complete) => {
    const status = {
      runId: RUN_ID,
      complete,
      startedAt: new Date(t0).toISOString(),
      finishedAt: complete ? new Date().toISOString() : null,
      durationMs: Date.now() - t0,
      series: Series.resolveSeries(null),
      ok: results.every((r) => r.skipped || r.ok),
      log: logFile,
      steps: results,
    };
    fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
    return status;
  };
  console.log('');
  for (const { step, skipped } of plan) {
    if (skipped) { results.push({ id: step.id, title: step.title, skipped }); continue; }
    process.stdout.write(`▶ ${step.id} … `);
    const r = runStep(step, logStream);
    results.push(r);
    const secs = (r.durationMs / 1000).toFixed(1);
    console.log(r.ok ? `✅ ${secs}s` : `❌ ${secs}s — ${r.error}`);
    if (!r.ok) console.log(r.tail.split('\n').map((l) => `      ${l}`).join('\n'));
    writeStatus(false);
  }

  const status = writeStatus(true);
  logStream.end(`\n# Fin ${status.finishedAt} — ${status.ok ? 'OK' : 'CON FALLOS'}\n`);

  const mins = (status.durationMs / 60000).toFixed(1);
  console.log(`\n${status.ok ? '✔' : '⚠'} Pipeline ${status.ok ? 'completo' : 'con fallos'} en ${mins} min`);
  console.log(`   Estado: ${statusFile}`);
  console.log(`   Log:    ${logFile}\n`);
  process.exitCode = status.ok ? 0 : 1;
})();
