// sdlc-orchestrator: control flow only. Every stage is a typed inline child under this run ID,
// two of them from sibling packages, and every stage ends at a durable review: a human question,
// or the Gatekeeper decider when autoApprove is set and the stage's own gate passed.
import { defineWorkflow } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import bootstrap from '../../project-bootstrap.quiet-choir/workflows/project-bootstrap.js';
import releaseNotes from '../../release-notes.quiet-choir/workflows/release-notes.js';
import {
  DocumentStage,
  IntakeFor,
  Review,
  SdlcInput,
  SdlcOutput,
  type Stage,
  type StageRecord,
  type StageResult,
} from '../contracts.js';
import { jev, proceed } from '../lib/deciders.js';
import { delegation, finalStatus, preview } from '../lib/stages.js';
import { prompts } from '../prompts.js';
import { orchestratorRoster } from '../roster.js';
import lifecycleDocument from './lifecycle-document.js';
import lifecycleImplementation from './lifecycle-implementation.js';
import lifecycleVerification from './lifecycle-verification.js';

export default defineWorkflow({
  name: 'sdlc-orchestrator',
  version: 'packaged-03',
  description:
    'Tailor a lifecycle, run typed children inline and checkpoint stage-specific durable reviews.',
  roster: orchestratorRoster,
  decisions: [jev],
  prompts: [prompts],
  children: [
    lifecycleDocument,
    lifecycleImplementation,
    lifecycleVerification,
    bootstrap,
    releaseNotes,
  ],
  input: SdlcInput,
  output: SdlcOutput,
  async run(ctx, input) {
    const { goal } = input;
    const intake = await ctx.roster.Intake.value('intake', {
      schema: IntakeFor(input.allowedStages),
      prompt: prompts.Intake({ goal, artifacts: input.artifacts, allowed: input.allowedStages }),
    });
    const plan = [...new Set(intake.plan)];
    const artifacts = { ...input.artifacts };
    const stages: StageRecord[] = [];
    const skipped: Stage[] = [];
    const output = (status: 'plan' | 'complete' | 'stopped' | 'needs-review') => ({
      runId: ctx.runId,
      status,
      plan,
      artifacts,
      stages,
      skipped,
    });
    if (input.planOnly) return output('plan');
    let releaseAllowed = false;
    for (const stage of plan) {
      if (stage === 'release-notes' && !releaseAllowed) {
        skipped.push(stage);
        continue;
      }
      let answer = '';
      for (let round = 0; round <= input.maxRedos; round++) {
        const scoped = ctx.within(ctx.id(stage, round));
        const context = { goal, artifacts, answer };
        let result: StageResult;
        const doc = DocumentStage.safeParse(stage);
        if (doc.success)
          result = await scoped.workflow(
            'work',
            lifecycleDocument,
            { ...context, stage: doc.data, out: `${input.artifactsDir}/${stage}-${round}.md` },
            { profiles: delegation.document },
          );
        else if (stage === 'implement')
          result = await scoped.workflow(
            'work',
            lifecycleImplementation,
            { ...context, testCommand: input.testCommand },
            { profiles: delegation.implementation },
          );
        else if (stage === 'qa' || stage === 'release-gate')
          result = await scoped.workflow('work', lifecycleVerification, {
            stage,
            testCommand: input.testCommand,
          });
        else if (stage === 'bootstrap') {
          const applied = await scoped.workflow(
            'work',
            bootstrap,
            bootstrap.input.parse({ spec: std.exec.json(context) }),
            { profiles: delegation.bootstrap },
          );
          result = {
            summary: applied.status,
            artifact: null,
            gate: applied.status === 'applied' ? 'pass' : 'blocked',
            details: [applied.approvedDigest],
          };
        } else if (stage === 'release-notes') {
          const notes = await scoped.workflow(
            'work',
            releaseNotes,
            releaseNotes.input.parse({
              since: input.since,
              publication: 'commit',
              out: `${input.artifactsDir}/release-notes-${round}.md`,
            }),
            { profiles: delegation.releaseNotes },
          );
          result = {
            summary: notes.status,
            artifact: notes.written.path,
            gate: notes.status === 'verified' ? 'pass' : 'concerns',
            details: [
              notes.factChecked ? 'fact-check approved' : 'fact-check not approved',
              ...notes.missing.map((sha) => `missing summary: ${sha}`),
            ],
          };
        } else throw new Error(`Unsupported lifecycle stage: ${stage}`);
        if (stage === 'release-gate') releaseAllowed = result.gate === 'pass';
        // Decide, then act: only a passing gate is screened, and anything short of a confident
        // continue (a review answer, low confidence or a failed screen) goes to the human.
        const screen =
          input.autoApprove && result.gate === 'pass'
            ? await scoped.roster.Gatekeeper.decide('screen', {
                state: { goal, stage, round, result },
                questions: { proceed },
                onError: 'return',
              })
            : null;
        if (
          screen?.ok &&
          screen.value.proceed.choice === 'continue' &&
          screen.value.proceed.confidence >= input.autoApproveConfidence
        ) {
          stages.push({ stage, round, result, review: 'auto' });
          if (result.artifact) artifacts[stage] = result.artifact;
          break;
        }
        stages.push({ stage, round, result, review: 'human' });
        const reply = await scoped.ask('review', {
          title: 'Stage review',
          audience: 'human',
          prompt: `Review ${stage}, round ${round + 1}. Continue, redo with an answer, or stop?`,
          schema: Review,
          subject: { stage, round, result },
          details: preview(std.exec.json(result)),
        });
        if (reply.decision === 'stop') return output('stopped');
        if (reply.decision === 'continue') {
          if (result.artifact) artifacts[stage] = result.artifact;
          break;
        }
        answer = reply.answer;
        if (round === input.maxRedos) return output('needs-review');
      }
    }
    return output(finalStatus(plan, stages, skipped));
  },
});
