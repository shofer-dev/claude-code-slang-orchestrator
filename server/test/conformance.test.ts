import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseSlang, validateSlangAST } from "../src/slang/slang-parser.js"
import { runWorkflow } from "../src/executor.js"
import { FakeDispatcher } from "../src/dispatcher.js"
import type { FlowDecl } from "../src/slang/slang-ast.js"
import type { StakeRequest } from "../src/dispatcher.js"

// Showcase/fixture workflows shipped with the plugin (also serve as conformance fixtures).
// These are the plugin's own examples — distinct from the user's runtime `.claude/workflows/`.
const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.resolve(here, "fixtures")
const files = existsSync(fixturesDir) ? readdirSync(fixturesDir).filter((f) => f.endsWith(".slang")).sort() : []

/** Mock dispatcher result: a value conforming to whatever output contract the stake declares. */
function mockResult(req: StakeRequest): string {
	const schema = req.outputJsonSchema as { properties?: Record<string, { type?: string }> } | undefined
	if (!schema?.properties) return "{}"
	const obj: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(schema.properties)) {
		obj[k] = v.type === "number" ? 50 : v.type === "boolean" ? true : "value"
	}
	return JSON.stringify(obj)
}

/** Generic flow params (one dummy value per declared param type). */
function mockParams(flow: FlowDecl): Record<string, unknown> {
	const p: Record<string, unknown> = {}
	for (const param of flow.params ?? []) {
		p[param.name] = param.paramType === "number" ? 5 : param.paramType === "boolean" ? true : "value"
	}
	return p
}

test("fixture workflows are present", { skip: files.length > 0 ? false : "no fixtures dir" }, () => {
	assert.ok(files.length > 0)
})

for (const f of files) {
	test(`conformance: ${f} parses, validates, and runs to convergence (mock)`, async () => {
		const src = readFileSync(path.join(fixturesDir, f), "utf8")

		// 1. Parses with no errors.
		const { ast, errors } = parseSlang(src)
		assert.deepEqual(errors, [], `parse errors in ${f}: ${errors.join("; ")}`)

		// 2. Passes static analysis (no hard errors; warnings are allowed).
		const hardErrors = validateSlangAST(ast).filter((d) => d.startsWith("[error]"))
		assert.deepEqual(hardErrors, [], `static-analysis errors in ${f}: ${hardErrors.join("; ")}`)

		// 3. Runs to convergence under a schema-conforming mock (no model calls).
		const flow = ast.flows[0]
		assert.ok(flow, `no flow in ${f}`)
		const { result } = await runWorkflow(flow, mockParams(flow), new FakeDispatcher(mockResult), {
			cwd: fixturesDir,
			onEscalate: async () => "ACK",
			maxRounds: 50,
		})
		assert.equal(result.status, "converged", `${f} ended as "${result.status}", expected "converged"`)
	})
}
