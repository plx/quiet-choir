// Type-level contracts for call-site options, ctx.agent profiles and declared child dispatch. The
// workflows are constructed but never run: typecheck (`npm run typecheck`) is the assertion, with
// one `@ts-expect-error` per rejected call and `expectTypeOf` for inferred results.
import { expect, expectTypeOf, it } from 'vitest';
import type { claudeCapabilityKeys, codexCapabilityKeys } from '../src/index.js';
import {
  defineHarness,
  defineWorkflow,
  runWorkflow,
  z,
  type AgentIsolation,
  type BuiltInHarnesses,
  type CallOptions,
  type CapabilityKeysOf,
  type JsonValue,
  type WorkflowContext,
  type WorkflowDeclaration,
  type WorkflowDefinition,
} from '../src/index.js';

const base = { version: '1', input: z.null(), output: z.null() } as const;
const prompt = 'x';
const tool = defineHarness({
  name: 'tool',
  revision: 1,
  options: z.object({
    prompt: z.string(),
    tools: z.array(z.string()).optional(),
    depth: z.number().optional(),
  }),
  capabilities: { structuredOutput: 'native' },
  capabilityKeys: ['tools'],
  access: () => 'read',
});
const wideKeys: 'tools'[] = ['tools'];
const wide = defineHarness({
  name: 'wide',
  revision: 1,
  options: z.object({ prompt: z.string(), tools: z.array(z.string()).optional() }),
  capabilities: { structuredOutput: 'native' },
  capabilityKeys: wideKeys,
  access: () => 'read',
});

// Pre-built option variables escape excess-property checks, so strictness must be structural.
const claudeToolsOptions = { prompt, tools: ['Read'] };
const codexSandboxOptions = { prompt, sandbox: 'workspace-write' as const };
const registeredToolsOptions = { prompt, tools: ['shell'] };
const undefinedToolsOptions = { prompt, tools: undefined };
const inheritOptions = { prompt, isolation: 'inherit' as const };
const worktreeOptions = { prompt, isolation: 'worktree' as const };

