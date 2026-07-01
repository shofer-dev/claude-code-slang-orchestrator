# slang-workflows

Run deterministic, `.slang`-driven **multi-agent workflows** inside Claude Code.

A non-LLM state machine (the *slang executor*) runs inside an MCP server and coordinates
agents; each agent is a Claude **Agent SDK** session. The top-level Claude Code session only
*triggers* and *observes* runs — it never makes a coordination decision, so the workflow is a
provable state machine, not an LLM improvising orchestration.

> Design and rationale: [`DESIGN.md`](DESIGN.md). Language reference: [`slang_specs.md`](slang_specs.md).

## What works today

- Discover / validate / run `.slang` workflows (MCP tools below).
- Deterministic executor: stake → output-contract validation + retry → mailbox routing →
  convergence; **multi-agent** flows; **session resume** (one agent = one session across stakes);
  `escalate @Human`.
- Output contracts: **structural** (`output: {...}`, enforced via SDK `outputFormat`) +
  **semantic** (`where <expr>`).

See [`DESIGN.md` § Implementation Status](DESIGN.md#implementation-status) for the full matrix.

## Requirements

- **Node.js 22+** and **pnpm**.
- **Claude Code** installed and authenticated (the `claude` CLI on your `PATH`) — the Agent SDK
  spawns it to run agents.

## Install

```bash
cd server
pnpm install
```

> **Agent SDK note.** `@anthropic-ai/claude-agent-sdk` is declared as an *optional* dependency
> because some internal registries don't mirror it. If `pnpm install` skips it, add it from the
> public registry:
>
> ```bash
> pnpm add @anthropic-ai/claude-agent-sdk --registry=https://registry.npmjs.org/
> ```
>
> The server *parses/validates* workflows without it; *running* agents requires it.

Verify the install:

```bash
pnpm typecheck   # type-checks the whole server
pnpm test        # runs the unit suite (mock-based, no model calls)
```

## Use it

At runtime the server discovers `.slang` files in **your project's** `.claude/workflows/` (and
`~/.claude/workflows/`) — that's the user's space for their own workflows. The plugin ships
showcase workflows in [`server/test/fixtures/`](server/test/fixtures); copy them in to try them:

```bash
mkdir -p .claude/workflows
cp /PATH/TO/slang-orchestrator/server/test/fixtures/*.slang .claude/workflows/
```

### Quickest: register the MCP server with Claude Code

From the project whose `.claude/workflows/` you want to run:

```bash
claude mcp add slang-workflows -- npx tsx /ABSOLUTE/PATH/TO/slang-orchestrator/server/src/main.ts
```

Then in Claude Code, ask it to use the tools — e.g. *"list the slang workflows"*, *"run the
where-clause workflow"*.

### As a Claude Code plugin

This directory is a self-contained plugin: [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json)
+ [`.mcp.json`](.mcp.json) (a stdio server launched as `npx tsx ${CLAUDE_PLUGIN_ROOT}/server/src/main.ts`).
Install it through Claude Code's plugin mechanism to expose the tools automatically.

## MCP tools

| Tool | Purpose |
|------|---------|
| `list_workflows` | Discover `.slang` files (name, title, params, agent count). |
| `get_slang_grammar` | Concise grammar cheatsheet + example, so an LLM can **generate** a workflow to run inline. |
| `validate_workflow` | Parse + static analysis (deadlocks, unknown refs, orphan outputs) without running. Accepts a `name`/`path` **or** inline `source`. |
| `run_workflow` | Run a workflow by `name`/`path` **or** inline `source` (rejects parse/static-analysis errors first). Synchronous by default; `background:true` returns a `workflow_id` immediately to poll live. |
| `get_workflow_state` | Serialized `FlowState` (per-agent status, round, budget) by `workflow_id` — live during a `background` run. |
| `get_topology` | Run topology as a Mermaid **flowchart** (status-colored snapshot) by `workflow_id`. |
| `get_trace` | Execution **trace** as a Mermaid **sequenceDiagram** + raw event log (who staked/routed to whom, commits, escalations, terminal) by `workflow_id`. |

**Generate-and-run loop:** `get_slang_grammar` → author slang → `validate_workflow{source}` → `run_workflow{source, background:true}` → poll `get_topology` / `get_trace` while it runs. The workflow is authored by an LLM but **executed deterministically** (contracts enforced, always terminates). `@Human` escalation works in synchronous runs only (interactive elicitation needs the tool call to stay open).

## Develop

```bash
pnpm dev        # run the server over stdio (logs to stderr)
pnpm typecheck  # tsc --noEmit
pnpm test       # node:test suite
```

The executor depends only on a `Dispatcher` interface; `FakeDispatcher` makes the whole VM
testable without the Agent SDK or any model calls (see [`server/test/`](server/test)).

## Layout

```
.claude-plugin/plugin.json   plugin manifest
.mcp.json                    stdio MCP server declaration
server/
  src/
    main.ts                  MCP server + tool surface
    executor.ts              deterministic round loop + output contracts
    dispatcher.ts            Dispatcher interface + FakeDispatcher (the agent-runtime seam)
    agent-sdk-dispatcher.ts  production backend (Claude Agent SDK)
    tool-group-map.ts        slang tool-groups → Claude Code tools
    workflows.ts             .slang discovery + validation
    slang/                   vendored, framework-agnostic slang VM (lexer/parser/interpreter/…)
  test/                      node:test unit + conformance suite
    fixtures/                showcase .slang workflows (also the conformance fixtures)
```

## License

MIT.
