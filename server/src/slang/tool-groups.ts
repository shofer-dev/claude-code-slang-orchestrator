/**
 * Tool-group vocabulary for the slang `tools: [...]` agent-meta clause.
 *
 * These are abstract capability groups an agent may request. The resolver uses this
 * set only to validate that a `tools:` clause references known groups; the runtime
 * dispatch layer maps each group to concrete Claude Code tools (see `tool-group-map.ts`).
 */
export const toolGroups = [
	"read",
	"write",
	"execute",
	"browser",
	"mcp",
	"mode",
	"subtasks",
	"questions",
	"uncategorized",
] as const

export type ToolGroup = (typeof toolGroups)[number]
