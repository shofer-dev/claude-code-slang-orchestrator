---
description: Show the topology + sequence-diagram trace of a slang run
argument-hint: "[workflow_id]"
allowed-tools: mcp__slang-workflows__get_trace, mcp__slang-workflows__get_topology, mcp__slang-workflows__get_workflow_state
---

Render diagrams for the slang run identified by `$ARGUMENTS`. If no id is given, use the most recent run started in this session.

1. Call `get_trace` for the workflow id and render its Mermaid sequence diagram + event log inline.
2. Call `get_topology` and render the current (or final) round topology.
3. Briefly summarize what happened — who staked to whom, any escalations, and the terminal status (use `get_workflow_state` if more detail helps).
