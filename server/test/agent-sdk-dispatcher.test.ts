import { test } from "node:test"
import assert from "node:assert/strict"
import { AgentSdkDispatcher, type QueryFn } from "../src/agent-sdk-dispatcher.js"
import type { StakeRequest } from "../src/dispatcher.js"
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"

// Integration test for the *boundary* where we yield control to the Agent SDK.
// We inject a fake `query()` that records the Options it was handed and replays a canned
// SDK message stream. Everything inside the real `query()` (CLI, API, model, outputFormat
// enforcement) is out of our control and deliberately NOT exercised here — this pins only
// our two edges: StakeRequest → Options, and SDK messages → StakeResult.
//
// Caveat: the canned messages encode our *assumptions* about the SDK protocol, so this
// catches our mapping bugs but not SDK protocol drift (only a real run / fake-CLI does).

function fakeQuery(messages: SDKMessage[]) {
	const calls: Array<{ prompt: string; options?: Options }> = []
	const fn: QueryFn = (args) => {
		calls.push(args)
		return (async function* () {
			for (const m of messages) yield m
		})()
	}
	return { fn, calls }
}

const initMsg = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId }) as unknown as SDKMessage
const successMsg = (sessionId: string, result: string, structured?: unknown) =>
	({ type: "result", subtype: "success", session_id: sessionId, result, ...(structured !== undefined ? { structured_output: structured } : {}) }) as unknown as SDKMessage
const errorMsg = (sessionId: string, subtype: string) => ({ type: "result", subtype, session_id: sessionId }) as unknown as SDKMessage

const baseReq: StakeRequest = { agentName: "A", prompt: "do the thing", allowedTools: ["Read", "Bash"], cwd: "/work" }

// ── Outbound edge: StakeRequest → SDK Options ──

test("maps a full StakeRequest onto SDK Options", async () => {
	const { fn, calls } = fakeQuery([initMsg("S1"), successMsg("S1", "ok")])
	const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }
	await new AgentSdkDispatcher({}, fn).runStake({
		...baseReq,
		model: "sonnet",
		systemPrompt: "You are X.",
		outputJsonSchema: schema,
	})
	const opts = calls[0]!.options!
	assert.equal(calls[0]!.prompt, "do the thing")
	assert.equal(opts.cwd, "/work")
	assert.deepEqual(opts.allowedTools, ["Read", "Bash"])
	assert.equal(opts.permissionMode, "bypassPermissions")
	assert.equal(opts.allowDangerouslySkipPermissions, true)
	assert.equal(opts.model, "sonnet")
	// Role is appended to the Claude Code preset, not used as a replacement prompt.
	assert.deepEqual(opts.systemPrompt, { type: "preset", preset: "claude_code", append: "You are X." })
	assert.deepEqual(opts.outputFormat, { type: "json_schema", schema })
})

test("omits optional options when the request doesn't set them", async () => {
	const { fn, calls } = fakeQuery([initMsg("S1"), successMsg("S1", "ok")])
	await new AgentSdkDispatcher({}, fn).runStake(baseReq)
	const opts = calls[0]!.options!
	assert.equal(opts.model, undefined)
	assert.equal(opts.systemPrompt, undefined)
	assert.equal(opts.resume, undefined)
	assert.equal(opts.outputFormat, undefined)
})

test("threads sessionId through as options.resume", async () => {
	const { fn, calls } = fakeQuery([initMsg("S9"), successMsg("S9", "ok")])
	await new AgentSdkDispatcher({}, fn).runStake({ ...baseReq, sessionId: "PRIOR" })
	assert.equal(calls[0]!.options!.resume, "PRIOR")
})

test("forwards pathToClaudeCodeExecutable when configured", async () => {
	const { fn, calls } = fakeQuery([initMsg("S1"), successMsg("S1", "ok")])
	await new AgentSdkDispatcher({ pathToClaudeCodeExecutable: "/usr/bin/claude" }, fn).runStake(baseReq)
	assert.equal(calls[0]!.options!.pathToClaudeCodeExecutable, "/usr/bin/claude")
})

// ── Inbound edge: SDK message stream → StakeResult ──

test("captures session id, result text, and structured_output on success", async () => {
	const { fn } = fakeQuery([initMsg("S1"), successMsg("S1", "the answer", { n: 42 })])
	const out = await new AgentSdkDispatcher({}, fn).runStake(baseReq)
	assert.deepEqual(out, { sessionId: "S1", result: "the answer", structured: { n: 42 }, error: undefined })
})

test("success without structured_output leaves structured undefined", async () => {
	const { fn } = fakeQuery([initMsg("S1"), successMsg("S1", "plain text")])
	const out = await new AgentSdkDispatcher({}, fn).runStake(baseReq)
	assert.equal(out.result, "plain text")
	assert.equal(out.structured, undefined)
	assert.equal(out.error, undefined)
})

test("maps an error result subtype to StakeResult.error", async () => {
	const { fn } = fakeQuery([initMsg("S2"), errorMsg("S2", "error_max_turns")])
	const out = await new AgentSdkDispatcher({}, fn).runStake(baseReq)
	assert.equal(out.error, "error_max_turns")
	assert.equal(out.result, "")
	assert.equal(out.sessionId, "S2")
})

test("reports an error when no result message arrives", async () => {
	const { fn } = fakeQuery([initMsg("S3")])
	const out = await new AgentSdkDispatcher({}, fn).runStake(baseReq)
	assert.match(out.error ?? "", /no result message/)
	assert.equal(out.sessionId, "S3")
})
