#!/bin/bash
#
# cron-run.sh — What the scheduler actually executes.
#
# cron and launchd start a process with almost no environment: no shell profile, no
# nvm, often no usable PATH. A bare `node bin/run-all.js` in a crontab therefore works
# when tested from a terminal and fails silently at 06:00. This wrapper pins the
# interpreter, the working directory and the log destination so the scheduled run
# behaves the same as the manual one.
#
#   bin/cron-run.sh              full pipeline
#   bin/cron-run.sh --skip-capture   reports only
#
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

# Absolute interpreter. Override with QA_NODE_BIN when the runtime moves (an nvm
# upgrade changes this path), and keep a PATH lookup as the fallback.
NODE_BIN="${QA_NODE_BIN:-/Users/hackerunet/.nvm/versions/node/v22.17.0/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "$(date '+%F %T') ERROR: no se encontró node ejecutable" >> "$PROJECT_DIR/logs/cron.log"
  exit 127
fi

mkdir -p "$PROJECT_DIR/logs"
CRON_LOG="$PROJECT_DIR/logs/cron.log"

# Playwright's browsers live in the user's cache; without HOME the launch fails.
export HOME="${HOME:-/Users/hackerunet}"

{
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "$(date '+%F %T')  inicio  ($NODE_BIN)  args: $*"
} >> "$CRON_LOG"

"$NODE_BIN" "$PROJECT_DIR/bin/run-all.js" "$@" >> "$CRON_LOG" 2>&1
STATUS=$?

echo "$(date '+%F %T')  fin     salida=$STATUS" >> "$CRON_LOG"

# Keep the tail only. An unbounded log on a three-a-day schedule is a slow disk leak.
if [ -f "$CRON_LOG" ] && [ "$(wc -l < "$CRON_LOG")" -gt 20000 ]; then
  tail -n 8000 "$CRON_LOG" > "$CRON_LOG.tmp" && mv "$CRON_LOG.tmp" "$CRON_LOG"
fi

# Per-run pipeline logs are pruned on the same principle: the JSON captures are the
# evidence, the logs are only for diagnosing a failed execution.
find "$PROJECT_DIR/logs" -name 'run-*.log' -type f -mtime +30 -delete 2>/dev/null

exit $STATUS
