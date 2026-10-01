import { z } from 'zod';
import { digest, jsonValue } from './json.js';
import { schemaJson } from './schema.js';
import { questionRequest } from './question-schema.js';
import type { QuestionRequest } from './question-model.js';
import type { JsonValue } from './model.js';
import type { WaitRecord, WaitRequest, WaitSources } from './wait-model.js';
import { MAX_EPOCH_MS } from './clock.js';

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
});

/** Normalize dependencies before recording or comparing a wait identity. @internal */
export function waitRequest(sources: WaitSources): {
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
  if (
    poll !== undefined &&
    ((poll as unknown) === null || typeof poll !== 'object' || typeof poll.observe !== 'function')
  )
    throw new Error('Poll source requires an observe callback.');
  // observeTimeoutMs is execution policy: it is validated here but deliberately kept out of the
  // request below, so it never enters wait identity and may change on resume.
  const observeTimeoutMs = poll?.observeTimeoutMs as unknown;
  if (
    observeTimeoutMs !== undefined &&
    !(Number.isSafeInteger(observeTimeoutMs) && (observeTimeoutMs as number) > 0)
  )
    throw new Error('Poll observeTimeoutMs must be a positive integer.');
  const every = poll?.every;
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
                observe: digest(Function.prototype.toString.call(poll.observe)),
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
