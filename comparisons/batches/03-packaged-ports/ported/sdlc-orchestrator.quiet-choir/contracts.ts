// Data contracts: the inputs and outputs of the orchestrator and its stages, and the structured
// agent and human results.
import { z } from 'quiet-choir';

export const Path = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value
        .split('/')
        .every((part) => part !== '..' && part !== '.' && part !== '' && part !== '.git') &&
      !value.includes('\0'),
    'Use a repository-relative path without dot segments or .git',
  );
export const Argv = z.tuple([z.string().min(1)]).rest(z.string());

export const DocumentStage = z.enum(['requirements', 'spec', 'roadmap', 'backlog', 'feedback']);
export const Stage = z.enum([
  ...DocumentStage.options,
  'bootstrap',
  'implement',
  'qa',
  'release-gate',
  'release-notes',
]);
export type Stage = z.infer<typeof Stage>;
export const StageResult = z.object({
  summary: z.string(),
  artifact: z.string().nullable(),
  gate: z.enum(['pass', 'concerns', 'blocked']),
  details: z.array(z.string()),
});
export type StageResult = z.infer<typeof StageResult>;
/** What a document reviewer returns; the stage adds the artifact path. */
export const DocumentReview = StageResult.omit({ artifact: true });

const context = {
  goal: z.string().min(1).describe('Lifecycle goal'),
  artifacts: z.record(z.string(), z.string()),
  answer: z.string().describe('Human answer belonging only to this stage'),
};
export const DocumentInput = z.object({
  ...context,
  stage: DocumentStage.describe('Document to produce'),
  out: Path.describe('New artifact file'),
});
export const ImplementationInput = z.object({
  ...context,
  testCommand: Argv.describe('Verification argv command approved by the operator'),
});
export const VerificationInput = z.object({
  stage: z.enum(['qa', 'release-gate']).describe('Verification gate'),
  testCommand: Argv.describe('Operator-selected verification command'),
});

export const IntakeFor = (allowed: Stage[]) =>
  z.object({
    plan: z.array(z.enum(allowed)).min(1).max(allowed.length),
    rationale: z.string(),
  });
export const Review = z.object({
  decision: z.enum(['continue', 'redo', 'stop']),
  answer: z.string().default(''),
});

export const SdlcInput = z.object({
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
  autoApprove: z
    .boolean()
    .default(false)
    .describe(
      'Let the Gatekeeper decider pass a stage whose gate passed; anything else still asks a human',
    ),
  autoApproveConfidence: z.number().min(0.5).max(1).default(0.8),
});

export const StageRecord = z.object({
  stage: Stage,
  round: z.number().int().min(0).max(3),
  result: StageResult,
  review: z.enum(['human', 'auto']),
});
export type StageRecord = z.infer<typeof StageRecord>;

export const SdlcOutput = z.object({
  runId: z.string(),
  status: z.enum(['plan', 'complete', 'stopped', 'needs-review']),
  plan: z.array(Stage),
  artifacts: z.record(z.string(), z.string()),
  stages: z.array(StageRecord),
  skipped: z.array(Stage),
});
