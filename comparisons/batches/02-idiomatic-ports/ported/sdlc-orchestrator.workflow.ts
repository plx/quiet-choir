// Idiomatic rewrite of the pinned MIT upstream; see ../LICENSE and ../notes.json.
import { defineWorkflow, z } from 'quiet-choir';
import bootstrap from './project-bootstrap.workflow.js';
import releaseNotes from './release-notes.workflow.js';
import { Argv, Path, json, profiles } from './support.js';
import {
  DocumentStage,
  Stage,
  StageResult,
  documentStage,
  implementationStage,
  verificationStage,
} from './lifecycle-stages.js';

export default defineWorkflow({
  name: 'sdlc-orchestrator',
  version: 'idiomatic-02',
  profiles,
  description:
    'Tailor a lifecycle, run typed children inline and checkpoint stage-specific human decisions.',
  children: [documentStage, implementationStage, verificationStage, bootstrap, releaseNotes],
  input: z.object({
    goal: z.string().min(1).describe('Feature or project to drive through the lifecycle'),
    testCommand: Argv.describe(
      'Operator-selected verification command for implementation, QA and release gates',
    ),
    allowedStages: z
      .array(Stage)
      .min(1)
      .max(10)
      .default([
        'requirements',
        'spec',
        'roadmap',
        'backlog',
        'bootstrap',
        'implement',
        'qa',
        'release-gate',
        'release-notes',
        'feedback',
      ]),
    artifacts: z.record(z.string(), z.string()).default({}),
    artifactsDir: Path.default('workflow-artifacts'),
    since: z.string().min(1).default('HEAD~1'),
    maxRedos: z.number().int().min(0).max(3).default(1),
    planOnly: z.boolean().default(false),
  }),
  output: z.object({
    runId: z.string(),
    status: z.enum(['plan', 'complete', 'stopped', 'needs-review']),
    plan: z.array(Stage),
    artifacts: z.record(z.string(), z.string()),
    stages: z.array(
      z.object({ stage: Stage, round: z.number().int().min(0).max(3), result: StageResult }),
    ),
    skipped: z.array(Stage),
  }),
  async run(ctx, input) {
    const intake = await ctx.claude.value('intake', {
      profile: 'reader',
      schema: z.object({
        plan: z.array(z.enum(input.allowedStages)).min(1).max(input.allowedStages.length),
        rationale: z.string(),
      }),
      prompt: `Tailor an ordered lifecycle for this goal, inspecting the repository and existing artifacts. Use each selected stage at most once; bootstrap only if necessary. A release gate must precede release notes.\n${json({ goal: input.goal, artifacts: input.artifacts, allowed: input.allowedStages })}`,
    });
    const plan = [...new Set(intake.plan)];
    const artifacts = { ...input.artifacts };
    const stages: {
      stage: z.infer<typeof Stage>;
      round: number;
      result: z.infer<typeof StageResult>;
    }[] = [];
    const skipped: z.infer<typeof Stage>[] = [];
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
        const common = { goal: input.goal, artifacts, answer };
        let result: z.infer<typeof StageResult>;
        const doc = DocumentStage.safeParse(stage);
        if (doc.success)
          result = await scoped.workflow('work', documentStage, {
            ...common,
            stage: doc.data,
            out: `${input.artifactsDir}/${stage}-${round}.md`,
          });
        else if (stage === 'implement')
          result = await scoped.workflow('work', implementationStage, {
            ...common,
            testCommand: input.testCommand,
          });
        else if (stage === 'qa' || stage === 'release-gate')
          result = await scoped.workflow('work', verificationStage, {
            stage,
            testCommand: input.testCommand,
          });
        else if (stage === 'bootstrap') {
          const applied = await scoped.workflow(
            'work',
            bootstrap,
            bootstrap.input.parse({ spec: json({ goal: input.goal, artifacts, answer }) }),
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
          );
          result = {
            summary: notes.status,
            artifact: notes.written.path,
            gate: notes.status === 'verified' ? 'pass' : 'concerns',
            details: notes.concerns,
          };
        } else throw new Error(`Unsupported lifecycle stage: ${stage}`);
        stages.push({ stage, round, result });
        if (stage === 'release-gate') releaseAllowed = result.gate === 'pass';
        const reply = await scoped.ask('review', {
          title: 'Stage review',
          audience: 'human',
          prompt: `Review ${stage}, round ${round + 1}. Continue, redo with an answer, or stop?`,
          schema: z.object({
            decision: z.enum(['continue', 'redo', 'stop']),
            answer: z.string().default(''),
          }),
          subject: { stage, round, result },
          details: Buffer.from(json(result)).subarray(0, 15_000).toString('utf8'),
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
    return output(
      plan.some(
        (stage) => stages.findLast((entry) => entry.stage === stage)?.result.gate !== 'pass',
      ) || skipped.length
        ? 'needs-review'
        : 'complete',
    );
  },
});
