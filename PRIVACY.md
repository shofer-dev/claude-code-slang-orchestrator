# Privacy Policy — slang-workflows (Claude Code plugin)

_Last updated: 2026-07-05_

slang-workflows is an open-source Claude Code plugin published by **shofer.dev**. It runs entirely on
**your own machine** as a local MCP server: a non-LLM executor (the *slang executor*) that coordinates
one or more **Claude Agent SDK** sessions according to a workflow you declare in a `.slang` file. This
policy describes what data it touches, what leaves your machine, and what is stored.

**Short version:** the plugin author (shofer.dev) collects **nothing**. There is no telemetry, no
analytics, and no server operated by shofer.dev that receives your data. The only data that leaves your
machine goes to **Anthropic**, via the Claude Agent SDK, using your existing Claude Code authentication —
exactly as a normal Claude Code session does.

## What the plugin accesses

- **Your `.slang` workflow files** and the prompts/instructions you put in them.
- **Workspace files** that the agents in your workflow read or edit while doing the work you asked for.

The executor itself is a deterministic, **non-LLM** state machine — it makes coordination decisions
locally and makes no model calls of its own.

## What the agents can do to your files

Unlike a read-only tool, the agents a workflow runs are ordinary **Claude Agent SDK** sessions that can
**read and modify files** in your workspace to accomplish their tasks. You constrain them in the `.slang`
file: `write_paths:` restricts which paths an agent may Write/Edit and `deny:` removes tools (e.g.
`Bash`), enforced through the SDK's `canUseTool` control. Scope each agent to only what it needs.

## What leaves your machine, and to whom

To run the agents, the Claude Agent SDK sends the relevant **prompts and workspace context** to
**Anthropic** (Claude), authenticated with **your existing Claude Code credentials / subscription** — the
same trust boundary as any Claude Code session. That data is processed by Anthropic under **their**
privacy policy and your account terms; shofer.dev never receives a copy.

The plugin makes **no other network calls** — no third-party analytics or telemetry, and no service
operated by shofer.dev. If you point the underlying Agent SDK at a different or local model, data goes
there instead, under that provider's terms.

## What is stored, and where

Per-run **execution traces** (the event log used to render the topology and sequence diagrams via the
`get_trace` / `get_topology` tools) are held **in memory for the duration of the server process** and
returned to your session on request. The plugin does not upload your runs anywhere, and does not persist
them to any remote service. Any files created or changed during a run are the **agents' own work in your
workspace**, under your version control — not hidden plugin storage.

## Your controls

- **Define the workflow and its tool-scoping** (`write_paths` / `deny`) in the `.slang` file — you decide
  what each agent may touch.
- **Inspect** any run live with `get_trace`, `get_topology`, `get_workflow_state`.
- **Stop** a workflow / the server to end all activity; **uninstall** the plugin with `/plugin uninstall`.
- Review changes the agents made through your normal git workflow before committing.

## Children

slang-workflows is a developer tool and is not directed to children under 13.

## Changes

Material changes to this policy will be reflected in this file in the plugin's repository, with an
updated date.

## Contact

Questions or concerns: open an issue at
<https://github.com/shofer-dev/claude-code-slang-orchestrator/issues> or contact shofer.dev.
