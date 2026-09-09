/**
 * trace.js — Chrome DevTools timeline trace capture + parsing.
 *
 * Captures the same event families the historical audits used, so the resulting
 * metrics (timerFired, longTasks, layoutThrashing, scriptEval, functionCalls,
 * gcEvents, parseHTML, paint, compositeLayers) are directly comparable.
 */

const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'blink.user_timing',
  'v8.execute',
  'latencyInfo',
];

const LONG_TASK_MS = 50;

const GC_EVENTS = new Set([
  'MinorGC', 'MajorGC', 'GCEvent', 'V8.GCScavenger', 'V8.GCCompactor',
  'V8.GCIncrementalMarking', 'V8.GCFinalizeMC', 'BlinkGC.AtomicPhase',
]);

/** Starts a browser-wide DevTools trace. Returns a handle with stop(). */
async function startTrace(browser) {
  const client = await browser.newBrowserCDPSession();
  await client.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    streamFormat: 'json',
    traceConfig: {
      recordMode: 'recordAsMuchAsPossible',
      includedCategories: TRACE_CATEGORIES,
    },
  });

  return {
    async stop() {
      const complete = new Promise((resolve) => client.once('Tracing.tracingComplete', resolve));
      await client.send('Tracing.end');
      const { stream } = await complete;
      if (!stream) { await client.detach().catch(() => {}); return []; }

      let raw = '';
      for (;;) {
        const chunk = await client.send('IO.read', { handle: stream, size: 4 * 1024 * 1024 });
        raw += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data;
        if (chunk.eof) break;
      }
      await client.send('IO.close', { handle: stream }).catch(() => {});
      await client.detach().catch(() => {});

      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : (parsed.traceEvents || []);
      } catch {
        return [];
      }
    },
  };
}

/** Script URL attributed to a timeline event, if any. */
function scriptUrlOf(ev) {
  const d = ev.args && ev.args.data;
  if (!d) return null;
  return d.url || d.scriptName || d.fileName || null;
}

/**
 * Aggregates trace events into the metric shape used by the reports.
 *
 * Script CPU is attributed top-level only: an EvaluateScript/FunctionCall nested
 * inside another already-attributed event is skipped, so a 2.4s script bundle is
 * counted once rather than once per inner frame.
 */
function parseTrace(events) {
  const metrics = {
    timerFired: 0,
    longTasks: { count: 0, maxMs: 0, p95Ms: 0, avgMs: 0 },
    layoutThrashing: { recalcStyles: 0, layouts: 0 },
    scriptEval: 0,
    functionCalls: 0,
    gcEvents: 0,
    parseHTML: 0,
    paint: 0,
    compositeLayers: 0,
  };

  const longTaskDurations = [];
  const longTasks = [];
  const scriptMs = new Map();

  // Complete events only; sorted per thread so nesting can be tracked with a stack.
  // "Long task" is a property of a renderer main thread. Counting RunTask on the
  // browser/GPU/IO threads inflates the number with work the page never blocked on.
  const rendererThreads = new Set();
  for (const e of events) {
    if (e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain') {
      rendererThreads.add(e.pid + ':' + e.tid);
    }
  }

  const complete = events
    .filter((e) => e.ph === 'X' && typeof e.ts === 'number')
    .sort((a, b) => (a.pid - b.pid) || (a.tid - b.tid) || (a.ts - b.ts) || ((b.dur || 0) - (a.dur || 0)));

  let traceStartTs = Infinity;
  for (const e of complete) if (e.ts < traceStartTs) traceStartTs = e.ts;
  if (!isFinite(traceStartTs)) traceStartTs = 0;

  let stack = [];
  let currentThread = null;

  for (const ev of complete) {
    const thread = ev.pid + ':' + ev.tid;
    if (thread !== currentThread) { stack = []; currentThread = thread; }

    const start = ev.ts;
    const end = ev.ts + (ev.dur || 0);
    while (stack.length && stack[stack.length - 1].end <= start) stack.pop();

    const name = ev.name;

    switch (name) {
      case 'TimerFire': metrics.timerFired++; break;
      case 'UpdateLayoutTree':
      case 'RecalculateStyles': metrics.layoutThrashing.recalcStyles++; break;
      case 'Layout': metrics.layoutThrashing.layouts++; break;
      case 'ParseHTML': metrics.parseHTML++; break;
      case 'Paint': metrics.paint++; break;
      case 'CompositeLayers': metrics.compositeLayers++; break;
      case 'EvaluateScript':
      case 'v8.compile':
      case 'v8.evaluateModule': metrics.scriptEval++; break;
      case 'FunctionCall': metrics.functionCalls++; break;
      case 'RunTask': {
        const durMs = (ev.dur || 0) / 1000;
        if (durMs >= LONG_TASK_MS && (rendererThreads.size === 0 || rendererThreads.has(thread))) {
          longTaskDurations.push(durMs);
          longTasks.push({ durationMs: Math.round(durMs), startOffsetMs: (start - traceStartTs) / 1000 });
        }
        break;
      }
      default:
        if (GC_EVENTS.has(name)) metrics.gcEvents++;
        break;
    }

    // Top-level script CPU attribution.
    if (name === 'EvaluateScript' || name === 'FunctionCall' || name === 'v8.compile') {
      const url = scriptUrlOf(ev);
      if (url && !stack.some((s) => s.attributed)) {
        const ms = (ev.dur || 0) / 1000;
        if (ms > 0) scriptMs.set(url, (scriptMs.get(url) || 0) + ms);
        stack.push({ end, attributed: true });
        continue;
      }
    }

    stack.push({ end, attributed: stack.some((s) => s.attributed) });
  }

  longTaskDurations.sort((a, b) => a - b);
  if (longTaskDurations.length) {
    const sum = longTaskDurations.reduce((a, b) => a + b, 0);
    metrics.longTasks.count = longTaskDurations.length;
    metrics.longTasks.maxMs = Math.round(longTaskDurations[longTaskDurations.length - 1]);
    metrics.longTasks.avgMs = Math.round(sum / longTaskDurations.length);
    const idx = Math.min(longTaskDurations.length - 1, Math.floor(0.95 * longTaskDurations.length));
    metrics.longTasks.p95Ms = Math.round(longTaskDurations[idx]);
  }

  const topLongTasks = longTasks
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10)
    .map((t) => ({ durationMs: t.durationMs, startOffset: (t.startOffsetMs / 1000).toFixed(1) + 's' }));

  const heaviestScripts = [...scriptMs.entries()]
    .map(([fullUrl, ms]) => ({ fullUrl, totalMs: Math.round(ms) }))
    .filter((s) => s.totalMs > 0)
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 30);

  return { metrics, topLongTasks, heaviestScripts };
}

/** Historical reports truncate long script URLs to 80 chars, keeping the tail. */
function shortenScript(fullUrl) {
  if (!fullUrl) return 'unknown';
  if (fullUrl.length <= 80) return fullUrl;
  return '...' + fullUrl.slice(-77);
}

module.exports = { startTrace, parseTrace, shortenScript, LONG_TASK_MS };
