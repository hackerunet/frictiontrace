/**
 * paths.js — Single source of truth for where data is read from and where reports go.
 *
 * The layout separates two things that used to live in one folder:
 *
 *   reports/runs/<runId>/        immutable capture output, one folder per execution
 *   reports/<category>/          derived reports, overwritten in place every execution
 *
 * A capture is evidence and must never be rewritten, so each run gets its own folder.
 * A derived report is a *view* of all evidence to date, so it keeps a stable filename:
 * whoever bookmarks comparativos/comparativo-13-tiendas.html always sees the curren
 * picture instead of hunting for the newest dated copy.
 *
 * Run ids carry the hour — `20260821-0600` — because the pipeline runs three times a
 * day and a bare date could not tell those executions apart. Historical folders tha
 * predate the schedule are plain `YYYYMMDD`; both forms sort correctly with a plain
 * string compare, since a bare date is a prefix of any run on that date.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

/** Everything this project produces. Override with QA_REPORTS_ROOT for a dry run. */
const REPORTS_ROOT = process.env.QA_REPORTS_ROOT
  ? path.resolve(process.env.QA_REPORTS_ROOT)
  : path.join(PROJECT_ROOT, 'reports');

const RUNS_DIR = path.join(REPORTS_ROOT, 'runs');
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');

/** Report categories. Each is a folder of stable filenames, rewritten on every run. */
const CATEGORIES = {
  comparativos: path.join(REPORTS_ROOT, 'comparativos'),
  ejecutivos: path.join(REPORTS_ROOT, 'ejecutivos'),
  tendencias: path.join(REPORTS_ROOT, 'tendencias'),
  // Reports published before this layout existed. Nothing regenerates them; they are
  // kept exactly as they were and only ever read.
  archivo: path.join(REPORTS_ROOT, 'archivo'),
};

/**
 * Extra read-only roots to resolve runs against, colon-separated in QA_ARCHIVE_DIRS.
 *
 * Empty by default since 2026-08-21, when the captures that used to live in
 * ../reportesaproducir were moved under reports/runs. The mechanism stays because
 * mounting a colleague's archive read-only is a reasonable thing to want; nothing is
 * ever written to these roots.
 */
const ARCHIVE_DIRS = (process.env.QA_ARCHIVE_DIRS || '')
  .split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));

const RUN_ID_RE = /^\d{8}(?:-\d{4})?$/;

const pad = (n) => String(n).padStart(2, '0');

/** `20260821-0600` for the given moment — the identity of one pipeline execution. */
function newRunId(when = new Date()) {
  return `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`
    + `-${pad(when.getHours())}${pad(when.getMinutes())}`;
}

function parseRunId(id) {
  const m = String(id).match(/^(\d{4})(\d{2})(\d{2})(?:-(\d{2})(\d{2}))?$/);
  if (!m) return null;
  return {
    id: String(id),
    date: `${m[1]}-${m[2]}-${m[3]}`,
    ymd: `${m[1]}${m[2]}${m[3]}`,
    time: m[4] ? `${m[4]}:${m[5]}` : null,
  };
}

/** Where runs may live, newest layout first so a re-run shadows an archived copy. */
function runRoots() {
  return [RUNS_DIR, ...ARCHIVE_DIRS].filter((d) => fs.existsSync(d));
}

/** Every run on disk, oldest first. */
function listRuns() {
  const seen = new Map();
  for (const root of runRoots()) {
    for (const name of fs.readdirSync(root)) {
      if (!RUN_ID_RE.test(name)) continue;
      if (seen.has(name)) continue; // first root wins
      const dir = path.join(root, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      seen.set(name, { ...parseRunId(name), dir, root });
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Absolute directory for a run id, or null when it is on no root. */
function resolveRun(id) {
  for (const root of runRoots()) {
    const dir = path.join(root, String(id));
    if (fs.existsSync(path.join(dir, 'json'))) return dir;
  }
  return null;
}

/** True when a run directory holds at least one capture, not just empty subfolders. */
function hasCaptures(dir) {
  const jsonDir = path.join(dir, 'json');
  try { return fs.readdirSync(jsonDir).some((f) => f.endsWith('.json')); } catch { return false; }
}

/**
 * The N most recent runs that actually contain captures, oldest first.
 *
 * Emptiness matters: a crashed or interrupted execution leaves the folder skeleton
 * behind, and counting it would put a blank column in every comparison report.
 */
function latestRuns(n) {
  const withData = listRuns().filter((r) => hasCaptures(r.dir));
  return n > 0 ? withData.slice(-n) : withData;
}

/** Where a run would live under the writable root. Creates nothing. */
function runDirPath(id) {
  return path.join(RUNS_DIR, String(id));
}

/** Directory for a new run under the writable root, subfolders created. */
function createRunDir(id) {
  const dir = runDirPath(id);
  for (const sub of ['json', 'csv', 'html', 'network']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

function ensureLayout() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  for (const dir of Object.values(CATEGORIES)) fs.mkdirSync(dir, { recursive: true });
}

/** Path inside a report category, e.g. inCategory('comparativos', 'x.html'). */
function inCategory(category, file) {
  const dir = CATEGORIES[category];
  if (!dir) throw new Error(`Categoría de reporte desconocida: ${category}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, file);
}

module.exports = {
  PROJECT_ROOT, REPORTS_ROOT, RUNS_DIR, LOGS_DIR, CATEGORIES, ARCHIVE_DIRS, RUN_ID_RE,
  newRunId, parseRunId, runRoots, listRuns, resolveRun, latestRuns, hasCaptures,
  runDirPath, createRunDir, ensureLayout, inCategory,
};
