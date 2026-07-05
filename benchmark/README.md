# Slang Workflows — benchmark

Two-arm benchmark for `slang-workflows`. Mirrors the structure of the live-memory
benchmark (`../../live-memory/benchmark/`). Harness in [`harness/`](harness/), recorded
runs + findings in [`results/`](results/).

## The claim (and why it's NOT tokens)

Unlike live-memory (a token-cost play), slang-workflows's value is **deterministic,
reliable multi-agent coordination**. Per `DESIGN.md`, LLM-driven orchestration "may **skip
steps, forget the review loop, or terminate early**." The slang executor is a **non-LLM
state machine** — zero coordination LLM calls — so the orchestration is *provable*. The
benchmark measures **whether that determinism actually buys reliability** on real work.

## The two arms (the Operator vs Driver dichotomy from DESIGN.md)

Hold the *work* constant, vary only the *coordinator* (the live-memory confound lesson):

| | A — **slang (Operator)** | B — **LLM-orchestrated** |
|---|---|---|
| coordination | deterministic `.slang` executor (0 LLM coordination calls) | a top-level Claude given the same protocol in prose; spawns + coordinates subagents itself |
| agents / work | Agent-SDK sessions (Architect/Developer/Reviewer) | the same agents, same task prompts |
| only difference | **who runs the coordination logic** | — |

## Task

`workflows/implement-feature.slang` — a 3-agent flow (Architect → Developer ⇄ Reviewer) with a
**review loop**, **output contracts** on every routed stake, **mailbox routing**, and **two
`@Human` escalations**. The agents implement small `src/utils` helpers (e.g. `formatDuration`,
`formatBytes`, an `LRUCache`) into a **self-contained TS + vitest scaffold** (`target/`, built by
`harness/setup_target.sh`) — so the benchmark runs anywhere. *(The originally-published runs used
a worktree of a large internal repo; see [`results/RESULTS.md` § Reproducibility](results/RESULTS.md).)*

## Reproduce it yourself

**Prereqs:** Node 22+, the `claude` CLI on your `PATH` (authenticated — a Claude subscription or
`ANTHROPIC_API_KEY`), and the server deps installed (`cd server && pnpm install`).

```bash
cd server && pnpm install && cd ..                 # once: the executor's Agent SDK deps
bash benchmark/harness/setup_target.sh             # build the self-contained target scaffold

# Arm A (slang operator) — 5 runs:
bash benchmark/harness/convergence-rate.sh 5
# Arm B (turn-by-turn LLM driver) — 5 runs:
bash benchmark/harness/driver-rate.sh 5
```

Override paths via env: `BENCH_WORKDIR` (target dir), `BENCH_OUT` (CSV output dir). A second
feature reuses the scripts via `PARAMS` / `IMPL_FILE` / `CSV_NAME`; the complex flow via
`WF=…/implement-feature-complex.slang` + a `CHECK_CMD`. **Arm C** uses Claude Code's native
dynamic-workflows feature — run `harness/armc-*.js` via the `Workflow` tool (they read
`BENCH_WORKDIR`). Per-run CSVs land in `$BENCH_OUT`.

## Metrics (all)

- **Protocol reliability**: % of runs where the implementation was *genuinely reviewed before
  commit* — Reviewer actually invoked, the loop ran, rejections → fixes, final review happened.
  Slang: guaranteed by construction; LLM-arm: *can* drift — but at N=10/model the drift rate was
  **0%** (see RESULTS § Firmed-up), so this is a guarantee difference, not an observed-rate gap.
- **Coordination cost** (the primary *durable* finding): top-level orchestrator tokens — slang ≈
  **0** vs the LLM-arm's ~95–98k/run.
- **Feature correctness**: `tsc` + tests green (the faithful-env acceptance).
- **Quality**: did review *catch* real issues (defect-catch rate).
- **Coordination cost** (secondary): top-level orchestrator tokens — slang ≈ **0** vs the
  LLM-arm's overhead.
- **Variance**: run-to-run consistency.

## Hypothesis: complexity-shaped — TESTED and REFUTED

The original hypothesis was that the slang reliability advantage **grows with coordination
complexity** (more agents/loops/context). We tested it with a 5-agent pipeline
(`implement-feature-complex.slang`) — and it does **not** hold: turn-by-turn LLM coordination
went from **3/5 on the simple 3-agent task → 5/5 on the harder 5-agent task** (it did *better*
with more decomposition). Reliability is **task-dependent** (a *confusable handoff* — an
architect that embeds code in the design — is what tripped turn-by-turn, not scale), not
monotonic in complexity. See [`results/RESULTS.md` § Complexity test](results/RESULTS.md). The
robust differentiator is slang's **enforced guarantees + diagrams**, and the general principle
the benchmark establishes: **a grounded verification step in the loop** protects against
hallucination / lazy-termination at any complexity.

## Harness

