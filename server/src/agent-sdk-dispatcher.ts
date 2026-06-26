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
		// Append the agent role to Claude Code's default system prompt (don't replace it).
		if (req.systemPrompt) options.systemPrompt = { type: "preset", preset: "claude_code", append: req.systemPrompt }
		if (req.sessionId) options.resume = req.sessionId
		if (req.outputJsonSchema) options.outputFormat = { type: "json_schema", schema: req.outputJsonSchema }
		if (this.sdk.pathToClaudeCodeExecutable) options.pathToClaudeCodeExecutable = this.sdk.pathToClaudeCodeExecutable

		let sessionId = req.sessionId ?? ""
		let result = ""
		let structured: unknown
		let error: string | undefined

		for await (const msg of this.queryFn({ prompt: req.prompt, options })) {
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

		if (!result && structured === undefined && !error) error = "no result message returned"
		return { sessionId, result, structured, error }
	}
}
