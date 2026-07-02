#!/usr/bin/env bash
# Build the self-contained TS + vitest target project (the codebase the agents implement into),
# so the benchmark runs anywhere — no private repo required. Location: $1 or $BENCH_WORKDIR
# (default /tmp/slang-bench/target). It is a fresh git repo so the harness can reset it
# (git checkout/clean) between runs.
set -euo pipefail
HARNESS=$(cd "$(dirname "$0")" && pwd)
WT="${1:-${BENCH_WORKDIR:-/tmp/slang-bench/target}}"
rm -rf "$WT"; mkdir -p "$WT"
cp -R "$HARNESS/../target/." "$WT/"
cd "$WT"
npm install --silent --no-fund --no-audit
git init -q
git add -A
git -c user.email=bench@local -c user.name=bench commit -qm "baseline scaffold"
echo "OK: benchmark target at $WT ($(node -e "process.stdout.write(require('./package.json').name)"))"