Shared setup:
- **`setup_target.sh [dir]`** — builds a **self-contained** TS + vitest scaffold (`../target/`)
  into `$BENCH_WORKDIR` (default `/tmp/slang-bench/target`) as the codebase the agents implement
  into, and `git init`s it so the harness can reset between runs. No private repo needed.
- **`workflows/implement-feature.slang`** — benchmark-owned, hardened copy of the flow
  (Architect `write_paths:["**/*.md"]`+`deny:[Bash]` so it designs but cannot self-implement;
  `create_design` has an output contract + "write then stop" instruction).
- **`workflows/implement-feature-complex.slang`** — the complexity-test flow: a 5-agent linear
  pipeline (Architect→Developer→Tester→Reviewer→Documenter) producing a multi-file feature.
- The rate scripts take env overrides: `WF` (workflow), `PARAMS`, `IMPL_FILE`, `CHECK_CMD`
  (a full-delivery predicate), `CSV_NAME` — so a second feature / the complex flow reuse them.

Arm A — **slang (Operator)**:
- **`smoke.ts`** — headless `parseSlang` → `runWorkflow` with the real `AgentSdkDispatcher`,
  auto-approving `@Human` escalations. Validated the real-agent path the unit tests mock.
- **`diagnose-real.ts`** — one full run, tracing each stake's agent + output (+ per-stake
  timeout via `STAKE_TIMEOUT_MS`); the per-run instrument.
- **`convergence-rate.sh [N]`** — N sequential runs from a fresh-reset worktree → CSV of
  terminal status / rounds / elapsed / launch-errors / impl-written.
- Deterministic coordination proofs: **`repro-handshake.ts`** (intended outputs converge in
  8 rounds), **`stress-handshake.ts`** (reject cycles converge; reviewer-never-approves
  terminates). These run with the `FakeDispatcher` — no model — so they pin the *executor*.

Arm B — **LLM-orchestrated (Driver)**:
- **`driver.ts`** — the **same** role-agents (parsed from the same workflow → identical
  tools/role/`write_paths`), same worktree, same feature, but an **LLM coordinator** decides
  each step via structured output instead of the slang executor. Its role-actions are **derived
  from the workflow's agents** (works for the 3- and 5-agent flows alike). Records coordination
  tokens + protocol fidelity.
- **`driver-rate.sh [N]`** — N driver runs → CSV of converged / steps / roles ran / driver tokens / impl.

Arm C — **native dynamic workflows**: **`armc-workflow.js`** (formatDuration, the reusable one),
**`armc-workflow-formatbytes.js`** and **`armc-complex.js`** (feature-hardcoded variants) — JS
orchestration scripts run via the `Workflow` tool, coordinating the same role-agents. *(Note:
`args` did not propagate to workflow agents, so per-feature variants hardcode the feature.)*

## Status

- [x] **Real-run path validated** (`pipeline.slang` smoke, contracts honored).
- [x] **Executor hardened** so `implement-feature` runs reliably — budget honored + per-stake
      timeout (always terminates), `write_paths` (command-hook backed; works in the worktree),
      `deny:` tool control, `create_design` termination tune. 49 unit tests pass.
- [x] **Arm A rate: 5/5 converged** (`convergence-rate.sh`), 0 launch errors, impl every run.
- [x] **Arm B rate** (`driver-rate.sh`): ~95–98k coordination tokens/run (arm A: 0). An early
      N=5 batch reported "40% silent false-convergence" (3/5), but the **N=10/model firm-up found
      0%** on both Sonnet and Fable — that gap was small-N variance, **now superseded**. See
      [`results/RESULTS.md`](results/RESULTS.md) § Firmed-up reliability.
- [x] **Arm C** — Claude Code's **native dynamic-workflows** feature (`armc-workflow.js`):
      **5/5 real implementations**, ~0 per-run coordination LLM (codified JS script). Matches
      arm A on reliability → the finding is *codified vs. turn-by-turn*, and slang's edge over
      the native feature is **guarantees + diagrams**, not raw reliability. See RESULTS.
- [x] **Second feature** (`formatBytes`, all 3 arms × 5): pattern generalizes — A **5/5**,
      C **5/5**, B **3/5** (combined across 2 features: codified A/C = 10/10, turn-by-turn B = 6/10).
      Two harness bugs found + corrected mid-run (arm-B leftover-design confound; arm-C `Workflow`
      args-propagation) — see RESULTS.
- [x] **Complexity test** (`implement-feature-complex.slang`, 5-agent pipeline, multi-file
      feature, all 3 arms × 5, full-delivery metric): **all three arms 5/5** — turn-by-turn went
      **3/5 → 5/5**, *refuting* the "gap widens with complexity" hypothesis. Reliability is
      task-dependent, not scale-monotonic. See RESULTS § Complexity test.
- [x] **Second model + more reps**: arm B ×10 on **Sonnet and Fable** — false-convergence **0/10
      both** (§ Firmed-up); arm A holds on Fable (2/2, ~4× faster). The reliability gap did not
      survive; coordination cost + enforced guarantees + diagrams are the durable findings.
