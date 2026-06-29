// Arm B — LLM-orchestrated (Driver). Same three role-agents as arm A (parsed from the
// SAME workflow, so identical tools/role/write_paths), same worktree, same feature — but
// instead of the deterministic slang executor deciding who runs when and when it's done,
// an LLM "driver" decides each step. We measure the driver's own coordination tokens
// (arm A ≈ 0) and its protocol fidelity (does it actually design→implement→review, or drift
// — skip the review / finish early?).
//   npx tsx benchmark/harness/driver.ts <slang> <paramsJSON> <worktree-cwd>
import { readFileSync, mkdirSync } from "node:fs"
import { parseSlang } from "../../server/src/slang/slang-parser.js"
import { AgentSdkDispatcher, sdkQuery as query } from "../../server/src/agent-sdk-dispatcher.js"
import type { SdkOptions as Options } from "../../server/src/agent-sdk-dispatcher.js"
import { resolveAllowedTools } from "../../server/src/tool-group-map.js"
import { toolGroups } from "../../server/src/slang/tool-groups.js"
import type { AgentDecl } from "../../server/src/slang/slang-ast.js"

const flowPath = process.argv[2]
const params: Record<string, string> = process.argv[3] ? JSON.parse(process.argv[3]) : {}
const cwd = process.argv[4] ?? process.cwd()
const MAX_STEPS = Number(process.env.DRIVER_MAX_STEPS) || 20
const STAKE_TIMEOUT_MS = Number(process.env.STAKE_TIMEOUT_MS) || 300_000
const DRIVER_CWD = "/tmp/slang/driver" // neutral cwd (small dir → control-protocol-free path unaffected)
mkdirSync(DRIVER_CWD, { recursive: true })

const { ast, errors } = parseSlang(readFileSync(flowPath, "utf8"))
if (errors.length) { console.error("PARSE:", errors.join("\n")); process.exit(2) }
const flow = ast.flows[0]!
const interp = (s: string | undefined) => (s ?? "").replace(/\$\{(\w+)\}/g, (_, k) => params[k] ?? "")

// Extract the role-agents from the workflow → identical config to arm A.
const validGroups = new Set<string>(toolGroups)
const agents = new Map<string, { allowedTools: string[]; deny?: string[]; writePaths?: string[]; role?: string }>()
for (const item of flow.body) {
  if (item.type !== "AgentDecl") continue
  const d = item as AgentDecl
  agents.set(d.name, {
    allowedTools: resolveAllowedTools((d.meta.tools ?? []).filter((t) => validGroups.has(t)) as never),
    deny: d.meta.deny,
    writePaths: d.meta.writePaths,
    role: interp(d.meta.role),
  })
}
const ACTION_TO_AGENT: Record<string, string> = { run_architect: "Architect", run_developer: "Developer", run_reviewer: "Reviewer" }

if (process.env.DRIVER_DRY) {
  for (const [n, c] of agents) console.error(`${n}: tools=[${c.allowedTools.join(",")}] deny=${JSON.stringify(c.deny)} writePaths=${JSON.stringify(c.writePaths)} role="${(c.role ?? "").slice(0, 50)}..."`)
  process.exit(0)
}

const dispatcher = new AgentSdkDispatcher(process.env.CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.CLAUDE_BIN } : {})
const sessions = new Map<string, string>() // resume each role-agent across calls (like arm A)

const DECISION = {
  type: "object",
  properties: {
    next_action: { type: "string", enum: ["run_architect", "run_developer", "run_reviewer", "finish"] },
    instructions: { type: "string", description: "Concise instructions for the chosen specialist (ignored for finish)." },
    rationale: { type: "string" },
  },
  required: ["next_action", "instructions", "rationale"],
  additionalProperties: false,
} as const

const DESIGN_PATH = interp(params.design_path ? "${design_path}" : "plans/feature-design.md")
const DRIVER_SYS = `You orchestrate a small team implementing ONE software feature in a real repo. You invoke ONE specialist at a time and decide the order yourself:
- run_architect — writes a design document (.md only; CANNOT write code).
- run_developer — implements the code per the design, slice by slice, with tests.
- run_reviewer — reviews the developer's work against the design and reports pass/issues.

STARTING STATE: the repo is CLEAN for this feature — there is NO design document and NO implementation yet. Nothing has been done until you invoke a specialist and it reports back. Do NOT assume any step is already complete; trust ONLY the specialists' actual results, never an assumption that work "already exists." The architect must CREATE the design at EXACTLY ${DESIGN_PATH} (it does not exist until then); the developer then implements the code; the reviewer then checks it.

Each step: pick next_action and give that specialist concise instructions (include all context they need — they see ONLY what you tell them, plus the repo files). When the feature is fully implemented (code files actually written) AND has been reviewed, choose "finish". Do not finish before the work has actually been implemented and reviewed by the specialists.`

