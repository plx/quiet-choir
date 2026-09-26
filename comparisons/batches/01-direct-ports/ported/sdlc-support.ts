import { z, type WorkflowContext, type JsonValue } from 'quiet-choir';
import requirements from './requirements-to-prd.workflow.js';
import roadmap from './roadmap-plan.workflow.js';
import backlog from './prd-decompose.workflow.js';
import bootstrap from './project-bootstrap.workflow.js';
import qa from './acceptance-qa-batch.workflow.js';
import gate from './release-gate.workflow.js';
import notes from './release-notes.workflow.js';
import feedback from './feedback-synthesis.workflow.js';
import { runChild } from './children.js';

export const stateSchema = z.object({
  goal: z.string(),
  flags: z.object({
    greenfield: z.boolean().optional(),
    hasUI: z.boolean().optional(),
    hasFeedbackSource: z.boolean().optional(),
  }),
  inputs: z.record(z.string(), z.string()),
  answers: z.record(z.string(), z.string()),
  paths: z.record(z.string(), z.string()),
  plan: z.array(z.string()),
  cursor: z.number().int().nonnegative(),
  artifacts: z.record(
    z.string(),
    z.object({ path: z.string().optional(), summary: z.string().optional() }).passthrough(),
  ),
  log: z.array(z.string()),
  gateWentGo: z.boolean().optional(),
});

export async function runNamedChild(
  ctx: WorkflowContext,
  id: string,
  name: string,
  input: unknown,
): Promise<Record<string, JsonValue>> {
  const registry = {
    'requirements-to-prd': requirements,
    'roadmap-plan': roadmap,
    'prd-decompose': backlog,
    'project-bootstrap': bootstrap,
    'acceptance-qa-batch': qa,
    'release-gate': gate,
    'release-notes': notes,
    'feedback-synthesis': feedback,
  };
  const child = registry[name];
  if (!child) throw new Error(`Unknown SDLC leaf workflow: ${name}`);
  return (await runChild(ctx, id, child, input)) as Record<string, JsonValue>;
}
