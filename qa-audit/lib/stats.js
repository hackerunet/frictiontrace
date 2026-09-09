/**
 * stats.js — Outlier detection over the whole historical base.
 *
 * Purpose: flag values that are probably capture artefacts rather than real behaviour,
 * so a reader is not led to conclude something from a number the tooling got wrong.
 *
 * The population is built **per stage**, pooling every store and every date. Pooling
 * across stores is deliberate: a per-store population would have only a handful of
 * points — too few for a meaningful σ — while a global population over all stages a
 * once would drown a fast stage's anomaly inside a slow stage's spread.
 *
 * Robust statistics are used rather than mean/σ. A single wild value (a 59s timeout,
 * a 0.34s trace artefact) drags the mean toward itself and inflates σ, which is exactly
 * how an outlier hides from a mean-based test. Median and MAD do not have that problem.
 */

const fs = require('fs');
const path = require('path');
const S = require('./stages');
const P = require('./paths');

/** Scale factor making MAD a consistent estimator of σ for normal data. */
const MAD_TO_SIGMA = 1.4826;

function median(sorted) {
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/** Every run id present on any root, oldest first. */
function allRunIds() {
  return P.listRuns().map((r) => r.id);
}

/**
 * Per-stage distribution over the full history.
 * Returns { stage: { n, median, mad, sigma, lo, hi } } where lo/hi bound the
 * non-outlier range at `k` robust sigmas.
 */
function buildStageStats(stores, { k = 2, folders = null } = {}) {
  const dates = folders || allRunIds();
  const samples = {};
  for (const s of S.STAGES) samples[s.key] = [];

  for (const folder of dates) {
    const byStore = S.readRun(folder, stores);
    for (const stages of Object.values(byStore)) {
      for (const s of S.STAGES) {
        const v = stages[s.key];
        if (v != null && !Number.isNaN(v)) samples[s.key].push(v);
      }
    }
  }

  const out = {};
  for (const s of S.STAGES) {
    const xs = samples[s.key].slice().sort((a, b) => a - b);
    if (xs.length < 4) { out[s.key] = { n: xs.length, insufficient: true }; continue; }
    const med = median(xs);
    const devs = xs.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
    const mad = median(devs);
    // An MAD of zero (many identical readings) would flag every distinct value, so fall
    // back to the interquartile range before giving up on a spread estimate.
    let sigma = mad * MAD_TO_SIGMA;
    if (!sigma) {
      const q = (p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
      sigma = (q(0.75) - q(0.25)) / 1.349;
    }
    out[s.key] = {
      n: xs.length, median: med, mad, sigma,
      // Times cannot be negative; an unclamped lower bound would read as if some
      // impossible value were still "expected".
      lo: sigma ? Math.max(0, med - k * sigma) : null,
      hi: sigma ? med + k * sigma : null,
      k, dates: dates.length,
    };
  }
  return out;
}

/** How many robust sigmas a value sits from its stage's median; null when unknown. */
function zScore(stats, stageKey, value) {
  const st = stats[stageKey];
  if (!st || st.insufficient || !st.sigma || value == null || Number.isNaN(value)) return null;
  return (value - st.median) / st.sigma;
}

/** True when a value falls outside the stage's expected range. */
function isOutlier(stats, stageKey, value) {
  const z = zScore(stats, stageKey, value);
  return z != null && Math.abs(z) > (stats[stageKey].k || 2);
}

module.exports = { buildStageStats, zScore, isOutlier, allRunIds };
