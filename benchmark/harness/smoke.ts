// Headless real-run smoke for the slang executor: parse a .slang, run it through the
// REAL AgentSdkDispatcher (spawns actual claude agents), auto-answer any @Human
// escalation, print the result + final state. Validates the path the unit tests mock.
//   npx tsx benchmark/harness/smoke.ts <abs-path-to.slang> [paramsJSON] [cwd]
import { readFileSync } from "node:fs"
import { parseSlang } from "../../server/src/slang/slang-parser.js"
import { runWorkflow, type EscalationRequest } from "../../server/src/executor.js"
import { AgentSdkDispatcher } from "../../server/src/agent-sdk-dispatcher.js"
import { serializeFlowState } from "../../server/src/slang/slang-types.js"

const flowPath = process.argv[2]
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {}
const cwd = process.argv[4] ?? process.cwd()

const { ast, errors } = parseSlang(readFileSync(flowPath, "utf8"))
if (errors.length) { console.error("PARSE ERRORS:\n" + errors.join("\n")); process.exit(2) }
const flow = ast.flows[0]
if (!flow) { console.error("No flow in source"); process.exit(2) }

let escalations = 0
const onEscalate = async (req: EscalationRequest): Promise<string> => {
  escalations++
  const ans: Record<string, unknown> = {}
  if (req.form?.length) {
    for (const f of req.form) {
      ans[f.name] = f.options?.[0] ?? (f.paramType === "boolean" ? true : f.paramType === "number" ? 0 : "I approve")
    }
  } else if (req.choices?.length) ans.answer = req.choices[0]
  else ans.answer = "I approve"
  console.error(`[escalate #${escalations}] agent=${req.agent} -> ${JSON.stringify(ans)}`)
  return JSON.stringify(ans)
}

void (async () => {
  const t0 = Date.now()
  try {
    const dispatcher = new AgentSdkDispatcher()
    const { result, flowState } = await runWorkflow(flow, params, dispatcher, { cwd, defaultModel: "sonnet", onEscalate })
    console.log("=== RESULT ===")
    console.log(JSON.stringify(result, null, 2))
    console.log("=== STATE (status/round/agents) ===")
    const s = serializeFlowState(flowState) as any
    console.log(JSON.stringify({ status: s.status, round: s.round, agents: Object.fromEntries(Object.entries(s.agents ?? {}).map(([k, v]: any) => [k, v.status])) }, null, 2))
    console.log(`ELAPSED_S=${((Date.now() - t0) / 1000).toFixed(1)} ESCALATIONS=${escalations}`)
  } catch (e) {
    console.error("RUN FAILED:", (e as Error).stack ?? (e as Error).message)
    process.exit(1)
  }
})()
