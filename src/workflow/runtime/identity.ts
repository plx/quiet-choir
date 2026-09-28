import { isolationIdentity } from './worktree-identity.js';
import { resolveIsolation } from './agent-isolation.js';
import { environmentEdits } from './agent-environment.js';
import { createHash } from 'node:crypto';
import { digest, jsonValue } from './json.js';
import type { HarnessRequestInput, JsonValue } from './model.js';

/** Component hashes explain drift without persisting prompts or dependencies. */
export type StepIdentity = Readonly<Record<string, string>>;

/** Hash each semantic component independently. @internal */
export function stepIdentity(components: Record<string, JsonValue>): StepIdentity {
  return Object.fromEntries(Object.entries(components).map(([key, value]) => [key, digest(value)]));
}

/** Explicit request identity before any authorized execution overrides. @internal */
export function agentIdentity(request: HarnessRequestInput, schema: JsonValue): StepIdentity {
  const options = resolveIsolation(request.options);
  if (options.worktree !== undefined)
    Object.assign(options, {
      worktree: isolationIdentity(options.worktree === true ? 'worktree' : options.worktree),
    });
  if (options.env !== undefined) Object.assign(options, { env: environmentEdits(options.env) });
  if (request.provider === 'codex' && request.imageAttachments !== undefined)
    Object.assign(options, { images: request.imageAttachments.map((image) => image.sha256) });
  const capabilities = Object.fromEntries(
    Object.entries(options)
      .filter(
        ([key, value]) =>
          !(
            (key === 'tools' || key === 'allowedTools') &&
            Array.isArray(value) &&
            value.length === 0
          ) && !(key === 'sandbox' && value === 'read-only'),
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
    kind: request.provider,
    onError: options.onError ?? 'throw',
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

/** Bounded identity text for diagnostics. @internal */
export function displayId(id: string): string {
  return JSON.stringify(id.length > 80 ? `${id.slice(0, 80)}…` : id);
}

/** A collision diagnostic shared by live effects and map replay. @internal */
export function duplicateStepId(id: string, context = { scope: '', leaf: id }): Error {
  return new Error(
    `Duplicate step ID: ${displayId(id)} (scope ${displayId(context.scope)}, leaf ${displayId(context.leaf)}). Use explicit unique leaves or a named map key. Allowed pattern: ${pattern}.`,
  );
}

/** Validate a full ID with scope context and the exact offending character/position. @internal */
export function validateStepId(id: string, context = { scope: '', leaf: id }): void {
  if (typeof id === 'string' && valid.test(id) && context.leaf.length > 0) return;
  if (typeof id !== 'string')
    throw new Error('Invalid step ID: expected a string. Use ctx.id(...) for arbitrary text.');
  const display = displayId(id);
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
    `Invalid step ID ${display} (scope ${displayId(context.scope)}, leaf ${displayId(context.leaf)}): must match ${pattern} (${invalid === undefined ? 'missing first character' : `first invalid character ${JSON.stringify(invalid)}`} at index ${String(index)}). Allowed: letters, digits, . _ : / -; start with a letter or digit; at most 200 characters. Use ctx.id(...) for arbitrary text.`,
  );
}

/**
 * Build stable ID segments from arbitrary text/numbers. Clean segments up to 64 characters pass
 * through; other segments get a bounded slug and eight hex characters of SHA-256 over the raw text.
 * The joined ID must fit the existing 200-character limit. This helper does not add a scope prefix.
 */
export function stepId(...parts: readonly (string | number)[]): string {
  if (parts.length === 0) throw new Error('stepId requires at least one part.');
  const id = parts
    .map((part) => {
      if (typeof part !== 'string' && typeof part !== 'number')
        throw new Error('stepId parts must be strings or numbers.');
      const raw = String(part);
      if (/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/u.test(raw)) return raw;
      const slug =
        raw
          .replace(/[^a-zA-Z0-9._:-]+/gu, '-')
          .replace(/^[^a-zA-Z0-9]+/u, '')
          .slice(0, 55)
          .replace(/-+$/u, '') || 'id';
      return `${slug}-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
    })
    .join('/');
  validateStepId(id);
  return id;
}
