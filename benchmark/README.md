# Slang Orchestrator — benchmark

Two-arm benchmark for `slang-orchestrator`. Mirrors the structure of the live-memory
benchmark (`../../live-memory/benchmark/`). Harness in [`harness/`](harness/), recorded
runs + findings in [`results/`](results/).

## The claim (and why it's NOT tokens)

Unlike live-memory (a token-cost play), slang-orchestrator's value is **deterministic,
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

`extensions/shofer/src/media/workflows/implement-feature.slang` — a 3-agent flow
(Architect → Developer ⇄ Reviewer) with a **review loop**, **output contracts** on every
routed stake, **mailbox routing**, and **two `@Human` escalations**. Run on a faithful
**master** worktree of shofer (`harness/setup_worktree.sh`), implementing real features.

## Metrics (all)

- **Protocol reliability** (primary): % of runs where the implementation was *genuinely
  reviewed before commit* — Reviewer actually invoked, the loop ran, rejections → fixes,
  final review happened. Slang: guaranteed by construction; LLM-arm: drifts.
- **Feature correctness**: `tsc` + tests green (the faithful-env acceptance).
- **Quality**: did review *catch* real issues (defect-catch rate).
- **Coordination cost** (secondary): top-level orchestrator tokens — slang ≈ **0** vs the
  LLM-arm's overhead.
- **Variance**: run-to-run consistency.

## Hypothesis: complexity-shaped

Expect, by analogy to live-memory's "task-shaped" result: on trivial flows the LLM
orchestrator does fine (no gap); the slang reliability advantage **grows with coordination
complexity** (more agents, loops, contracts, longer context where the LLM forgets the
protocol). `implement-feature` is deliberately at the complex end.

## Harness

Shared setup:
- **`setup_worktree.sh [wt] [ref]`** — faithful build-env shofer worktree at master HEAD
  (`pnpm install --offline` + built `@shofer/*` + `vscode-shim` link + base `tsc` clean).
- **`workflows/implement-feature.slang`** — benchmark-owned, hardened copy of the flow
  (Architect `write_paths:["**/*.md"]`+`deny:[Bash]` so it designs but cannot self-implement;
  `create_design` has an output contract + "write then stop" instruction).

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
  each step (`run_architect`/`run_developer`/`run_reviewer`/`finish`, via structured output)
  instead of the slang executor. Records coordination tokens + protocol fidelity.
- **`driver-rate.sh [N]`** — N driver runs → CSV of converged / steps / which roles ran /
  whether the FINAL work was reviewed / driver tokens / impl.

## Status

- [x] **Real-run path validated** (`pipeline.slang` smoke, contracts honored).
- [x] **Executor hardened** so `implement-feature` runs reliably — budget honored + per-stake
      timeout (always terminates), `write_paths` (command-hook backed; works in the worktree),
      `deny:` tool control, `create_design` termination tune. 49 unit tests pass.
- [x] **Arm A rate: 5/5 converged** (`convergence-rate.sh`), 0 launch errors, impl every run.
- [x] **Arm B rate** (`driver-rate.sh`): fair LLM driver **3/5 real implementations**
      (5/5 self-report "converged" → **40% silent false-convergence**); ~98–135k coordination
      tokens/run (arm A: 0). *Correction:* an earlier batch scored 1/5 but was confounded by a
      gitignored leftover design (reset now `rm -rf plans`); 3/5 is the clean number. Two
      failure modes + mechanism in [`results/RESULTS.md`](results/RESULTS.md).
- [x] **Arm C** — Claude Code's **native dynamic-workflows** feature (`armc-workflow.js`):
      **5/5 real implementations**, ~0 per-run coordination LLM (codified JS script). Matches
      arm A on reliability → the finding is *codified vs. turn-by-turn*, and slang's edge over
      the native feature is **guarantees + diagrams**, not raw reliability. See RESULTS.
- [x] **Second feature** (`formatBytes`, all 3 arms × 5): pattern generalizes — A **5/5**,
      C **5/5**, B **3/5** (combined across 2 features: codified A/C = 10/10, turn-by-turn B = 6/10).
      Two harness bugs found + corrected mid-run (arm-B leftover-design confound; arm-C `Workflow`
      args-propagation) — see RESULTS.
- [ ] More models + more reps (still one model, directional).
