import { isolationIdentity } from './worktree-identity.js';
import { resolveIsolation } from './agent-isolation.js';
import { environmentEdits } from './agent-environment.js';
import { jsonValue } from './json.js';
import { stepIdentity, type StepIdentity } from './identity.js';
import type { BuiltinHarnessRequestInput as HarnessRequestInput, JsonValue } from './model.js';

/** Explicit request identity before any authorized execution overrides. @internal */
export function legacyAgentIdentity(request: HarnessRequestInput, schema: JsonValue): StepIdentity {
  const options = resolveIsolation(request.options);
  if (options.worktree !== undefined)
    Object.assign(options, {
      worktree: isolationIdentity(options.worktree === true ? 'worktree' : options.worktree),
    });
  if (options.env !== undefined) Object.assign(options, { env: environmentEdits(options.env) });
  if (request.harness === 'codex' && request.imageAttachments !== undefined)
    Object.assign(options, { images: request.imageAttachments.map((image) => image.sha256) });
  const capabilities = Object.fromEntries(
    Object.entries(options)
      .filter(
        ([key, value]) =>
          !(
            (key === 'tools' || key === 'allowedTools') &&
            Array.isArray(value) &&
            value.length === 0
          ) &&
          !(key === 'sandbox' && value === 'read-only') &&
          // 'native' is the default, so it fingerprints like unset (#130).
          !(key === 'instructions' && value === 'native'),
      )
      .filter(
        ([key]) =>
          ![
            'profile',
            'prompt',
            'model',
            'reasoningEffort',
            'cwd',
            'timeoutMs',
            'maxTurns',
            'maxBudgetUsd',
            'retry',
            'onError',
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
    kind: request.harness,
    onError: options.onError ?? 'throw',
    prompt: options.prompt,
    model: options.model ?? null,
    reasoningEffort: request.harness === 'codex' ? (request.options.reasoningEffort ?? null) : null,
    cwd: request.cwd,
    schema,
  });
}
