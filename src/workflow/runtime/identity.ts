import { digest, jsonValue } from './json.js';
import type { HarnessRequest, JsonValue } from './model.js';

/** Component hashes explain drift without persisting prompts or dependencies. */
export type StepIdentity = Readonly<Record<string, string>>;

/** Hash each semantic component independently. @internal */
export function stepIdentity(components: Record<string, JsonValue>): StepIdentity {
  return Object.fromEntries(Object.entries(components).map(([key, value]) => [key, digest(value)]));
}

/** Explicit request identity before any authorized execution overrides. @internal */
export function agentIdentity(request: HarnessRequest, schema: JsonValue): StepIdentity {
  const options = request.options;
  const capabilities = Object.fromEntries(
    Object.entries(options).filter(
      ([key]) =>
        ![
          'prompt',
          'model',
          'reasoningEffort',
          'cwd',
          'timeoutMs',
          'maxTurns',
          'maxBudgetUsd',
          'retry',
        ].includes(key),
    ),
  );
  const namedCapabilities = Object.fromEntries(
    Object.entries(capabilities).map(([key, value]) => [
      ['tools', 'allowedTools', 'sandbox', 'skipGitRepoCheck', 'structuredOutput'].includes(key)
        ? key
        : `option.${key}`,
      value,
    ]),
  );
  return stepIdentity({
    ...(jsonValue(namedCapabilities) as Record<string, JsonValue>),
    kind: request.provider,
    prompt: options.prompt,
    model: options.model ?? null,
    reasoningEffort:
      request.provider === 'codex' ? (request.options.reasoningEffort ?? null) : null,
    cwd: request.cwd,
    schema,
  });
}

const pattern = '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$';
const valid = new RegExp(pattern, 'u');

/** Validate a leaf ID with a bounded display and the exact offending character/position. @internal */
export function validateStepId(id: string): void {
  if (valid.test(id)) return;
  const display = JSON.stringify(id.length > 80 ? `${id.slice(0, 80)}…` : id);
  let index = 0;
  let invalid: string | undefined;
  for (const character of id) {
    if (index >= 200 || !(index === 0 ? /^[a-zA-Z0-9]$/u : /^[a-zA-Z0-9._:/-]$/u).test(character)) {
      invalid = character;
      break;
    }
    index += character.length;
  }
  throw new Error(
    `Invalid step ID ${display}: must match ${pattern} (${invalid === undefined ? 'missing first character' : `first invalid character ${JSON.stringify(invalid)}`} at index ${String(index)}).`,
  );
}
