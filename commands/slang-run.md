---
description: Run a .slang multi-agent workflow to completion (contract-enforced, human-gated)
argument-hint: "<workflow-name-or-.slang-path> [param=value ...]"
allowed-tools: mcp__slang-workflows__run_workflow, mcp__slang-workflows__list_workflows, mcp__slang-workflows__get_trace
---

Start the slang workflow the user asked for: `$ARGUMENTS`

The first token is the workflow identifier; any following `key=value` pairs are workflow params.

1. **Resolve the workflow.** If the identifier contains `/` or ends in `.slang`, you'll run it by `path`; otherwise it's a `name`. If none was given, or the name is ambiguous, call `list_workflows` and ask the user which one to run.
2. **Gather required inputs BEFORE running.** Call `list_workflows` to see the chosen flow's declared `params`. For every param that has no `default` and was **not** supplied as a `key=value` arg, ask the user for it now, in this conversation — do **not** run with it missing: `run_workflow` does not prompt for params, and an unfilled `${param}` is left **verbatim** in the agents' prompts and breaks the run. Collect these answers plus the provided `key=value` pairs into the `params` object.
3. **Run** `run_workflow` with the `name`/`path` and `params`, **synchronously** (do NOT pass `background:true`) — so any `escalate @Human` step, including a workflow that collects input via an initial `form:`, can prompt the user through this conversation. Relay each escalation's reason/choices and continue the run with the user's answer.
4. When it finishes, summarize the terminal status and each agent's committed output, and offer to render the run diagram with `get_trace`.
