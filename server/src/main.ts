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
import { analyzeSource, listWorkflows, resolveWorkflow, validateWorkflowFile } from "./workflows.js"
import { runWorkflow, type EscalationRequest, type WorkflowEvent } from "./executor.js"
import { AgentSdkDispatcher } from "./agent-sdk-dispatcher.js"
import { eventsToSequenceDiagram, serializeFlowState, topologyToMermaid, type FlowState } from "./slang/slang-types.js"

const VERSION = "0.1.2"

function jsonResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }
}

function errorResult(message: string) {
	return { content: [{ type: "text" as const, text: message }], isError: true }
}

/** Concise generation cheatsheet for `get_slang_grammar` — enough for an LLM to emit a valid
 * flow inline; the full 988-line spec lives in slang_specs.md. */
const SLANG_CHEATSHEET = `# Slang — quick grammar (for generating a workflow to run inline)

A flow coordinates one or more agents. The executor is a deterministic state machine: it
schedules stakes, routes results through mailboxes, validates output contracts, and converges.

\`\`\`slang
-- comments start with --
flow "my-flow" {
  title: "Human title"
  description: "what it does"

  agent Worker {
    role: "System prompt for this agent. Return ONLY JSON matching the output contract."
    tools: [read, write, execute]      -- tool groups; omit for full access under bypass
    -- optional scoping: write_paths: ["**/*.md"]   deny: [Bash]   mode: "code"

    stake do_thing(
      task: "Instruction. Reference flow params with \${param}."
    ) -> @other                         -- '-> @Agent' routes the RESULT to that agent's mailbox
      output: { ok: "boolean", note: "string" }   -- contract: validated + re-prompted on miss

    await reply <- @other               -- block until a result is routed from @other
    commit                              -- this agent is done
  }

  converge when: @Worker.committed      -- termination condition
  budget: rounds(20)                    -- hard cap (always terminates)
}
\`\`\`

Key constructs: \`stake name(args) -> @Agent\` (run + route), \`await x <- @Agent\` (receive),
\`commit\`, \`repeat until <cond> { ... }\`, \`when <cond> { ... } otherwise { ... }\`,
\`escalate @Human reason: "..." form: { field: "string" { options: [...] } }\`, \`converge when:\`,
\`budget: rounds(N)\`. Every routed/looped stake SHOULD declare an \`output:\` contract.
Validate before running: parse errors and \`[error]\` diagnostics (deadlock, unknown refs,
missing converge/budget, orphan outputs) block execution.`

