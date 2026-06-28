#!/usr/bin/env bash
# Faithful build-env shofer worktree at a given ref (default: master HEAD).
set -euo pipefail
SH=/home/alsterg/Projects/arkware.ai/extensions/shofer
WT=${1:-/tmp/slang/shofer}
REF=${2:-$(git -C "$SH" rev-parse master)}
git -C "$SH" worktree add --detach "$WT" "$REF" 2>/dev/null || { cd "$WT"; git checkout -- .; git clean -fd; }
cd "$WT"
pnpm install --offline --config.confirmModulesPurge=false
pnpm turbo build --filter='./packages/*' --output-logs errors-only
ln -sf ../../../packages/vscode-shim src/node_modules/@shofer/vscode-shim 2>/dev/null || true
ln -sf ../../packages/vscode-shim     node_modules/@shofer/vscode-shim 2>/dev/null || true
( cd src && pnpm check-types ) && echo "OK: faithful worktree at $WT @ ${REF:0:12}"
