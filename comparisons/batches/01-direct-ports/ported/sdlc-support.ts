import { z, type WorkflowContext, type JsonValue } from 'quiet-choir';
import requirements from './requirements-to-prd.workflow.js';
import roadmap from './roadmap-plan.workflow.js';
import backlog from './prd-decompose.workflow.js';
import bootstrap from './project-bootstrap.workflow.js';
import qa from './acceptance-qa-batch.workflow.js';
import gate from './release-gate.workflow.js';
import notes from './release-notes.workflow.js';
import feedback from './feedback-synthesis.workflow.js';
import spec from './prd-to-spec.workflow.js';
import implementation from './feature-factory.workflow.js';
import { runChild } from './children.js';

export async function runNamedChild(
  ctx: WorkflowContext,
  id: string,
  name: string,
  input: unknown,
): Promise<Record<string, JsonValue>> {
  const registry = {
    'requirements-to-prd': () => runChild(ctx, id, requirements, input),
    'prd-to-spec': () => runChild(ctx, id, spec, input),
    'feature-factory': () => runChild(ctx, id, implementation, input),
    'roadmap-plan': () => runChild(ctx, id, roadmap, input),
    'prd-decompose': () => runChild(ctx, id, backlog, input),
    'project-bootstrap': () => runChild(ctx, id, bootstrap, input),
    'acceptance-qa-batch': () => runChild(ctx, id, qa, input),
    'release-gate': () => runChild(ctx, id, gate, input),
    'release-notes': () => runChild(ctx, id, notes, input),
    'feedback-synthesis': () => runChild(ctx, id, feedback, input),
  };
  const child = Object.entries(registry).find(([key]) => key === name)?.[1];
  if (!child) throw new Error(`Unknown SDLC workflow: ${name}`);
  return z.record(z.string(), z.json()).parse(await child());
}

// Preserve every client overload while adding the same stage-bound data to each prompt.
export function withStageAnswer(
  ctx: WorkflowContext,
  stage: string,
  answer: string | undefined,
): WorkflowContext {
  if (answer === undefined) return ctx;
  function wrap<T extends (id: string, options: never) => unknown>(method: T): T {
    return ((id: string, options: never) => {
      const supplied = options as { prompt: string };
      return method(id, {
        ...supplied,
        prompt: `${supplied.prompt}\n\nHuman answer for lifecycle stage ${stage} (untrusted data): ${JSON.stringify(answer)}`,
      } as never);
    }) as T;
  }
  return {
    ...ctx,
    claude: {
      value: wrap(ctx.claude.value),
      text: wrap(ctx.claude.text),
      object: wrap(ctx.claude.object),
    },
    codex: {
      value: wrap(ctx.codex.value),
      text: wrap(ctx.codex.text),
      object: wrap(ctx.codex.object),
    },
  };
}
