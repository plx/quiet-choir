import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { jsonValue } from './json.js';
import { schemaJson } from './schema.js';
import type { AskOptions, QuestionRequest } from './question-model.js';

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
    .array(z.object({ at: z.iso.datetime(), error: z.string().max(4096), file: z.string() }))
    .max(20),
});

/** Optional launch metadata, independent of runtime identity. @internal */
export const workflowLaunchSchema = z.object({
  entrypoint: z.string().refine(isAbsolute),
  tsconfig: z.string().refine(isAbsolute).nullable(),
  sources: z.record(z.string().refine(isAbsolute), z.string().regex(/^[a-f0-9]{64}$/u)).optional(),
  policy: z
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
    .strict()
    .optional(),
});

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
});

/** Routing guard only: attribution is self-asserted, never authentication. @internal */
export function validateAnswerAuthor(audience: QuestionRequest['audience'], by: string): void {
  if (audience === 'human' && !/^human:\S.*$/u.test(by))
    throw new Error(
      'A human question requires attribution --by human:<name>; ask the human first.',
    );
}
