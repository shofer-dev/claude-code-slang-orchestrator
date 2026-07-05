---
description: Run a .slang multi-agent workflow to completion (contract-enforced, human-gated)
argument-hint: "<workflow-name-or-.slang-path> [param=value ...]"
allowed-tools: mcp__slang-workflows__run_workflow, mcp__slang-workflows__list_workflows, mcp__slang-workflows__get_trace
---

Start the slang workflow the user asked for: `$ARGUMENTS`

The first token is the workflow identifier; any following `key=value` pairs are workflow params.

1. If the identifier contains `/` or ends in `.slang`, call `run_workflow` with `path` set to it. Otherwise treat it as a workflow `name` and call `run_workflow` with that `name`. If no identifier was given, or the name is ambiguous, call `list_workflows` first and ask the user which one to run.
2. Collect any `key=value` arguments into the `params` object.
3. Run **synchronously** — do NOT pass `background:true` — so an `escalate @Human` step can prompt the user through this conversation. When the workflow escalates, relay its reason and choices to the user, then continue the run with their answer.
4. When it finishes, summarize the terminal status and each agent's committed output, and offer to render the run diagram with `get_trace`.
