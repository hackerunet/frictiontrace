/**
 * series.js — Decides which DAYS a comparison report puts side by side, and how the
 * readings inside a day become one number.
 *
 * A column is a day, not an execution. The pipeline captures three times a day, and one
 * reading is a sample of a noisy process — a slow CDN moment, a mid-morning promo, an
 * unlucky garbage collection. Three readings averaged give a midpoint that describes
 * the day, plus a spread that says whether the three agreed. Publishing a single
 * reading as if it were the day was the weakness this replaces.
 *
 * Several reports need to agree on this list or their columns stop lining up, so the
 * decision lives here instead of being re-derived from a default string in each script.
 */

const fs = require('fs');
const path = require('path');
const P = require('./paths');
const S = require('./stages');

const STORES = require('../config/stores.json').stores;

function loadPipelineConfig() {
  const f = path.join(P.PROJECT_ROOT, 'config', 'pipeline.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}

function seriesConfig() {
  const cfg = loadPipelineConfig().series || {};
  return {
    // The *Runs names are the pre-2026-08-21 spelling, read as a fallback so an
    // un-migrated config produces the intended series rather than an empty one.
    baselineDays: cfg.baselineDays || cfg.baselineRuns || [],
    recentDays: cfg.recentDays != null ? cfg.recentDays : (cfg.recentRuns != null ? cfg.recentRuns : 3),
    excludeRuns: cfg.excludeRuns || [],
    minStoreCoverage: cfg.minStoreCoverage != null ? cfg.minStoreCoverage : 0.6,
    aggregate: cfg.aggregate || 'mean',
    dispersionWarn: cfg.dispersionWarn != null ? cfg.dispersionWarn : 0.4,
  };
}

/** Runs that are on disk but are not measurements. Exclusion is per run, not per day. */
function excludedRuns() {
  return new Set(seriesConfig().excludeRuns);
}

/** Reader bound to the configured aggregation and exclusions: (ymd, stores) → stages. */
function dayReader() {
  const { aggregate } = seriesConfig();
  const exclude = excludedRuns();
  return (ymd, stores = STORES) => S.readDay(ymd, stores, { exclude, aggregate });
}

/** Same, but keeping n / min / max / spread per cell. */
function dayDetailReader() {
  const { aggregate } = seriesConfig();
  const exclude = excludedRuns();
  return (ymd, stores = STORES) => S.readDayDetail(ymd, stores, { exclude, aggregate });
}

/** Relative spread above which a day's readings are considered to disagree. */
function dispersionWarn() { return seriesConfig().dispersionWarn; }

/** How many runs backed a given day, after exclusions. */
function runsOfDay(ymd) { return S.runsOfDay(ymd, { exclude: excludedRuns() }); }

/**
 * @param {string|null} datesArg  Value of --dates; an explicit list always wins.
 * @returns {string[]} day ids (YYYYMMDD), oldest first.
 */
function resolveSeries(datesArg) {
  if (datesArg) {
    return String(datesArg).split(',').map((x) => x.trim()).filter(Boolean);
  }
  const cfg = seriesConfig();
  const exclude = excludedRuns();
  const read = dayReader();
  const floor = Math.ceil(STORES.length * cfg.minStoreCoverage);

  /**
   * A day earns a column only if it captured enough of the chain. A day whose only
   * execution died after three storefronts is not a thin measurement — it is an
   * absence, and charting it would show ten stores dropping to nothing that day.
   */
  const covered = (ymd) => Object.keys(read(ymd)).length >= floor;

  // Pinned baselines skip the coverage floor: pinning is an explicit human decision and
  // an automatic rule should not quietly overturn it. Their runs can still be excluded,
  // because excludeRuns is the more specific statement — "never use this one".
  const baselines = cfg.baselineDays.filter((ymd) => S.runsOfDay(ymd, { exclude }).length > 0);

  const pool = S.listDays({ exclude }).map((d) => d.ymd).filter(covered);
  const recent = pool.slice(-(cfg.recentDays || 3));

  return [...new Set([...baselines, ...recent])].sort((a, b) => a.localeCompare(b));
}

/**
 * Index of the day the published Ago-05 figures back-fill. Three stores were captured
 * that day by DevTools trace import, which recorded no per-stage breakdown; the
 * baseline JSON supplies those cells. Returns -1 when that day is not in the series.
 */
function baselineIndex(series, baselineDay = '20260805') {
  return series.indexOf(baselineDay);
}

module.exports = {
  loadPipelineConfig, seriesConfig, resolveSeries, baselineIndex,
  excludedRuns, dayReader, dayDetailReader, dispersionWarn, runsOfDay,
};
