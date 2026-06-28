// Deterministic repro of implement-feature.slang's coordination with a FakeDispatcher
// scripting the INTENDED agent outputs. If this converges, the executor is fine and the
// real-run livelock was the agents producing wrong outputs. If it livelocks, it's an
// executor/interpreter bug (and the dispatch-sequence trace pinpoints it).
//   npx tsx benchmark/harness/repro-handshake.ts <abs-path-to-implement-feature.slang>
import { readFileSync } from "node:fs"
import { parseSlang } from "../../server/src/slang/slang-parser.js"
import { runWorkflow, type EscalationRequest } from "../../server/src/executor.js"
import { FakeDispatcher } from "../../server/src/dispatcher.js"

const flowPath = process.argv[2]
const { ast, errors } = parseSlang(readFileSync(flowPath, "utf8"))
if (errors.length) { console.error("PARSE:", errors.join("\n")); process.exit(2) }
const flow = ast.flows[0]!

let n = 0
const responder = (req: { agentName: string; prompt: string }): string => {
  const a = req.agentName
  const p = req.prompt.toLowerCase()
  let stake = "?", out = "{}"
  const m = (s: string) => p.includes(s)
  if (a === "Developer") {
    if (m("all design items are implemented")) { stake = "done_signal"; out = JSON.stringify({ done: true, summary: "all done" }) }
    else { stake = "progress_update"; out = JSON.stringify({ done: false, summary: "slice" }) }
  } else if (a === "Reviewer") { stake = "review_verdict"; out = JSON.stringify({ approved: true, issues: "" }) }
  else if (a === "Architect") {
    if (m("create the design document")) { stake = "create_design"; out = "Design written to plans/feature-design.md" }
    else if (m("hand the approved design off")) { stake = "implement"; out = "Handoff: design at plans/feature-design.md" }
    else if (m("brief the reviewer")) { stake = "prepare_to_review"; out = "Reviewer briefed" }
    else if (m("forward this round")) { stake = "review_this_round"; out = JSON.stringify({ complete: false, details: "work to review" }) }
    else if (m("accepted this round")) { stake = "reviewer_accepted"; out = JSON.stringify({ accepted: true, details: "passed" }) }
    else if (m("found issues")) { stake = "fix_issues"; out = JSON.stringify({ accepted: false, details: "fix these" }) }
    else if (m("final comprehensive review")) { stake = "final_review"; out = JSON.stringify({ complete: false, details: "final" }) }
    else if (m("terminal signal")) { stake = "review_complete"; out = JSON.stringify({ complete: true, details: "stop" }) }
  }
  console.error(`#${++n} dispatch @${a} ${stake} -> ${out.slice(0, 60)}`)
  return out
}

const onEscalate = async (_req: EscalationRequest) => JSON.stringify({ decision: "I approve", feedback: "", instructions: "" })
const onEvent = (e: any) => { if (e.kind !== "stake" && e.kind !== "retry") console.error(`   [r${e.round}] ${e.kind}${e.agent ? " @" + e.agent : ""}`) }

void (async () => {
  const { result } = await runWorkflow(flow, { feature: "x", design_path: "plans/feature-design.md" },
    new FakeDispatcher(responder), { cwd: "/tmp", onEscalate, onEvent, maxRounds: 40 })
  console.error("=== STATUS:", (result as any).status, "rounds:", (result as any).rounds, "dispatches:", n)
})()
