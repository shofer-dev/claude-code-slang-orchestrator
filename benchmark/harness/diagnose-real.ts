// Real-agent diagnostic run: wraps the real AgentSdkDispatcher to log EXACTLY what each
// agent emits per stake (the data we never captured), so a non-convergence shows which
// real output breaks the handshake. Now that budget + per-stake timeout are in, the run
// is guaranteed to terminate.
//   npx tsx benchmark/harness/diagnose-real.ts <slang> <paramsJSON> <cwd>
import { readFileSync } from "node:fs"
import { parseSlang } from "../../server/src/slang/slang-parser.js"
import { runWorkflow, type EscalationRequest } from "../../server/src/executor.js"
import { AgentSdkDispatcher } from "../../server/src/agent-sdk-dispatcher.js"
import type { Dispatcher, StakeRequest } from "../../server/src/dispatcher.js"

const flowPath = process.argv[2]
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {}
const cwd = process.argv[4] ?? process.cwd()
const { ast, errors } = parseSlang(readFileSync(flowPath, "utf8"))
if (errors.length) { console.error("PARSE:", errors.join("\n")); process.exit(2) }
const flow = ast.flows[0]!

const stakeOf = (p: string): string => {
  const s = p.toLowerCase()
  for (const [k, v] of [["only write .md", "create_design"], ["hand the approved design", "implement"], ["brief the reviewer", "prepare_to_review"], ["forward this round", "review_this_round"], ["accepted this round", "reviewer_accepted"], ["found issues", "fix_issues"], ["final comprehensive", "final_review"], ["terminal signal", "review_complete"], ["next slice", "progress_update"], ["all design items", "done_signal"], ["evaluate the implementation", "review_verdict"]] as const)
    if (s.includes(k)) return v
  return "?"
}

class Tracer implements Dispatcher {
  n = 0
  constructor(private inner: Dispatcher) {}
  async runStake(req: StakeRequest) {
    const stake = stakeOf(req.prompt)
    const res = await this.inner.runStake({ ...req, timeoutMs: Number(process.env.STAKE_TIMEOUT_MS) || 300_000 })
    const out = res.structured !== undefined ? JSON.stringify(res.structured) : (res.result || "").slice(0, 80)
    console.error(`#${++this.n} @${req.agentName} ${stake} -> ${String(out).slice(0, 100)}${res.error ? "  ERR:" + res.error : ""}`)
    return res
  }
}

const onEscalate = async (_r: EscalationRequest) => JSON.stringify({ decision: "I approve", feedback: "", instructions: "" })
const onEvent = (e: any) => { if (["committed", "converged", "budget", "deadlock", "error", "escalate"].includes(e.kind)) console.error(`   [r${e.round}] ${e.kind}${e.agent ? " @" + e.agent : ""}`) }

// The SDK auto-resolves a bundled `claude` that can mismatch this host's libc; pin the
// known-good system binary (CLAUDE_BIN) when provided.
const claudeBin = process.env.CLAUDE_BIN
void (async () => {
  const t0 = Date.now()
  const inner = new AgentSdkDispatcher(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {})
  const { result } = await runWorkflow(flow, params, new Tracer(inner),
    { cwd, defaultModel: "sonnet", onEscalate, onEvent })
  const r = result as any
  console.error(`=== STATUS: ${r.status} rounds:${r.rounds} elapsed:${((Date.now() - t0) / 1000).toFixed(0)}s`)
  console.error("agents:", JSON.stringify((r.agents ?? []).map((a: any) => ({ n: a.name, s: a.status }))))
})()
