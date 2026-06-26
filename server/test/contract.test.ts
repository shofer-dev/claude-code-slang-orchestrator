import { test } from "node:test"
import assert from "node:assert/strict"
import { validateContract, contractToJsonSchema } from "../src/executor.js"
import type { OutputSchema } from "../src/slang/slang-ast.js"

const schema: OutputSchema = {
	fields: [
		{ name: "a", fieldType: "number" },
		{ name: "b", fieldType: "string" },
	],
}

test("validateContract accepts valid JSON matching the schema", () => {
	const r = validateContract(JSON.stringify({ a: 1, b: "x" }), schema)
	assert.equal(r.ok, true)
	assert.deepEqual(r.value, { a: 1, b: "x" })
})

test("validateContract rejects non-JSON", () => {
	assert.equal(validateContract("not json at all", schema).ok, false)
})

test("validateContract rejects a missing field", () => {
	assert.equal(validateContract(JSON.stringify({ a: 1 }), schema).ok, false)
})

test("validateContract rejects a wrong-typed field", () => {
	assert.equal(validateContract(JSON.stringify({ a: "nope", b: "y" }), schema).ok, false)
})

test("validateContract rejects a JSON array (must be an object)", () => {
	assert.equal(validateContract(JSON.stringify([1, 2]), schema).ok, false)
})

test("validateContract strips a ```json fence", () => {
	const r = validateContract("```json\n{ \"a\": 1, \"b\": \"x\" }\n```", schema)
	assert.equal(r.ok, true)
})

test("validateContract with no schema always passes", () => {
	assert.equal(validateContract("anything", undefined).ok, true)
})

test("contractToJsonSchema produces a strict object schema", () => {
	const js = contractToJsonSchema(schema) as Record<string, unknown>
	assert.equal(js.type, "object")
	assert.equal(js.additionalProperties, false)
	assert.deepEqual(js.required, ["a", "b"])
	assert.deepEqual(js.properties, { a: { type: "number" }, b: { type: "string" } })
})
