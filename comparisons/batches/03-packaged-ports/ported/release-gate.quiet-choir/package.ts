// Packaged rewrite of the pinned MIT upstream release-gate.js; see ../../LICENSE and
// ../../notes.json. Control flow is in workflows/, prose in prompts/, agents in roster.ts.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import releaseGate from './workflows/release-gate.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'release-gate',
  version: '1',
  description:
    "Gate a release on six readiness dimensions with evidence: code runs the operator's tests and evidence commands, read-only assessors judge the pinned range, an independent Codex skeptic confirms each blocker, and the gatekeeper chooses only among the decisions a code-owned rule allows",
  whenToUse:
    "The go/no-go gate before shipping or promoting a release, decided from evidence rather than vibes. Run it on a checkout with no uncommitted or untracked files (ignored ones such as dependencies are fine) whose HEAD is the release; it gates since the previous tag by default, or since a given ancestor of HEAD. No agent edits the checkout, but the operator's commands run in it: one that moves HEAD or rewrites a tracked file refuses the gate, and an artifact that is not git-ignored refuses the next gate there; each pinned reader leaves a run-owned ref under refs/quiet-choir/ until workflow rm --refs. A go needs testCommands while tests is in blockOn: without them tests is cannot-check. Input: {since?, tagPattern?, policy?, blockOn?, testCommands?, evidenceCommands?, commandTimeoutMs?, maxRangeChars?}.",
  workflows: [releaseGate],
  entry: releaseGate,
  prompts: [prompts],
});
