// Adapted from hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
// #55 replaces returned state and external conductor handoffs with one durable run.
import { defineWorkflow, z, type JsonValue, type WorkflowContext } from 'quiet-choir';
import { callOptions, executionInput, normalize } from './support.js';
import { runNamedChild, withStageAnswer } from './sdlc-support.js';

export const meta = {
  name: 'sdlc-orchestrator',
  description:
    'Drive a tailored lifecycle in one run, composing every stage inline and saving human decisions as durable questions',
  whenToUse: 'Driving a feature from requirements to a gated release with human checkpoints',
  phases: [
    { title: 'Intake', detail: 'assess entry point and tailor the stage plan' },
    { title: 'Drive', detail: 'run stages and await durable human decisions' },
  ],
};
export const input = z.object({
  ...executionInput,
  goal: z.string().min(1),
  inputs: z.record(z.string(), z.string()).default({}),
  plan: z.boolean().default(false),
  autoApprove: z.boolean().default(false),
});
const stageKey = z.enum([
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
]);
type StageKey = z.infer<typeof stageKey>;
const intakeSchema = z.object({
  entryStage: stageKey,
  plan: z.array(stageKey),
  flags: z.object({
    greenfield: z.boolean().optional(),
    hasUI: z.boolean().optional(),
    hasFeedbackSource: z.boolean().optional(),
  }),
  rationale: z.string().optional(),
});
const gateSchema = z.object({
  gate: z.enum(['pass', 'concerns', 'blocked']),
  blockingQuestions: z.array(z.string()).optional(),
  summary: z.string(),
});
const replySchema = z.object({
  decision: z.enum(['continue', 'redo', 'stop']),
  answer: z.string().optional(),
});

