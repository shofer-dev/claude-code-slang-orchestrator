/**
 * Dispatcher — the seam between the deterministic slang executor and the agent runtime.
 *
 * The executor coordinates *what* runs and *when* (pure state machine); a Dispatcher
 * actually runs one stake against an agent and returns its terminal result. Isolating
 * this behind an interface keeps the executor independent of any specific agent backend
 * and lets the whole VM be tested with a fake.
 *
 * The production implementation (AgentSdkDispatcher) maps one slang agent to one Claude
 * Agent SDK session (`query()` / `resume`) and lives in its own module so the rest of the
 * server compiles and tests without that dependency present.
 */

export interface StakeRequest {
	/** Slang agent name (stable identity; one agent ⇒ one session for its lifetime). */
	agentName: string
	/** The prompt to send for this stake (already includes any routed inputs/contract). */
	prompt: string
	/** Existing session to resume; absent on the agent's first stake. */
	sessionId?: string
	/** Claude Code tool names this agent may use (from the tool-group mapping). */
	allowedTools: string[]
	/** Tool names this agent may NOT use (native, or MCP via `mcp__server__tool` /
	 * `mcp__server` / `mcp__*`). Deny wins over `allowedTools`. From the agent's `deny:`. */
	disallowedTools?: string[]
	/** Model alias or full id (`sonnet` / `opus` / `haiku` / id). */
	model?: string
	/** Role/system prompt layered onto the base. */
	systemPrompt?: string
	/** Working directory (also the sandbox writable root when sandboxing is on). */
	cwd: string
	/** Enable Claude Code's native filesystem sandbox for this session (Linux/macOS). */
	sandbox?: boolean
	/**
	 * JSON Schema for the stake's output contract. When set, the dispatcher requests SDK
	 * structured output (`outputFormat`) so the result is validated against it and returned
	 * in {@link StakeResult.structured}. This is the SDK's structural enforcement layer
	 * (post-hoc validate + re-prompt — not token-level constrained decoding, which the SDK
	 * does not expose for custom tools).
	 */
	outputJsonSchema?: Record<string, unknown>
	/** Per-stake wall-clock cap (ms). Omitted ⇒ the dispatcher's default; <=0 ⇒ no cap. */
	timeoutMs?: number
}

export interface StakeResult {
	/** The session id (captured on first stake, echoed on resume) for later resumption. */
	sessionId: string
	/** Raw terminal output of the stake (the contract payload, pre-validation). */
	result: string
	/** Structured args captured from a `submit_result` tool call, when available. */
	structured?: unknown
	/** Set when the stake failed to produce a terminal result (turn limit, retraction…). */
	error?: string
}

export interface Dispatcher {
	/** Run one stake to completion (the agent works and terminates), returning its result. */
	runStake(req: StakeRequest): Promise<StakeResult>
}

/**
 * Deterministic in-process Dispatcher for tests and offline development — no agent runtime.
 * Echoes a canned result keyed by agent so the executor, mailbox routing, and convergence
 * can be exercised with plain fixtures.
 */
export class FakeDispatcher implements Dispatcher {
	private counter = 0
	constructor(private readonly responder: (req: StakeRequest) => string = () => "{}") {}

	async runStake(req: StakeRequest): Promise<StakeResult> {
		const sessionId = req.sessionId ?? `fake-${req.agentName}-${++this.counter}`
		return { sessionId, result: this.responder(req) }
	}
}
