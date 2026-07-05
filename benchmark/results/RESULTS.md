# Slang Workflows — benchmark results

## Smoke findings (real-run validation)

### ✅ The executor drives real multi-agent flows

`pipeline.slang` (2 agents, await + routing + output contracts): Producer→`{n:21}` →
Worker→`{doubled:42}`, **converged** in 8.9s, contracts honored. The real
`AgentSdkDispatcher` path works — the thing the 40 unit tests only mock.

### ⚠️ The flagship `implement-feature.slang` does NOT run reliably (as-is)

Run on a worktree of a large internal repo (feature: a `formatDuration` util).
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
restriction (upstream: `.md`-only) is **not enforced** in the claude-code mapping — the
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
during `create_design`, because the upstream `architect` mode (`.md`-only write) is a no-op in
the port. The hardened workflow (`benchmark/workflows/implement-feature.slang`) blocks that.

**`write_paths` enforcement — `canUseTool` vs command hook (resolved).** The first
`write_paths` backing used the SDK's `canUseTool`. That needs the Agent-SDK **control
protocol** (a bidirectional Node↔CLI channel for the JS callback), whose subprocess launch
**deterministically fails when `cwd` is the full internal-repo worktree** — "native binary failed
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

A real run on a clean internal-repo worktree **converged in 9 rounds / 507s, 0 launch errors**:
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
`implement-feature.slang`, the same worktree (the internal target repo @ `5429efcab`, reset clean
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
**without** scripting the order (drift still possible).

**A harness confound found + fixed (do not skip this).** `plans/` was **gitignored** in that repo
(`.gitignore:57`), so the worktree reset (`git clean -fd`, no `-x`) **left the previous run's
code-laden design in place** — priming both the driver and the Developer that work "already
exists." The first batch (with the confound) scored **1/5**; after fixing the reset
(`rm -rf plans`) and re-running, the fair driver scores **3/5**. The **3/5 is the honest
number**; the confounded 1/5 is retained only to show the effect.

| run | converged (self-report) | ran A→D→R | final work reviewed | **real impl** | driver tok | failure |
|---|---|---|---|---|---|---|
| 1 | ✓ | ✓ | ✓ | **yes** | 98.3k | — |
| 2 | ✓ | ✓ | ✓ | **yes** | 98.4k | — |
| 3 | ✓ | ✓ | ✓ | **no**  | 97.9k | Developer hallucinated "done" |
| 4 | ✓ | ✓ | ✓ | **yes** | 97.9k | — |
| 5 | ✓ | ✗ (1 step) | ✗ | **no**  | 134.7k | driver skipped A+D, "all present" |

**All 5 self-report "converged"; 3/5 ship real code — i.e. a 40% *silent false-convergence*
rate** (reports success, ships nothing). Coordination ~98–135k tokens/run (~0 for arm A).

### Mechanism — two failure modes (both instrumented)

**(a) Developer-level hallucination (run 3; dominant mode).** Root-caused from an instrumented
run + the artifact:
1. The Architect is `write_paths`-restricted to `.md`, so — unable to write code — it **embeds
   the full implementation as a code block in the design `.md`** (verified: the design carried
   the complete `formatDuration` body, 2 code blocks).
2. The Developer, given the driver's brief free-form instruction, reads the design, sees
   complete code, and — **stochastically** — either *verifies the filesystem and writes* (the
   3/5: instrumented run showed it run `ls src/utils/` → "does not exist" → wrote 3 files → 9
   tests pass), or *trusts the design and reports* **"done — both files already present"**
   without writing (the 2/5).
3. When it doesn't write, the driver (neutral cwd, no verification) trusts it and the Reviewer
   "reviews" nonexistent code and passes.

**(b) Coordinator-level drift (run 5).** The driver itself declared *"design, implementation,
and spec are all present, 15/15 tests pass,"* ran only the Reviewer, and finished in **one
step** — skipping the Architect and Developer entirely.

**Arm A gets the identical (code-laden) design yet implements 5/5** — its Developer's
*authored* stake prompt + a validated `{done,summary}` contract + the executor faithfully
running the review→fix loop (Reviewer caught missing tests → Developer fixed → real files)
**force a verified artifact** where the driver's free-form relay lets an unverified claim reach
"done." The essence: free-form coordination never *requires* any step to produce a verified
result; whether the Developer bothers to check + write is left to chance.

### Arm C — native Claude Code dynamic workflows (codified JS orchestration): 5/5

Claude Code's **dynamic-workflows** feature (v2.1.154+) is the modern, fair comparison: an
LLM writes a **JavaScript orchestration script** that the runtime executes, coordinating
subagents. Unlike arm B, the plan is *codified* — once written it runs deterministically
(JS control flow, **~0 per-run coordination LLM**), like slang. Arm C ran the *same* three
roles (Architect→Developer⇄Reviewer) over the *same* `formatDuration` task in the *same*
worktree (`benchmark/harness/armc-workflow.js`; `schema` as the contract-analog).

**Result: 5/5 real implementations** (impl + spec every rep), all in 1 review round; ~59k
tokens/run (all *agent work* — the script's coordination is 0 LLM). Notably the Architect
*still* embedded code in the design (2 code blocks, as in A/B), yet the Developer wrote the
real files every time — because the codified script explicitly said "create the ACTUAL
files + run the tests" and the Reviewer was guarded ("do not approve if the file doesn't
exist"). **Codified orchestration grounds the agents, exactly as arm A does.**

*Caveat:* arm C's reliability rests on a **well-authored script** (that reviewer guard is
load-bearing); a sloppier script could regress. And `write_paths` (`.md`-only) is **not
enforceable** in a native workflow — it was prompt-only, so the Architect *could* have
written code directly. slang bakes both (the review-loop grounding *and* enforced tool
scoping) into the DSL/executor.

### Head-to-head (three arms)

Real implementations across **two features** — formatDuration (f1) + formatBytes (f2), 5 runs each:

| | A — Operator (slang) | C — Native dynamic workflow | B — Driver (turn-by-turn LLM) |
|---|---|---|---|
| **real impl — f1** | **5/5** | **5/5** | **3/5** |
| **real impl — f2** | **5/5** | **5/5** | **3/5** |
| **combined** | **10/10** | **10/10** | **6/10** |
| orchestration | codified **DSL** | codified **JS script** | **live LLM** decisions |
| per-run coordination LLM tokens | **0** | **~0** (deterministic script) | ~98–154k |
| silent false-convergence | impossible | not observed (0/10) | **~40%** (4/10) |
| enforced output contracts | **yes** (validated + re-prompt) | partial (`schema` structured output) | no |
| static analysis (deadlock/ref) | **yes** | no | no |
| enforced tool scoping (`write_paths`/`deny`) | **yes** | no (prompt-only) | no (prompt-only) |
| provable termination (budget/timeout) | **yes** | no (script must self-bound) | no |
| auto-generated diagrams | **topology + trace (Mermaid)** | progress tree only | none |

**Second feature (`formatBytes`) confirms the pattern** — same harness, distinct task, 5 runs/arm:
arm A **5/5**, arm C **5/5**, arm B **3/5** — identical shape to formatDuration. So the split is
robust across two features (codified A/C = **10/10**; turn-by-turn B = **6/10**), not task-specific.

> *Harness honesty note:* the **first** arm-C/f2 attempt scored 0/5 but was **invalid** — a
> `Workflow` `args`-propagation bug meant the workflow silently built *formatDuration* (its
> hardcoded default) while we checked for `formatBytes`. Caught by inspecting the design (**0**
> mentions of the target feature). Re-run with the feature hardcoded inline → **5/5**. The lesson
> cuts both ways: even the native-workflow path has footguns that need per-run verification —
> which is exactly what slang's enforced contracts provide.

### Complexity test — "the gap widens with complexity" is REFUTED (it's task-dependent)

To test the positioning claim that the codified-vs-turn-by-turn gap *widens with coordination
complexity*, we ran a deliberately harder workflow: a **5-agent pipeline** (Architect →
Developer → Tester → Reviewer → Documenter, `implement-feature-complex.slang`) implementing a
**multi-file** feature (an `LRUCache`: class + vitest spec + usage doc = **3 required
deliverables**). All three arms × 5 runs, scored on **full delivery** (all 3 artifacts present
— catches a coordinator that drops a stage):

| | A — slang | C — native workflow | B — turn-by-turn LLM |
|---|---|---|---|
| **full delivery** | **5/5** | **5/5** | **5/5** |
| coordination tokens/run | 0 | ~0 | ~155k |

**The hypothesis is refuted.** Turn-by-turn (arm B) went from **3/5 on the simple task → 5/5 on
the complex one** — it did *better* with more coordination, not worse. Root cause: arm B's
simple-task failures were **never about complexity**; they were a **confusable handoff** — the
`.md`-only Architect embeds the full implementation as a code block in the design, so the
Developer reads a code-laden design and reports "already done" without writing. The 5-stage
task **removes that ambiguity** (each role has a distinct, unmistakable deliverable: design /
code / tests / review / docs), so the coordinator has nothing to be fooled by. **More
decomposition *helped* the turn-by-turn coordinator.**

**Corrected takeaway.** Reliability is **task-dependent** (which failure modes a task exposes),
not monotonic in complexity. Turn-by-turn LLM coordination is vulnerable to hallucination /
lazy-termination on *confusable* tasks and has nothing to catch it; codified arms embed a
verification step (contracts / a review stage) that does. **What protects against the failure —
at any complexity — is a grounded verification step in the loop, not "being codified" per se.**
So slang's differentiation stands where it always was — **enforced guarantees + auto-generated
diagrams** — *not* a reliability edge that grows with complexity (that specific claim is
unsupported by this test).

### Conclusions (the honest reframe)

- **Reliability comes from *codified* orchestration, not from slang specifically.** Across **two
  features** (10 runs each) both arm A (slang DSL) and arm C (native JS workflow) ship **10/10**;
  the turn-by-turn LLM coordinator (arm B) shipped **6/10** here. **⚠️ Superseded:** the N=5 batches
  this bullet summarizes reported a "~40% silent false-convergence" — the **N=10/model firm-up
  (§ Firmed-up reliability) found 0%**, so that gap was small-N variance, not a real effect. The
  durable dividing line is not reliability but **coordination cost** (~0 for codified A/C vs ~95k
  tokens/run for live-LLM B) — and arm B's turn-by-turn model is what Claude Code's native
  dynamic-workflows feature was **shipped to replace**.
- **So slang does *not* win on raw reliability against modern tooling** — a native dynamic
  workflow matches it. slang's differentiation is the **guarantees and tooling on top of
  codified orchestration** (the bottom half of the table): enforced output contracts, static
  analysis (deadlock/unknown-ref/orphan detection), **enforced** `write_paths`/`deny` tool
  scoping, provable termination, and **auto-generated topology + trace diagrams** — none of
  which a raw JS workflow provides (arm C's reliability even *depended* on a hand-added
  reviewer guard + prompt-only `.md` restriction that slang enforces by construction).
- **Coordination cost:** ~0 per-run LLM for both codified arms (A, C) vs ~100k/run for the
  live-LLM coordinator (B).

### Firmed-up reliability (N=10 per model) — the false-convergence claim does not hold up

The runs above were all on Sonnet at N=5. Re-running arm B **×10 on each of two models** (`sonnet`
and `claude-fable-5`; same feature + self-contained scaffold; via `BENCH_MODEL`) does **not**
reproduce the "silent false-convergence" that was the headline arm-B failure:

| arm B (turn-by-turn) | converged | review ran (no skip) | silent false-convergence | impl at expected path | coord tokens/run |
|---|---|---|---|---|---|
| **Sonnet** ×10 | 9/10¹ | 9/9 | **0/10** | 8/10² | ~98k |
| **Fable** ×10  | 10/10 | 10/10 | **0/10** | 9/10² | ~95k |

¹ one run was a harness/launch crash (the driver process died), not a coordination failure.
² the misses are "converged **and** the review ran, but the impl file wasn't at the exact expected
path" — a naming/path quirk of the file-existence checker, **not** the review-skipping the original
claim described.

Arm A (slang) control on Fable: **2/2**, impl every run, **~4× faster** (271s vs Sonnet's 1075s/run)
— codified reliability holds across models by construction.

**Correction to the headline.** At N=10, **silent false-convergence is 0% on both models** — every
converged run actually ran the review. The original Sonnet **3/5 (40%)** — itself a confound-corrected
1/5→3/5 (§ Arm B) — was **small-N variance**, not a robust turn-by-turn behavior. So this benchmark
does **not** establish a meaningful reliability gap between codified and turn-by-turn coordination on
this task: turn-by-turn is about as reliable — it just **pays ~95–98k coordination tokens/run** to get
there (codified: ~0). **Treat the "~40% silent false-convergence" figures elsewhere in this doc as
superseded by this firm-up.**

**What robustly survives** as codified/slang's model-independent edge — none of which depends on
out-drifting a live coordinator: **~0 vs ~95k coordination tokens/run**, enforced output contracts +
tool-scoping + static analysis + provable termination, and auto-generated topology/trace diagrams.

**Honest caveats.** The strongest data is the **N=10-per-model firm-up** (§ Firmed-up reliability),
which shows the arm-B "silent false-convergence" is **0% on both models** — the original N=5 3/5 was
**variance, not a real gap**. The two-feature Sonnet N=5 numbers below predate that and are directional
at best; **the "~40% silent false-convergence" headline is superseded** — treat the durable findings as
*coordination cost* (~0 vs ~95k tokens/run) and *enforced guarantees + diagrams*, not a reliability gap.
Two harness bugs were found and corrected mid-way
(both *inflated an arm's failure*, and both are documented above): arm B's first batch had a
gitignored leftover design (1/5 → 3/5), and arm C/f2's first batch had a `Workflow` args bug
(bogus 0/5 → 5/5). Arm C's scripts were authored carefully (the reviewer guard is load-bearing);
a sloppier script could regress. **The gap does NOT widen with complexity** — the 5-agent test
refutes that (arm B went 3/5 → 5/5); the gap is **task-dependent** (it appears on confusable
handoffs, not on scale). **Positioning takeaway (corrected):** turn-by-turn LLM coordination is
reliable *when the task is well-decomposed* and fails on *confusable* tasks with nothing to
catch it — so pitch slang not as "more reliable at scale" but on the **enforced guarantees +
auto-generated diagrams** that native workflows/turn-by-turn lack, and on the broader principle
it embodies: **a grounded verification step in the loop is what protects against hallucination /
lazy termination** (the same reason to add a verifier to any autonomous agent loop).
Harnesses: `convergence-rate.sh` (A), `driver.ts`+`driver-rate.sh` (B), `armc-workflow.js` +
`armc-complex.js` (C), `implement-feature-complex.slang` (complexity). Per-run CSVs are written
to `$BENCH_OUT` (default `/tmp/slang-bench/diag`), regenerated on each run.

> **Reproducibility.** The *original* runs above were done on a worktree of a large internal
> repo (base `5429efcab`). The published harness is
> **self-contained**: `harness/setup_target.sh` builds a minimal TS + vitest scaffold
> (`benchmark/target/`) as the codebase the agents implement into, so anyone can re-run A/B/C
> without that repo — see [`../README.md` § Reproduce](../README.md). Numbers are directional and
> model-/codebase-dependent. At N=10/model the reliability *shape* is: **codified and turn-by-turn are
> comparably reliable** on this task (turn-by-turn false-convergence 0%) — the durable difference is
> **coordination cost** (~0 vs ~95k tokens/run) plus slang's **enforced guarantees + diagrams**, not a
> reliability gap. The earlier "gap" was small-N variance.
