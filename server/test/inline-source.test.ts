import { test } from "node:test"
import assert from "node:assert/strict"
import { analyzeSource } from "../src/workflows.js"
import { runWorkflow } from "../src/executor.js"
import { FakeDispatcher } from "../src/dispatcher.js"

// The "LLM generates slang → validate → run inline" path: analyzeSource backs both
// validate_workflow(source) and run_workflow(source)'s parse/static-error gate.

const VALID = `flow "gen" {
  agent Worker {
    role: "x"
    stake go(task: "do") -> @out
      output: { ok: "boolean" }
    commit
  }
  converge when: @Worker.committed
  budget: rounds(5)
}`

test("analyzeSource: a valid inline flow has no parse or static errors", () => {
	const r = analyzeSource(VALID)
	assert.equal(r.parseErrors.length, 0)
	assert.equal(r.hardErrors.length, 0)
	assert.equal(r.ast.flows[0]?.name, "gen")
})

test("analyzeSource: malformed source returns parse errors (run_workflow would reject)", () => {
	const r = analyzeSource(`flow "bad" { agent W { role: "x" stake go(task:`)
	assert.ok(r.parseErrors.length > 0)
	assert.equal(r.ast.flows.length, 0)
})

test("analyzeSource: stake to an unknown agent is a blocking [error]", () => {
	const r = analyzeSource(`flow "ur" {
  agent Worker { role: "x" stake go(task: "do") -> @Ghost output: { ok: "boolean" } commit }
  converge when: @Worker.committed
  budget: rounds(5)
}`)
	assert.equal(r.parseErrors.length, 0)
	assert.ok(r.hardErrors.length > 0, "expected a hard error for the unknown stake target")
	assert.ok(r.hardErrors.some((e) => e.includes("Ghost")))
})

test("inline generate → validate → run: a generated flow executes via the dispatcher", async () => {
	const r = analyzeSource(VALID)
	assert.equal(r.parseErrors.length + r.hardErrors.length, 0) // would-be run_workflow gate passes
	const { result } = await runWorkflow(r.ast.flows[0]!, {}, new FakeDispatcher(() => JSON.stringify({ ok: true })), { cwd: "/tmp" })
	assert.equal((result as { status: string }).status, "converged")
})
