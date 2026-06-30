/**
 * Slang workflow executor — the deterministic, non-LLM coordination loop.
 *
 * Drives the pure VM (`slang/slang-interpreter`) round by round and dispatches each stake
 * through a {@link Dispatcher}, validating every result against the stake's output contract
 * and retrying on failure. The executor makes zero model calls itself — all agent work
 * happens behind the Dispatcher seam, so the whole loop is testable with `FakeDispatcher`.
 *
 * Phase 1 scope: single- and multi-agent flows with stake → contract → route → commit →
 * converge. Stateless contract retries (fresh dispatch + feedback). Escalation, session
 * resume, and the `where` semantic clause land in later phases.
 */
import type { Dispatcher } from "./dispatcher.js"
import { resolveAllowedTools } from "./tool-group-map.js"
import type { ToolGroup } from "./slang/tool-groups.js"
import { toolGroups } from "./slang/tool-groups.js"
import type { AgentDecl, FlowDecl, FlowParam, OutputSchema, StakeOp } from "./slang/slang-ast.js"
import type { AgentState, FlowState } from "./slang/slang-types.js"
import {
	advanceAgent,
	checkConverge,
	compileAgentProgram,
	evalExpr,
	formatEmittedValue,
	interpolate,
	type Instr,
	routeOutput,
	toBool,
} from "./slang/slang-interpreter.js"

const MAX_RETRIES = 3
const DEFAULT_MAX_ROUNDS = 100

export interface EscalationRequest {
	/** The agent raising the escalation. */
	agent: string
	/** Free-text prompt shown to the human. */
	reason?: string
	/** Fixed answer set (presented as choices); the chosen text is returned. */
	choices?: string[]
	/** Typed input form (widget grammar); answers returned serialized into the value. */
	form?: FlowParam[]
}

export interface RunOptions {
	cwd: string
	/** Default model for agents that don't specify `api_configuration`. */
	defaultModel?: string
	/** Enable Claude Code's native filesystem sandbox for inner sessions. */
	sandbox?: boolean
	maxRounds?: number
	/** Optional progress sink (one line per significant event). */
	onEvent?: (e: WorkflowEvent) => void
	/**
	 * Handler for `escalate @Human` — resolves with the human's answer, which is delivered to
	 * the escalating agent as mail from `@Human`. Without it, an escalation fails the flow.
	 * The MCP server supplies one backed by MCP elicitation (within the open `run_workflow` call).
	 */
	onEscalate?: (req: EscalationRequest) => Promise<string>
}

export interface WorkflowEvent {
	round: number
	kind: "stake" | "retry" | "committed" | "converged" | "error" | "deadlock" | "budget" | "escalate"
	agent?: string
	/** Routing targets of a `stake` (the `-> @X` recipients) — for the sequence-diagram trace. */
	to?: string[]
	detail?: string
}

export interface AgentResultSummary {
	name: string
	status: AgentState["status"]
	output?: unknown
	retryCount: number
}

export interface RunResult {
	flowName: string
	status: FlowState["status"]
	rounds: number
	agents: AgentResultSummary[]
}

// ── Output-contract validation (structural) ──

export interface ContractCheck {
	ok: boolean
	value?: Record<string, unknown>
	error?: string
}

/** Strip an optional ```json … ``` fence the model may wrap the result in. */
function stripFence(raw: string): string {
	const t = raw.trim()
	const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
	return (m ? m[1]! : t).trim()
}

const TYPE_OK: Record<string, (v: unknown) => boolean> = {
	string: (v) => typeof v === "string",
	number: (v) => typeof v === "number",
	boolean: (v) => typeof v === "boolean",
}

/** Validate a raw stake result against the structural output contract. */
export function validateContract(raw: string, schema: OutputSchema | undefined): ContractCheck {
	if (!schema) return { ok: true, value: undefined }
	let parsed: unknown
	try {
		parsed = JSON.parse(stripFence(raw))
	} catch (e) {
		return { ok: false, error: `result is not valid JSON (${(e as Error).message})` }
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, error: "result must be a JSON object" }
	}
	const obj = parsed as Record<string, unknown>
	for (const f of schema.fields) {
		if (!(f.name in obj)) return { ok: false, error: `missing required field "${f.name}"` }
		const check = TYPE_OK[f.fieldType]
		if (check && !check(obj[f.name])) {
			return { ok: false, error: `field "${f.name}" must be ${f.fieldType}` }
		}
	}
	return { ok: true, value: obj }
}

/** Compile a slang output contract to a JSON Schema for SDK structured output. */
export function contractToJsonSchema(schema: OutputSchema): Record<string, unknown> {
	const properties: Record<string, unknown> = {}
	for (const f of schema.fields) properties[f.name] = { type: f.fieldType }
	return {
		type: "object",
		properties,
		required: schema.fields.map((f) => f.name),
		additionalProperties: false,
	}
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
}

// ── Prompt construction ──

