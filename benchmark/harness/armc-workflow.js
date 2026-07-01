export const meta = {
  name: 'armC-implement-feature',
  description: 'Arm C: native dynamic workflow coordinating Architect->Developer<->Reviewer to implement a src/utils helper in the shofer worktree (benchmark vs slang arms A/B). Feature via args {feature, implFile, examples}.',
  phases: [{ title: 'Design' }, { title: 'Implement' }, { title: 'Review' }],
}

const WT = '/tmp/slang/shofer'
// Parameterized by args so the same script runs any feature; defaults = formatDuration (feature 1).
const FEATURE = (args && args.feature) || 'add a pure helper formatDuration(ms:number):string in src/utils that renders a duration human-readably (500->500ms, 1500->1.5s, 65000->1m 5s), plus a vitest spec'
const IMPL = (args && args.implFile) || 'src/utils/formatDuration.ts'
const EXAMPLES = (args && args.examples) || '500->500ms, 1500->1.5s, 65000->1m 5s'

const DESIGN_SCHEMA = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }
const DEV_SCHEMA = { type: 'object', properties: { done: { type: 'boolean' }, summary: { type: 'string' } }, required: ['done', 'summary'], additionalProperties: false }
const REVIEW_SCHEMA = { type: 'object', properties: { approved: { type: 'boolean' }, issues: { type: 'string' } }, required: ['approved', 'issues'], additionalProperties: false }

phase('Design')
const design = await agent(`You are a software ARCHITECT. Work ONLY in the repo at ${WT}. Write a design document to ${WT}/plans/feature-design.md for this feature: ${FEATURE}. Write ONLY the .md design — do NOT write code (the Developer implements it). Return a one-paragraph summary of the approach.`, { schema: DESIGN_SCHEMA, label: 'architect', phase: 'Design' })
log(`design: ${design?.summary?.slice(0, 80) ?? '(none)'}`)

phase('Implement')
let approved = false, issues = '', rounds = 0
while (!approved && rounds < 3) {
  rounds++
  const dev = await agent(`You are a DEVELOPER. Work in the repo at ${WT}. Implement the feature per the design at ${WT}/plans/feature-design.md — create the ACTUAL source files: ${WT}/${IMPL} and a vitest spec. Verify by running the tests (from ${WT}/src). ${rounds > 1 ? 'Address this reviewer feedback: ' + issues : ''} Return {done, summary}.`, { schema: DEV_SCHEMA, label: `developer-r${rounds}`, phase: 'Implement' })
  log(`dev r${rounds}: done=${dev?.done}`)
  const review = await agent(`You are a code REVIEWER. Work in the repo at ${WT}. Review the ACTUAL files on disk: read ${WT}/${IMPL} and its spec, and check they exist and match the design at ${WT}/plans/feature-design.md (${EXAMPLES}). Return {approved, issues}. Do NOT approve if the source file does not exist.`, { schema: REVIEW_SCHEMA, label: `reviewer-r${rounds}`, phase: 'Review' })
  approved = !!review?.approved
  issues = review?.issues ?? ''
  log(`review r${rounds}: approved=${approved}`)
}
return { arm: 'C', approved, rounds }
