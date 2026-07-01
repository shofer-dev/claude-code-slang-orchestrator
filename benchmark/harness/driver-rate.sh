#!/usr/bin/env bash
# Arm B rate: run the LLM-driver N times (same feature, fresh-reset worktree), recording
# convergence, protocol fidelity (did it run architect/developer/reviewer; was the FINAL
# work reviewed) and the driver's coordination tokens. Mirror of convergence-rate.sh (arm A).
#   bash driver-rate.sh [N]
set -uo pipefail
N=${1:-5}
HARNESS=$(cd "$(dirname "$0")" && pwd)
SERVER="$HARNESS/../../server"
WF="$HARNESS/../workflows/implement-feature.slang"
WT=/tmp/slang/shofer
OUT=/tmp/slang/diag
PARAMS="${PARAMS:-}"
[ -n "$PARAMS" ] || PARAMS='{"feature":"format-duration-util: add a pure helper formatDuration(ms:number):string in src/utils that renders a duration human-readably (500->500ms, 1500->1.5s, 65000->1m 5s), plus a vitest spec","design_path":"plans/feature-design.md"}'
IMPL_FILE="${IMPL_FILE:-src/utils/formatDuration.ts}"
CSV="$OUT/${CSV_NAME:-driver-rate}.csv"
mkdir -p "$OUT"
echo "run,converged,steps,architect,developer,reviewer,reviewed_final,driver_tokens,impl,elapsed_s" > "$CSV"
for i in $(seq 1 "$N"); do
  git -C "$WT" checkout -- . >/dev/null 2>&1
  git -C "$WT" clean -fdq -e node_modules -e dist 2>/dev/null
  rm -rf "$WT/plans" 2>/dev/null   # design lives in gitignored plans/ — clean -fd skips it
  LOG="$OUT/driver_$i.log"
  ( cd "$SERVER" && STAKE_TIMEOUT_MS=300000 DRIVER_MAX_STEPS=20 timeout 1800 \
      npx tsx "$HARNESS/driver.ts" "$WF" "$PARAMS" "$WT" > "$LOG" 2>&1 )
  impl=$([ -f "$WT/$IMPL_FILE" ] && echo yes || echo no)
  row=$(tail -1 "$LOG" | python3 -c '
import sys,json
try: s=json.loads(sys.stdin.read())
except Exception: print("ERR,?,?,?,?,?,?,?"); sys.exit()
r=s.get("ran",{})
print(",".join(str(x) for x in [s.get("converged"),s.get("steps"),r.get("architect"),r.get("developer"),r.get("reviewer"),s.get("reviewed_final_work"),s.get("driver_tokens_total"),s.get("elapsed_s")]))' 2>/dev/null)
  IFS=',' read -r conv steps arch dev rev revf dtok elapsed <<<"$row"
  echo "$i,$conv,$steps,$arch,$dev,$rev,$revf,$dtok,$impl,$elapsed" >> "$CSV"
  echo "[driver-rate] run $i: converged=$conv steps=$steps architect=$arch reviewer=$rev reviewed_final=$revf driver_tok=$dtok impl=$impl"
done
echo "=== arm B (driver) summary ==="
conv=$(grep -c ",True,\|,true," "$CSV"); echo "converged: $conv / $N"
skiparch=$(awk -F, 'NR>1 && $4=="False"{c++} END{print c+0}' "$CSV"); echo "skipped architect: $skiparch / $N"
column -t -s, "$CSV"
