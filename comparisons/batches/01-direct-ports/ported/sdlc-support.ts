import { type WorkflowContext, type JsonValue } from 'quiet-choir';
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
    'requirements-to-prd': requirements,
    'prd-to-spec': spec,
    'feature-factory': implementation,
    'roadmap-plan': roadmap,
    'prd-decompose': backlog,
    'project-bootstrap': bootstrap,
    'acceptance-qa-batch': qa,
    'release-gate': gate,
    'release-notes': notes,
    'feedback-synthesis': feedback,
  };
  const child = registry[name];
  if (!child) throw new Error(`Unknown SDLC workflow: ${name}`);
  return (await runChild(ctx, id, child, input)) as Record<string, JsonValue>;
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
