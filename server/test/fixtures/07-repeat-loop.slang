-- Loop: repeat-until driven by a boolean guard set inside the body.
-- Slang is a *coordination* language with no arithmetic, so loops are gated by
-- boolean conditions (flags toggled by `when`), not by incremented counters.
flow "repeat-loop" {
  title: "Repeat-Until Loop"
  description: "Runs a repeat-until loop whose body stakes once and then sets the exit flag. Exercises repeat-until, let/set, and a loop-carried stake."

  agent Looper {
    role: "You return ONLY JSON."

    let done = false
    let pinged = false

    repeat until done {
      stake tick(
        task: "Acknowledge this iteration."
      ) -> @out
        output: { ack: "boolean" }

      set pinged = true

      when pinged {
        set done = true
      }
    }

    commit
  }

  converge when: @Looper.committed
  budget: rounds(10)
}
