// Live MCP-elicitation test for `escalate @Human`.
//
// The DESIGN status table flagged this leg "wired, not headless-testable — needs a live Claude
// Code session". It IS testable headlessly: spawn the real server over stdio with a real MCP
// Client that advertises the `elicitation` capability and answers the elicitInput() the server
// raises when the workflow hits `escalate @Human`. The 08-escalation fixture has no stake (no
// model calls), so this exercises the pure elicitation round-trip deterministically.
//
//   node server/test/elicitation-live.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, "..", "src", "main.ts")
const TSX = join(HERE, "..", "node_modules", ".bin", "tsx")
const SOURCE = readFileSync(join(HERE, "fixtures", "08-escalation.slang"), "utf8")

async function runOnce(answer) {
	const transport = new StdioClientTransport({
		command: TSX,
		args: [SERVER],
		cwd: join(HERE, ".."),
		stderr: "inherit",
	})
	const client = new Client({ name: "elicit-test", version: "1.0.0" }, { capabilities: { elicitation: {} } })
	let elicited = null
	// Server -> client elicitation request handler: this is the human's dialog, scripted.
	client.setRequestHandler(ElicitRequestSchema, async (req) => {
		elicited = req.params
		return { action: "accept", content: { answer } }
	})
	await client.connect(transport)
	const res = await client.callTool({ name: "run_workflow", arguments: { source: SOURCE } })
	await client.close()
	const text = (res.content ?? []).map((c) => c.text ?? "").join("\n")
	return { elicited, text }
}

let failures = 0
for (const [answer, expect] of [["ACK", "approved"], ["Reject", "rejected"]]) {
	const { elicited, text } = await runOnce(answer)
	const parsed = (() => { try { return JSON.parse(text) } catch { return null } })()
	const status = parsed?.status ?? "(unknown)"
	const gotElicit = elicited != null
	const enumOffered = JSON.stringify(elicited?.requestedSchema?.properties?.answer?.enum ?? null)
	const committed = text.includes(expect)
	const ok = gotElicit && committed
	if (!ok) failures++
	console.log(`\n=== answer="${answer}" (expect commit "${expect}") ===`)
	console.log(`  elicitation raised : ${gotElicit}  message="${elicited?.message ?? ""}"`)
	console.log(`  choices offered    : ${enumOffered}`)
	console.log(`  flow status        : ${status}`)
	console.log(`  committed "${expect}" : ${committed}`)
	console.log(`  => ${ok ? "PASS" : "FAIL"}`)
	if (!ok) console.log("  raw result:", text.slice(0, 600))
}
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`)
process.exit(failures === 0 ? 0 : 1)
