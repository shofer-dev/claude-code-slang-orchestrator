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

**`write_paths` enforcement — `canUseTool` vs command hook (resolved).** The first
`write_paths` backing used the SDK's `canUseTool`. That needs the Agent-SDK **control
protocol** (a bidirectional Node↔CLI channel for the JS callback), whose subprocess launch
**deterministically fails when `cwd` is the full shofer worktree** — "native binary failed
to launch (musl on glibc)", but the message is misleading: it's **cwd-dependent**, not
libc. Isolation established (each tested alone, worktree cwd): bypass-mode stakes launch
fine there; **any JS callback** — `canUseTool` *or* a JS hook — fails; minimal cwds (plain,
git-dir, git-worktree, node_modules) all pass; only the large real project fails. Ruled out:
binary/libc, project settings (`settingSources:[]`), MCP (`mcpServers:{}`), settings-hooks,
git-worktree (`.git` detached), `node_modules` presence, resource exhaustion (tmpdir passes
+ worktree fails back-to-back in one process).

**Fix: back `write_paths` with a PreToolUse *command* hook** (`server/src/write-guard.mjs`)
instead of `canUseTool`. A command hook is run by the CLI itself — no control protocol — so
it launches under `bypassPermissions` wherever a normal stake does. Injected **per-session**
via inline `settings` + a `SLANG_WRITE_PATHS` env var, so it scopes only the `write_paths`
agent, not others sharing the worktree cwd. The `write_paths:` language surface is unchanged;
only the dispatcher's mechanism changed. **Verified end-to-end in the worktree:** the
Architect launches (0 binary errors) and a `.ts` write is denied → falls back to `.md`; the
hook produces **no spurious denials** on the allowed `.md` design (isolated `create_design`:
`writes=0, denies=1` where the 1 was an `EISDIR` directory-read, not a write-scope block).

**Architect termination tune.** With `write_paths` working, the only remaining issue was
the Architect *over-exploring* `create_design` — it wrote the `.md` design then kept
spawning sub-agents past the timeout instead of returning. Fixed with an output contract
(`{summary}`) + instructions to "write the design then STOP, no implementing, no
sub-agents." Now `create_design` returns cleanly on attempt 1.

### ✅ Converges end-to-end (the hardened workflow)

A real run on a clean shofer worktree **converged in 9 rounds / 507s, 0 launch errors**:
`create_design` (Architect writes `.md` only) → escalation → `implement` (hand-off) →
Developer writes `src/utils/formatDuration.ts` + vitest spec → review loop (Reviewer flags
missing boundary tests → Developer fixes) → terminal → converged. **The Architect authored
only the `.md` design; the Developer wrote the code** — `write_paths` enforced the
delegation that was run-1's root-cause bug, and the produced `formatDuration` is correct.
Convergence remains probabilistic on agent behavior, but the mechanism (launch, scoping,
termination, handshake) is now solid.

### Convergence rate: 5/5

Same workflow + prompt, fresh-reset worktree each time (`harness/convergence-rate.sh`):

| run | status | rounds | elapsed |
|---|---|---|---|
| 1 | converged | 9 | 589s |
| 2 | converged | 8 | 497s |
| 3 | converged | 8 | 822s |
| 4 | converged | 8 | 387s |
| 5 | converged | 8 | 484s |

**5/5 converged**, every run wrote the implementation, **0 launch errors** across all runs.
Round count is stable (8–9, the canonical happy/one-reject paths); wall-clock varies
(~6.5–14 min) with agent speed. The hardened `implement-feature` is now reliable enough to
anchor the two-arm benchmark.

## Two-arm comparison — Operator (slang) vs Driver (LLM)

> Supersedes the earlier caution that `implement-feature` wasn't benchmark-ready: after the
> hardening above (arm A = 5/5), the full A/B was run.

