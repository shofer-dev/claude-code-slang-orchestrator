-- Complexity-test workflow: a 5-agent LINEAR pipeline with multiple deliverables.
-- Architect -> Developer -> Tester -> Reviewer -> Documenter -> @out.
-- More coordination steps + more artifacts than implement-feature.slang (3 agents), to test
-- whether turn-by-turn LLM coordination (arm B) degrades with coordination complexity while
-- codified arms (A slang, C native workflow) hold. Deliverables: the code, its spec, its docs.
flow "implement-feature-complex" {
  title: "Complex feature pipeline (5 agents)"
  description: "Design -> implement -> test -> review -> document, as a deterministic 5-stage pipeline producing a multi-file feature."

  agent Architect {
    mode: "architect"
    role: "Senior software architect. Design the feature and write ONLY the .md design document — you CANNOT write code (write_paths enforces .md-only). The design lives at EXACTLY ${design_path}. Specify the API, the module layout (which files: the implementation, its vitest spec, and a usage .md doc), and the edge cases."
    tools: [read, write, questions]
    write_paths: ["**/*.md"]
    deny: [Bash]

    stake create_design(
      feature: feature,
      instructions: "Write the feature design to EXACTLY ${design_path} (only .md — you cannot write code). Cover the API, the file layout, and edge cases. As soon as the design is written, return a one-paragraph summary and STOP."
    ) -> @Developer
      output: { summary: "string" }

    commit
  }

  agent Developer {
    mode: "code"
    role: "Implementation specialist. Implement the code per the design. Write the ACTUAL implementation source file(s). Do NOT write the test file (the Tester does) or the docs (the Documenter does)."
    tools: [read, write, execute]

    await design <- @Architect

    stake implement(
      task: "Implement the feature per the design at ${design_path}. Create the ACTUAL implementation file(s) under src/utils (the primary module only — not tests, not docs). Verify it type-checks. Report the file path(s) you created."
    ) -> @Tester
      output: { files: "string", done: "boolean" }

    commit
  }

  agent Tester {
    mode: "code"
    role: "Test author. Write a comprehensive vitest spec for the implemented code and make it pass."
    tools: [read, write, execute]

    await impl <- @Developer

    stake write_tests(
      task: "Read the implementation the Developer created and the design at ${design_path}. Write a comprehensive vitest spec (the ACTUAL test file next to the code) covering the API and edge cases. Run the tests and ensure they pass. Report the spec file path and the passing test count."
    ) -> @Reviewer
      output: { spec_file: "string", passing: "boolean" }

    commit
  }

  agent Reviewer {
    mode: "reviewer"
    role: "Code reviewer. Verify the implementation and tests exist on disk and match the design."
    tools: [read, execute]

    await work <- @Tester

    stake review(
      task: "Review the ACTUAL files on disk (implementation + spec) against the design at ${design_path}. Verify they exist, are correct, and the tests pass (run them). Report a verdict and any issues."
    ) -> @Documenter
      output: { approved: "boolean", issues: "string" }

    commit
  }

  agent Documenter {
    mode: "architect"
    role: "Technical writer. Write concise usage/API documentation (.md) for the shipped feature."
    tools: [read, write]
    write_paths: ["**/*.md"]

    await verdict <- @Reviewer

    stake document(
      task: "Write a concise usage/API document as a .md file next to the code (in src/utils), based on the design at ${design_path} and the actual implementation on disk. Report the doc file path."
    ) -> @out
      output: { doc_file: "string" }

    commit
  }

  converge when: @Architect.committed && @Developer.committed && @Tester.committed && @Reviewer.committed && @Documenter.committed
  budget: rounds(30)
}
