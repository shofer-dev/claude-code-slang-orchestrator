-- Conditional logic: let/set, when-otherwise with `contains`, and a guarded commit.
flow "branching" (text: "string") {
  title: "Branching & Conditions"
  description: "Exercises let/set, when-otherwise with `contains`, and `commit if`. Both branches lead to a commit, so the flow always converges."

  agent Classifier {
    role: "You classify text and return ONLY JSON."

    let urgent = false

    when text contains "URGENT" {
      set urgent = true
    } otherwise {
      set urgent = false
    }

    stake classify(
      text: text,
      urgent: urgent
    ) -> @out
      output: { label: "string", urgent: "boolean" }

    let ready = true
    commit "classified" if ready
  }

  converge when: @Classifier.committed
  budget: rounds(5)
}
