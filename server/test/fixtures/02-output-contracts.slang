-- Structural output contracts: all three field types, with named and list arguments.
flow "output-contracts" (subject: "string") {
  title: "Output Contracts"
  description: "Exercises structural output contracts (string/number/boolean) plus named and list arguments."

  agent Reporter {
    role: "You return ONLY a JSON object that matches the output contract exactly."
    tools: [read]

    stake analyze(
      subject: subject,
      dimensions: ["clarity", "depth", "accuracy"],
      strict: true
    ) -> @out
      output: { score: "number", summary: "string", passed: "boolean" }

    commit
  }

  converge when: @Reporter.committed
  budget: rounds(5)
}
