# Testing the slang-workflows plugin

Layers, fastest first: **type-check → automated tests (no model calls) → manual real-model
runs**. The automated tests mock at two seams — the `Dispatcher` interface (most tests) and
the SDK `query()` boundary (the dispatcher integration test) — so the whole suite runs with no
API key, no `claude` CLI, and no cost. The **manual** layer (§ 3) is the part that still needs
you — it hasn't been run yet.

## 0. Setup

```bash
cd claude-code/slang-orchestrator/server
pnpm install
# If the Agent SDK was skipped by your registry, add it from public npm
# (only needed for real model runs, not for the automated tests):
pnpm add @anthropic-ai/claude-agent-sdk --registry=https://registry.npmjs.org/
```

## 1. Type-check

```bash
pnpm typecheck     # tsc --noEmit over the whole server
```

## 2. Automated tests — no model calls, no cost

```bash
pnpm test          # 57 tests
```

No API key, no `claude` CLI, no network. The tests mock at two different seams:

**A. Logic tests — mock the `Dispatcher` interface (`FakeDispatcher`).** They bypass the Agent
SDK entirely and exercise the deterministic executor.

| Suite | What it covers |
|-------|----------------|
| `test/contract.test.ts` | `validateContract` (valid / non-JSON / missing / wrong-type / fenced / no-schema) and `contractToJsonSchema`. |
| `test/tool-group-map.test.ts` | slang tool-groups → Claude Code tools (each group, `mcp` expansion, empties, de-dup). |
| `test/executor.test.ts` | Executor loop: contract retry, `where` reject→accept, retry-exhaustion → error, multi-agent routing, escalate ±handler, session-resume threading. |
| `test/conformance.test.ts` | **Every workflow in `server/test/fixtures/`** is parsed, statically analyzed, and **run to convergence** under a schema-conforming mock. |
| `test/inline-source.test.ts` | Inline/generated workflows: `analyzeSource` (valid / parse errors / hard static errors), inline generate→validate→run, `eventsToSequenceDiagram` (the `get_trace` diagram), and `onStart` exposing the live `FlowState` (background polling). |

**B. Boundary integration test — mock the SDK `query()`.** This is the seam where control is
handed to the Agent SDK; it injects a fake `query()` and pins both edges of that call.

| Suite | What it covers |
|-------|----------------|
| `test/agent-sdk-dispatcher.test.ts` | **Outbound:** `StakeRequest` → SDK `Options` (cwd, allowedTools, `bypassPermissions`, model, append-preset system prompt, `resume`, `outputFormat`, `pathToClaudeCodeExecutable`; unset fields omitted) — plus `deny` → `disallowedTools`, `write_paths` → PreToolUse command-hook + `SLANG_WRITE_PATHS` env (`globToRegExp`), and per-stake timeout / time-budget prompt note. **Inbound:** SDK message stream → `StakeResult` (session-id capture, success `result` + `structured_output`, error-subtype mapping, no-result error). |

> **What the automated tests do NOT cover** — by design; these need § 3:
> - Anything *inside* `query()` — the real CLI, API, model, and `outputFormat` enforcement.
> - **SDK protocol drift** — the boundary test encodes our *assumptions* about the SDK's
>   message shapes; if the SDK changed them, the fake would still pass.
> - The **elicitation dialog** UI for `escalate @Human`.

### How the conformance test works

`test/conformance.test.ts` discovers `server/test/fixtures/*.slang` (the plugin's own showcase
workflows — distinct from the user's runtime `.claude/workflows/`) and, for each file, asserts it:

1. **parses** with zero errors,
2. **passes static analysis** (no `[error]` diagnostics — deadlocks, unknown refs, …),
3. **runs to `converged`** under a mock that returns a schema-conforming object for any output
   contract (`number→50`, `string→"value"`, `boolean→true`) and answers any `escalate @Human`
   with `"ACK"`.

So adding a `.slang` file to `server/test/fixtures/` automatically gets conformance-tested. If a
workflow can't converge under the generic mock (e.g. a `where` constraint the mock can't
satisfy, or a branch that never commits), the test fails and names the file + terminal status.

## 3. Manual tests — still to run ⚠️

These are the checks the automated suite **cannot** make: they need **real model calls** (cost
+ the authenticated `claude` CLI) and, for the last one, a **live Claude Code session**. None
have been run yet — this is the part that needs you.

### Register the server with Claude Code

The MCP server discovers workflows in the **current project's** `.claude/workflows/` (and
`~/.claude/workflows/`) — that directory is the *user's* space. To try the plugin's bundled
showcase workflows, copy them into your project first:

