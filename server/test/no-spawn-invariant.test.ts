import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveAllowedTools, TOOL_GROUP_MAP, MCP_WILDCARD } from "../src/tool-group-map.js"
import { toolGroups } from "../src/slang/tool-groups.js"

// INVARIANT: a slang inner agent can never be granted a tool that spawns another agent or starts
// another workflow — so a single top-level run cannot fan out in *depth*. This holds today by
// construction: `subtasks` maps to [] (no Task tool), and the executor resolves an agent's
// allowedTools WITHOUT passing availableMcpTools, so the `mcp` group's `mcp__*` wildcard expands
// to nothing — no `run_workflow`, no MCP tool at all, reaches an inner agent. Depth = 1.
//
// These tests LOCK that property so a future change (wiring availableMcpTools, adding Task to
// `subtasks`, or setting settingSources so inner sessions inherit .mcp.json) trips CI and forces
// a conscious decision — the guarantee is enforced, not merely emergent.
// See DESIGN § The Central Invariant: Operator Mode.

test("subtasks tool-group grants no Task tool — inner agents never self-spawn", () => {
	assert.deepEqual(TOOL_GROUP_MAP.subtasks, [], "subtasks must map to [] (no native subagent spawn)")
})

test("as the executor resolves them (no availableMcpTools), NO group grants spawn/workflow/MCP tools", () => {
	// executor.ts calls resolveAllowedTools(groups) with ONE argument — replicate that exactly,
	// across EVERY declarable group at once (the maximal grant an agent could ever request).
	const resolved = resolveAllowedTools([...toolGroups])
	assert.ok(!resolved.includes("Task"), `Task must never be granted; got ${JSON.stringify(resolved)}`)
	assert.ok(!resolved.includes("run_workflow"), "run_workflow must never be granted to an inner agent")
	assert.ok(!resolved.includes(MCP_WILDCARD), "the raw mcp__* wildcard must not leak as a callable tool")
	assert.ok(
		!resolved.some((t) => t.startsWith("mcp__")),
		`no MCP tools without availableMcpTools; leaked: ${JSON.stringify(resolved.filter((t) => t.startsWith("mcp__")))}`,
	)
})

test("tripwire: the invariant rests on the executor NOT passing MCP tools", () => {
	// The `mcp` group DOES expand when availableMcpTools is supplied — so the guarantee is
	// precisely "the executor must never supply them". If a future change provided the server's
	// own tools, an inner agent with tools:[mcp] could call run_workflow → unbounded depth.
	const withMcp = resolveAllowedTools(["mcp"], ["mcp__slang-workflows__run_workflow"])
	assert.ok(
		withMcp.includes("mcp__slang-workflows__run_workflow"),
		"the mcp group expands when tools are provided — hence the executor must never provide them",
	)
	// ...but Task is STILL never granted, regardless of MCP wiring (subtasks -> [] is independent):
	const all = resolveAllowedTools([...toolGroups], ["mcp__slang-workflows__run_workflow"])
	assert.ok(!all.includes("Task"), "subtasks -> [] guards Task even if MCP tools are ever exposed")
})
