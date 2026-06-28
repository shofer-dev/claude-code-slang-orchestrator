// Probe: does the SDK's canUseTool callback fire for an autonomous inner agent, and can
// it DENY a write by inspecting the path? Tests both permission modes, since the dispatcher
// currently uses bypassPermissions (which may skip canUseTool). Decides whether write_paths
// can be enforced via canUseTool.
//   npx tsx benchmark/harness/probe-canusetool.ts
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { mkdtempSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function run(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "canuse-"))
  const calls: string[] = []
  const canUseTool = async (toolName: string, input: Record<string, unknown>) => {
    const path = String(input.file_path ?? input.path ?? "")
    calls.push(`${toolName}(${path})`)
    if ((toolName === "Write" || toolName === "Edit") && path && !path.endsWith(".md")) {
      return { behavior: "deny" as const, message: "architect may only write .md files" }
    }
    return { behavior: "allow" as const, updatedInput: input }
  }
  const options: Options = {
    cwd: dir,
    // Write is NOT pre-allowed (allowedTools pre-approves & bypasses canUseTool) — so the
    // write goes through canUseTool, where we scope it by path. Read stays freely allowed.
    allowedTools: ["Read"],
    permissionMode: mode as any,
    canUseTool,
  }
  try {
    for await (const msg of query({ prompt: "Create a file named foo.ts in the current directory containing the text hello. Then stop.", options })) {
      void msg
    }
  } catch (e) { calls.push(`THREW:${(e as Error).message.slice(0, 60)}`) }
  const wrote = existsSync(join(dir, "foo.ts"))
  rmSync(dir, { recursive: true, force: true })
  console.log(`mode=${mode.padEnd(18)} canUseTool fired=${calls.length > 0} (${calls.join(", ").slice(0, 90)}) | foo.ts written=${wrote}  => ${calls.length > 0 && !wrote ? "ENFORCED ✓" : "NOT enforced"}`)
}

void (async () => {
  for (const mode of ["default", "bypassPermissions"]) await run(mode)
})()
