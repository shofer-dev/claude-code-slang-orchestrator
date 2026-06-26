import { test } from "node:test"
import assert from "node:assert/strict"
import { parseSlang } from "../src/slang/slang-parser.js"
import { runWorkflow } from "../src/executor.js"
import { FakeDispatcher } from "../src/dispatcher.js"
import type { FlowDecl } from "../src/slang/slang-ast.js"

function flowFrom(src: string): FlowDecl {
	const { ast, errors } = parseSlang(src)
	assert.deepEqual(errors, [], `parse errors: ${errors.join(", ")}`)
	assert.ok(ast.flows[0], "no flow parsed")
	return ast.flows[0]!
}

test("single agent: structural contract rejects bad output, retries, then commits", async () => {
	const flow = flowFrom(`flow "t" {
  agent A {
    role: "r"
    stake go(task: "x")
      output: { n: "number" }
    commit
  }
  converge when: @A.committed
}`)
	let calls = 0
	const fake = new FakeDispatcher(() => {
		calls++
		return calls === 1 ? "not json" : JSON.stringify({ n: 5 })
	})
	const { result } = await runWorkflow(flow, {}, fake, { cwd: "/tmp" })
	assert.equal(result.status, "converged")
	assert.equal(calls, 2)
	assert.deepEqual(result.agents[0]!.output, { n: 5 })
})

test("where clause: semantically invalid result is rejected, then accepted", async () => {
	const flow = flowFrom(`flow "t" {
  agent A {
    role: "r"
    stake go(task: "x")
      output: { n: "number" } where n >= 50
    commit
  }
  converge when: @A.committed
}`)
	let calls = 0
	const fake = new FakeDispatcher(() => {
		calls++
		return JSON.stringify({ n: calls === 1 ? 10 : 80 })
	})
	const { result } = await runWorkflow(flow, {}, fake, { cwd: "/tmp" })
	assert.equal(result.status, "converged")
	assert.equal(calls, 2)
	assert.equal((result.agents[0]!.output as { n: number }).n, 80)
})

test("contract exhausts retries → agent error → flow error", async () => {
	const flow = flowFrom(`flow "t" {
  agent A {
    role: "r"
    stake go(task: "x")
      output: { n: "number" } retries(1)
    commit
  }
  converge when: @A.committed
}`)
	const fake = new FakeDispatcher(() => "never valid json")
	const { result } = await runWorkflow(flow, {}, fake, { cwd: "/tmp" })
	assert.equal(result.status, "error")
	assert.equal(result.agents[0]!.status, "error")
})

test("multi-agent: stake routes from producer to consumer; both converge", async () => {
	const flow = flowFrom(`flow "p" {
  agent P {
    role: "r"
    stake mk(task: "x") -> @C
      output: { n: "number" }
    commit
  }
  agent C {
    role: "r"
    await d <- @P
    stake use(task: "x") -> @out
      output: { r: "number" }
    commit
  }
  converge when: @P.committed && @C.committed
}`)
	const fake = new FakeDispatcher((req) => (req.agentName === "P" ? JSON.stringify({ n: 1 }) : JSON.stringify({ r: 2 })))
	const { result, flowState } = await runWorkflow(flow, {}, fake, { cwd: "/tmp" })
	assert.equal(result.status, "converged")
	assert.ok(result.agents.every((a) => a.status === "committed"))
	assert.ok(flowState.mailboxHistory.some((m) => m.from === "P" && m.to === "C"))
})

test("escalate: human answer is delivered and drives the branch", async () => {
	const flow = flowFrom(`flow "s" {
  agent C {
    role: "r"
    escalate @Human reason: "ok?"
    await u <- @Human
    when u contains "ACK" {
      commit "approved"
    } otherwise {
      commit "rejected"
    }
  }
  converge when: @C.committed
}`)
	let asked = 0
	const { result, flowState } = await runWorkflow(flow, {}, new FakeDispatcher(), {
		cwd: "/tmp",
		onEscalate: async () => {
			asked++
			return "ACK"
		},
	})
	assert.equal(asked, 1)
	assert.equal(result.status, "converged")
	assert.equal(result.agents[0]!.output, "approved")
	assert.ok(flowState.mailboxHistory.some((m) => m.from === "Human" && m.to === "C"))
})

test("escalate without a handler fails the flow loudly", async () => {
	const flow = flowFrom(`flow "s" {
  agent C {
    role: "r"
    escalate @Human reason: "x"
    await u <- @Human
    commit
  }
  converge when: @C.committed
}`)
	const { result } = await runWorkflow(flow, {}, new FakeDispatcher(), { cwd: "/tmp" })
	assert.equal(result.status, "escalated")
})

test("session resume: an agent's session id is threaded across its stakes", async () => {
	const flow = flowFrom(`flow "m" {
  agent A {
    role: "r"
    stake one(task: "x")
      output: { a: "number" }
    stake two(task: "y")
      output: { b: "number" }
    commit
  }
  converge when: @A.committed
}`)
	const resumes: boolean[] = []
	// FakeDispatcher echoes the sessionId it was given; capture whether each stake resumed.
	const fake = new FakeDispatcher((req) => {
		resumes.push(!!req.sessionId)
		return JSON.stringify({ a: 1, b: 2 })
	})
	const { result } = await runWorkflow(flow, {}, fake, { cwd: "/tmp" })
	assert.equal(result.status, "converged")
	assert.deepEqual(resumes, [false, true]) // first stake fresh, second resumes
})
