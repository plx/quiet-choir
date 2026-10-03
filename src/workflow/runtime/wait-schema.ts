import { z } from 'zod';
import { digest, jsonValue } from './json.js';
import { schemaJson } from './schema.js';
import { questionRequest } from './question-schema.js';
import type { QuestionRequest } from './question-model.js';
import type { JsonValue } from './model.js';
import type { WaitRecord, WaitRequest, WaitSources } from './wait-model.js';
import { MAX_EPOCH_MS } from './clock.js';
import { execSummarySchema } from './exec-schema.js';
import type { PollCommandIdentity } from './poll-command.js';
import { pollIdentityKey } from './poll-identity.js';

const epoch = z.number().int().min(0).max(MAX_EPOCH_MS);
const duration = z.number().min(0).max(MAX_EPOCH_MS);
const spacing = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const everySchema = z
  .object({
    initialMs: spacing,
    maxMs: spacing,
    factor: z.number().min(1),
  })
  .refine(
    (value) => value.maxMs >= value.initialMs,
    'Poll maximum spacing must be at least initialMs.',
  );
const requestSchema = z
  .object({
    timeoutMs: duration.nullable(),
    deadline: epoch.nullable(),
    poll: z
      .object({
        input: z.json(),
        schema: z.json(),
        every: everySchema,
        observe: z.string().regex(/^[a-f0-9]{64}$/u),
        // Only a command poll has it, so an observer poll's request and identity are unchanged.
        command: z.object({ exec: execSummarySchema, output: z.json() }).exactOptional(),
      })
      .nullable(),
  })
  .refine(
    (value) => value.timeoutMs === null || value.deadline === null,
    'Choose timeoutMs or deadline, not both.',
  );

/** Persisted progress has bounded cardinality regardless of the number of checks. @internal */
export const waitRecordSchema: z.ZodType<WaitRecord> = z.object({
  request: requestSchema,
  openedAt: epoch,
  deadline: epoch.nullable(),
  nextCheckAt: epoch.nullable(),
  checks: epoch,
  note: z.json(),
  notifiedAt: epoch.nullable(),
  lastError: z
    .object({
      message: z.string().max(4096),
      consecutive: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      at: epoch,
    })
    .exactOptional(),
});

/**
 * Normalize dependencies before recording or comparing a wait identity. A command poll also needs
 * its prepared command identity (see `commandPollIdentity`), which takes an asynchronous cwd lookup.
 * @internal
 */
export function waitRequest(
  sources: WaitSources,
  command?: PollCommandIdentity,
): {
  request: WaitRequest;
  question: QuestionRequest | undefined;
} {
  if ((sources as unknown) === null || typeof sources !== 'object' || Array.isArray(sources))
    throw new Error('Wait sources must be an object.');
  if (
    sources.timeoutMs === undefined &&
    sources.deadline === undefined &&
    sources.signal === undefined &&
    sources.poll === undefined
  )
    throw new Error('Wait requires a timeout, deadline, signal, or poll source.');
  if (sources.timeoutMs !== undefined) duration.parse(sources.timeoutMs);
  if (sources.deadline !== undefined) epoch.parse(sources.deadline);
  const poll = sources.poll;
  if (poll !== undefined && ((poll as unknown) === null || typeof poll !== 'object'))
    throw new Error('Poll source must be an object.');
  // Read the callbacks as plain values: a JavaScript caller may pass either, both or neither.
  const callbacks = poll as
    { readonly observe?: unknown; readonly command?: unknown; readonly done?: unknown } | undefined;
  const commandForm = callbacks?.command !== undefined;
  if (commandForm && callbacks.observe !== undefined)
    throw new Error('Poll source takes an observe callback or a command, not both.');
  if (callbacks !== undefined && !commandForm && typeof callbacks.observe !== 'function')
    throw new Error('Poll source requires an observe callback or a command.');
  if (commandForm && command === undefined)
    throw new Error('Command poll identity must be prepared before its wait request.');
  // observeTimeoutMs is execution policy: it is validated here but deliberately kept out of the
  // request below, so it never enters wait identity and may change on resume.
  const observeTimeoutMs = poll?.observeTimeoutMs as unknown;
  if (
    observeTimeoutMs !== undefined &&
    !(Number.isSafeInteger(observeTimeoutMs) && (observeTimeoutMs as number) > 0)
  )
    throw new Error('Poll observeTimeoutMs must be a positive integer.');
  // onError is policy too: validated here, never part of the request, so it may change on resume.
  const onError = poll?.onError as unknown;
  if (onError !== undefined) {
    if (onError === null || typeof onError !== 'object' || Array.isArray(onError))
      throw new Error('Poll onError must be an object.');
    const { tolerate, classify, retryAfterMs } = onError as Record<string, unknown>;
    if (!(Number.isSafeInteger(tolerate) && (tolerate as number) > 0))
      throw new Error('Poll onError.tolerate must be a positive integer.');
    if (classify !== undefined && typeof classify !== 'function')
      throw new Error('Poll onError.classify must be a function.');
    if (retryAfterMs !== undefined && typeof retryAfterMs !== 'function')
      throw new Error('Poll onError.retryAfterMs must be a function.');
  }
  const every = poll?.every;
  // A built-in helper's internal identity (poll-identity.ts), read as a plain value.
  const helperValue =
    poll === undefined
      ? undefined
      : (poll as { readonly [pollIdentityKey]?: unknown })[pollIdentityKey];
  const helper =
    helperValue === undefined ? undefined : jsonValue(helperValue, 'Poll helper identity');
  const request = requestSchema.parse(
    jsonValue(
      {
        timeoutMs: sources.timeoutMs ?? null,
        deadline: sources.deadline ?? null,
        poll:
          poll === undefined
            ? null
            : {
                input: jsonValue(poll.input, 'Poll input'),
                schema: schemaJson(poll.schema),
                every:
                  typeof every === 'number'
                    ? { initialMs: every, maxMs: every, factor: 1 }
                    : {
                        initialMs: every?.initialMs,
                        maxMs: every?.maxMs,
                        factor: every?.factor ?? 2,
                      },
                // A command poll records done's source where an observer poll records observe's;
                // a built-in helper's versioned identity replaces either source text.
                observe:
                  helper === undefined
                    ? digest(
                        Function.prototype.toString.call(
                          commandForm ? callbacks.done : callbacks?.observe,
                        ),
                      )
                    : digest({ helper }),
                ...(commandForm && command !== undefined ? { command } : {}),
              },
      },
      'Wait sources',
    ),
  );
  return {
    request,
    question: sources.signal === undefined ? undefined : questionRequest(sources.signal),
  };
}

/** Last-note payloads are diagnostics, with a fixed size bound. @internal */
export function waitNote(note: unknown): JsonValue {
  const value = jsonValue(note ?? null, 'Poll note');
  if (Buffer.byteLength(JSON.stringify(value)) > 16_384)
    throw new Error('Poll note exceeds 16 KiB; retain a bounded summary.');
  return value;
}
