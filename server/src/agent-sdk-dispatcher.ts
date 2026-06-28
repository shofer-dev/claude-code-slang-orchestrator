/**
 * AgentSdkDispatcher — production Dispatcher backed by the Claude Agent SDK.
 *
 * One stake = one `query()` call. The agent runs autonomously (no interactive approval),
 * terminates, and its final result text is captured as the stake result for the executor
 * to validate against the output contract. Session ids are captured so later phases can
 * resume an agent across stakes.
 *
 * This is the only module that imports the Agent SDK; everything else depends on the
 * `Dispatcher` interface and is testable with `FakeDispatcher`.
 */
import { query as realQuery } from "@anthropic-ai/claude-agent-sdk"
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Dispatcher, StakeRequest, StakeResult } from "./dispatcher.js"

/**
 * The slice of the SDK's `query()` we depend on: given a prompt + options, it yields a stream
 * of SDK messages. Injectable so the *boundary* — our Options assembly and our message →
 * {@link StakeResult} mapping — can be tested without spawning the CLI or calling a model.
 * Everything *inside* `query()` (the CLI, the API, the model) is out of our control.
 */
export type QueryFn = (args: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>

/** Default per-stake wall-clock cap (ms): aborts an agent session that never terminates. */
export const DEFAULT_STAKE_TIMEOUT_MS = 300_000

export interface AgentSdkDispatcherOptions {
	/** Override the Claude Code executable the SDK spawns (defaults to auto-resolution). */
	pathToClaudeCodeExecutable?: string
}

export class AgentSdkDispatcher implements Dispatcher {
	constructor(
		private readonly sdk: AgentSdkDispatcherOptions = {},
		/** The SDK `query()` to drive — overridable in tests; defaults to the real SDK. */
		private readonly queryFn: QueryFn = realQuery,
	) {}

	async runStake(req: StakeRequest): Promise<StakeResult> {
		const options: Options = {
			cwd: req.cwd,
			allowedTools: req.allowedTools,
			// Inner sessions are autonomous — never block on interactive approval.
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
		}
		if (req.model) options.model = req.model
		// Per-agent tool deny-list — removes named tools entirely (native, or MCP via
		// `mcp__server__tool` / `mcp__server` / `mcp__*`). Deny wins over the allow-list.
		if (req.disallowedTools?.length) options.disallowedTools = req.disallowedTools
		// Append the agent role to Claude Code's default system prompt (don't replace it).
		if (req.systemPrompt) options.systemPrompt = { type: "preset", preset: "claude_code", append: req.systemPrompt }
		if (req.sessionId) options.resume = req.sessionId
		if (req.outputJsonSchema) options.outputFormat = { type: "json_schema", schema: req.outputJsonSchema }
		if (this.sdk.pathToClaudeCodeExecutable) options.pathToClaudeCodeExecutable = this.sdk.pathToClaudeCodeExecutable

		// Per-stake wall-clock cap: an agent session that never produces a terminal result
		// (tool loop, stuck turn) would otherwise hang the whole flow forever. On timeout we
		// abort the query and report an error; the executor then retries / fails the stake
		// deterministically instead of blocking. Default generous; opt out with timeoutMs<=0.
		const timeoutMs = req.timeoutMs ?? DEFAULT_STAKE_TIMEOUT_MS
		const ac = new AbortController()
		if (timeoutMs > 0) options.abortController = ac
		const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : undefined

		// Make the agent aware of its time budget so it can plan to finish in time (the
		// abort above is a hard backstop; this is the soft, cooperative deadline).
		const prompt = timeoutMs > 0
			? `${req.prompt}\n\n[Time budget: you have about ${Math.round(timeoutMs / 1000)}s of wall-clock time to finish this task and return your result. Work efficiently; if you are running low on time, stop and return your best result rather than continuing past the budget.]`
			: req.prompt

		let sessionId = req.sessionId ?? ""
		let result = ""
		let structured: unknown
		let error: string | undefined

		try {
			for await (const msg of this.queryFn({ prompt, options })) {
				if (msg.type === "system" && msg.subtype === "init") {
					sessionId = msg.session_id
				} else if (msg.type === "result") {
					sessionId = msg.session_id
					if (msg.subtype === "success") {
						result = msg.result
						if (msg.structured_output !== undefined) structured = msg.structured_output
					} else {
						error = msg.subtype
					}
				}
			}
		} catch (e) {
			error = ac.signal.aborted ? `stake timed out after ${timeoutMs}ms` : (e as Error).message
		} finally {
			if (timer) clearTimeout(timer)
		}

		if (!result && structured === undefined && !error) error = "no result message returned"
		return { sessionId, result, structured, error }
	}
}