```bash
mkdir -p .claude/workflows
cp claude-code/slang-orchestrator/server/test/fixtures/*.slang .claude/workflows/
```

Then register the server (run Claude Code from that project so the server's cwd is the project root):

```bash
claude mcp add slang-workflows -- npx tsx /ABSOLUTE/PATH/TO/claude-code/slang-orchestrator/server/src/main.ts
```

### Checklist — drive it from a Claude Code session

- [ ] **`list_workflows`** — *"list the slang workflows"* → returns the 8 workflows you copied in.
- [ ] **`validate_workflow`** — *"validate the pipeline workflow"* → reports no errors.
- [ ] **`run_workflow` (single agent + `where`)** — *"run the where-clause workflow"* →
      `status: converged` with output like `{ "score": 82, "reason": "…" }`. Confirms the
      structural + semantic (`where`) contract end-to-end through the real SDK.
- [ ] **`run_workflow` (multi-agent + resume)** — *"run the pipeline workflow"* → `Producer`
      emits `{n:21}`, routed to `Worker`, which returns `{doubled:42}`. Confirms stake routing,
      `await`, `${...}` interpolation, and session resume through real models.
- [ ] **`escalate @Human` elicitation** — *"run the escalation workflow"* → an **elicitation
      dialog** with **ACK / Reject** buttons should pop. Confirm it appears and that your choice
      drives the commit (`approved` vs `rejected`). **This is the single path no automated test
      can reach** (the dialog lives in the live client).

### Or run a workflow directly (no MCP client)

```bash
cd claude-code/slang-orchestrator/server
# quick smoke via tsx (writes a tiny script, or adapt one of the test files)
pnpm dev        # starts the stdio server; logs to stderr
```

## 4. Pre-push gate (blocks pushes on failing tests)

A husky `pre-push` hook runs **type-check + the full test suite** and **blocks the push on any
failure**. It lives at [`.husky/pre-push`](.husky/pre-push) and runs `pnpm typecheck && pnpm test`
in `server/`.

**Activation.** The hook installs itself via the root [`package.json`](package.json) `prepare`
script, but **only when this folder is its own git repo** (the standalone publish). In a nested
checkout with no `.git` here, `prepare` skips husky and no outer hooks are touched.

- **Standalone repo:** `pnpm install` at the plugin root installs husky and wires the hook;
  every `git push` then gates on the suite.
- **Run it manually any time:** `sh .husky/pre-push` (equivalently `cd server && pnpm typecheck && pnpm test`).

> Verified: the hook passes the 40-test suite and exits non-zero on any failure. The one thing
> that can't be verified inside the monorepo is husky's *auto-install* into a standalone `.git`
> — that only happens once the plugin is checked out as its own repository.

## Feature coverage map

Each bundled workflow (in `server/test/fixtures/`) targets specific slang features:

| Workflow | Features exercised |
|----------|--------------------|
| `01-hello-world` | stake, commit, `converge when: @Agent.committed`, budget |
| `02-output-contracts` | structural output (`string`/`number`/`boolean`), named + list args, `tools:` meta |
| `03-where-clause` | **`where` semantic assertion (plugin extension)**, `&&`, comparison operators |
| `04-pipeline` | multi-agent, stake routing `-> @Agent`, `await`, `${...}` interpolation + dot-access, `&&` converge |
| `05-broadcast` | `-> @all` broadcast, `await <- @any` wildcard, `all_committed` |
| `06-branching` | `let`/`set`, `when … otherwise`, `contains`, `commit … if` |
| `07-repeat-loop` | `repeat until`, `let`/`set`, loop-carried stake (slang has **no arithmetic** — loops use boolean flags) |
| `08-escalation` | `escalate @Human`, `choices:`, `await <- @Human`, `contains`, branch |

## Adding workflows

- **A conformance-tested example/fixture:** drop a `.slang` file in `server/test/fixtures/`.
  `pnpm test` parses, validates, and mock-runs it automatically. If it doesn't converge under
  the generic mock, the failure names the file and its terminal status (`deadlock`, `error`,
  `budget_exceeded`) — fix the flow, or give an intentionally non-converging fixture its own
  targeted test instead of relying on conformance.
- **Your own runtime workflow:** drop a `.slang` file in your project's `.claude/workflows/`
  (the user space). The MCP server discovers it at runtime; check it with `validate_workflow`.

> **Language note:** slang is a *coordination* language — no arithmetic, no string building
> beyond `${...}` interpolation. Logic is expressed with `let`/`set`, comparisons, `contains`,
> `&&`/`||`, `when`/`otherwise`, and `repeat until`. See [`slang_specs.md`](slang_specs.md).
