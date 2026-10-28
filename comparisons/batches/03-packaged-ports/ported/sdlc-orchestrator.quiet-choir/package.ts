// Packaged rewrite of the pinned MIT upstream sdlc-orchestrator.js; see ../../LICENSE and
// ../../notes.json. The orchestrator and its three lifecycle stages are one package; bootstrap
// and release notes are the sibling packages' workflows, run as typed inline children.
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import lifecycleDocument from './workflows/lifecycle-document.js';
import lifecycleImplementation from './workflows/lifecycle-implementation.js';
import lifecycleVerification from './workflows/lifecycle-verification.js';
import sdlcOrchestrator from './workflows/sdlc-orchestrator.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'sdlc-orchestrator',
  version: '1',
  description:
    'Tailor a lifecycle, run each stage as a typed inline child under one run ID, and checkpoint every stage with a durable human review',
  whenToUse:
    'Driving a feature from requirements to a gated release with human checkpoints. Input: {goal, testCommand, allowedStages?, autoApprove?}; --workflow lifecycle-verification runs one gate alone.',
  workflows: [sdlcOrchestrator, lifecycleDocument, lifecycleImplementation, lifecycleVerification],
  entry: sdlcOrchestrator,
  prompts: [prompts],
});
