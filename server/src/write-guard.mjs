#!/usr/bin/env node
// PreToolUse command hook: deny Write/Edit/MultiEdit to paths outside SLANG_WRITE_PATHS
// (':'-separated globs). Runs as a CLI-spawned command (no Agent-SDK control protocol),
// so it works under bypassPermissions and in cwds where canUseTool can't launch.
let data = ""
process.stdin.on("data", (c) => (data += c))
process.stdin.on("end", () => {
  let input
  try { input = JSON.parse(data) } catch { process.exit(0) }
  const tool = input.tool_name
  const ti = input.tool_input ?? {}
  const path = String(ti.file_path ?? ti.path ?? "")
  const globs = (process.env.SLANG_WRITE_PATHS ?? "").split(":").filter(Boolean)
  const toRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*") + "$")
  if (["Write", "Edit", "MultiEdit"].includes(tool) && path && globs.length && !globs.some((g) => toRe(g).test(path))) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `this agent may only write: ${globs.join(", ")}` },
    }))
  }
  process.exit(0)
})
