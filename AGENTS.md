# Agent working agreements — slang-orchestrator

Durable rules for changing this plugin. Current-state only. Full detail lives in
`DESIGN.md` (rationale + invariants) and `slang_specs.md` (the language). This
file is the short version; don't duplicate those docs here.

## What this is

A Claude Code plugin: a stdio MCP server (`server/`) hosting a **deterministic,
non-LLM executor** that runs typed `.slang` multi-agent workflows. Each agent is
a Claude Agent SDK session; the executor coordinates them (contracts,
tool-scoping, termination). The top-level session only triggers/observes.

## Stack & conventions

- **TypeScript ESM, Node ≥20** (server `engines`; README/benchmark ask Node 22+),
  **pnpm**. All source is under `server/`; run every command from there.
- `tsconfig`: `strict`, `target ES2022`, `moduleResolution: Bundler`, `noEmit`.
  **Indent with tabs** (matches existing `.ts`; `.mjs` hooks use 2 spaces).
- **Relative imports use `.js` extensions** on `.ts` sources (bundler/ESM).
- No ESLint/Prettier config in the repo — match surrounding style by hand.
- `@modelcontextprotocol/sdk` and `zod` are **version-pinned**; keep them pinned.
  `@anthropic-ai/claude-agent-sdk` is only needed for *real* runs — the whole test
  suite mocks it, so tests need no SDK, no `claude` CLI, no API key, no network.

## Build / test / run (all in `server/`)

- `pnpm typecheck` — `tsc --noEmit` over the server.
- `pnpm test` — `node --test --import tsx test/*.test.ts` (unit + conformance; no
  model calls).
- `pnpm dev` / `start` — run the stdio MCP server (`tsx src/main.ts`; logs to
  **stderr**, stdout is the MCP channel).
- `pnpm build` — **esbuild bundle** to `dist/main.js` (not `tsc` emit) and copies
  `src/*.mjs` → `dist/`.
- Root shortcut `pnpm check` = typecheck + test. A husky **pre-push** hook runs
  both and blocks the push (active only when this folder is its own git repo).
  Leave the tree green before committing a module you touched.

## Non-obvious invariants (read before changing code)

- **`server/src/slang/` is vendored** (`@riktar/slang`, MIT: lexer/parser/resolver/
  AST/interpreter). Treat as upstream — don't casually refactor it. Note `where`
  (semantic contract) is a slang-orchestrator **extension**, not upstream.
- **Depth-1 invariant:** an inner agent can never be granted a tool that spawns a
  subagent or starts another workflow (`subtasks` group → `[]`; the executor
  resolves tools without `availableMcpTools` so no `mcp__*`/`run_workflow` leaks).
  Locked by `test/no-spawn-invariant.test.ts` — breaking it must be conscious.
- **Output contracts are enforced at the system-prompt level, not API
  JSON-schema.** Two layers: structural `output: {…}` + semantic `where <expr>`. A
  miss re-prompts; `MAX_RETRIES = 3` (agent marked `error` on the 4th failure).
- **`write_paths` is enforced by a PreToolUse command hook** (`src/write-guard.mjs`,
  via the `SLANG_WRITE_PATHS` env), not `canUseTool` — so it holds even under
  `bypassPermissions`. Any new `.mjs` hook must live in `src/` (the `build` step
  globs `src/*.mjs`).
- **`escalate @Human` works in synchronous runs only** (MCP elicitation needs the
  tool call to stay open); background runs return a `workflow_id` to poll and
  reject missing required params up front.
- **Tunable magic numbers live only in `src/constants.ts`** (round cap, retry
  budget, stake timeout, loop guard). Precedence: call-site > `.slang` directive >
  default.
- **slang is a coordination language: no arithmetic, no string building** beyond
  `${…}`. Model counters/loops with boolean flags + `round`/`committed_count`;
  `import` goes *inside* the flow body; use `otherwise` not `else`; `tools:` entries
  are bare **ToolGroup** names (`read`, `write`, `execute`, `browser`, `mcp`,
  `mode`, `subtasks`, `questions`, `uncategorized`).
- **Add a showcase workflow** → drop a `.slang` in `server/test/fixtures/`; the
  conformance test auto-parses, statically analyzes, and mock-runs it to
  convergence, so a non-converging fixture fails CI (give an intentionally
  non-converging one its own test).

## Docs

Current-state only — no changelogs / "previously". `DESIGN.md` and
`slang_specs.md` are the sources of truth; keep them in sync with code in the same
change.
