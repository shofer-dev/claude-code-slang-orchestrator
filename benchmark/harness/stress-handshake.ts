// Stress the implement-feature coordination with REALISTIC-but-valid agent behaviors
// (the review loop actually iterating: Reviewer rejects K times before approving) to
// flush out executor/language bugs the idealized happy-path repro can't trigger.
//   npx tsx benchmark/harness/stress-handshake.ts <abs-path-to.slang>
import { readFileSync } from "node:fs"
import { parseSlang } from "../../server/src/slang/slang-parser.js"
import { runWorkflow, type EscalationRequest } from "../../server/src/executor.js"
import { FakeDispatcher } from "../../server/src/dispatcher.js"

const flowPath = process.argv[2]
const { ast, errors } = parseSlang(readFileSync(flowPath, "utf8"))
if (errors.length) { console.error("PARSE:", errors.join("\n")); process.exit(2) }
const flow = ast.flows[0]!
const onEscalate = async (_r: EscalationRequest) => JSON.stringify({ decision: "I approve", feedback: "", instructions: "" })

// Build a responder where the Reviewer rejects its first `rejectRounds` per-round verdicts,
// then approves (and always approves the final review). Models a real, iterating review loop.
function makeResponder(rejectRounds: number) {
  let perRoundVerdicts = 0
  let final = false
  return (req: { agentName: string; prompt: string }): string => {
    const a = req.agentName
    const p = req.prompt.toLowerCase()
    if (a === "Developer") return p.includes("all design items are implemented")
      ? JSON.stringify({ done: true, summary: "done" })
      : JSON.stringify({ done: false, summary: "slice" })
    if (a === "Reviewer") {
      // The per-round verdicts come before the final one. Reject the first `rejectRounds`.
      if (final) return JSON.stringify({ approved: true, issues: "" })
      perRoundVerdicts++
      const approve = perRoundVerdicts > rejectRounds
      return JSON.stringify({ approved: approve, issues: approve ? "" : `nit #${perRoundVerdicts}` })
    }
    if (a === "Architect") {
      if (p.includes("forward this round")) return JSON.stringify({ complete: false, details: "work" })
      if (p.includes("accepted this round")) return JSON.stringify({ accepted: true, details: "passed" })
      if (p.includes("found issues")) return JSON.stringify({ accepted: false, details: "fix" })
      if (p.includes("final comprehensive review")) { final = true; return JSON.stringify({ complete: false, details: "final" }) }
      if (p.includes("terminal signal")) return JSON.stringify({ complete: true, details: "stop" })
      return "handoff"  // create_design / implement / prepare_to_review (no contract)
    }
    return "{}"
  }
}

// Adversarial-but-VALID patterns a real LLM agent plausibly produces.
function patterns(): Record<string, (req: { agentName: string; prompt: string }) => string> {
  const base = makeResponder(0)
  return {
    "happy": base,
    "reject-1x": makeResponder(1),
    "reject-2x": makeResponder(2),
    // Developer sets done=true in progress_update (spec says done=false there). The
    // "terminate early" failure mode — both stakes share the {done,summary} schema.
    "dev-done-early": (req) => req.agentName === "Developer"
      ? JSON.stringify({ done: true, summary: "I think I'm done" })
      : base(req),
    // Reviewer never approves (keeps finding nits). Should hit the budget and TERMINATE,
    // not hang. (A real, fallible reviewer.)
    "reviewer-never-approves": (req) => req.agentName === "Reviewer"
      ? JSON.stringify({ approved: false, issues: "more nits" })
      : base(req),
  }
}

void (async () => {
  for (const [name, responder] of Object.entries(patterns())) {
    let finalState: any
    try {
      const { result, flowState } = await runWorkflow(flow, { feature: "x", design_path: "plans/d.md" },
        new FakeDispatcher(responder), { cwd: "/tmp", onEscalate, maxRounds: 80 })
      const r = result as any
      const stuck = (r.agents ?? []).filter((a: any) => a.status !== "committed").map((a: any) => `${a.name}:${a.status}`).join(",")
      const ok = r.status === "converged"
      const terminated = r.status === "converged" || r.status === "budget_exceeded"
      console.log(`${name.padEnd(24)} status=${r.status} rounds=${r.rounds}  ${ok ? "CONVERGED" : terminated ? "terminated(" + (stuck || "-") + ")" : "*** " + r.status + " ***"}`)
    } catch (e) {
      console.log(`${name.padEnd(24)} *** THREW: ${(e as Error).message.slice(0, 80)} ***`)
    }
  }
})()
