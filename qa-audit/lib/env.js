/**
 * env.js — Minimal .env reader (no dependency).
 *
 * Credentials are read at run time and never written into any report artifact.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PATHS = [
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', 'walmart-perf-attribution', '.env'),
];

function loadEnv(extraPath) {
  const out = {};
  const paths = extraPath ? [extraPath, ...DEFAULT_PATHS] : DEFAULT_PATHS;
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (out[m[1]] === undefined) out[m[1]] = v;
    }
  }
  return out;
}

module.exports = { loadEnv };
