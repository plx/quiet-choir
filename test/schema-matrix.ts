import { z } from 'zod';

// Every schema uses the locked Zod version; JSON fixtures are checked against these definitions.
export const schemaMatrix = [
  {
    name: 'optional',
    schema: z.object({ a: z.string(), b: z.number().optional() }),
    wire: { a: 'x', b: null },
    output: { a: 'x' },
    rules: ['optional'],
  },
  {
    name: 'nested-optional',
    schema: z.object({ rows: z.array(z.object({ value: z.string().optional() })) }),
    wire: { rows: [{ value: null }, { value: 'x' }] },
    output: { rows: [{}, { value: 'x' }] },
    rules: ['optional'],
  },
  {
    name: 'nullable-optional',
    schema: z.object({ value: z.string().nullable().optional() }),
    wire: { value: null },
    output: { value: null },
    rules: ['optional'],
  },
  {
    name: 'string-record',
    schema: z.record(z.string(), z.number()),
    wire: {
      value: [
        { key: 'a', value: 2 },
        { key: 'b', value: 3 },
      ],
    },
    output: Object.fromEntries([
      ['a', 2],
      ['b', 3],
    ]),
    rules: ['record'],
  },
  {
    name: 'enum-record',
    schema: z.record(z.enum(['a', 'b']), z.string()),
    wire: { a: 'x', b: 'y' },
    output: { a: 'x', b: 'y' },
    rules: ['record'],
  },
  {
    name: 'loose-object',
    schema: z.looseObject({ a: z.string() }),
    wire: { a: 'x' },
    output: { a: 'x' },
    rules: ['open-object'],
  },
  {
    name: 'discriminated-union',
    schema: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), a: z.string().optional() }),
      z.object({ kind: z.literal('b'), b: z.number() }),
    ]),
    wire: { value: { kind: 'a', a: null } },
    output: { kind: 'a' },
    rules: ['object-root', 'oneOf', 'optional'],
  },
  {
    name: 'array-root',
    schema: z.array(z.string()),
    wire: { value: ['x'] },
    output: ['x'],
    rules: ['object-root'],
  },
  {
    name: 'string-root',
    schema: z.string(),
    wire: { value: 'x' },
    output: 'x',
    rules: ['object-root'],
  },
  {
    name: 'tuple',
    schema: z.object({ pair: z.tuple([z.string(), z.number()]) }),
    wire: null,
    output: { pair: ['x', 1] },
    rules: ['tuple'],
  },
  {
    name: 'nullable',
    schema: z.object({ value: z.string().nullable() }),
    wire: { value: null },
    output: { value: null },
    rules: [],
  },
  {
    name: 'default',
    schema: z.object({ value: z.string().default('x') }),
    wire: { value: 'x' },
    output: { value: 'x' },
    rules: [],
  },
  {
    name: 'union',
    schema: z.object({
      value: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
    }),
    wire: { value: { b: 1 } },
    output: { value: { b: 1 } },
    rules: [],
  },
  {
    name: 'min-length',
    schema: z.object({ value: z.string().min(2) }),
    wire: { value: 'xx' },
    output: { value: 'xx' },
    rules: [],
  },
  {
    name: 'wrapped-array',
    schema: z.object({ value: z.array(z.string()) }),
    wire: { value: ['x'] },
    output: { value: ['x'] },
    rules: [],
  },
] as const;
