// Type-level contracts for call-site options, the removed profile surface (#726) and declared child
// dispatch. The workflows are constructed but never run: typecheck (`npm run typecheck`) is the
// assertion, with one `@ts-expect-error` per rejected call and `expectTypeOf` for inferred results.
import { expect, expectTypeOf, it } from 'vitest';
import type { claudeCapabilityKeys, codexCapabilityKeys } from '../src/index.js';
import {
  defineHarness,
  defineWorkflow,
  runWorkflow,
  z,
  type AgentDefaults,
  type AgentResult,
  type BuiltInHarnesses,
  type CallOptions,
  type CapabilityKeysOf,
  type EmptyRoster,
  type HarnessIsolation,
  type JsonValue,
  type MapStepError,
  type Settled,
  type WorkflowContext,
  type WorkflowDeclaration,
  type WorkflowDefinition,
  type WorkflowResult,
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
const worktreeOptions = { prompt, worktree: true as const };
const baseWorktreeOptions = { prompt, worktree: { base: 'main' } };
const addDirs = ['runs/a'];
const addDirOptions = { prompt, addDirs };
const commit = 'a'.repeat(40);

// Every built-in capability key is rejected under an explicit strictProfiles: true.
export const strict = defineWorkflow({
  ...base,
  name: 'strict',
  strictProfiles: true,
  harnesses: [tool, wide],
  async run(ctx) {
    // @ts-expect-error -- strict: tools belongs to a roster entry.
    await ctx.claude.text('t', { prompt, tools: ['Read'] });
    // @ts-expect-error -- strict: allowedTools belongs to a roster entry.
    await ctx.claude.text('t', { prompt, allowedTools: ['Read'] });
    // @ts-expect-error -- strict: disallowedTools belongs to a roster entry.
    await ctx.claude.text('t', { prompt, disallowedTools: ['Bash'] });
    // @ts-expect-error -- strict: permissionMode belongs to a roster entry.
    await ctx.claude.text('t', { prompt, permissionMode: 'plan' });
    // @ts-expect-error -- strict: agent belongs to a roster entry.
    await ctx.claude.text('t', { prompt, agent: 'reviewer' });
    // @ts-expect-error -- strict: agents belongs to a roster entry.
    await ctx.claude.text('t', { prompt, agents: {} });
    // @ts-expect-error -- strict: plugins belongs to a roster entry.
    await ctx.claude.text('t', { prompt, plugins: ['p'] });
    // @ts-expect-error -- strict: mcpServers belongs to a roster entry.
    await ctx.claude.text('t', { prompt, mcpServers: {} });
    // @ts-expect-error -- strict: strictMcpConfig belongs to a roster entry.
    await ctx.claude.text('t', { prompt, strictMcpConfig: true });
    // @ts-expect-error -- strict: settings belongs to a roster entry.
    await ctx.claude.text('t', { prompt, settings: {} });
    // @ts-expect-error -- strict: addDirs belongs to a roster entry.
    await ctx.claude.text('t', { prompt, addDirs: ['docs'] });
    // @ts-expect-error -- strict: extraArgs belongs to a roster entry.
    await ctx.claude.text('t', { prompt, extraArgs: ['--verbose'] });
    // @ts-expect-error -- strict: env belongs to a roster entry.
    await ctx.claude.text('t', { prompt, env: { A: 'b' } });
    // @ts-expect-error -- strict: inherited configuration belongs to a roster entry.
    await ctx.claude.text('t', { prompt, isolation: 'inherit' });
    // @ts-expect-error -- strict: sandbox belongs to a roster entry.
    await ctx.codex.text('t', { prompt, sandbox: 'workspace-write' });
    // @ts-expect-error -- strict: networkAccess belongs to a roster entry.
    await ctx.codex.text('t', { prompt, networkAccess: true });
    // @ts-expect-error -- strict: config belongs to a roster entry.
    await ctx.codex.text('t', { prompt, config: {} });
    // @ts-expect-error -- strict: harnessProfile belongs to a roster entry.
    await ctx.codex.text('t', { prompt, harnessProfile: 'p' });
    // @ts-expect-error -- strict: addDirs belongs to a roster entry.
    await ctx.codex.text('t', { prompt, addDirs: ['docs'] });
    // @ts-expect-error -- strict: extraArgs belongs to a roster entry.
    await ctx.codex.text('t', { prompt, extraArgs: ['--x'] });
    // @ts-expect-error -- strict: env belongs to a roster entry.
    await ctx.codex.text('t', { prompt, env: { A: 'b' } });
    // @ts-expect-error -- strict: inherited configuration belongs to a roster entry.
    await ctx.codex.text('t', { prompt, isolation: 'inherit' });
    // ctx.agent('claude') and ctx.agent('codex') match ctx.claude and ctx.codex.
    // @ts-expect-error -- strict through ctx.agent too.
    await ctx.agent('claude').text('t', { prompt, tools: ['Read'] });
    // @ts-expect-error -- strict through ctx.agent too.
    await ctx.agent('codex').text('t', { prompt, sandbox: 'workspace-write' });
    // @ts-expect-error -- strict: addDirs belongs to a roster entry, through ctx.agent too.
    await ctx.agent('claude').text('t', { prompt, addDirs: ['runs/pr-1'] });
    // @ts-expect-error -- strict: addDirs belongs to a roster entry inside a bound scope too.
    await ctx.within('scope').claude.text('t', { prompt, addDirs: ['runs/pr-1'] });
    // @ts-expect-error -- strict: Codex addDirs are writable roots and stay role-owned.
    await ctx.agent('codex').text('t', { prompt, addDirs: ['docs'] });
    // A registered harness's literal capabilityKeys are rejected; other options are not.
    // @ts-expect-error -- strict: tools is a declared capability key of the tool harness.
    await ctx.agent('tool').text('t', { prompt, tools: ['shell'] });
    await ctx.agent('tool').text('t', { prompt, depth: 2 });
    // A widened capabilityKeys list stays permissive; the runtime check still applies.
    await ctx.agent('wide').text('t', { prompt, tools: ['shell'] });
    // Pre-built variables are rejected structurally, not only fresh literals.
    // @ts-expect-error -- strict: a variable's tools belongs to a roster entry.
    await ctx.claude.text('t', claudeToolsOptions);
    // @ts-expect-error -- strict: a variable's sandbox belongs to a roster entry.
    await ctx.codex.text('t', codexSandboxOptions);
    // @ts-expect-error -- strict: a variable's tools belongs to a roster entry.
    await ctx.agent('claude').text('t', claudeToolsOptions);
    // @ts-expect-error -- strict: a variable's tools is a declared capability key of the tool harness.
    await ctx.agent('tool').text('t', registeredToolsOptions);
    // @ts-expect-error -- strict: an explicit undefined still sets the key (runtime Object.hasOwn).
    await ctx.claude.text('t', undefinedToolsOptions);
    // @ts-expect-error -- strict: a variable's inherited configuration belongs to a roster entry.
    await ctx.claude.text('t', inheritOptions);
    // @ts-expect-error -- strict: a variable's addDirs belongs to a roster entry.
    await ctx.claude.text('t', addDirOptions);
    await ctx.claude.text('t', worktreeOptions);
    await ctx.codex.text('t', worktreeOptions);
    await ctx.claude.text('t', baseWorktreeOptions);
    await ctx.agent('wide').text('t', registeredToolsOptions);
    // Strictness survives within().
    // @ts-expect-error -- strict inside a bound scope too.
    await ctx.within('scope').claude.text('t', { prompt, tools: ['Read'] });
    // Non-capability options, restricted isolation and every worktree form still compile.
    await ctx.claude.text('t', { prompt, isolation: 'restricted', model: 'm', effort: 'low' });
    await ctx.claude.text('t', { prompt, worktree: true });
    await ctx.codex.text('t', { prompt, worktree: { base: 'main' }, effort: 'low' });
    // Codex has one effort option (#341): it adds none and minimal to the shared levels.
    await ctx.codex.text('t', { prompt, effort: 'none' });
    await ctx.codex.text('t', { prompt, effort: 'minimal' });
    await ctx.codex.text('t', { prompt, effort: 'xhigh' });
    // @ts-expect-error -- reasoningEffort was renamed to effort.
    await ctx.codex.text('t', { prompt, reasoningEffort: 'low' });
    // @ts-expect-error -- minimal is a Codex-only effort level.
    await ctx.claude.text('t', { prompt, effort: 'minimal' });
    await ctx.codex.text('t', { prompt, worktree: { base: { commit } } });
    const tree = await ctx.worktree('tree');
    await ctx.claude.text('t', { prompt, worktree: tree, isolation: 'restricted' });
    await ctx.agent('codex').text('t', { prompt, worktree: tree });
    // worktree is the only checkout selector; the pre-#340 spellings run but no longer type-check.
    // @ts-expect-error -- isolation is only the configuration mode.
    await ctx.claude.text('t', { prompt, isolation: 'worktree' });
    // @ts-expect-error -- isolation is only the configuration mode.
    await ctx.codex.text('t', { prompt, isolation: 'worktree' });
    // @ts-expect-error -- a handle goes in worktree.
    await ctx.claude.text('t', { prompt, isolation: tree });
    // @ts-expect-error -- a handle goes in worktree.
    await ctx.codex.text('t', { prompt, isolation: tree });
    // @ts-expect-error -- use worktree: true.
    await ctx.claude.text('t', { prompt, worktree: 'worktree' });
    // @ts-expect-error -- use worktree: true.
    await ctx.codex.text('t', { prompt, worktree: 'worktree' });
    // @ts-expect-error -- use worktree: { base }.
    await ctx.claude.text('t', { prompt, worktree: { kind: 'worktree' } });
    // @ts-expect-error -- use worktree: { base }.
    await ctx.codex.text('t', { prompt, worktree: { kind: 'worktree', base: 'main' } });
    // @ts-expect-error -- the profile call option was removed (#726), under strictProfiles too.
    await ctx.within('scope').claude.text('t', { prompt, profile: 'text' });
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
    // Every worktree form, alone or with either configuration mode.
    const tree = await ctx.worktree('tree');
    await ctx.claude.text('t', { prompt, worktree: true, isolation: 'inherit' });
    await ctx.codex.text('t', { prompt, worktree: { base: 'main' }, isolation: 'restricted' });
    await ctx.codex.text('t', { prompt, worktree: { base: { commit } } });
    await ctx.claude.text('t', { prompt, worktree: tree });
    await ctx.claude.text('t', baseWorktreeOptions);
    // The pre-#340 spellings are type errors without strict profiles too.
    // @ts-expect-error -- isolation is only the configuration mode.
    await ctx.claude.text('t', { prompt, isolation: 'worktree' });
    // @ts-expect-error -- isolation is only the configuration mode.
    await ctx.codex.text('t', { prompt, isolation: 'worktree' });
    // @ts-expect-error -- a handle goes in worktree.
    await ctx.claude.text('t', { prompt, isolation: tree });
    // @ts-expect-error -- a handle goes in worktree.
    await ctx.codex.text('t', { prompt, isolation: tree });
    // @ts-expect-error -- use worktree: true.
    await ctx.claude.text('t', { prompt, worktree: 'worktree' });
    // @ts-expect-error -- use worktree: true.
    await ctx.codex.text('t', { prompt, worktree: 'worktree' });
    // @ts-expect-error -- use worktree: { base }.
    await ctx.claude.text('t', { prompt, worktree: { kind: 'worktree' } });
    // @ts-expect-error -- use worktree: { base }.
    await ctx.codex.text('t', { prompt, worktree: { kind: 'worktree', base: 'main' } });
    return null;
  },
});

// Omitted strictProfiles infers false (#577): raw capability keys type at every call site.
export const omittedStrict = defineWorkflow({
  ...base,
  name: 'omitted-strict',
  harnesses: [tool],
  async run(ctx) {
    await ctx.claude.text('t', { prompt, tools: ['Read'] });
    await ctx.claude.text('t', { prompt, addDirs: ['d'], env: { A: 'b' } });
    await ctx.codex.text('t', { prompt, sandbox: 'workspace-write', networkAccess: true });
    await ctx.agent('tool').text('t', { prompt, tools: ['shell'] });
    await ctx.within('scope').claude.text('t', { prompt, isolation: 'inherit' });
    await ctx.claude.text('t', claudeToolsOptions);
    // @ts-expect-error -- the profile call option was removed (#726) without strict profiles too.
    await ctx.claude.text('t', { prompt, profile: 'text' });
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
  await ctx.claude.text('t', { prompt, addDirs: ['runs/a'] });
  // @ts-expect-error -- a bare context has no profile call option either (#726).
  await ctx.claude.text('t', { prompt, profile: 'text' });
  return ctx.workflow('c', 'anything', { any: 'json' });
}
// A strict helper contract names the built-in registry and true.
async function strictHelper(ctx: WorkflowContext<BuiltInHarnesses, true>) {
  // @ts-expect-error -- a strict helper rejects raw keys.
  await ctx.claude.text('t', { prompt, tools: ['Read'] });
  return ctx.claude.text('t', { prompt });
}

// The removed profile call option (#726) is an excess property on every client and on bind.
export const removedProfileOption = defineWorkflow({
  ...base,
  name: 'removed-profile-option',
  harnesses: [tool],
  async run(ctx) {
    // @ts-expect-error -- the profile call option was removed (#726).
    await ctx.claude.text('x', { prompt, profile: 'text' });
    // @ts-expect-error -- on Codex too.
    await ctx.codex.text('x', { prompt, profile: 'text' });
    // @ts-expect-error -- through ctx.agent('claude').
    await ctx.agent('claude').text('x', { prompt, profile: 'text' });
    // @ts-expect-error -- through ctx.agent('codex').
    await ctx.agent('codex').text('x', { prompt, profile: 'text' });
    // @ts-expect-error -- on a registered harness.
    await ctx.agent('tool').text('x', { prompt, profile: 'text' });
    // @ts-expect-error -- inside within().
    await ctx.within('scope').claude.text('x', { prompt, profile: 'text' });
    // @ts-expect-error -- bind cannot set it either.
    ctx.claude.bind({ profile: 'text' });
    await permissiveHelper(ctx);
    await strictHelper(ctx);
    return null;
  },
});

// The removed `profiles` field and `defaults.profile` (#726) fail typecheck.
export const removedProfiles = defineWorkflow({
  ...base,
  name: 'removed-profiles',
  // @ts-expect-error -- profiles were removed (#726); declare agents with defineRoster.
  profiles: { scout: { claude: { tools: ['Read'] } } },
  run: () => Promise.resolve(null),
});
export const removedDefaultProfile = defineWorkflow({
  ...base,
  name: 'removed-default-profile',
  defaults: {
    maxTurns: 5,
    // @ts-expect-error -- defaults.profile was removed (#726); the default role is always text.
    profile: 'text',
  },
  run: () => Promise.resolve(null),
});

// Defaults take the single Codex effort (#341).
export const effortDefaults = defineWorkflow({
  ...base,
  name: 'effort-defaults',
  defaults: {
    codex: {
      effort: 'minimal',
      // @ts-expect-error -- reasoningEffort was renamed to effort.
      reasoningEffort: 'low',
    },
    claude: {
      // @ts-expect-error -- none is a Codex-only effort level.
      effort: 'none',
    },
  },
  run: () => Promise.resolve(null),
});

// Rooted call-site directories were removed (#707): no defaults block declares roots, and static
// addDirs stay.
export const rootedDefaults = defineWorkflow({
  ...base,
  name: 'rooted-defaults',
  defaults: {
    claude: {
      addDirs: ['docs'],
      // @ts-expect-error -- defaults.claude.addDirRoots was removed; list addDirs on a roster entry.
      addDirRoots: ['runs'],
    },
    codex: {
      // @ts-expect-error -- codex.addDirRoots is rejected; list Codex directories in codex.addDirs.
      addDirRoots: ['runs'],
    },
  },
  run: () => Promise.resolve(null),
});

// An inline defaults literal keeps its excess-property checks (#385), and checkout placement is a
// per-call decision: defaults isolation is only the configuration mode.
export const unknownDefaultsKeys = defineWorkflow({
  ...base,
  name: 'unknown-defaults-keys',
  defaults: {
    codex: {
      model: 'gpt',
      // @ts-expect-error -- defaults.codex has no such key.
      sandboxMode: 'read-only',
    },
    claude: {
      tools: ['Read'],
      // @ts-expect-error -- defaults.claude has no such key.
      allowTools: ['Read'],
    },
  },
  run: () => Promise.resolve(null),
});
const defaultsRun = () => Promise.resolve(null);
defineWorkflow({
  ...base,
  name: 'top-level-defaults-key',
  // @ts-expect-error -- defaults have no such top-level key.
  defaults: { addDirRoots: ['runs'] },
  run: defaultsRun,
});
defineWorkflow({
  ...base,
  name: 'defaults-isolation-worktree',
  // @ts-expect-error -- defaults isolation is only the configuration mode.
  defaults: { claude: { isolation: 'worktree' } },
  run: defaultsRun,
});
defineWorkflow({
  ...base,
  name: 'defaults-worktree',
  // @ts-expect-error -- defaults never select a checkout.
  defaults: { claude: { worktree: true } },
  run: defaultsRun,
});
defineWorkflow({
  ...base,
  name: 'defaults-worktree-base',
  // @ts-expect-error -- defaults never select a checkout, with a base either.
  defaults: { codex: { worktree: { base: 'main' } } },
  run: defaultsRun,
});

// The checks recurse into structured values such as env edits; open records stay open. A mistyped
// edit is reported against the flat overlay, so its well-formed sibling values fail as well.
export const unknownEnvKeys = defineWorkflow({
  ...base,
  name: 'unknown-env-keys',
  defaults: {
    claude: {
      env: {
        // @ts-expect-error -- the flat overlay takes only string values.
        set: { FOO: 'bar' },
        // @ts-expect-error -- defaults.claude.env edits have only set and unset.
        unest: ['BAZ'],
      },
    },
    codex: {
      env: {
        // @ts-expect-error -- the flat overlay takes only string values.
        unset: ['BAZ'],
        // @ts-expect-error -- defaults.codex.env edits have only set and unset.
        sett: { FOO: 'bar' },
      },
    },
  },
  run: () => Promise.resolve(null),
});
export const structuredDefaultValues = defineWorkflow({
  ...base,
  name: 'structured-default-values',
  defaults: {
    claude: {
      env: { set: { FOO: 'bar' }, unset: ['BAZ'] },
      settings: { anyKey: { nested: true } },
      mcpServers: { local: { command: 'server', args: ['--x'] } },
      agents: { scout: { description: 'd', prompt: 'p', model: 'sonnet' } },
    },
    codex: { env: { unset: ['BAZ'] }, config: { 'features.anything': true } },
    harnesses: { tool: { tools: ['x'], extra: { nested: 1 } } },
  },
  run: () => Promise.resolve(null),
});
export const flatDefaultValues = defineWorkflow({
  ...base,
  name: 'flat-default-values',
  defaults: { claude: { env: { FOO: 'bar' } }, codex: { env: { FOO: 'bar', BAZ: 'qux' } } },
  run: () => Promise.resolve(null),
});

// strictProfiles: false keeps call-site addDirs.
export const permissiveAddDirs = defineWorkflow({
  ...base,
  name: 'permissive-add-dirs',
  strictProfiles: false,
  async run(ctx) {
    await ctx.claude.text('t', { prompt, addDirs });
    await ctx.claude.text('t', addDirOptions);
    await ctx.codex.text('t', { prompt, addDirs });
    return null;
  },
});
// Array-valued controls in inline defaults stay assignable, and a strict structured call still
// infers its schema type.
export const constDefaults = defineWorkflow({
  ...base,
  name: 'const-defaults',
  strictProfiles: true,
  defaults: { claude: { tools: ['Read'], settings: { list: [1, { a: [true] }] } } },
  async run(ctx) {
    await ctx.claude.text('t', { prompt });
    expectTypeOf(
      await ctx.claude.value('v', { prompt, schema: z.number() }),
    ).toEqualTypeOf<number>();
    expectTypeOf(
      await ctx.claude.object('o', { prompt, schema: z.string(), onError: 'return' }),
    ).toEqualTypeOf<Settled<AgentResult<string>>>();
    // @ts-expect-error -- strict: addDirs belongs to a roster entry.
    await ctx.claude.text('t', { prompt, addDirs });
    return null;
  },
});
const constDeclaration: WorkflowDeclaration = constDefaults;
export const constParent = defineWorkflow({
  ...base,
  name: 'const-parent',
  children: [constDefaults],
  async run(ctx) {
    expectTypeOf(await ctx.workflow('c', constDefaults, null)).toEqualTypeOf<null>();
    expectTypeOf(await ctx.workflow('r', 'const-defaults', null)).toEqualTypeOf<null>();
    return null;
  },
});
const runConst = () =>
  runWorkflow(constDefaults, { runId: 'unused', stateDir: 'unused', input: null });
// Explicit type arguments type a strict workflow's call sites too.
export const explicitStrict = defineWorkflow<
  null,
  null,
  readonly [],
  true,
  readonly [],
  'explicit-strict'
>({
  ...base,
  name: 'explicit-strict',
  strictProfiles: true,
  async run(ctx) {
    await ctx.claude.text('t', { prompt });
    // @ts-expect-error -- strict: addDirs belongs to a roster entry.
    await ctx.claude.text('t', { prompt, addDirs });
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
// Explicit defineWorkflow type arguments are all-or-nothing: TypeScript has no partial inference,
// so a shorter prefix takes the permissive, childless defaults for the remaining parameters.
export const prefixStrictRefused = defineWorkflow<null, null>({
  ...base,
  name: 'prefix-strict-refused',
  // @ts-expect-error -- the <Input, Output> prefix defaults TStrict to false.
  strictProfiles: true,
  run: () => Promise.resolve(null),
});
export const prefixPermissive = defineWorkflow<null, null>({
  ...base,
  name: 'prefix-permissive',
  strictProfiles: false,
  async run(ctx) {
    await ctx.claude.text('t', { prompt, tools: ['Read'] });
    return null;
  },
});
export const prefixParent = defineWorkflow<null, null>({
  ...base,
  name: 'prefix-parent',
  // @ts-expect-error -- the <Input, Output> prefix defaults TChildren to an empty tuple.
  children: [child],
  run: () => Promise.resolve(null),
});
// The prefix form still compiles for a childless workflow that omits strictProfiles.
export const prefixStrict = defineWorkflow<null, null>({
  ...base,
  name: 'prefix-strict',
  run: () => Promise.resolve(null),
});
// Spelling all six type arguments types strictProfiles: false and declared children.
export const explicitAll = defineWorkflow<
  null,
  null,
  readonly [],
  false,
  readonly [typeof child],
  'explicit-all'
>({
  ...base,
  name: 'explicit-all',
  strictProfiles: false,
  children: [child],
  async run(ctx) {
    await ctx.claude.text('t', { prompt, tools: ['Read'] });
    expectTypeOf(await ctx.workflow('c', 'child', { x: 1 })).toEqualTypeOf<string>();
    return null;
  },
});
// Typed definitions still reach unparameterized definition parameters and runWorkflow.
const accepts = (definition: WorkflowDefinition<null, null>) => definition.name;
// ctx.map has one named signature: onError selects the result shape, cancelSiblings the policy.
export const mapForms = defineWorkflow({
  ...base,
  name: 'map-forms',
  async run(ctx) {
    const items = [1, 2];
    const mapper = (item: number) => Promise.resolve(String(item));
    expectTypeOf(await ctx.map('a', items, { concurrency: 2 }, mapper)).toEqualTypeOf<string[]>();
    expectTypeOf(
      await ctx.map('b', items, { concurrency: 2, onError: 'throw', cancelSiblings: true }, mapper),
    ).toEqualTypeOf<string[]>();
    expectTypeOf(
      await ctx.map('c', items, { concurrency: 2, onError: 'return' }, mapper),
    ).toEqualTypeOf<Settled<string, MapStepError>[]>();
    expectTypeOf(
      await ctx.map(
        'd',
        items,
        { concurrency: 2, onError: 'return', cancelSiblings: true, version: '2' },
        mapper,
      ),
    ).toEqualTypeOf<Settled<string, MapStepError>[]>();
    const mode = 'return' as 'throw' | 'return';
    expectTypeOf(
      await ctx.map('e', items, { concurrency: 2, onError: mode }, mapper),
    ).toEqualTypeOf<string[] | Settled<string, MapStepError>[]>();
    // @ts-expect-error The positional ctx.map(items, concurrency, mapper) form was removed.
    await ctx.map(items, 2, mapper);
    // @ts-expect-error 'abort' is now cancelSiblings: true.
    await ctx.map('f', items, { concurrency: 2, onError: 'abort' }, mapper);
    // @ts-expect-error 'drain' is the default policy, not an onError value.
    await ctx.map('g', items, { concurrency: 2, onError: 'drain' }, mapper);
    // @ts-expect-error 'settle' is accepted only as an untyped runtime alias for 'return'.
    await ctx.map('h', items, { concurrency: 2, onError: 'settle' }, mapper);
    // @ts-expect-error A typo names the valid literals (see map-types.test.ts).
    await ctx.map('i', items, { concurrency: 2, onError: 'settled' }, mapper);
    // @ts-expect-error cancelSiblings is a boolean.
    await ctx.map('j', items, { concurrency: 2, cancelSiblings: 'yes' }, mapper);
    return null;
  },
});

const run = () => runWorkflow(parent, { runId: 'unused', stateDir: 'unused', input: null });
// The three-argument explicit runWorkflow form still compiles for a strict workflow with children.
const runExplicit = () =>
  runWorkflow<null, null, readonly []>(parent, {
    runId: 'unused',
    stateDir: 'unused',
    input: null,
  });

it('carries strictness and declared children into authoring types', () => {
  // The literal name and strictness flow into the definition type.
  expectTypeOf(parent.name).toEqualTypeOf<'parent'>();
  expectTypeOf(strict.strictProfiles).toEqualTypeOf<true | undefined>();
  expectTypeOf(permissive.strictProfiles).toEqualTypeOf<false | undefined>();
  expectTypeOf(omittedStrict.strictProfiles).toEqualTypeOf<false | undefined>();
  // Strict built-in call options can set only a narrowed isolation of the shared key tuples; the
  // other capability keys, Claude's addDirs included (#707), remain as optional never properties.
  type StrictClaude = CallOptions<'claude', BuiltInHarnesses['claude'], true>;
  type StrictCodex = CallOptions<'codex', BuiltInHarnesses['codex'], true>;
  type Settable<T> = {
    [P in keyof T]-?: [Exclude<T[P], undefined>] extends [never] ? never : P;
  }[keyof T];
  expectTypeOf<
    Extract<Settable<StrictClaude>, (typeof claudeCapabilityKeys)[number]>
  >().toEqualTypeOf<'isolation'>();
  expectTypeOf<{ prompt: string; addDirs: string[] }>().not.toExtend<StrictClaude>();
  expectTypeOf<{ prompt: string; addDirs: string[] }>().not.toExtend<StrictCodex>();
  expectTypeOf<
    Extract<Settable<StrictCodex>, (typeof codexCapabilityKeys)[number]>
  >().toEqualTypeOf<'isolation'>();
  expectTypeOf<Exclude<(typeof claudeCapabilityKeys)[number], keyof StrictClaude>>().toBeNever();
  // Call options have no profile key, strict or not (#726).
  expectTypeOf<Extract<keyof StrictClaude, 'profile'>>().toBeNever();
  expectTypeOf<
    Extract<keyof CallOptions<'codex', BuiltInHarnesses['codex'], false>, 'profile'>
  >().toBeNever();
  type StrictTool = CallOptions<'tool', typeof tool, true>;
  expectTypeOf<Extract<Settable<StrictTool>, 'tools' | 'depth'>>().toEqualTypeOf<'depth'>();
  expectTypeOf<Extract<keyof StrictTool, 'tools'>>().toEqualTypeOf<'tools'>();
  expectTypeOf<Extract<keyof StrictTool, 'profile'>>().toBeNever();
  // A widened capabilityKeys list adds no forbidden keys.
  type StrictWide = CallOptions<'wide', typeof wide, true>;
  expectTypeOf<Extract<Settable<StrictWide>, 'tools'>>().toEqualTypeOf<'tools'>();
  expectTypeOf<StrictClaude['isolation']>().toEqualTypeOf<
    Exclude<HarnessIsolation, 'inherit'> | undefined
  >();
  expectTypeOf<StrictClaude['isolation']>().toEqualTypeOf<'restricted' | undefined>();
  expectTypeOf<CapabilityKeysOf<BuiltInHarnesses['claude']>>().toEqualTypeOf<
    (typeof claudeCapabilityKeys)[number]
  >();
  expectTypeOf<CapabilityKeysOf<typeof tool>>().toEqualTypeOf<'tools'>();
  expectTypeOf<CapabilityKeysOf<typeof wide>>().toBeNever();
  expect(
    [strict, permissive, dynamic, removedProfileOption, parent, childless, erasedParent, mapForms]
      .length,
  ).toBe(8);
  expect([prefixPermissive, prefixParent, prefixStrict].map(({ name }) => name)).toEqual([
    'prefix-permissive',
    'prefix-parent',
    'prefix-strict',
  ]);
  expectTypeOf(explicitAll.name).toEqualTypeOf<'explicit-all'>();
  expect(accepts(parent)).toBe('parent');
  expect(accepts(strict)).toBe('strict');
  expect(typeof run).toBe('function');
  expectTypeOf(runExplicit).returns.toEqualTypeOf<Promise<WorkflowResult<null>>>();
  expect(grandparent.name).toBe('grandparent');
  expect([permissiveAddDirs, rootedDefaults, effortDefaults].length).toBe(3);
  expect([constDeclaration.name, constParent.name, explicitStrict.name]).toEqual([
    'const-defaults',
    'const-parent',
    'explicit-strict',
  ]);
  expect([removedProfiles.name, removedDefaultProfile.name]).toEqual([
    'removed-profiles',
    'removed-default-profile',
  ]);
  expect(unknownDefaultsKeys.name).toBe('unknown-defaults-keys');
  expect([structuredDefaultValues.name, flatDefaultValues.name, unknownEnvKeys.name]).toHaveLength(
    3,
  );
  expect(typeof runConst).toBe('function');
});

// A generic factory that forwards a defaults value compiles, and the strict checks still apply.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the generic is the case.
function genericDefaultsFactory<D extends AgentDefaults>(defaults: D) {
  return defineWorkflow({
    ...base,
    name: 'generic-defaults',
    strictProfiles: true,
    defaults,
    async run(ctx) {
      await ctx.claude.text('t', { prompt });
      // @ts-expect-error -- tools stay role-owned under strict profiles.
      await ctx.claude.text('t', { prompt, tools: ['Read'] });
      // @ts-expect-error -- strict: addDirs belongs to a roster entry.
      await ctx.claude.text('t', { prompt, addDirs });
      return null;
    },
  });
}
// Excess-property checks still reject unknown keys in inline literals next to generic values.

function genericFactoryTypos<D extends AgentDefaults>(defaults: D) {
  const withDefaults = defineWorkflow({
    ...base,
    name: 'generic-defaults-typos',
    defaults,
    // @ts-expect-error -- the removed profiles field (#726) is still an excess property here.
    profiles: { plain: { claude: { tools: ['Read'] } } },
    run: () => Promise.resolve(null),
  });
  const inline = defineWorkflow({
    ...base,
    name: 'generic-inline-typos',
    // @ts-expect-error -- the edit object matches neither env shape.
    defaults: { claude: { env: { unest: ['BAZ'] } } },
    run: () => Promise.resolve(null),
  });
  return [withDefaults, inline, defaults];
}

it('infers literal and generic defaults through one defineWorkflow signature', () => {
  // TRoster is WorkflowDefinition's seventh parameter (#707, #726).
  expectTypeOf(constDefaults).toEqualTypeOf<
    WorkflowDefinition<null, null, readonly [], true, readonly [], 'const-defaults', EmptyRoster>
  >();
  expectTypeOf(genericDefaultsFactory({})).toEqualTypeOf<
    WorkflowDefinition<null, null, readonly [], true, readonly [], 'generic-defaults', EmptyRoster>
  >();
  expect(genericFactoryTypos({})).toHaveLength(3);
});
