/**
 * Maps the abstract slang tool-group vocabulary (an agent's `tools: [...]` meta clause)
 * to concrete Claude Code tool names, used to build the Agent SDK `allowedTools` for an
 * inner session.
 *
 * Restriction-only semantics: a requested group grants its tools; any tool not granted
 * by some requested group stays disallowed. The contract-terminus tool (`submit_result`)
 * is added unconditionally by the executor and is not part of any group.
 */
import type { ToolGroup } from "./slang/tool-groups"

/** Placeholder meaning "all MCP tools exposed to this session" — expanded at dispatch. */
export const MCP_WILDCARD = "mcp__*"

/** Group → Claude Code built-in tool names (the SDK allowedTools surface). */
export const TOOL_GROUP_MAP: Record<ToolGroup, string[]> = {
	// File reading + code/content search.
	read: ["Read", "Glob", "Grep"],
	// File mutation.
	write: ["Write", "Edit", "NotebookEdit"],
	// Shell command execution (+ managing background shells).
	execute: ["Bash", "BashOutput", "KillBash"],
	// MCP tools — expanded to the concrete `mcp__server__tool` names exposed to the
	// session by `resolveAllowedTools()`.
	mcp: [MCP_WILDCARD],
	// Agent-initiated questions to the human → the elicitation-backed custom tool.
	questions: ["ask_human"],

	// --- Groups with no direct Claude Code equivalent (intentionally empty) ---
	// Interactive browser automation: Claude Code ships no native browser tool. Supply a
	// browser MCP server and request the `mcp` group instead.
	browser: [],
	// Agent identity / mode is resolved by the executor's subagent mapping at spawn,
	// not exposed as an inner-agent tool.
	mode: [],
	// Subtask dispatch is executor-mediated in slang (the executor spawns agents); inner
	// agents never self-spawn, so they receive no Task tool.
	subtasks: [],
	// Catch-all for ungrouped tools — empty unless a workflow explicitly extends it.
	uncategorized: [],
}

/**
 * Build the Agent SDK `allowedTools` list for an agent that requested `groups`.
 *
 * @param groups            the agent's requested tool groups (from `.slang` meta)
 * @param availableMcpTools concrete `mcp__server__tool` names exposed to the session;
 *                          the `mcp` group expands to all of them
 */
export function resolveAllowedTools(
	groups: readonly ToolGroup[],
	availableMcpTools: readonly string[] = [],
): string[] {
	const tools = new Set<string>()
	for (const g of groups) {
		for (const t of TOOL_GROUP_MAP[g] ?? []) {
			if (t === MCP_WILDCARD) {
				for (const m of availableMcpTools) tools.add(m)
			} else {
				tools.add(t)
			}
		}
	}
	return [...tools]
}
