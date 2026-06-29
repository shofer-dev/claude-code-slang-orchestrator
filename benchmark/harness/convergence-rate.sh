#!/usr/bin/env bash
# Convergence-rate harness: run the SAME workflow + params from the SAME clean worktree N
# times (sequential — they share one worktree), recording each run's terminal status.
#   bash convergence-rate.sh [N]
set -uo pipefail
N=${1:-5}
HARNESS=$(cd "$(dirname "$0")" && pwd)
SERVER="$HARNESS/../../server"
WF="$HARNESS/../workflows/implement-feature.slang"
WT=/tmp/slang/shofer
OUT=/tmp/slang/diag
PARAMS='{"feature":"format-duration-util: add a pure helper formatDuration(ms:number):string in src/utils that renders a duration human-readably (500->500ms, 1500->1.5s, 65000->1m 5s), plus a vitest spec","design_path":"plans/feature-design.md"}'
CSV="$OUT/rate.csv"
mkdir -p "$OUT"
echo "run,status,rounds,elapsed_s,launch_errors,impl_written" > "$CSV"
for i in $(seq 1 "$N"); do
  git -C "$WT" checkout -- . >/dev/null 2>&1
  git -C "$WT" clean -fdq -e node_modules -e dist 2>/dev/null
  LOG="$OUT/rate_$i.log"
  ( cd "$SERVER" && STAKE_TIMEOUT_MS=300000 SLANG_MAX_ROUNDS=30 timeout 1800 \
      npx tsx "$HARNESS/diagnose-real.ts" "$WF" "$PARAMS" "$WT" > "$LOG" 2>&1 )
  st_line=$(grep "=== STATUS:" "$LOG" | tail -1)
  if [ -z "$st_line" ]; then status="killed/timeout"; rounds="?"; elapsed="?"
  else
    status=$(sed -E 's/.*STATUS: ([a-z_]+).*/\1/' <<<"$st_line")
    rounds=$(sed -E 's/.*rounds:([0-9]+).*/\1/' <<<"$st_line")
    elapsed=$(sed -E 's/.*elapsed:([0-9]+)s.*/\1/' <<<"$st_line")
  fi
  lerr=$(grep -c "failed to launch" "$LOG")
  impl=$([ -f "$WT/src/utils/formatDuration.ts" ] && echo yes || echo no)
  echo "$i,$status,$rounds,$elapsed,$lerr,$impl" >> "$CSV"
  echo "[rate] run $i: $status rounds=$rounds elapsed=${elapsed}s launch_err=$lerr impl=$impl"
done
echo "=== convergence rate ==="
conv=$(grep -c ",converged," "$CSV"); echo "converged: $conv / $N"
column -t -s, "$CSV"