// Every built-in capability key is rejected under the default strictProfiles.
export const strict = defineWorkflow({
  ...base,
  name: 'strict',
  profiles: { scout: { claude: { tools: ['Read'] } } },
  harnesses: [tool, wide],
  async run(ctx) {
    // @ts-expect-error -- strict: tools belongs to a named profile.
    await ctx.claude.text('t', { prompt, tools: ['Read'] });
    // @ts-expect-error -- strict: allowedTools belongs to a named profile.
    await ctx.claude.text('t', { prompt, allowedTools: ['Read'] });
    // @ts-expect-error -- strict: disallowedTools belongs to a named profile.
    await ctx.claude.text('t', { prompt, disallowedTools: ['Bash'] });
    // @ts-expect-error -- strict: permissionMode belongs to a named profile.
    await ctx.claude.text('t', { prompt, permissionMode: 'plan' });
    // @ts-expect-error -- strict: agent belongs to a named profile.
    await ctx.claude.text('t', { prompt, agent: 'reviewer' });
    // @ts-expect-error -- strict: agents belongs to a named profile.
    await ctx.claude.text('t', { prompt, agents: {} });
    // @ts-expect-error -- strict: plugins belongs to a named profile.
    await ctx.claude.text('t', { prompt, plugins: ['p'] });
    // @ts-expect-error -- strict: mcpServers belongs to a named profile.
    await ctx.claude.text('t', { prompt, mcpServers: {} });
    // @ts-expect-error -- strict: strictMcpConfig belongs to a named profile.
    await ctx.claude.text('t', { prompt, strictMcpConfig: true });
    // @ts-expect-error -- strict: settings belongs to a named profile.
    await ctx.claude.text('t', { prompt, settings: {} });
    // @ts-expect-error -- strict: addDirs belongs to a named profile.
    await ctx.claude.text('t', { prompt, addDirs: ['docs'] });
    // @ts-expect-error -- strict: extraArgs belongs to a named profile.
    await ctx.claude.text('t', { prompt, extraArgs: ['--verbose'] });
    // @ts-expect-error -- strict: env belongs to a named profile.
    await ctx.claude.text('t', { prompt, env: { A: 'b' } });
    // @ts-expect-error -- strict: inherited configuration belongs to a named profile.
    await ctx.claude.text('t', { prompt, isolation: 'inherit' });
    // @ts-expect-error -- strict: sandbox belongs to a named profile.
    await ctx.codex.text('t', { prompt, sandbox: 'workspace-write' });
    // @ts-expect-error -- strict: networkAccess belongs to a named profile.
    await ctx.codex.text('t', { prompt, networkAccess: true });
    // @ts-expect-error -- strict: config belongs to a named profile.
    await ctx.codex.text('t', { prompt, config: {} });
    // @ts-expect-error -- strict: harnessProfile belongs to a named profile.
    await ctx.codex.text('t', { prompt, harnessProfile: 'p' });
    // @ts-expect-error -- strict: addDirs belongs to a named profile.
    await ctx.codex.text('t', { prompt, addDirs: ['docs'] });
    // @ts-expect-error -- strict: extraArgs belongs to a named profile.
    await ctx.codex.text('t', { prompt, extraArgs: ['--x'] });
    // @ts-expect-error -- strict: env belongs to a named profile.
    await ctx.codex.text('t', { prompt, env: { A: 'b' } });
    // @ts-expect-error -- strict: inherited configuration belongs to a named profile.
    await ctx.codex.text('t', { prompt, isolation: 'inherit' });
    // ctx.agent('claude') and ctx.agent('codex') match ctx.claude and ctx.codex.
    // @ts-expect-error -- strict through ctx.agent too.
    await ctx.agent('claude').text('t', { prompt, tools: ['Read'] });
    // @ts-expect-error -- strict through ctx.agent too.
    await ctx.agent('codex').text('t', { prompt, sandbox: 'workspace-write' });
    // A registered harness's literal capabilityKeys are rejected; other options are not.
    // @ts-expect-error -- strict: tools is a declared capability key of the tool harness.
    await ctx.agent('tool').text('t', { prompt, tools: ['shell'] });
    await ctx.agent('tool').text('t', { prompt, depth: 2 });
    // A widened capabilityKeys list stays permissive; the runtime check still applies.
    await ctx.agent('wide').text('t', { prompt, tools: ['shell'] });
    // Pre-built variables are rejected structurally, not only fresh literals.
    // @ts-expect-error -- strict: a variable's tools belongs to a named profile.
    await ctx.claude.text('t', claudeToolsOptions);
    // @ts-expect-error -- strict: a variable's sandbox belongs to a named profile.
    await ctx.codex.text('t', codexSandboxOptions);
    // @ts-expect-error -- strict: a variable's tools belongs to a named profile.
    await ctx.agent('claude').text('t', claudeToolsOptions);
    // @ts-expect-error -- strict: a variable's tools is a declared capability key of the tool harness.
    await ctx.agent('tool').text('t', registeredToolsOptions);
    // @ts-expect-error -- strict: an explicit undefined still sets the key (runtime Object.hasOwn).
    await ctx.claude.text('t', undefinedToolsOptions);
    // @ts-expect-error -- strict: a variable's inherited configuration belongs to a named profile.
    await ctx.claude.text('t', inheritOptions);
    await ctx.claude.text('t', worktreeOptions);
    await ctx.codex.text('t', worktreeOptions);
    await ctx.agent('wide').text('t', registeredToolsOptions);
    // Strictness survives within().
    // @ts-expect-error -- strict inside a bound scope too.
    await ctx.within('scope').claude.text('t', { prompt, tools: ['Read'] });
    // Non-capability options, restricted isolation and worktree shorthands still compile.
    await ctx.claude.text('t', { prompt, isolation: 'restricted', model: 'm', effort: 'low' });
    await ctx.claude.text('t', { prompt, isolation: { kind: 'worktree' } });
    await ctx.codex.text('t', { prompt, isolation: 'worktree', reasoningEffort: 'low' });
    await ctx.within('scope').claude.text('t', { prompt, profile: 'scout' });
    return null;
  },
});

