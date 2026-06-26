-- Multi-agent pipeline: Producer → Worker → @out, with the awaited value interpolated.
flow "pipeline" {
  title: "Two-Stage Pipeline"
  description: "Producer emits a number; Worker awaits it, doubles it (the value is interpolated into its prompt), and emits the result. Exercises stake routing, await, and ${...} interpolation."

  agent Producer {
    role: "You return ONLY JSON."

    stake produce(
      task: "Output the number 21."
    ) -> @Worker
      output: { n: "number" }

    commit
  }

  agent Worker {
    role: "You return ONLY JSON."

    await data <- @Producer

    stake consume(
      task: "Double this number and return the result: ${data.n}"
    ) -> @out
      output: { doubled: "number" }

    commit
  }

  converge when: @Producer.committed && @Worker.committed
  budget: rounds(10)
}