function contractDirective(schema: OutputSchema): string {
	const lines = schema.fields.map((f) => `  - ${f.name}: ${f.fieldType}`)
	return [
		"\n\nOUTPUT CONTRACT:",
		"Your final answer MUST be ONLY a single valid JSON object (no markdown, no prose, no fences)",
		"with exactly these fields:",
		...lines,
		"A non-JSON answer or any missing/mistyped field will be rejected and you will be re-prompted.",
	].join("\n")
}

function renderArg(value: Expr, state: AgentState, flowState: FlowState): string {
	const v = evalExpr(value, state, flowState)
	return typeof v === "string" ? interpolate(v, state, flowState) : formatEmittedValue(v)
}

type Expr = StakeOp["call"]["args"][number]["value"]

function buildStakePrompt(op: StakeOp, state: AgentState, flowState: FlowState): string {
	const parts: string[] = []
	for (const arg of op.call.args) {
		const rendered = renderArg(arg.value, state, flowState)
		parts.push(arg.name ? `${arg.name}: ${rendered}` : rendered)
	}
	let prompt = parts.join("\n\n")
	if (op.output) prompt += contractDirective(op.output)
	return prompt
}

// ── Setup ──

function validatedGroups(agent: AgentDecl): ToolGroup[] {
	const valid = new Set<string>(toolGroups)
	return (agent.meta.tools ?? []).filter((t): t is ToolGroup => valid.has(t))
}

function initFlowState(flow: FlowDecl, params: Record<string, unknown>): {
	flowState: FlowState
	programs: Map<string, Instr[]>
	agentDecls: Map<string, AgentDecl>
} {
	const agents = new Map<string, AgentState>()
	const programs = new Map<string, Instr[]>()
	const agentDecls = new Map<string, AgentDecl>()
	for (const item of flow.body) {
		if (item.type !== "AgentDecl") continue
		const decl = item as AgentDecl
		agents.set(decl.name, {
			name: decl.name,
			taskId: decl.name,
			status: "idle",
			opIndex: 0,
			bindings: new Map(),
			retryCount: 0,
		})
		programs.set(decl.name, compileAgentProgram(decl))
		agentDecls.set(decl.name, decl)
	}
	const flowState: FlowState = {
		flowName: flow.name,
		params,
		agents,
		round: 0,
		tokensUsed: 0,
		status: "running",
		mailbox: [],
		mailboxHistory: [],
	}
	return { flowState, programs, agentDecls }
}

// ── Run ──

/** The flow's `budget: rounds(N)` directive, if present — caps the executor's rounds.
 * Previously parsed but never read, so every flow ran to DEFAULT_MAX_ROUNDS. */
function flowBudgetRounds(flow: FlowDecl): number | undefined {
	for (const item of flow.body) {
		if (item.type === "BudgetStmt") {
			const r = item.items.find((i) => i.kind === "rounds")
			if (r && r.value.type === "NumberLit") return r.value.value
		}
	}
	return undefined
}

export async function runWorkflow(
	flow: FlowDecl,
	params: Record<string, unknown>,
	dispatcher: Dispatcher,
	opts: RunOptions,
): Promise<{ result: RunResult; flowState: FlowState }> {
	const { flowState, programs, agentDecls } = initFlowState(flow, params)
	// Precedence: explicit opts.maxRounds > the flow's own `budget: rounds(N)` > the safety default.
	const maxRounds = opts.maxRounds ?? flowBudgetRounds(flow) ?? DEFAULT_MAX_ROUNDS
	const emit = opts.onEvent ?? (() => {})
	// One agent ⇒ one session for its whole lifetime: resumed across stakes (and retries),
	// so the agent retains its history when re-staked.
	const sessions = new Map<string, string>()

	while (flowState.status === "running") {
		if (flowState.round >= maxRounds) {
			flowState.status = "budget_exceeded"
			emit({ round: flowState.round, kind: "budget" })
			break
		}

		let progressed = false
		for (const [name, state] of flowState.agents) {
			if (state.status !== "idle" && state.status !== "blocked") continue
			const program = programs.get(name)!
			const adv = advanceAgent(program, state, flowState.mailbox, flowState)
			progressed = true

			if (adv.type === "stake") {
				state.status = "running"
				const check = await runStakeWithRetries(name, state, flowState, adv.op, agentDecls.get(name)!, dispatcher, opts, emit, sessions)
				if (!check.ok) {
					state.status = "error"
					flowState.status = "error"
					emit({ round: flowState.round, kind: "error", agent: name, detail: check.error })
					break
				}
				state.output = check.value
				const before = flowState.mailbox.length
				routeOutput(flowState.mailbox, flowState.agents, name, adv.op, check.value)
				for (let i = before; i < flowState.mailbox.length; i++) flowState.mailboxHistory.push(flowState.mailbox[i]!)
				state.opIndex++
				state.retryCount = 0
				state.status = "idle"
			} else if (adv.type === "committed") {
				emit({ round: flowState.round, kind: "committed", agent: name })
			} else if (adv.type === "end") {
				// advanceAgent may have set "error" via its step-limit guard (status is mutated
				// in place, so TS's earlier idle/blocked narrowing is stale here).
				if ((state.status as AgentState["status"]) !== "error") state.status = "committed"
			} else if (adv.type === "await") {
				state.status = "blocked"
			} else if (adv.type === "escalate") {
				if (!opts.onEscalate) {
					state.status = "error"
					flowState.status = "escalated"
					emit({ round: flowState.round, kind: "error", agent: name, detail: "escalate @Human but no handler configured" })
					break
				}
				emit({ round: flowState.round, kind: "escalate", agent: name, detail: adv.op.reason })
				const answer = await opts.onEscalate({
					agent: name,
					reason: adv.op.reason,
					choices: adv.op.choices,
					form: adv.op.form,
				})
				// Deliver the human's answer to the agent as mail from @Human; the agent's
				// `await … <- @Human` consumes it next time it advances.
				const entry = { from: "Human", to: name, value: answer, timestamp: Date.now() }
				flowState.mailbox.push(entry)
				flowState.mailboxHistory.push(entry)
				state.opIndex++
				state.status = "idle"
			} else if (adv.type === "error") {
				state.status = "error"
				flowState.status = "error"
				emit({ round: flowState.round, kind: "error", agent: name })
			}
		}

		if (flowState.status !== "running") break
		if (checkConverge(flow, flowState)) {
			flowState.status = "converged"
			emit({ round: flowState.round, kind: "converged" })
			break
		}
		if (!progressed) {
			flowState.status = "deadlock"
			emit({ round: flowState.round, kind: "deadlock" })
			break
		}
		flowState.round++
	}

	return { result: summarize(flowState), flowState }
}

