export const meta = {
  name: 'armC-formatBytes',
  description: 'Arm C (feature 2): native dynamic workflow implementing formatBytes in the shofer worktree (feature hardcoded — args did not propagate to agents).',
  phases: [{ title: 'Design' }, { title: 'Implement' }, { title: 'Review' }],
}
const WT = '/tmp/slang/shofer'
const FEATURE = 'add a pure helper formatBytes(bytes:number):string in src/utils that renders a byte size human-readably (0->0 B, 1536->1.5 KB, 1048576->1 MB), plus a vitest spec'
const IMPL = 'src/utils/formatBytes.ts'
const EX = '0->0 B, 1536->1.5 KB, 1048576->1 MB'
const DESIGN_SCHEMA = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }
const DEV_SCHEMA = { type: 'object', properties: { done: { type: 'boolean' }, summary: { type: 'string' } }, required: ['done', 'summary'], additionalProperties: false }
const REVIEW_SCHEMA = { type: 'object', properties: { approved: { type: 'boolean' }, issues: { type: 'string' } }, required: ['approved', 'issues'], additionalProperties: false }

phase('Design')
await agent(`You are a software ARCHITECT. Work ONLY in the repo at ${WT}. Write a design document to ${WT}/plans/feature-design.md for this feature: ${FEATURE}. Write ONLY the .md design — do NOT write code (the Developer implements it). Return a one-paragraph summary.`, { schema: DESIGN_SCHEMA, label: 'architect', phase: 'Design' })

phase('Implement')
let approved = false, issues = '', rounds = 0
while (!approved && rounds < 3) {
  rounds++
  const dev = await agent(`You are a DEVELOPER. Work in the repo at ${WT}. Implement the feature per the design at ${WT}/plans/feature-design.md — create the ACTUAL source files: ${WT}/${IMPL} and a vitest spec. Verify by running the tests (from ${WT}/src). ${rounds > 1 ? 'Address this reviewer feedback: ' + issues : ''} Return {done, summary}.`, { schema: DEV_SCHEMA, label: `developer-r${rounds}`, phase: 'Implement' })
  const review = await agent(`You are a code REVIEWER. Work in the repo at ${WT}. Review the ACTUAL files on disk: read ${WT}/${IMPL} and its spec, check they exist and match the design at ${WT}/plans/feature-design.md (${EX}). Return {approved, issues}. Do NOT approve if the source file does not exist.`, { schema: REVIEW_SCHEMA, label: `reviewer-r${rounds}`, phase: 'Review' })
  approved = !!review?.approved
  issues = review?.issues ?? ''
}
return { arm: 'C', feature: 'formatBytes', approved, rounds }
