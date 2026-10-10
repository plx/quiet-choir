import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { jsonValue } from './json.js';
import { schemaJson } from './schema.js';
import type {
  AskOptions,
  QuestionRequest,
  WorkflowLaunch,
  WorkflowLaunchOptions,
} from './question-model.js';

/** Persisted presentation is validated without loading workflow code. @internal */
export const questionRequestSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(1024)
    .refine((s) => s.trim().length > 0 && !/[\r\n]/u.test(s)),
  details: z
    .string()
    .refine((s) => Buffer.byteLength(s) <= 16_384)
    .nullable(),
  title: z.string().min(1).max(12).nullable(),
  choices: z
    .array(
      z.object({
        value: z.json(),
        label: z.string().min(1).max(100),
        description: z.string().max(1024).optional(),
      }),
    )
    .max(4),
  audience: z.enum(['human', 'agent', 'any']),
  subject: z.json(),
  schema: z.json(),
});

/** Question ledger schema, separate from agent request diagnostics. @internal */
export const questionRecordSchema = z.object({
  request: questionRequestSchema,
  askedAt: z.iso.datetime(),
  resolution: z
    .object({ via: z.literal('inbox'), by: z.string().min(1).max(200), at: z.iso.datetime() })
    .nullable(),
  rejections: z
    .array(
      z.object({
        at: z.iso.datetime(),
        error: z.string().max(4096),
        // Owner-side structured reasons (#289); absent for plain-text refusals and older records.
        issues: z
          .array(
            z.object({
              code: z.string().min(1).max(100),
              path: z.array(z.union([z.string().max(256), z.number()])).max(32),
              message: z.string().max(1024),
            }),
          )
          .max(20)
          .optional(),
        file: z.string(),
      }),
    )
    .max(20),
});

/** The CLI's non-secret launch policy as persisted on a run record. */
const launchPolicySchema = z
  .object({
    harness: z
      .object({
        kind: z.enum(['cli', 'fixture']),
        fixtures: z
          .array(
            z
              .object({
                name: z
                  .string()
                  .regex(/^[a-z][a-z0-9-]{0,31}$/u)
                  .optional(),
                path: z.string().refine(isAbsolute),
                sha256: z.string().regex(/^[a-f0-9]{64}$/u),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .refine(({ kind, fixtures = [] }) => {
        const names = fixtures.flatMap(({ name }) => (name === undefined ? [] : [name]));
        const global = fixtures.length - names.length;
        return new Set(names).size === names.length && global === (kind === 'fixture' ? 1 : 0);
      }, 'A launch policy has one unnamed fixture exactly for kind fixture, and unique names.'),
    waitMode: z.enum(['suspend', 'block']),
    worktrees: z
      .object({
        keep: z.enum(['all', 'failed', 'none']).optional(),
        root: z.string().refine(isAbsolute).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Optional launch metadata as persisted on a record, independent of runtime identity. @internal */
export const workflowLaunchSchema = z.object({
  entrypoint: z.string().refine(isAbsolute),
  tsconfig: z.string().refine(isAbsolute).nullable(),
  sources: z.record(z.string().refine(isAbsolute), z.string().regex(/^[a-f0-9]{64}$/u)).optional(),
  policy: launchPolicySchema.optional(),
});

/**
 * Launch metadata as an execution states it: like the record's, but a null policy clears the
 * recorded one. The record itself never stores null. @internal
 */
export const workflowLaunchOptionsSchema = workflowLaunchSchema.extend({
  policy: launchPolicySchema.nullable().optional(),
});

/**
 * The launch a record keeps after an execution states `incoming`: every field but the policy is
 * replaced, and the policy is replaced by a stated one, kept when absent and dropped when null.
 * @internal
 */
export function mergeLaunch(
  recorded: WorkflowLaunch | undefined,
  incoming: WorkflowLaunchOptions,
): WorkflowLaunch {
  const { policy, ...rest } = structuredClone(incoming);
  const kept = policy === undefined ? structuredClone(recorded?.policy) : (policy ?? undefined);
  return { ...rest, ...(kept === undefined ? {} : { policy: kept }) };
}

/** Validate and snapshot every question identity component. @internal */
export function questionRequest<T>(options: AskOptions<T>): QuestionRequest {
  const request = questionRequestSchema.parse(
    jsonValue({
      prompt: options.prompt,
      details: options.details ?? null,
      title: options.title ?? null,
      choices: options.choices ?? [],
      audience: options.audience ?? 'any',
      subject: options.subject ?? null,
      schema: schemaJson(options.schema),
    }),
  );
  for (const choice of request.choices) options.schema.parse(choice.value);
  return request;
}

/** Fixed approval answer contract. @internal */
export const approvalSchema = z.object({ approved: z.boolean(), comment: z.string().optional() });

/** Inbox deliveries are untrusted, including their attribution and timestamp. @internal */
export const answerEnvelopeSchema = z.object({
  value: z.json(),
  by: z.string().trim().min(1).max(200),
  at: z.iso.datetime(),
  questionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  /**
   * The generation of the run the writer addressed (its random `generation`, or its `createdAt` for
   * a run created before schema revision 17), so the owner of a later run that reuses the ID
   * rejects the delivery even when that run has the same `createdAt` (ADR 0049, #371). Optional:
   * deliveries from older writers carry none.
   */
  runGeneration: z.union([z.uuid(), z.iso.datetime()]).optional(),
  /**
   * The `createdAt` of the run the writer addressed. Still written beside `runGeneration` for
   * owners from older builds, which strip unknown envelope keys and bind on this field alone.
   * Optional: deliveries from older writers before ADR 0049 carry none.
   */
  runCreatedAt: z.iso.datetime().optional(),
});

/**
 * Whether an envelope is addressed to `run`: `'match'` when every binding field it carries
 * (`runGeneration`, `runCreatedAt`) equals the run's own value (its effective generation and its
 * `createdAt`), `'mismatch'` when any carried field differs, and `'unbound'` when it carries
 * neither (an older writer). Takes unknown field values so raw, unvalidated JSON can be checked.
 * @internal
 */
export function envelopeBinding(
  envelope: { readonly runGeneration?: unknown; readonly runCreatedAt?: unknown },
  run: { readonly createdAt: string; readonly generation?: string | undefined },
): 'match' | 'mismatch' | 'unbound' {
  const fields: [unknown, string][] = [
    [envelope.runGeneration, run.generation ?? run.createdAt],
    [envelope.runCreatedAt, run.createdAt],
  ];
  const carried = fields.filter(([value]) => value !== undefined);
  if (!carried.length) return 'unbound';
  return carried.every(([value, expected]) => value === expected) ? 'match' : 'mismatch';
}

/** Routing guard only: attribution is self-asserted, never authentication. @internal */
export function validateAnswerAuthor(audience: QuestionRequest['audience'], by: string): void {
  if (audience !== 'human') return;
  if (!/^human:\S.*$/u.test(by))
    throw new Error(
      'A human question requires attribution --by human:<name>; ask the human first.',
    );
  if (/^human:<[^<>]*>$/u.test(by))
    throw new Error(
      "Replace the placeholder in --by human:<NAME> with the human's name; ask the human first.",
    );
}