let driverSession: string | undefined
const tok = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
async function driverDecide(userPrompt: string) {
  const options: Options = {
    cwd: DRIVER_CWD, allowedTools: [], permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
    model: "sonnet", systemPrompt: { type: "preset", preset: "claude_code", append: DRIVER_SYS },
    outputFormat: { type: "json_schema", schema: DECISION as never },
  }
  if (process.env.CLAUDE_BIN) options.pathToClaudeCodeExecutable = process.env.CLAUDE_BIN
  if (driverSession) options.resume = driverSession
  let decision: { next_action: string; instructions: string; rationale: string } | undefined
  for await (const m of query({ prompt: userPrompt, options })) {
    const mm = m as Record<string, unknown>
    if (mm.type === "system" && (mm as { subtype?: string }).subtype === "init") driverSession = (mm as { session_id?: string }).session_id ?? driverSession
    if (mm.type === "result") {
      const u = (mm as { usage?: Record<string, number> }).usage ?? {}
      tok.input += u.input_tokens ?? 0; tok.output += u.output_tokens ?? 0
      tok.cache_read += u.cache_read_input_tokens ?? 0; tok.cache_write += u.cache_creation_input_tokens ?? 0
      const raw = (mm as { result?: string }).result ?? ""
      try { decision = JSON.parse(raw) } catch { /* fall through */ }
    }
  }
  return decision
}

void (async () => {
  const t0 = Date.now()
  const actions: string[] = []
  let converged = false
  let last = `Begin. The repo is in a CLEAN state — no design document and no implementation for this feature exist yet; you are starting from scratch. The feature to deliver:\n${params.feature ?? ""}\nDecide the first action.`
  for (let step = 0; step < MAX_STEPS; step++) {
    const decision = await driverDecide(last)
    if (!decision) { console.error(`[driver] step ${step}: no decision (driver failed)`); break }
    console.error(`[driver] step ${step}: ${decision.next_action} — ${decision.rationale.slice(0, 80)}`)
    if (decision.next_action === "finish") { converged = true; break }
    const agentName = ACTION_TO_AGENT[decision.next_action]
    const cfg = agentName ? agents.get(agentName) : undefined
    if (!cfg) { last = `Unknown action. Choose run_architect|run_developer|run_reviewer|finish.`; continue }
    actions.push(agentName)
    const res = await dispatcher.runStake({
      agentName, prompt: decision.instructions, sessionId: sessions.get(agentName),
      allowedTools: cfg.allowedTools, disallowedTools: cfg.deny, writePaths: cfg.writePaths,
      model: "sonnet", systemPrompt: cfg.role, cwd, timeoutMs: STAKE_TIMEOUT_MS,
    })
    if (res.sessionId) sessions.set(agentName, res.sessionId)
    const out = res.structured !== undefined ? JSON.stringify(res.structured) : res.result
    console.error(`   -> @${agentName} ${res.error ? "ERR:" + res.error : String(out).slice(0, 90)}`)
    last = res.error
      ? `The ${agentName} step failed (${res.error}). Decide the next action.`
      : `The ${agentName} returned:\n${String(out).slice(0, 4000)}\n\nDecide the next action (or finish if the feature is implemented AND reviewed).`
  }
  // protocol fidelity
  const lastDev = actions.lastIndexOf("Developer")
  const reviewedFinalWork = actions.lastIndexOf("Reviewer") > lastDev && lastDev >= 0
  const summary = {
    arm: "driver", converged, steps: actions.length, actions,
    ran: { architect: actions.includes("Architect"), developer: actions.includes("Developer"), reviewer: actions.includes("Reviewer") },
    reviewed_final_work: reviewedFinalWork, // reviewer ran after the last developer step
    driver_tokens: tok, driver_tokens_total: tok.input + tok.output + tok.cache_read + tok.cache_write,
    elapsed_s: Math.round((Date.now() - t0) / 1000),
  }
  console.error("=== DRIVER SUMMARY ===")
  console.log(JSON.stringify(summary))
})()
