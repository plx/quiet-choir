import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { z, type HarnessDeclaration } from '../src/index.js';
import { agentDiagnosticsSchema } from '../src/workflow/runtime/agent-stream-schema.js';
import { execResultSchema } from '../src/workflow/runtime/exec-schema.js';
import { readFileResultSchema, writeFileResultSchema } from '../src/workflow/runtime/files.js';
import { agentIdentity } from '../src/workflow/runtime/identity.js';
import { digest } from '../src/workflow/runtime/json.js';
import { approvalSchema } from '../src/workflow/runtime/question-schema.js';
import { schemaJson } from '../src/workflow/runtime/schema.js';
import { usageIdentitySchema } from '../src/workflow/runtime/usage.js';
import {
  mergeResultSchema,
  worktreeChangeSchema,
  worktreeHandleSchema,
} from '../src/workflow/runtime/worktree-schema.js';

const require = createRequire(import.meta.url);
const installed = {
  zod: (require('zod/package.json') as { version: string }).version,
  tsx: (require('tsx/package.json') as { version: string }).version,
};

/**
 * One message for every golden, so the guidance is identical wherever a pin fails.
 * The pinned values are literal, never a snapshot that `vitest -u` could rewrite.
 */
function message(name: string): string {
  return [
    `Pinned step-identity encoding changed: ${name}.`,
    `This JSON enters step and agent identity. Changing it makes completed steps of existing suspended runs fail resume with "schema changed on a completed step".`,
    `Do not just update the golden: a change needs an explicit decision (see docs/decisions/0005-step-identity-and-policy.md, docs/decisions/0006-code-change-recovery.md and the durability reference, plugins/*/quiet-choir/skills/quiet-choir/references/durability.md).`,
    `Installed zod ${installed.zod}, tsx ${installed.tsx}. A zod or tsx upgrade is the usual cause.`,
  ].join('\n');
}

/** Compare against a literal value; the only assertion path in this file. */
function pinned(name: string, actual: unknown, expected: unknown): void {
  expect(actual, message(name)).toEqual(expected);
}

// Verbatim copy of the wrapper in runner.ts, until it is extracted.
function resultIdentity(output: z.ZodType, isolated: boolean) {
  const baseResultSchema = z.object({
    diagnostics: agentDiagnosticsSchema,
    output,
    sessionId: z.string().nullable(),
    usage: usageIdentitySchema,
  });
  return isolated ? baseResultSchema.extend({ worktree: worktreeChangeSchema }) : baseResultSchema;
}

describe('schemaJson corpus', () => {
  const corpus: [string, z.ZodType][] = [
    ['nullable', z.string().nullable()],
    ['optional field', z.object({ note: z.string().optional() })],
    ['nullable and optional field', z.object({ note: z.string().nullable().optional() })],
    ['default', z.object({ count: z.number().default(3), label: z.string().default('x') })],
    [
      'discriminated union',
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), value: z.string() }),
        z.object({ kind: z.literal('b'), value: z.number().nullable() }),
      ]),
    ],
    ['iso datetime', z.iso.datetime()],
    ['record of json', z.record(z.string(), z.json())],
    ['enum', z.enum(['low', 'high'])],
    ['refine drops the refinement', z.string().refine((value) => value.startsWith('a'))],
    ['bounded int', z.number().int().min(1).max(10)],
    ['strict object', z.strictObject({ id: z.string(), tags: z.array(z.string()) })],
  ];
  const expected = new Map<string, unknown>([
    ['nullable', { $schema: 'http://json-schema.org/draft-07/schema#', type: ['string', 'null'] }],
    [
      'optional field',
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: false,
        properties: { note: { type: 'string' } },
        type: 'object',
      },
    ],
    [
      'nullable and optional field',
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: false,
        properties: { note: { type: ['string', 'null'] } },
        type: 'object',
      },
    ],
    [
      'default',
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: false,
        properties: {
          count: { default: 3, type: 'number' },
          label: { default: 'x', type: 'string' },
        },
        required: ['count', 'label'],
        type: 'object',
      },
    ],
    [
      'discriminated union',
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        oneOf: [
          {
            additionalProperties: false,
            properties: { kind: { const: 'a', type: 'string' }, value: { type: 'string' } },
            required: ['kind', 'value'],
            type: 'object',
          },
          {
            additionalProperties: false,
            properties: {
              kind: { const: 'b', type: 'string' },
              value: { type: ['number', 'null'] },
            },
            required: ['kind', 'value'],
            type: 'object',
          },
        ],
      },
    ],
    [
      'iso datetime',
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        format: 'date-time',
        pattern:
          '^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$',
        type: 'string',
      },
    ],
    [
      'record of json',
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: { $ref: '#/definitions/__schema0' },
        definitions: {
          __schema0: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'null' },
              { items: { $ref: '#/definitions/__schema0' }, type: 'array' },
              {
                additionalProperties: { $ref: '#/definitions/__schema0' },
                propertyNames: { type: 'string' },
                type: 'object',
              },
            ],
          },
        },
        propertyNames: { type: 'string' },
        type: 'object',
      },
    ],
    [
      'enum',
      { $schema: 'http://json-schema.org/draft-07/schema#', enum: ['low', 'high'], type: 'string' },
    ],
    [
      'refine drops the refinement',
      { $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' },
    ],
    [
      'bounded int',
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        maximum: 10,
        minimum: 1,
        type: 'integer',
      },
    ],
    [
      'strict object',
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: false,
        properties: { id: { type: 'string' }, tags: { items: { type: 'string' }, type: 'array' } },
        required: ['id', 'tags'],
        type: 'object',
      },
    ],
  ]);

  it.each(corpus)('pins %s', (name, schema) => {
    pinned(`corpus: ${name}`, schemaJson(schema), expected.get(name));
  });

  it('pins the diagnostics record as the corpus record', () => {
    pinned(
      'corpus: agentDiagnosticsSchema',
      schemaJson(agentDiagnosticsSchema),
      expected.get('record of json'),
    );
  });
});

