import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveAllowedTools } from "../src/tool-group-map.js"

test("read → Read/Glob/Grep", () => {
	assert.deepEqual(resolveAllowedTools(["read"]).sort(), ["Glob", "Grep", "Read"])
})

test("write → Write/Edit/NotebookEdit", () => {
	assert.deepEqual(new Set(resolveAllowedTools(["write"])), new Set(["Write", "Edit", "NotebookEdit"]))
})

test("execute → Bash (+ background controls)", () => {
	assert.ok(resolveAllowedTools(["execute"]).includes("Bash"))
})

test("questions → ask_human", () => {
	assert.deepEqual(resolveAllowedTools(["questions"]), ["ask_human"])
})

test("browser/mode/subtasks/uncategorized map to nothing", () => {
	assert.deepEqual(resolveAllowedTools(["browser", "mode", "subtasks", "uncategorized"]), [])
})

test("mcp expands to the session's available mcp tools", () => {
	assert.deepEqual(resolveAllowedTools(["mcp"], ["mcp__a__x", "mcp__b__y"]), ["mcp__a__x", "mcp__b__y"])
})

test("mcp with no available tools yields nothing", () => {
	assert.deepEqual(resolveAllowedTools(["mcp"], []), [])
})

test("results are de-duplicated across groups", () => {
	const r = resolveAllowedTools(["read", "read"])
	assert.equal(new Set(r).size, r.length)
})