async function runStakeWithRetries(
	name: string,
	state: AgentState,
	flowState: FlowState,
	op: StakeOp,
	decl: AgentDecl,
	dispatcher: Dispatcher,
	opts: RunOptions,
	emit: (e: WorkflowEvent) => void,
	sessions: Map<string, string>,
): Promise<ContractCheck> {
	const allowedTools = resolveAllowedTools(validatedGroups(decl))
	const model = decl.meta.apiConfiguration ?? opts.defaultModel
	const basePrompt = buildStakePrompt(op, state, flowState)
	const maxRetries = op.retries ?? decl.meta.retry ?? MAX_RETRIES
	const outputJsonSchema = op.output ? contractToJsonSchema(op.output) : undefined

	let feedback = ""
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const prompt = attempt === 0 ? basePrompt : `${basePrompt}\n\n${feedback}`
		emit({ round: flowState.round, kind: attempt === 0 ? "stake" : "retry", agent: name, to: op.recipients.map((r) => r.ref), detail: `attempt ${attempt + 1}` })
		const res = await dispatcher.runStake({
			agentName: name,
			prompt,
			sessionId: sessions.get(name),
			allowedTools,
			disallowedTools: decl.meta.deny,
			writePaths: decl.meta.writePaths,
			model,
			systemPrompt: decl.meta.role,
			cwd: opts.cwd,
			sandbox: opts.sandbox,
			outputJsonSchema,
		})
		if (res.sessionId) sessions.set(name, res.sessionId)
		if (res.error) {
			feedback = `Your previous attempt did not produce a result (${res.error}). Provide the JSON answer now.`
			state.retryCount++
			continue
		}

		// Structural layer: prefer the SDK's schema-validated structured output; otherwise
		// parse and validate the result text ourselves.
		let value: Record<string, unknown> | undefined
		if (op.output && isPlainObject(res.structured)) {
			value = res.structured
		} else {
			const check = validateContract(res.result, op.output)
			if (!check.ok) {
				feedback = `Your previous answer was rejected: ${check.error}. Reply with ONLY the JSON object required by the OUTPUT CONTRACT.`
				state.retryCount++
				continue
			}
			value = check.value
		}

		// Layer 2 — semantic `where` clause: evaluate with the result fields in scope.
		if (op.where && value) {
			const evalState: AgentState = {
				...state,
				bindings: new Map<string, unknown>([...state.bindings, ...Object.entries(value)]),
			}
			if (!toBool(evalExpr(op.where, evalState, flowState))) {
				feedback =
					"Your answer was well-formed but violated the contract's semantic constraint (the `where` clause). " +
					"Revise the values so the constraint holds, and reply with ONLY the JSON object."
				state.retryCount++
				continue
			}
		}
		return { ok: true, value }
	}
	return { ok: false, error: `output contract not satisfied after ${maxRetries + 1} attempts` }
}

function summarize(flowState: FlowState): RunResult {
	return {
		flowName: flowState.flowName,
		status: flowState.status,
		rounds: flowState.round,
		agents: [...flowState.agents.values()].map((a) => ({
			name: a.name,
			status: a.status,
			output: a.output,
			retryCount: a.retryCount,
		})),
	}
}