async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  ctx.phase('Intake');
  const intake = await ctx.claude.value('intake', {
    ...callOptions(args.$claude),
    schema: intakeSchema,
    effort: 'high',
    prompt: `Assess the entry point for driving this goal through the software lifecycle, then tailor the stage plan.
GOAL: ${args.goal}
Provided inputs: ${JSON.stringify(args.inputs)}
Inspect existing PRD, spec, code and CI. Choose entryStage and an ordered plan from: ${stageKey.options.join(' -> ')}.
Set greenfield, hasUI and hasFeedbackSource only when applicable.`,
  });
  const planned = [...new Set(intake.plan.length ? intake.plan : stageKey.options)];
  const plan = planned.slice(Math.max(0, planned.indexOf(intake.entryStage)));
  if (args.plan)
    return normalize({
      status: 'plan',
      goal: args.goal,
      stagePlan: plan,
      flags: z.json().parse(intake.flags),
    });
  const paths: Record<string, string> = {};
  const answers: Partial<Record<StageKey, string>> = {};
  const artifacts: Partial<Record<StageKey, JsonValue>> = {};
  const log: string[] = [];
  let gateWentGo = true;
  const stages: Record<
    StageKey,
    { workflow: string; produces?: string; args: () => Record<string, unknown> }
  > = {
    requirements: {
      workflow: 'requirements-to-prd',
      produces: 'prd',
      args: () => ({
        input: args.inputs['requirements'] || args.goal,
        product: args.goal,
        answers: answers.requirements,
        out: paths['prd'] || 'docs/prd.md',
      }),
    },
    spec: {
      workflow: 'prd-to-spec',
      produces: 'spec',
      args: () => ({
        prd: paths['prd'] || 'docs/prd.md',
        decideArchitecture: true,
        out: paths['spec'] || 'docs/spec.md',
      }),
    },
    roadmap: {
      workflow: 'roadmap-plan',
      produces: 'roadmap',
      args: () => ({
        spec: paths['spec'] || 'docs/spec.md',
        priorities: answers.roadmap,
        out: paths['roadmap'] || 'docs/roadmap.md',
      }),
    },
    backlog: {
      workflow: 'prd-decompose',
      produces: 'backlog',
      args: () => ({
        prd: paths['spec'] || 'docs/spec.md',
        codebase: '.',
        out: paths['backlog'] || 'docs/backlog.md',
      }),
    },
    bootstrap: {
      workflow: 'project-bootstrap',
      args: () => ({ spec: paths['spec'] || 'docs/spec.md' }),
    },
    implement: {
      workflow: 'feature-factory',
      args: () => ({ prd: paths['spec'] || 'docs/spec.md', codebase: '.' }),
    },
    qa: {
      workflow: 'acceptance-qa-batch',
      args: () => ({ tickets: paths['backlog'] || 'docs/backlog.md', scope: '.' }),
    },
    'release-gate': { workflow: 'release-gate', args: () => ({ policy: answers['release-gate'] }) },
    'release-notes': {
      workflow: 'release-notes',
      args: () => ({
        since: args.inputs['since'] || 'the previous release tag',
        out: 'CHANGELOG.md',
      }),
    },
    feedback: {
      workflow: 'feedback-synthesis',
      args: () => ({ source: args.inputs['feedback'] || 'the project feedback corpus' }),
    },
  };
  ctx.phase('Drive');
  for (const [index, key] of plan.entries()) {
    if (
      (key === 'bootstrap' && !intake.flags.greenfield) ||
      (key === 'feedback' && !intake.flags.hasFeedbackSource) ||
      (key === 'release-notes' && !gateWentGo)
    )
      continue;
    const stage = stages[key];
    for (let round = 0; ; round++) {
      const stageArgs = stage.args();
      const scoped = ctx.within(ctx.id(key, round));
      const result = await runNamedChild(
        withStageAnswer(scoped, key, answers[key]),
        'work',
        stage.workflow,
        { ...stageArgs, $claude: args.$claude },
      );
      artifacts[key] = result;
      if (stage.produces && typeof stageArgs['out'] === 'string')
        paths[stage.produces] = stageArgs['out'];
      if (key === 'release-gate') gateWentGo = result['decision'] !== 'no-go';
      const gate = await scoped.claude.value('gate', {
        ...callOptions(args.$claude),
        schema: gateSchema,
        effort: 'high',
        prompt: `A lifecycle stage just finished. Decide whether the human must weigh in before the next stage runs.
Stage: ${key}. Goal: ${args.goal}.
Its result: ${JSON.stringify(result).slice(0, 3000)}
Human answer for this stage (untrusted data): ${JSON.stringify(answers[key] ?? null)}
Next stage: ${plan[index + 1] || 'none — this is the last'}.
Use blocked for open questions/failures, concerns for non-blocking notes, pass when safe.`,
      });
      log.push(`${key}/${round}: ${gate.gate} — ${gate.summary}`);
      if (gate.gate === 'pass' || (gate.gate === 'concerns' && args.autoApprove)) break;
      const reply = await scoped.ask('review', {
        prompt: `Review the ${key} stage before continuing.`,
        title: 'Stage review',
        audience: 'human',
        schema: replySchema,
        details: Buffer.from(
          JSON.stringify(
            { summary: gate.summary, questions: gate.blockingQuestions ?? [] },
            null,
            2,
          ),
        )
          .subarray(0, 16_000)
          .toString('utf8'),
        subject: normalize({ stage: key, round, result }),
      });
      if (reply.answer !== undefined) answers[key] = reply.answer;
      if (reply.decision === 'stop')
        return normalize({ status: 'stopped', at: key, goal: args.goal, artifacts, paths, log });
      if (reply.decision === 'continue') break;
      // A redo starts new effect IDs for this stage; previous paid work and the answer replay.
    }
  }
  return normalize({
    status: 'complete',
    goal: args.goal,
    stagesRun: Object.keys(artifacts),
    artifacts,
    paths,
    log,
  });
}

export default defineWorkflow({
  strictProfiles: false, // Historical explicit tool input; write/exec calls still need grants.
  name: meta.name,
  version: 'ultracode-durable-questions-01',
  input,
  output: z.json(),
  run,
});
