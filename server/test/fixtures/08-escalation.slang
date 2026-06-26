-- Human-in-the-loop: escalate @Human with choices, await the answer, branch on it.
flow "escalation" {
  title: "Human Sign-off (escalate)"
  description: "An agent escalates to the human for sign-off (with clickable choices), awaits the answer, and commits differently depending on it. Exercises escalate @Human, choices, await @Human, and `contains`."

  agent Coordinator {
    role: "You coordinate work and ask the human to sign off."

    escalate @Human
      reason: "Work is complete. Approve to finish, or Reject to send it back."
      choices: ["ACK", "Reject"]

    await decision <- @Human

    when decision contains "ACK" {
      commit "approved"
    } otherwise {
      commit "rejected"
    }
  }

  converge when: @Coordinator.committed
  budget: rounds(5)
}
