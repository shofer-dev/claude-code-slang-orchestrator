export const meta = {
  name: 'armC-complex',
  description: 'Arm C (complexity): native 5-agent pipeline (Architect->Developer->Tester->Reviewer->Documenter) implementing a multi-file LRUCache (code + spec + docs) in the shofer worktree. Feature hardcoded.',
  phases: [{ title: 'Design' }, { title: 'Implement' }, { title: 'Test' }, { title: 'Review' }, { title: 'Document' }],
}
const WT = '/tmp/slang/shofer'
const DP = `${WT}/plans/feature-design.md`
const S = (props) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false })

phase('Design')
await agent(`You are a software ARCHITECT. Work ONLY in ${WT}. Write a design doc to ${DP} for this feature: implement an LRUCache<K,V> class in src/utils/LRUCache.ts (methods get/set/has/delete/clear + a size getter; capacity-based least-recently-used eviction on set), a vitest spec at src/utils/LRUCache.spec.ts, and a short usage/API doc at src/utils/LRUCache.md. Write ONLY the .md design — do NOT write code. Cover the API, the 3-file layout, and edge cases. Return a one-paragraph summary.`, { schema: S({ summary: { type: 'string' } }), label: 'architect', phase: 'Design' })

phase('Implement')
await agent(`You are a DEVELOPER. Work in ${WT}. Implement the code per the design at ${DP}: create the ACTUAL implementation file ${WT}/src/utils/LRUCache.ts (the class only — NOT the test, NOT the docs). Verify it type-checks. Report the file path.`, { schema: S({ files: { type: 'string' }, done: { type: 'boolean' } }), label: 'developer', phase: 'Implement' })

phase('Test')
await agent(`You are a TEST AUTHOR. Work in ${WT}. Read src/utils/LRUCache.ts and the design at ${DP}. Write a comprehensive vitest spec at ${WT}/src/utils/LRUCache.spec.ts covering the API + edge cases. Run the tests (from ${WT}/src) and ensure they pass. Report the spec path + pass count.`, { schema: S({ spec_file: { type: 'string' }, passing: { type: 'boolean' } }), label: 'tester', phase: 'Test' })

phase('Review')
await agent(`You are a code REVIEWER. Work in ${WT}. Review the ACTUAL files on disk (src/utils/LRUCache.ts + its spec) against the design at ${DP} — verify they exist, are correct, and the tests pass (run them). Report a verdict + issues.`, { schema: S({ approved: { type: 'boolean' }, issues: { type: 'string' } }), label: 'reviewer', phase: 'Review' })

phase('Document')
await agent(`You are a TECHNICAL WRITER. Work in ${WT}. Write a concise usage/API doc at ${WT}/src/utils/LRUCache.md, based on the design at ${DP} and the actual implementation on disk. Report the doc path.`, { schema: S({ doc_file: { type: 'string' } }), label: 'documenter', phase: 'Document' })

return { arm: 'C', complex: true }
