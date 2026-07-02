/**
 * Central registry of tunable magic numbers and internal defaults for the slang executor,
 * control-flow interpreter, and agent dispatcher — so the runtime's behaviour is reviewable
 * and editable in one place, with no magic numbers scattered across modules.
 *
 * Precedence for the overridable ones: an explicit call-site field wins, then a `.slang`
 * directive, then the default here:
 *   - rounds:  `RunOptions.maxRounds` > flow `budget: rounds(N)` > `DEFAULT_MAX_ROUNDS`
 *   - retries: op `retries(N)` > agent `retry:` > `MAX_RETRIES`
 *   - timeout: `StakeRequest.timeoutMs` (<=0 ⇒ no cap) > `DEFAULT_STAKE_TIMEOUT_MS`
 *
 * Deliberately NOT here (not tunables): the MCP server `VERSION` (a version tag, in `main.ts`);
 * the tool-group → Claude Code tool mapping and per-model tool prefs (integrator-owned, in
 * `tool-group-map.ts`); string identifiers (the `SLANG_WRITE_PATHS` hook env var, SDK model
 * ids/preset names); and the slang lexer/parser error codes.
 */

// ── executor: round + retry budgets ──
/** Safety cap on executor rounds when neither `RunOptions.maxRounds` nor the flow's
 * `budget: rounds(N)` is set — guarantees the run terminates. */
export const DEFAULT_MAX_ROUNDS = 100
/** Output-contract re-prompt attempts per stake (a stake runs up to `MAX_RETRIES + 1` times).
 * Overridable per-op (`retries(N)`) or per-agent (`retry:`); `retries(0)` ⇒ fail on first miss. */
export const MAX_RETRIES = 3

// ── control-flow interpreter ──
/** Hard cap on `repeat` / `when` interpreter steps per flow — backstops a runaway loop in a
 * malformed or LLM-generated workflow before it can spin forever. */
export const MAX_CONTROL_FLOW_STEPS = 10_000

// ── agent dispatch ──
/** Per-stake wall-clock cap (ms): aborts an agent session that never produces a terminal
 * result (stuck tool loop / hung turn) so it can't hang the whole flow. Overridable via
 * `StakeRequest.timeoutMs`; `<= 0` disables the cap. */
export const DEFAULT_STAKE_TIMEOUT_MS = 300_000
