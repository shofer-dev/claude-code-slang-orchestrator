// Probe: can the Agent SDK dispatch a stake on a given model? Used to confirm Fable is
// targetable before running a full benchmark sweep on it.
//   node_modules/.bin/tsx test/model-probe.ts [modelId]
import { AgentSdkDispatcher } from "../src/agent-sdk-dispatcher.js"

const model = process.argv[2] ?? "claude-fable-5"
const d = new AgentSdkDispatcher()
const t0 = Date.now()
const res = await d.runStake({
	agentName: "Probe",
	prompt: "Reply with exactly the token PROBE_OK and nothing else.",
	allowedTools: [],
	model,
	cwd: process.cwd(),
	timeoutMs: 60_000,
})
const dt = Math.round((Date.now() - t0) / 1000)
console.log(JSON.stringify({ model, elapsed_s: dt, error: res.error ?? null, result: (res.result ?? "").slice(0, 200) }, null, 2))
process.exit(res.error ? 1 : 0)
