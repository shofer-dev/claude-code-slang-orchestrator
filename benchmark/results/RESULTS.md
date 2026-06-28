# Slang Orchestrator — benchmark results

## Smoke findings (real-run validation)

### ✅ The executor drives real multi-agent flows

`pipeline.slang` (2 agents, await + routing + output contracts): Producer→`{n:21}` →
Worker→`{doubled:42}`, **converged** in 8.9s, contracts honored. The real
`AgentSdkDispatcher` path works — the thing the 40 unit tests only mock.

### ⚠️ The flagship `implement-feature.slang` does NOT run reliably (as-is)

Run on a faithful shofer **master** worktree (feature: a `formatDuration` util).
**Two real runs, two distinct failures — neither converged cleanly:**

1. **Run 1 — livelock.** The full protocol executed and the *work succeeded*:
   Architect designed it, escalation auto-approved, Developer implemented
   `formatDuration` + 13 passing tests, Reviewer returned **PASS**. But the
   Architect↔Developer **done/accept handshake never closed** — it looped to
   `budget_exceeded` at **round 100**. Deterministic, but a **livelock**, not a clean
   convergence.
2. **Run 2 — agent hang.** Hung at the Architect's `implement` hand-off stake (r2);
   the agent session stalled for the full 15-min timeout (`exit=124`), orphaning
   agent processes.

Plus a clear bug: **the `.slang` `budget: rounds(30)` directive is dead-wired** — the
executor uses `opts.maxRounds ?? DEFAULT_MAX_ROUNDS` (=100) and nothing plumbs the
flow's `budget` in. So the flow ran to 100, not 30.

### The honest thesis correction

The naive claim — "slang = deterministic = reliable" — is too strong, the same way
live-memory's "saves tokens" was. **Deterministic *coordination* is necessary but not
sufficient for reliable *workflows*.** End-to-end reliability also requires:
- a **correct workflow spec** (implement-feature's count-matched done/accept handshake
  is fragile and livelocks here), and
- **robust agent dispatch** (real Agent-SDK sessions are slow and sometimes hang).

The executor's round cap *is* the reliability backstop working as designed — it
terminated deterministically (`budget_exceeded`) instead of hanging forever. But the
workflow did not succeed. A buggy/fragile `.slang` deterministically fails.

## Hardening pass (making implement-feature execute reliably)

**The executor coordination is correct.** A deterministic `FakeDispatcher` repro
(`harness/repro-handshake.ts`) replaying the *intended* agent outputs converges in 8
rounds; a stress harness (`harness/stress-handshake.ts`) shows it also converges under
realistic reject-then-approve review cycles and **terminates** (not hangs) when a
reviewer never approves. So the pre-fix failures were **not** executor coordination bugs.

**Two real executor/dispatcher bugs found + fixed (with tests):**
1. **`budget: rounds(N)` was dead-wired.** Parsed but never read — every flow ran to the
   hard `DEFAULT_MAX_ROUNDS=100`. Now plumbed (`opts.maxRounds > flow budget > default`).
2. **No per-stake timeout.** `runStake` iterated the SDK stream uncapped, so a hung agent
   session hung the whole flow forever (run 2's 15-min hang). Added an AbortController +
   300s default cap; on timeout the stake errors and the executor proceeds.

**A workflow design fragility:** `progress_update` and `done_signal` share the
`{done,summary}` schema, so a Developer that sets `done:true` early **bypasses the review
loop** (the "skip review" failure mode) — deterministically reproduced.

**Mode-enforcement gap (from the real diagnostic run):** the `architect` mode's write
restriction (shofer: `.md`-only) is **not enforced** in the claude-code mapping — the
real Architect agent wrote `format-duration.ts` and *implemented the feature itself* during
`create_design`, instead of delegating. The `write` tool-group maps to Claude Code's full
Write/Edit. This corrupts the delegation premise (still converged once anyway, but it's a
real mapping bug).

**Post-fix outcome:** with budget + timeout in place, `implement-feature` **always
terminates**, and a real run **converged** in the canonical 8-round path (all agents
committed, 307s). Convergence is now **probabilistic** — it depends on the real agents
emitting the right contract signals. Convergence-rate measurement (N post-fix runs):
_see `rate.csv` — pending._

## Reliability fixes (language/executor) + a tool-control mechanism

Built to make `implement-feature` execute reliably (all tested, 48 pass):
- **Budget honored** + **per-stake timeout** → the flow always *terminates* (no more
  100-round livelocks / 15-min hangs).
- **`deny: [...]`** → SDK `disallowedTools` (native + MCP: `mcp__server__tool` /
  `mcp__server` / `mcp__*`). The general "which tools can/can't this agent use" control.
- **`write_paths: [glob]`** → argument-scoped Write/Edit via the SDK's `canUseTool`.
- **Stake time-budget** is communicated to the agent (soft deadline) alongside the abort.

**Root cause of run 1 (diagnosed):** the real **Architect implements the feature itself**
during `create_design`, because shofer's `architect` mode (`.md`-only write) is a no-op in
the port. The hardened workflow (`benchmark/workflows/implement-feature.slang`) blocks that.

**Environmental caveat on `write_paths`/`canUseTool` (this host):** the SDK's `canUseTool`
*control-protocol* launch is **unreliable here** — `create_design` consistently fails with
"native binary failed to launch (musl on glibc)" for **both** the bundled CLI (musl) and the
system `claude 2.1.195` (newer protocol than SDK `0.3.187`). The **bypass-mode** path
(`deny:` / normal stakes) is unaffected and reliable (pipeline + the original
`implement-feature` converge). So on this host the **robust** way to force Architect
delegation is **`deny: [Write, Edit, Bash]`** (pure coordinator; design authored by a
delegate) — the `write_paths` approach is correct + unit/probe/`wptest`-verified but blocked
here by the SDK control-protocol/libc/version mismatch.

### Implication for the benchmark

`implement-feature` is **not benchmark-ready** until its convergence + the budget
plumbing + agent-hang robustness are addressed. The A/B reliability comparison needs a
workflow the **slang arm itself completes reliably**. Recommended: establish the
benchmark on a simpler, reliably-converging multi-agent workflow first (pipeline, or a
fixed single-round review), then return to implement-feature once it's hardened.
