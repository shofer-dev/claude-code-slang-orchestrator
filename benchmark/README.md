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

- **`setup_worktree.sh [wt] [ref]`** — faithful build-env shofer worktree at master HEAD
  (same approach as the live-memory benchmark: `pnpm install --offline` + built
  `@shofer/*` + `vscode-shim` link + base `tsc` clean).
- **`smoke.ts`** — headless driver: `parseSlang` → `runWorkflow` with the **real**
  `AgentSdkDispatcher`, auto-answering `@Human` escalations (picks the approve option).
  This drives the path the unit tests *mock* (40 unit tests pass but `fakeQuery` the SDK).

## Status

- [x] **Real-run path validated** — `pipeline.slang` smoke: Producer→`{n:21}`→Worker→
      `{doubled:42}`, converged in 8.9s, contracts honored. The executor genuinely drives
      real agents end-to-end (not just the mocked unit path).
- [ ] **`implement-feature` smoke** on a master worktree (validates modes
      `architect`/`code`/`reviewer` + escalation auto-answer + agents doing real coding).
- [ ] Two-arm harness over N features × M runs, capturing the metrics above.
