# slang-workflows — MCP server

Provable, declarative **multi-agent workflows for Claude Code**. A non-LLM executor runs a typed
`.slang` file with **enforced** output contracts, static analysis, per-agent tool-scoping, provable
termination, and auto-generated Mermaid topology + trace diagrams.

This is the server behind the [slang-workflows Claude Code plugin](https://github.com/shofer-dev/claude-code-slang-orchestrator).
It runs inside Claude Code — each agent is a **Claude Agent SDK** session, so the **`claude` CLI must be
installed** and authenticated.

```bash
npx slang-workflows          # stdio MCP server
```

Docs: https://github.com/shofer-dev/claude-code-slang-orchestrator · Apache-2.0.