function buildServer(cwd: string): McpServer {
	const server = new McpServer({ name: "slang-workflows", version: VERSION })

	// In-memory registry of runs so state/topology can be inspected after a run.
	// (Phase 1 runs synchronously; this becomes the live store for background runs later.)
	const runs = new Map<string, FlowState>()
	// Per-run event log (the execution trace) for `get_trace`.
	const traces = new Map<string, WorkflowEvent[]>()

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
		"get_slang_grammar",
		{
			title: "Get slang grammar",
			description:
				"Return a concise slang grammar cheatsheet (constructs + a complete example) so you can " +
				"GENERATE a workflow on the fly and run it inline via run_workflow(source). Validate generated " +
				"source with validate_workflow(source) first; run_workflow also rejects parse/static-analysis errors.",
			inputSchema: {},
		},
		async () => ({ content: [{ type: "text" as const, text: SLANG_CHEATSHEET }] }),
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
				source: z.string().optional().describe("Inline .slang source to validate (overrides name/path) — validate generated flows before running."),
			},
		},
		async ({ name, path: filePath, source: inlineSource }) => {
			if (inlineSource != null) {
				const { ast, parseErrors, diagnostics, hardErrors } = analyzeSource(inlineSource)
				return jsonResult({ name: ast.flows[0]?.name ?? null, path: null, parseErrors, diagnostics, ok: parseErrors.length === 0 && hardErrors.length === 0 })
			}
			const file = filePath ?? (name ? await resolveWorkflow(cwd, name) : undefined)
			if (!file) return errorResult(`No workflow found for ${name ? `name "${name}"` : "the given arguments"} (or pass inline \`source\`).`)
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
				"Rejects parse/static-analysis errors before running. Default runs synchronously (returns the final status + each agent's output). Pass background:true to start the run and return a workflow_id immediately, then poll get_trace/get_topology/get_workflow_state to watch it live; @Human escalation only works in synchronous runs.",
			inputSchema: {
				name: z.string().optional().describe("Flow name or .slang filename."),
				path: z.string().optional().describe("Absolute path to a .slang file (overrides `name`)."),
				source: z.string().optional().describe("Inline .slang source (overrides name/path) — e.g. a workflow an LLM generated on the fly."),
				params: z.record(z.any()).optional().describe("Flow parameters as a key/value object."),
				model: z.string().optional().describe("Default model for agents without api_configuration (e.g. sonnet)."),
				background: z.boolean().optional().describe("Start the run and return a workflow_id immediately, then poll get_trace/get_topology/get_workflow_state. (@Human escalation unsupported in background.)"),
			},
		},
		async ({ name, path: filePath, source: inlineSource, params, model, background }) => {
			let source: string
			if (inlineSource != null) {
				source = inlineSource
			} else {
				const file = filePath ?? (name ? await resolveWorkflow(cwd, name) : undefined)
				if (!file) return errorResult(`No workflow found for ${name ? `name "${name}"` : "the given arguments"} (or pass inline \`source\`).`)
				try {
					source = await fs.readFile(file, "utf8")
				} catch (e) {
					return errorResult(`Failed to read ${file}: ${(e as Error).message}`)
				}
			}
			// Gate execution on parse errors AND hard static-analysis errors (deadlock, unknown
			// refs, missing converge/budget) — especially important for generated workflows.
			const { ast, parseErrors, hardErrors } = analyzeSource(source)
			if (parseErrors.length) return errorResult(`Parse errors:\n${parseErrors.join("\n")}`)
			if (hardErrors.length) return errorResult(`Static-analysis errors (fix before running):\n${hardErrors.join("\n")}`)
			const flow = ast.flows[0]
			if (!flow) return errorResult("No flow found in source.")
			const dispatcher = new AgentSdkDispatcher()
			const workflowId = randomUUID()
			const events: WorkflowEvent[] = []
			traces.set(workflowId, events)
			// Same run options both modes: onStart registers the LIVE FlowState (so topology/state/trace
			// are inspectable mid-run); onEvent streams into the trace. Elicitation only works while the
			// tool call is open, so @Human escalation is wired for synchronous runs only.
			const runOpts = {
				cwd,
				defaultModel: model ?? "sonnet",
				onEvent: (e: WorkflowEvent) => events.push(e),
				onStart: (fs: FlowState) => runs.set(workflowId, fs),
				onEscalate: background ? undefined : onEscalate,
			}
			if (background) {
				void runWorkflow(flow, params ?? {}, dispatcher, runOpts).catch((e) => {
					events.push({ round: -1, kind: "error", detail: `run failed: ${(e as Error).message}` })
				})
				return jsonResult({ workflow_id: workflowId, status: "running", poll: ["get_trace", "get_topology", "get_workflow_state"] })
			}
			try {
				const { result } = await runWorkflow(flow, params ?? {}, dispatcher, runOpts)
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

	server.registerTool(
		"get_trace",
		{
			title: "Get workflow trace (Mermaid sequence + event log)",
			description:
				"Return a run's execution trace as a Mermaid `sequenceDiagram` (round-by-round: who staked/" +
				"routed to whom, commits, escalations, terminal event) plus the raw event log. The timeline " +
				"counterpart to `get_topology`'s snapshot. Render the diagram inline. Identify it by `workflow_id`.",
			inputSchema: { workflow_id: z.string().describe("Id returned by run_workflow.") },
		},
		async ({ workflow_id }) => {
			const events = traces.get(workflow_id)
			if (!events) return errorResult(`Unknown workflow_id "${workflow_id}".`)
			const diagram = eventsToSequenceDiagram(events)
			return { content: [{ type: "text" as const, text: `${diagram}\n\n${JSON.stringify({ events }, null, 2)}` }] }
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