describe('built-in schemas that runner.ts feeds to an effect', () => {
  const builtins: [string, z.ZodType, unknown][] = [
    [
      'execResultSchema',
      execResultSchema,
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: false,
        properties: {
          code: {
            anyOf: [
              { maximum: 9007199254740991, minimum: -9007199254740991, type: 'integer' },
              { type: 'null' },
            ],
          },
          durationMs: { minimum: 0, type: 'number' },
          signal: { type: ['string', 'null'] },
          stderr: { type: 'string' },
          stdout: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['code', 'signal', 'stdout', 'stderr', 'truncated', 'durationMs'],
        type: 'object',
      },
    ],
    [
      'readFileResultSchema',
      readFileResultSchema,
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: false,
        properties: {
          content: { type: 'string' },
          sha256: { pattern: '^[a-f0-9]{64}$', type: 'string' },
        },
        required: ['content', 'sha256'],
        type: 'object',
      },
    ],
    [
      'writeFileResultSchema',
      writeFileResultSchema,
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: false,
        properties: {
          bytes: { maximum: 9007199254740991, minimum: 0, type: 'integer' },
          path: { type: 'string' },
          previousSha256: {
            anyOf: [{ pattern: '^[a-f0-9]{64}$', type: 'string' }, { type: 'null' }],
          },
          sha256: { pattern: '^[a-f0-9]{64}$', type: 'string' },
        },
        required: ['path', 'sha256', 'bytes', 'previousSha256'],
        type: 'object',
      },
    ],
    [
      'mergeResultSchema',
      mergeResultSchema,
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: false,
        properties: {
          commit: { pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$', type: 'string' },
          conflicts: {
            items: {
              additionalProperties: false,
              properties: {
                commit: { pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$', type: 'string' },
                files: { items: { minLength: 1, type: 'string' }, type: 'array' },
              },
              required: ['commit', 'files'],
              type: 'object',
            },
            type: 'array',
          },
          merged: {
            items: { pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$', type: 'string' },
            type: 'array',
          },
        },
        required: ['commit', 'merged', 'conflicts'],
        type: 'object',
      },
    ],
    [
      'worktreeHandleSchema',
      worktreeHandleSchema,
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: false,
        properties: {
          base: { pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$', type: 'string' },
          id: { minLength: 1, type: 'string' },
          path: { minLength: 1, type: 'string' },
        },
        required: ['id', 'path', 'base'],
        type: 'object',
      },
    ],
    [
      'approvalSchema',
      approvalSchema,
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: false,
        properties: { approved: { type: 'boolean' }, comment: { type: 'string' } },
        required: ['approved'],
        type: 'object',
      },
    ],
  ];
  it.each(builtins)('pins %s', (name, schema, expected) => {
    pinned(name, schemaJson(schema), expected);
  });
});

