---
description: Generate a .slang workflow from a plain-English description and run it
argument-hint: "<what the workflow should do>"
allowed-tools: mcp__slang-workflows__get_slang_grammar, mcp__slang-workflows__validate_workflow, mcp__slang-workflows__run_workflow, Read
---

The user wants a slang workflow for: `$ARGUMENTS`

1. Call `get_slang_grammar` to load the exact `.slang` syntax before writing anything.
2. Author a workflow that accomplishes the request: declare each agent with its `tools:` and `role:` (scope writers with `write_paths` / `deny` where safety matters), define stakes with `output:` contracts and mailbox routing (`-> @Agent`), add an `escalate @Human` approval gate if the task warrants sign-off, and set a `converge when:` condition plus a `budget: rounds(N)`.
3. Validate the source with `validate_workflow` (pass it as `source`). Fix any parse or static-analysis errors it reports, then re-validate.
4. Show the user the generated `.slang` and a one-line plan of what it will do. Then run it with `run_workflow` (pass the validated `source`), **synchronously** so `escalate @Human` works.