// A literal strictProfiles: false types every raw key.
export const permissive = defineWorkflow({
  ...base,
  name: 'permissive',
  strictProfiles: false,
  harnesses: [tool],
  async run(ctx) {
    await ctx.claude.text('t', { prompt, tools: ['Read'], allowedTools: ['Read'] });
    await ctx.claude.text('t', { prompt, disallowedTools: ['Bash'], permissionMode: 'plan' });
    await ctx.claude.text('t', { prompt, agent: 'a', agents: {}, plugins: ['p'] });
    await ctx.claude.text('t', { prompt, mcpServers: {}, strictMcpConfig: true, settings: {} });
    await ctx.claude.text('t', { prompt, addDirs: ['d'], extraArgs: ['--x'], env: { A: 'b' } });
    await ctx.claude.text('t', { prompt, isolation: 'inherit' });
    await ctx.codex.text('t', { prompt, sandbox: 'workspace-write', networkAccess: true });
    await ctx.codex.text('t', { prompt, config: {}, harnessProfile: 'p', addDirs: ['d'] });
    await ctx.codex.text('t', { prompt, extraArgs: ['--x'], env: { A: 'b' } });
    await ctx.codex.text('t', { prompt, isolation: 'inherit' });
    await ctx.agent('claude').text('t', { prompt, tools: ['Read'] });
    await ctx.agent('tool').text('t', { prompt, tools: ['shell'] });
    await ctx.within('scope').claude.text('t', { prompt, tools: ['Read'] });
    await ctx.claude.text('t', claudeToolsOptions);
    await ctx.codex.text('t', codexSandboxOptions);
    await ctx.agent('tool').text('t', registeredToolsOptions);
    await ctx.claude.text('t', inheritOptions);
    return null;
  },
});

// A non-literal boolean cannot prove strictness, so it stays permissive (the runtime decides).
const dynamicStrict: boolean = Date.now() > 0;
export const dynamic = defineWorkflow({
  ...base,
  name: 'dynamic',
  strictProfiles: dynamicStrict,
  async run(ctx) {
    await ctx.claude.text('t', { prompt, tools: ['Read'] });
    return null;
  },
});

// A bare WorkflowContext helper stays permissive and accepts strict and typed-children contexts.
async function permissiveHelper(ctx: WorkflowContext): Promise<JsonValue> {
  await ctx.claude.text('t', { prompt, tools: ['Read'] });
  return ctx.workflow('c', 'anything', { any: 'json' });
}
// A strict helper contract names its role, the built-in registry and true.
async function strictHelper(ctx: WorkflowContext<'scout', BuiltInHarnesses, true>) {
  // @ts-expect-error -- a strict helper rejects raw keys.
  await ctx.claude.text('t', { prompt, tools: ['Read'] });
  return ctx.claude.text('t', { prompt, profile: 'scout' });
}

// ctx.agent profiles are typed like ctx.claude profiles.
export const profiled = defineWorkflow({
  ...base,
  name: 'profiled',
  profiles: { scout: { claude: { tools: ['Read'] } } },
  harnesses: [tool],
  async run(ctx) {
    // @ts-expect-error -- typo is neither a built-in preset nor a declared role.
    await ctx.agent('claude').text('x', { prompt, profile: 'typo' });
    // @ts-expect-error -- typo is neither a built-in preset nor a declared role.
    await ctx.agent('codex').text('x', { prompt, profile: 'typo' });
    // @ts-expect-error -- typo is neither a built-in preset nor a declared role.
    await ctx.agent('tool').text('x', { prompt, profile: 'typo' });
    await ctx.agent('claude').text('x', { prompt, profile: 'scout' });
    await ctx.agent('codex').text('x', { prompt, profile: 'readonly' });
    await ctx.agent('tool').text('x', { prompt, profile: 'scout' });
    await permissiveHelper(ctx);
    await strictHelper(ctx);
    return null;
  },
});

