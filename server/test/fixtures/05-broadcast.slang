-- Broadcast: one sender → @all; receivers await (one named source, one wildcard).
flow "broadcast" (announcement: "string") {
  title: "Broadcast to All"
  description: "Sender broadcasts to every agent via -> @all; receivers await from a named source and from @any. Exercises @all routing, await wildcard, and all_committed convergence."

  agent Sender {
    role: "Broadcast a message."

    stake announce(
      message: announcement
    ) -> @all

    commit
  }

  agent ListenerA {
    role: "Receive the broadcast from the sender."
    await msg <- @Sender
    commit
  }

  agent ListenerB {
    role: "Receive the broadcast from any source."
    await msg <- @any
    commit
  }

  converge when: all_committed
  budget: rounds(10)
}
