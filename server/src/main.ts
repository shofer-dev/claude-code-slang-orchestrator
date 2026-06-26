/**
 * slang-workflows MCP server (stdio).
 *
 * Hosts the deterministic slang executor and exposes a control/observation tool surface
 * to the top-level Claude Code session. This entry currently wires the discovery/validation
 * tools (`list_workflows`, `validate_workflow`); run/observe and the executor dispatch land
 * incrementally on top of the same server instance.
 */
import { promises as fs } from "node:fs"
import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { listWorkflows, resolveWorkflow, validateWorkflowFile } from "./workflows.js"
import { parseSlang } from "./slang/slang-parser.js"
import { runWorkflow, type EscalationRequest } from "./executor.js"
import { AgentSdkDispatcher } from "./agent-sdk-dispatcher.js"
import { serializeFlowState, topologyToMermaid, type FlowState } from "./slang/slang-types.js"

const VERSION = "0.1.0"

function jsonResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }
}

function errorResult(message: string) {
	return { content: [{ type: "text" as const, text: message }], isError: true }
}

function buildServer(cwd: string): McpServer {
	const server = new McpServer({ name: "slang-workflows", version: VERSION })

	// In-memory registry of runs so state/topology can be inspected after a run.
	// (Phase 1 runs synchronously; this becomes the live store for background runs later.)
	const runs = new Map<string, FlowState>()

	// `escalate @Human` handler: elicit input from the user via MCP elicitation. This works
	// because `run_workflow` is still the open client tool call (elicitation is tool-call-scoped).
	const onEscalate = async (req: EscalationRequest): Promise<string> => {
		const properties: Record<string, unknown> = {}
		const required: string[] = []
		if (req.form && req.form.length) {
			for (const f of req.form) {
				const t = f.paramType === "number" ? "number" : f.paramType === "boolean" ? "boolean" : "string"
				properties[f.name] = f.options?.length ? { type: t, enum: f.options } : { type: t }
				required.push(f.name)
			}
		} else if (req.choices && req.choices.length) {
			properties.answer = { type: "string", enum: req.choices, description: "Choose one." }
			required.push("answer")
		} else {
			properties.answer = { type: "string", description: "Your response." }
			required.push("answer")
		}
		// The runtime values are valid MCP primitive schemas; cast to the SDK's precise
		// requestedSchema union (string/number/boolean/enum) which a generic record can't express.
		const result = await server.server.elicitInput({
			message: req.reason ?? `Workflow agent "${req.agent}" needs your input.`,
			requestedSchema: { type: "object", properties, required },
		} as Parameters<typeof server.server.elicitInput>[0])
		if (result.action !== "accept" || !result.content) return ""
		// Form answers → serialized object; single-answer → the bare string.
		if (req.form && req.form.length) return JSON.stringify(result.content)
		return String((result.content as Record<string, unknown>).answer ?? "")
	}

	server.registerTool(
		"list_workflows",
		{
			title: "List workflows",
			description:
				"Discover .slang workflow files in the project (.claude/workflows/) and global " +
				"(~/.claude/workflows/) directories. Returns each flow's name, title, params, and agent count.",
			inputSchema: {},
		},
		async () => jsonResult(await listWorkflows(cwd)),
	)

	server.registerTool(
		"validate_workflow",
		{
			title: "Validate workflow",
			description:
				"Parse and statically analyze one workflow (deadlock detection, unknown refs, missing " +
				"converge/budget, orphan outputs) without running it. Identify it by `name` or absolute `path`.",
			inputSchema: {
				name: z.string().optional().describe("Flow name or .slang filename (project scope preferred)."),
				path: z.string().optional().describe("Absolute path to a .slang file (overrides `name`)."),
			},
		},
		async ({ name, path: filePath }) => {
			const file = filePath ?? (name ? await resolveWorkflow(cwd, name) : undefined)
			if (!file) return errorResult(`No workflow found for ${name ? `name "${name}"` : "the given arguments"}.`)
			try {
				return jsonResult(await validateWorkflowFile(file))
			} catch (e) {
				return errorResult(`Failed to validate ${file}: ${(e as Error).message}`)
			}
		},
	)

	server.registerTool(
		"run_workflow",
		{
			title: "Run workflow",
			description:
				"Parse and run a .slang workflow to completion, dispatching each agent through the Claude " +
				"Agent SDK and validating results against output contracts. Identify it by `name` or `path`; " +
				"pass flow `params` as an object. Returns the final flow status and each agent's output. " +
				"(Phase 1: runs synchronously; long-running/background execution lands later.)",
			inputSchema: {
				name: z.string().optional().describe("Flow name or .slang filename."),
				path: z.string().optional().describe("Absolute path to a .slang file (overrides `name`)."),
				params: z.record(z.any()).optional().describe("Flow parameters as a key/value object."),
				model: z.string().optional().describe("Default model for agents without api_configuration (e.g. sonnet)."),
			},
		},
		async ({ name, path: filePath, params, model }) => {
			const file = filePath ?? (name ? await resolveWorkflow(cwd, name) : undefined)
			if (!file) return errorResult(`No workflow found for ${name ? `name "${name}"` : "the given arguments"}.`)
			let source: string
			try {
				source = await fs.readFile(file, "utf8")
			} catch (e) {
				return errorResult(`Failed to read ${file}: ${(e as Error).message}`)
			}
			const { ast, errors } = parseSlang(source)
			if (errors.length) return errorResult(`Parse errors:\n${errors.join("\n")}`)
			const flow = ast.flows[0]
			if (!flow) return errorResult("No flow found in source.")
			try {
				const dispatcher = new AgentSdkDispatcher()
				const { result, flowState } = await runWorkflow(flow, params ?? {}, dispatcher, {
					cwd,
					defaultModel: model ?? "sonnet",
					onEscalate,
				})
				const workflowId = randomUUID()
				runs.set(workflowId, flowState)
				return jsonResult({ workflow_id: workflowId, ...result })
			} catch (e) {
				return errorResult(`Run failed: ${(e as Error).stack ?? (e as Error).message}`)
			}
		},
	)

	server.registerTool(
		"get_workflow_state",
		{
			title: "Get workflow state",
			description:
				"Return the serialized FlowState for a run started by `run_workflow`: per-agent status, " +
				"opIndex, bindings, round, budget usage, and flow status. Identify it by `workflow_id`.",
			inputSchema: { workflow_id: z.string().describe("Id returned by run_workflow.") },
		},
		async ({ workflow_id }) => {
			const state = runs.get(workflow_id)
			if (!state) return errorResult(`Unknown workflow_id "${workflow_id}".`)
			return jsonResult(serializeFlowState(state))
		},
	)

	server.registerTool(
		"get_topology",
		{
			title: "Get workflow topology (Mermaid)",
			description:
				"Return the current agent topology of a run as a Mermaid flowchart (nodes colored by " +
				"status, plus live sending/waiting edges). Render it inline. Identify it by `workflow_id`.",
			inputSchema: { workflow_id: z.string().describe("Id returned by run_workflow.") },
		},
		async ({ workflow_id }) => {
			const state = runs.get(workflow_id)
			if (!state) return errorResult(`Unknown workflow_id "${workflow_id}".`)
			return { content: [{ type: "text" as const, text: topologyToMermaid(state.agents) }] }
		},
	)

	return server
}

async function main(): Promise<void> {
	const server = buildServer(process.cwd())
	const transport = new StdioServerTransport()
	await server.connect(transport)
	// stdio transport keeps the process alive; log to stderr (stdout is the MCP channel).
	process.stderr.write(`[slang-workflows] MCP server ${VERSION} ready (cwd=${process.cwd()})\n`)
}

main().catch((e) => {
	process.stderr.write(`[slang-workflows] fatal: ${(e as Error).stack ?? e}\n`)
	process.exit(1)
})