**Setup (identical task, verified).** `harness/convergence-rate.sh` (arm A) and
`harness/driver-rate.sh` (arm B) run a **byte-identical** feature + `design_path`, the same
`implement-feature.slang`, the same worktree (`/tmp/slang/shofer` @ `5429efcab`, reset clean
per run), the **same three agents** (arm B parses Architect/Developer/Reviewer from the same
workflow → identical tools/role/`write_paths`), and the same model (`sonnet`). The single
intended difference is **who coordinates**: the deterministic slang executor (A) vs an LLM
that decides each step (B, `harness/driver.ts`). *Honest framing:* the coordinator difference
necessarily changes **how agents are instructed** (authored stake prompts + validated output
contracts vs the driver's generated prose) — a fair **paradigm** comparison, not a clean
single-variable ablation.

**The metric that matters — "converged" ≠ shipped.** Both arms *self-report* convergence. We
ignore that and check the **filesystem**: does `src/utils/formatDuration.ts` exist? "Real
impl" = the code is on disk.

### Arm A — Operator (slang): 5/5 real implementations

The 5/5 table above — all 5 wrote the impl, 0 launch errors. **Coordination LLM tokens = 0**
(the executor is deterministic code); protocol (design→implement→review→done) **guaranteed by
construction**.

### Arm B — Driver (LLM): a methodology fork first (avoid strawman)

**Naive prompt — discarded (3/3 false convergence).** The first driver prompt left the
starting state implicit and named the design path as if it existed. The driver **hallucinated
the work was already done** and chose `finish` after 0–3 steps **without writing code** —
`converged=true`, `impl=no` every time (one run finished at **0 steps**, never invoking an
agent; 179k–276k coordination tokens). That measured a bad prompt, not LLM orchestration — so
it's a methodology note (cf. live-memory's `--strict-mcp-config` confound), not the result.

**Fair prompt — the real baseline.** Told the driver the true clean starting state, the role
dependencies, and "trust ONLY the specialists' actual results, never assume work exists" —
**without** scripting the order (drift still possible). 5 runs:

| run | converged (self-report) | ran A→D→R | final work reviewed | **real impl** | driver tokens |
|---|---|---|---|---|---|
| 1 | ✓ | ✓ | ✓ | **no**  | 98.0k |
| 2 | ✓ | ✓ | ✓ | **no**  | 98.3k |
| 3 | ✓ | ✓ | ✓ | **no**  | 99.1k |
| 4 | ✓ | ✓ | ✓ | **yes** | 98.2k |
| 5 | ✓ | ✓ | ✗ | **no**  | 124.2k |

**5/5 self-report "converged" and ran the full protocol — yet only 1/5 shipped real code.**
Coordination ~98–124k tokens/run (mostly cache-read; ~0 for arm A).

### Mechanism — why the fair driver false-converges

The fair prompt fixed the *driver's* step-skipping, so the failure moved **one level down**
(root-caused from the run logs + the produced artifact):
1. The Architect is `write_paths`-restricted to `.md`, so — unable to write code — it **embeds
   the full implementation as a code block in the design `.md`** (verified: the design was 163
   lines including the complete `formatDuration` body).
2. The Developer, given the driver's brief free-form instruction, reads the design, sees
   complete code, and reports **"done — both files already present"** *without creating the
   `.ts`*.
3. The driver (neutral cwd, no verification) trusts it; the Reviewer "reviews" nonexistent
   code and passes; the driver finishes. `impl=no`.

**Arm A gets the identical design yet implements 5/5** — its Developer's *authored* stake
prompt + a validated `{done,summary}` contract + the executor faithfully running the
review→fix loop (Reviewer caught missing tests → Developer fixed → real files) **ground the
agent** where the driver's loose coordination is fooled.

### Head-to-head

| | A — Operator (slang) | B — Driver (fair LLM) |
|---|---|---|
| converged (self-report) | 5/5 | 5/5 |
| **real implementation** | **5/5** | **1/5** |
| protocol fidelity | **guaranteed (by construction)** | ran 5/5, but **hollow** (reviewing no code) |
| coordination LLM tokens / run | **0** | ~98–124k |
| false-convergence possible | **no** | yes (naive 3/3, fair 4/5) |

### Conclusions

- **Coordination cost** — the clean, guaranteed delta: **0 vs ~100k tokens/run**, pure
  overhead on top of identical agent work.
- **Reliability** — the headline: same agents, same task, the operator ships **5/5** vs the
  LLM coordinator **1/5**, because **enforced output contracts + a deterministic loop** catch
  agent hallucination that free-form coordination can't.
- **Protocol fidelity** — a *guarantee* for the operator (static structure), a *per-run
  variable* for the LLM (naive: skips steps; fair: runs them but hollow).

**Honest caveats.** One feature, one model, 5 runs/arm — read as **directional**, not exact
rates. The failure is amplified by the `.md`-only Architect embedding code; a sharper driver
(verification tools, stricter per-agent instructions) would narrow the gap — but that means
**re-implementing the executor's contracts + validation**. That *is* the thesis: slang gives
that floor **for free and provably**, and the gap **widens with coordination complexity**
(more agents, loops, longer context) — the regime the product targets. Harnesses:
`convergence-rate.sh` (A), `driver.ts` + `driver-rate.sh` (B); raw data in `/tmp/slang/diag/`.