// Declared children type by-name dispatch.
const child = defineWorkflow({
  name: 'child',
  version: '1',
  input: z.object({ x: z.number() }),
  output: z.string(),
  run: (_ctx, input) => Promise.resolve(String(input.x)),
});
const other = defineWorkflow({
  name: 'other',
  version: '1',
  input: z.null(),
  output: z.object({ ok: z.boolean() }),
  run: () => Promise.resolve({ ok: true }),
});
export const parent = defineWorkflow({
  ...base,
  name: 'parent',
  children: [child, other],
  async run(ctx) {
    const text = await ctx.workflow('c', 'child', { x: 1 });
    expectTypeOf(text).toEqualTypeOf<string>();
    expectTypeOf(await ctx.workflow('o', 'other', null)).toEqualTypeOf<{ ok: boolean }>();
    // @ts-expect-error -- no-such-child is not declared.
    await ctx.workflow('c', 'no-such-child', { x: 1 });
    // @ts-expect-error -- child's input x is a number.
    await ctx.workflow('c', 'child', { x: '1' });
    // The typed-definition overload still infers the output, and children narrow within().
    expectTypeOf(await ctx.workflow('d', child, { x: 1 })).toEqualTypeOf<string>();
    expectTypeOf(await ctx.within('s').workflow('c', 'child', { x: 1 })).toEqualTypeOf<string>();
    expectTypeOf(await permissiveHelper(ctx)).toEqualTypeOf<JsonValue>();
    return null;
  },
});
export const childless = defineWorkflow({
  ...base,
  name: 'childless',
  async run(ctx) {
    // @ts-expect-error -- a workflow without children has nothing to dispatch by name.
    await ctx.workflow('c', 'child', { x: 1 });
    return null;
  },
});
// An erased declaration widens names, so by-name dispatch falls back to JSON.
const erased: WorkflowDeclaration = child;
export const erasedParent = defineWorkflow({
  ...base,
  name: 'erased-parent',
  children: [erased],
  async run(ctx) {
    expectTypeOf(await ctx.workflow('c', 'anything', { y: true })).toEqualTypeOf<JsonValue>();
    return null;
  },
});
// The typed-definition overload accepts strict and typed-children definitions.
export const grandparent = defineWorkflow({
  ...base,
  name: 'grandparent',
  async run(ctx) {
    expectTypeOf(await ctx.workflow('p', parent, null)).toEqualTypeOf<null>();
    expectTypeOf(await ctx.workflow('s', strict, null)).toEqualTypeOf<null>();
    return null;
  },
});
// Typed definitions still reach unparameterized definition parameters and runWorkflow.
const accepts = (definition: WorkflowDefinition<null, null>) => definition.name;
const run = () => runWorkflow(parent, { runId: 'unused', stateDir: 'unused', input: null });

it('carries strictness, profiles and declared children into authoring types', () => {
  // The literal name and strictness flow into the definition type.
  expectTypeOf(parent.name).toEqualTypeOf<'parent'>();
  expectTypeOf(strict.strictProfiles).toEqualTypeOf<true | undefined>();
  expectTypeOf(permissive.strictProfiles).toEqualTypeOf<false | undefined>();
  // Strict built-in call options can set only a narrowed isolation of the shared key tuples; the
  // other capability keys remain as optional never properties.
  type StrictClaude = CallOptions<'claude', BuiltInHarnesses['claude'], never, true>;
  type StrictCodex = CallOptions<'codex', BuiltInHarnesses['codex'], never, true>;
  type Settable<T> = {
    [P in keyof T]-?: [Exclude<T[P], undefined>] extends [never] ? never : P;
  }[keyof T];
  expectTypeOf<
    Extract<Settable<StrictClaude>, (typeof claudeCapabilityKeys)[number]>
  >().toEqualTypeOf<'isolation'>();
  expectTypeOf<
    Extract<Settable<StrictCodex>, (typeof codexCapabilityKeys)[number]>
  >().toEqualTypeOf<'isolation'>();
  expectTypeOf<Exclude<(typeof claudeCapabilityKeys)[number], keyof StrictClaude>>().toBeNever();
  type StrictTool = CallOptions<'tool', typeof tool, never, true>;
  expectTypeOf<Extract<Settable<StrictTool>, 'tools' | 'depth'>>().toEqualTypeOf<'depth'>();
  expectTypeOf<Extract<keyof StrictTool, 'tools'>>().toEqualTypeOf<'tools'>();
  // A widened capabilityKeys list adds no forbidden keys.
  type StrictWide = CallOptions<'wide', typeof wide, never, true>;
  expectTypeOf<Extract<Settable<StrictWide>, 'tools'>>().toEqualTypeOf<'tools'>();
  expectTypeOf<StrictClaude['isolation']>().toEqualTypeOf<
    Exclude<AgentIsolation, 'inherit'> | undefined
  >();
  expectTypeOf<CapabilityKeysOf<BuiltInHarnesses['claude']>>().toEqualTypeOf<
    (typeof claudeCapabilityKeys)[number]
  >();
  expectTypeOf<CapabilityKeysOf<typeof tool>>().toEqualTypeOf<'tools'>();
  expectTypeOf<CapabilityKeysOf<typeof wide>>().toBeNever();
  expect([strict, permissive, dynamic, profiled, parent, childless, erasedParent].length).toBe(7);
  expect(accepts(parent)).toBe('parent');
  expect(accepts(strict)).toBe('strict');
  expect(typeof run).toBe('function');
  expect(grandparent.name).toBe('grandparent');
});
