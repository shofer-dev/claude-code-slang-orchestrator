-- Minimal liveness: one agent, one stake, one commit.
flow "hello-world" {
  title: "Hello World"
  description: "The smallest viable workflow — one agent performs one task and commits."

  agent Greeter {
    role: "You produce a short, friendly greeting and return ONLY JSON."

    stake greet(
      task: "Produce a friendly greeting."
    ) -> @out
      output: { greeting: "string" }

    commit
  }

  converge when: @Greeter.committed
  budget: rounds(5)
}
