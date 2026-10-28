// Packaged rewrite of the pinned MIT upstream project-bootstrap.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import projectBootstrap from './workflows/project-bootstrap.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'project-bootstrap',
  version: '1',
  description:
    'Detect the stack, approve one hashed setup plan, apply each concern in its own worktree, and prove the integration with code-run commands',
  whenToUse:
    "Standing up a new project's tooling and CI from a spec, or retrofitting it onto a repository that lacks it; nothing is written before a human approves the plan. Input: {spec, stack?, concerns?}.",
  workflows: [projectBootstrap],
  entry: projectBootstrap,
  prompts: [prompts],
});
