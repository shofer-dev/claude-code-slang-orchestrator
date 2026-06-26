-- slang-orchestrator EXTENSION: the `where` semantic assertion on an output contract.
-- The structural schema checks the *shape*; `where` checks the *meaning* (a valid 0–100
-- score). A structurally-valid result whose score is out of range is rejected and the
-- agent is re-prompted — exactly like a structural failure.
flow "where-clause" {
  title: "Semantic Output Contract (where)"
  description: "Demonstrates the slang-orchestrator `where` clause: a semantic assertion evaluated after the structural schema check."

  agent Rater {
    role: "You rate things on a 0–100 scale and return ONLY JSON."

    stake rate(
      task: "Rate the developer experience of TypeScript from 0 to 100, with a one-line reason."
    ) -> @out
      output: { score: "number", reason: "string" } where score >= 0 && score <= 100

    commit
  }

  converge when: @Rater.committed
  budget: rounds(5)
}