describe('agent result identity wrapper', () => {
  it('pins the wrapper without a worktree', () => {
    pinned('agent result wrapper', schemaJson(resultIdentity(z.string(), false)), {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      definitions: {
        __schema0: {
          anyOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'null' },
            { items: { $ref: '#/definitions/__schema0' }, type: 'array' },
            {
              additionalProperties: { $ref: '#/definitions/__schema0' },
              propertyNames: { type: 'string' },
              type: 'object',
            },
          ],
        },
      },
      properties: {
        diagnostics: {
          additionalProperties: { $ref: '#/definitions/__schema0' },
          propertyNames: { type: 'string' },
          type: 'object',
        },
        output: { type: 'string' },
        sessionId: { type: ['string', 'null'] },
        usage: {
          additionalProperties: false,
          properties: {
            costUsd: { type: ['number', 'null'] },
            inputTokens: { type: ['number', 'null'] },
            outputTokens: { type: ['number', 'null'] },
          },
          required: ['inputTokens', 'outputTokens', 'costUsd'],
          type: 'object',
        },
      },
      required: ['diagnostics', 'output', 'sessionId', 'usage'],
      type: 'object',
    });
  });

  it('pins the wrapper with a worktree', () => {
    pinned('agent result wrapper with worktree', schemaJson(resultIdentity(z.string(), true)), {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      definitions: {
        __schema0: {
          anyOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'null' },
            { items: { $ref: '#/definitions/__schema0' }, type: 'array' },
            {
              additionalProperties: { $ref: '#/definitions/__schema0' },
              propertyNames: { type: 'string' },
              type: 'object',
            },
          ],
        },
      },
      properties: {
        diagnostics: {
          additionalProperties: { $ref: '#/definitions/__schema0' },
          propertyNames: { type: 'string' },
          type: 'object',
        },
        output: { type: 'string' },
        sessionId: { type: ['string', 'null'] },
        usage: {
          additionalProperties: false,
          properties: {
            costUsd: { type: ['number', 'null'] },
            inputTokens: { type: ['number', 'null'] },
            outputTokens: { type: ['number', 'null'] },
          },
          required: ['inputTokens', 'outputTokens', 'costUsd'],
          type: 'object',
        },
        worktree: {
          additionalProperties: false,
          properties: {
            base: { pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$', type: 'string' },
            commit: {
              anyOf: [
                { pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$', type: 'string' },
                { type: 'null' },
              ],
            },
            files: {
              items: {
                additionalProperties: false,
                properties: {
                  path: { minLength: 1, type: 'string' },
                  status: { enum: ['added', 'modified', 'deleted', 'renamed'], type: 'string' },
                },
                required: ['path', 'status'],
                type: 'object',
              },
              type: 'array',
            },
            ref: { anyOf: [{ minLength: 1, type: 'string' }, { type: 'null' }] },
          },
          required: ['base', 'commit', 'ref', 'files'],
          type: 'object',
        },
      },
      required: ['diagnostics', 'output', 'sessionId', 'usage', 'worktree'],
      type: 'object',
    });
  });

  it('pins the agent identity of a revision-1 built-in request through the wrapper', () => {
    const identity = agentIdentity(
      {
        harness: 'claude',
        revision: 1,
        cwd: '/repo',
        outputSchema: null,
        options: { prompt: 'golden', isolation: 'restricted', tools: [], allowedTools: [] },
      },
      schemaJson(resultIdentity(z.string(), false)),
    );
    pinned(
      'claude revision-1 agent identity',
      digest(identity),
      'ecf73d767c85d2fe084f0980b5fd07719a5eb0dffead4e5b58f68109f0167e87',
    );
  });

  it('pins the agent identity of a registered harness request through the wrapper', () => {
    const declaration: HarnessDeclaration = {
      name: 'echo',
      revision: 2,
      options: z.object({ prompt: z.string() }).loose(),
      capabilities: { structuredOutput: 'prompted' },
    };
    const identity = agentIdentity(
      {
        harness: 'echo',
        revision: 2,
        cwd: '/repo',
        outputSchema: null,
        options: { prompt: 'golden' },
      },
      schemaJson(resultIdentity(z.string(), true)),
      declaration,
    );
    pinned(
      'registered harness agent identity',
      digest(identity),
      '75d2ba829239b9c070e44dd0890c4a6b5d4cc04b4819f9d1048dec6f5de74a0c',
    );
  });
});
