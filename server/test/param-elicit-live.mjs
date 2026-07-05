// Live MCP test for run_workflow param-elicitation: a REQUIRED flow param (declared without a
// default) that the caller doesn't supply is collected from the user via elicitation before the
// run starts, and interpolated into the flow. The fixture has no stake (escalate/await/commit
// only) → no model calls → deterministic.
//   node server/test/param-elicit-live.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, "..", "src", "main.ts")
const TSX = join(HERE, "..", "node_modules", ".bin", "tsx")

const SOURCE = `flow "param-test" (topic: "string") {
  title: "Param elicitation test"
  param topic { description: "The topic to echo." }
  agent C {
    escalate @Human
      reason: "topic is \${topic}"
      choices: ["ok"]
    await a <- @Human
    commit "done"
  }
  converge when: @C.committed
  budget: rounds(3)
}`

async function run(provideParam) {
	const transport = new StdioClientTransport({ command: TSX, args: [SERVER], cwd: join(HERE, ".."), stderr: "inherit" })
	const client = new Client({ name: "param-test", version: "1.0.0" }, { capabilities: { elicitation: {} } })
	const elicitations = []
	client.setRequestHandler(ElicitRequestSchema, async (req) => {
		const props = req.params.requestedSchema?.properties ?? {}
		elicitations.push({ message: req.params.message, keys: Object.keys(props), props })
		if ("topic" in props) return { action: "accept", content: { topic: "PARAM_VALUE" } } // the param prompt
		return { action: "accept", content: { answer: "ok" } } // the escalate
	})
	await client.connect(transport)
	const args = { source: SOURCE }
	if (provideParam) args.params = { topic: "SUPPLIED" }
	const res = await client.callTool({ name: "run_workflow", arguments: args })
	await client.close()
	const text = (res.content ?? []).map((c) => c.text ?? "").join("\n")
	return { elicitations, text }
}

let fail = 0

// Case 1: param NOT supplied → server elicits for `topic` (with its description), then interpolates it.
{
	const { elicitations, text } = await run(false)
	const paramElicit = elicitations.find((e) => e.keys.includes("topic"))
	const raised = !!paramElicit
	const desc = paramElicit?.props?.topic?.description === "The topic to echo."
	const interpolated = elicitations.some((e) => e.keys.includes("answer") && (e.message || "").includes("PARAM_VALUE"))
	const done = /converged|committed|done/i.test(text)
	const ok = raised && desc && interpolated && done
	if (!ok) fail++
	console.log(`\n=== param NOT supplied (expect a prompt for "topic") ===`)
	console.log(`  param elicited      : ${raised}  keys=${JSON.stringify(paramElicit?.keys)}`)
	console.log(`  description forwarded: ${desc}`)
	console.log(`  value interpolated  : ${interpolated}  (escalate message saw the collected value)`)
	console.log(`  run converged       : ${done}`)
	console.log(`  => ${ok ? "PASS" : "FAIL"}`)
	if (!ok) console.log("  raw:", text.slice(0, 400), JSON.stringify(elicitations).slice(0, 500))
}

// Case 2: param SUPPLIED → server does NOT prompt for `topic` (only the escalate fires).
{
	const { elicitations, text } = await run(true)
	const paramElicit = elicitations.find((e) => e.keys.includes("topic"))
	const ok = !paramElicit && /converged|committed|done/i.test(text)
	if (!ok) fail++
	console.log(`\n=== param SUPPLIED (expect NO "topic" prompt) ===`)
	console.log(`  param elicited      : ${!!paramElicit}  (want false)`)
	console.log(`  => ${ok ? "PASS" : "FAIL"}`)
	if (!ok) console.log("  raw:", text.slice(0, 400), JSON.stringify(elicitations).slice(0, 500))
}

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`)
process.exit(fail === 0 ? 0 : 1)
