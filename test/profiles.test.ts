import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  capabilityManifest,
  defineWorkflow,
  HarnessError,
  readRun,
  runWorkflow,
  z,
  type AgentProfile,
  type Harness,
  type ProfileOverride,
} from '../src/index.js';
import { parseProfileOverride } from '../src/workflow/runtime/profiles.js';
import { parseClaude } from '../src/harnesses/protocol.js';

let stateDir: string;
const reply = {
  text: 'ok',
  sessionId: 'session',
  usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.31 },
};
const base = { name: 'profiles', version: '1', input: z.null(), output: z.string() };
const setup = () => ({ stateDir, runId: 'profiles', input: null });
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-profiles-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

it('publishes presets and default access without evaluating the body', () => {
  const run = vi.fn(() => Promise.resolve('done'));
  const definition = defineWorkflow({ ...base, run });
  const manifest = capabilityManifest(definition);
  expect(run).not.toHaveBeenCalled();
  expect(manifest).toMatchObject({
    strictProfiles: true,
    defaultProfile: 'text',
    requiredGrants: [],
  });
  expect(manifest.defaults).toMatchObject({
    maxTurns: 10,
    maxBudgetUsd: 0.5,
    timeoutMs: 300_000,
    access: 'read',
    claudeAccess: 'none',
    codexAccess: 'read',
    claude: { tools: [], allowedTools: [] },
    codex: { sandbox: 'read-only' },
  });
  expect(manifest.profiles['readonly']).toMatchObject({
    maxTurns: 25,
    maxBudgetUsd: 2,
    timeoutMs: 900_000,
    claude: { tools: ['Read', 'Grep', 'Glob'], allowedTools: ['Read', 'Grep', 'Glob'] },
  });
  expect(manifest.profiles['edit']).toMatchObject({
    maxTurns: 40,
    maxBudgetUsd: 5,
    timeoutMs: 1_800_000,
    access: 'write',
  });
});

it('merges preset, defaults, ancestors, role, call, named launch rules, and step policy in order', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    defaults: {
      profile: 'scout',
      maxTurns: 11,
      maxBudgetUsd: 0.8,
      claude: { model: 'sonnet' },
      codex: { reasoningEffort: 'medium' },
    },
    profiles: {
      ancestor: { extends: 'readonly', maxTurns: 20, codex: { reasoningEffort: 'high' } },
      scout: { extends: 'ancestor', maxTurns: 30, description: 'Reads source' },
    },
    async run(ctx) {
      await ctx.claude.text('read', { prompt: 'x', maxTurns: 40, maxBudgetUsd: 3 });
      await ctx.codex.text('cross', { profile: 'scout', prompt: 'y' });
      return 'ok';
    },
  });
  const run = await runWorkflow(definition, {
    ...setup(),
    harness: { invoke },
    profileOverrides: [
      { profile: '*', maxTurns: 50, timeoutMs: 6000 },
      { profile: 'scout', maxTurns: 60 },
    ],
    policy: [{ match: 'read', maxBudgetUsd: 4 }],
  });
  expect(invoke.mock.calls[0]?.[0].options).toEqual({
    prompt: 'x',
    model: 'sonnet',
    tools: ['Read', 'Grep', 'Glob'],
    allowedTools: ['Read', 'Grep', 'Glob'],
    maxTurns: 60,
    maxBudgetUsd: 4,
    timeoutMs: 6000,
  });
  expect(invoke.mock.calls[1]?.[0].options).toMatchObject({
    sandbox: 'read-only',
    reasoningEffort: 'high',
    timeoutMs: 6000,
  });
  expect(invoke.mock.calls[1]?.[0].options).not.toHaveProperty('maxTurns');
  expect(run.steps['read']?.attemptHistory?.[0]).toMatchObject({
    profile: 'scout',
    requestedModel: 'sonnet',
    sources: {
      maxTurns: 'profile-override:1',
      maxBudgetUsd: 'override:0',
      timeoutMs: 'profile-override:0',
      model: 'profile:scout',
    },
  });
  expect(run.steps['cross']?.attemptHistory?.[0]).toMatchObject({
    reasoningEffort: 'high',
    sources: { reasoningEffort: 'profile:scout' },
  });
});

it('infers permissions from the final exposure list and permits narrower rules', () => {
  const manifest = capabilityManifest({
    profiles: {
      parent: { extends: 'readonly', claude: { allowedTools: ['Read'] } },
      fixer: {
        extends: 'parent',
        access: 'exec',
        claude: {
          tools: ['Read', 'Edit', 'Bash'],
          allowedTools: ['Read', 'Edit', 'Bash(npm test:*)'],
        },
      },
      writer: { extends: 'parent', claude: { tools: ['Write'] } },
      custom: { claude: { tools: ['mcp__fixture__update'] } },
    },
  });
  expect(manifest.profiles['fixer']?.access).toBe('exec');
  expect(manifest.profiles['writer']).toMatchObject({
    access: 'write',
    claude: { allowedTools: ['Write'] },
  });
  expect(manifest.profiles['custom']?.access).toBe('exec');
  expect(manifest.requiredGrants).toEqual(['custom', 'fixer', 'writer']);
});

it.each([
  { profiles: { bad: { extends: 'absent' } } },
  { profiles: { a: { extends: 'b' }, b: { extends: 'a' } } },
  { profiles: { readonly: {} } },
  { profiles: { write: {} } },
  { profiles: { bad: { access: 'read', claude: { tools: ['Edit'] } } } },
  { profiles: { bad: { access: 'none' } } },
  { profiles: { bad: { claude: { tools: ['Read'], allowedTools: ['Write'] } } } },
  { profiles: { bad: { claude: { tools: ['Bash(npm test:*)'] } } } },
  { defaults: { profile: 'absent' } },
  { defaults: { idleTimeoutMs: 100 } },
  { strictProfiles: 'true' },
])('rejects invalid profile declarations before the body: %j', (config) => {
  expect(() => capabilityManifest(config as Parameters<typeof capabilityManifest>[0])).toThrow();
});

it.each(['fixer', 'write', 'exec', 'all'])(
  'enforces launch grants and saves %s for resume',
  async (grant) => {
    let stop = true;
    const body = vi.fn();
    const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
    const definition = defineWorkflow({
      ...base,
      profiles: { fixer: { extends: 'edit' } },
      async run(ctx) {
        body();
        await ctx.codex.text('fix', { prompt: 'x', profile: 'fixer' });
        if (stop) throw new Error('pause');
        return 'ok';
      },
    });
    await expect(runWorkflow(definition, { ...setup(), harness: { invoke } })).rejects.toThrow(
      '--grant fixer, --grant write, or --grant all',
    );
    expect(body).not.toHaveBeenCalled();
    await expect(
      runWorkflow(definition, { ...setup(), harness: { invoke }, grants: [grant] }),
    ).rejects.toThrow('pause');
    stop = false;
    const result = await runWorkflow(definition, { ...setup(), harness: { invoke }, resume: true });
    expect(result.grants).toEqual([grant]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((await readRun(setup())).capabilities?.requiredGrants).toEqual(['fixer']);
  },
);

it('pins named grants to capabilities across explicit source acceptance', async () => {
  const profiles: Record<string, AgentProfile> = { fixer: { extends: 'edit' } };
  const body = vi.fn(() => Promise.resolve('ok'));
  const definition = defineWorkflow({ ...base, profiles, run: body });
  await runWorkflow(definition, { ...setup(), grants: ['fixer'] });
  profiles['fixer'] = { extends: 'edit', claude: { tools: ['Bash'] } };
  await expect(
    runWorkflow(definition, { ...setup(), resume: true, acceptCodeChange: true }),
  ).rejects.toThrow('requires exec access');
  expect(body).toHaveBeenCalledTimes(1);
  await runWorkflow(definition, {
    ...setup(),
    resume: true,
    acceptCodeChange: true,
    grants: ['fixer'],
  });
  expect(body).toHaveBeenCalledTimes(2);
});

it('checks elevated built-ins at invocation and does not treat write as exec permission', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return (await ctx.claude.text('edit', { prompt: 'x', profile: 'edit' })).output;
    },
  });
  await expect(runWorkflow(definition, { ...setup(), harness: { invoke } })).rejects.toThrow(
    '--grant edit',
  );
  expect(invoke).not.toHaveBeenCalled();
  await runWorkflow(definition, {
    ...setup(),
    harness: { invoke },
    resume: true,
    grants: ['edit'],
  });
  const exec = defineWorkflow({
    ...base,
    profiles: { runner: { claude: { tools: ['Bash'] } } },
    run: () => Promise.resolve('ok'),
  });
  await expect(runWorkflow(exec, { ...setup(), runId: 'exec', grants: ['write'] })).rejects.toThrow(
    'requires exec access',
  );
});

it('rejects raw capabilities by default; escape-hatch calls still require class grants', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return (await ctx.claude.text('edit', { prompt: 'x', tools: ['Edit'] })).output;
    },
  });
  await expect(
    runWorkflow(definition, { ...setup(), harness: { invoke }, grants: ['all'] }),
  ).rejects.toThrow('strictProfiles forbids call-site tools');
  const legacy = { ...definition, strictProfiles: false };
  await expect(
    runWorkflow(legacy, { ...setup(), resume: true, harness: { invoke }, grants: ['text'] }),
  ).resolves.toMatchObject({ status: 'completed' }); // saved all grant is sticky
  await expect(
    runWorkflow(legacy, { ...setup(), runId: 'raw', harness: { invoke }, grants: ['text'] }),
  ).rejects.toThrow('requires write access');
  await runWorkflow(legacy, {
    ...setup(),
    runId: 'raw',
    resume: true,
    harness: { invoke },
    grants: ['write'],
  });
  expect(invoke.mock.calls.at(-1)?.[0].options).toMatchObject({
    tools: ['Edit'],
    allowedTools: ['Edit'],
  });
});

it('keeps profile names and limits outside identity, persists rules, and detects semantic changes', async () => {
  let name: 'scout' | 'renamed' = 'scout';
  let stop = true;
  const profiles: Record<'scout' | 'renamed', AgentProfile> = {
    scout: { extends: 'readonly' },
    renamed: { extends: 'readonly' },
  };
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    profiles,
    async run(ctx) {
      await ctx.claude.text('saved', { prompt: 'x', profile: name });
      await ctx.claude.text('pending', { prompt: 'y', profile: name });
      if (stop) throw new Error('pause');
      return 'ok';
    },
  });
  invoke.mockResolvedValueOnce(reply).mockRejectedValueOnce(new Error('limit'));
  await expect(runWorkflow(definition, { ...setup(), harness: { invoke } })).rejects.toThrow(
    'limit',
  );
  name = 'renamed';
  const overrides = [{ profile: '*', maxTurns: 60 }];
  await expect(
    runWorkflow(definition, {
      ...setup(),
      resume: true,
      harness: { invoke },
      profileOverrides: overrides,
    }),
  ).rejects.toThrow('pause');
  stop = false;
  const result = await runWorkflow(definition, { ...setup(), resume: true, harness: { invoke } });
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(invoke.mock.calls[2]?.[0].options).toHaveProperty('maxTurns', 60);
  expect(result.profileOverrides).toEqual(overrides);
  expect(result.steps['pending']?.redefinitions).toBeUndefined();
  expect(result.steps['pending']?.attemptHistory?.map((attempt) => attempt.profile)).toEqual([
    'scout',
    'renamed',
  ]);
  profiles.renamed = { extends: 'readonly', claude: { model: 'different' } };
  await expect(
    runWorkflow(definition, {
      ...setup(),
      resume: true,
      acceptCodeChange: true,
      harness: { invoke },
    }),
  ).rejects.toThrow('model changed');
});

it('uses sticky limits for unfinished calls and resets them to profile values', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockRejectedValue(new Error('offline'));
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return (await ctx.claude.text('ask', { prompt: 'x' })).output;
    },
  });
  const options = { ...setup(), harness: { invoke } };
  await expect(
    runWorkflow(definition, { ...options, profileOverrides: [{ profile: 'text', maxTurns: 40 }] }),
  ).rejects.toThrow('offline');
  await expect(runWorkflow(definition, { ...options, resume: true })).rejects.toThrow('offline');
  invoke.mockResolvedValue(reply);
  const result = await runWorkflow(definition, { ...options, resume: true, policyReset: true });
  expect(
    invoke.mock.calls.map(([request]) => (request.options as { maxTurns: number }).maxTurns),
  ).toEqual([40, 40, 10]);
  expect(result.profileOverrides).toEqual([]);
  const updated = await runWorkflow(definition, {
    ...options,
    resume: true,
    profileOverrides: [{ profile: 'text', maxTurns: 50 }],
    grants: ['write'],
  });
  expect(updated.profileOverrides).toHaveLength(1);
  expect(updated.grants).toEqual(['write']);
  expect(invoke).toHaveBeenCalledTimes(3);
});

it.each(['turn-limit', 'budget-limit'] as const)(
  'reports %s with configured cap, role, reported turns/spend and a usable flag',
  async (kind) => {
    const error = new HarnessError({
      provider: 'claude',
      kind,
      exit: { code: 1, signal: null },
      stderr: '',
      stdout: '',
      reason: '',
      failure: {
        reason: 'limit reached',
        subtype: kind,
        terminalReason: null,
        apiStatus: null,
        sessionId: 'failed',
        usage: reply.usage,
        turns: 30,
      },
    });
    const definition = defineWorkflow({
      ...base,
      profiles: { scout: { extends: 'readonly', maxTurns: 30 } },
      async run(ctx) {
        return (await ctx.claude.text('ask', { prompt: 'x', profile: 'scout' })).output;
      },
    });
    await expect(
      runWorkflow(definition, { ...setup(), harness: { invoke: () => Promise.reject(error) } }),
    ).rejects.toThrow(
      `--resume --profile scout.${kind === 'turn-limit' ? 'maxTurns=60' : 'maxBudgetUsd=4'}`,
    );
    const saved = await readRun(setup());
    expect(saved.error).toContain('turns=30; costUsd=0.31');
    expect(saved.steps['ask']?.failedAttempts?.[0]?.usage?.costUsd).toBe(0.31);
    expect(saved.steps['ask']?.attemptHistory?.[0]?.errorKind).toBe(kind);
  },
);

it.each(['warn', 'fail'] as const)(
  'persists permission-denial diagnostics in %s mode',
  async (mode) => {
    const definition = defineWorkflow({
      ...base,
      profiles: { scout: { extends: 'readonly', onPermissionDenied: mode } },
      async run(ctx) {
        const result = await ctx.claude.text('ask', {
          prompt: 'x',
          profile: 'scout',
          onError: 'return',
        });
        return result.ok ? result.value.output : result.error.kind;
      },
    });
    const result = await runWorkflow(definition, {
      ...setup(),
      harness: { invoke: () => Promise.resolve({ ...reply, permissionDenials: 2 }) },
    });
    expect(result.output).toBe(mode === 'warn' ? 'ok' : 'permission');
    expect(result.steps['ask']?.warnings).toEqual([
      'Profile scout: 2 permission denials reported.',
    ]);
    if (mode === 'fail')
      expect(result.steps['ask']?.failedAttempts?.[0]?.usage?.costUsd).toBe(0.31);
  },
);

it('extracts counts without persisting permission-denial payloads or fabricating tool use', () => {
  const metadata = {
    type: 'result',
    subtype: 'success',
    result: 'ok',
    num_turns: 5,
    permission_denials: [{ tool_name: 'Read', tool_input: { secret: 'private path' } }],
    total_cost_usd: 0.1,
  };
  const outcome = parseClaude(JSON.stringify(metadata), false);
  expect(outcome).toMatchObject({ kind: 'success', response: { turns: 5, permissionDenials: 1 } });
  expect(JSON.stringify(outcome)).not.toContain('private path');
  expect(
    parseClaude(JSON.stringify({ ...metadata, subtype: 'error_max_turns', is_error: true }), false),
  ).toMatchObject({ kind: 'failure', failure: { turns: 5, permissionDenials: 1 } });
});

it('validates CLI numeric policy syntax and runtime profile/grant names', async () => {
  expect(parseProfileOverride('*.timeoutMs=1800000')).toEqual({
    profile: '*',
    timeoutMs: 1_800_000,
  });
  expect(parseProfileOverride('scout.maxBudgetUsd=0.75')).toEqual({
    profile: 'scout',
    maxBudgetUsd: 0.75,
  });
  for (const value of [
    'scout.model=sonnet',
    'scout.maxTurns=0',
    'scout.maxTurns=1.5',
    'scout.timeoutMs=2147483648',
    'scout.idleTimeoutMs=20',
    '*.maxTurns=-2',
    'bad',
  ])
    expect(() => parseProfileOverride(value)).toThrow();
  const run = vi.fn(() => Promise.resolve('ok'));
  const definition = defineWorkflow({ ...base, run });
  await expect(
    runWorkflow(definition, { ...setup(), profileOverrides: [{ profile: 'typo', maxTurns: 2 }] }),
  ).rejects.toThrow('Unknown override profile');
  await expect(
    runWorkflow(definition, {
      ...setup(),
      profileOverrides: [{ profile: '*', model: 'x' } as unknown as ProfileOverride],
    }),
  ).rejects.toThrow();
  await expect(runWorkflow(definition, { ...setup(), grants: ['typo'] })).rejects.toThrow(
    'Unknown grant',
  );
  expect(run).not.toHaveBeenCalled();
});

// Compile-time contract: inference retains declared names through scoped contexts.
defineWorkflow({
  ...base,
  profiles: { scout: { extends: 'readonly' } },
  async run(ctx) {
    await ctx.within('scope').claude.text('ok', { prompt: 'x', profile: 'scout' });
    await ctx.codex.text('builtin', { prompt: 'x', profile: 'readonly' });
    // @ts-expect-error Undeclared profile is not in the inferred name union.
    await ctx.claude.text('typo', { prompt: 'x', profile: 'scuot' });
    return 'ok';
  },
});

it('checks raw Codex sandbox calls, unknown runtime names, and fresh fork grants', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    profiles: { fixer: { extends: 'edit' } },
    async run(ctx) {
      return (await ctx.codex.text('fix', { prompt: 'x', profile: 'fixer' })).output;
    },
  });
  await runWorkflow(definition, { ...setup(), harness: { invoke }, grants: ['fixer'] });
  await expect(
    runWorkflow(definition, {
      ...setup(),
      runId: 'fork',
      harness: { invoke },
      forkFrom: { runId: 'profiles' },
    }),
  ).rejects.toThrow('--grant fixer');
  expect(invoke).toHaveBeenCalledTimes(1);
  const raw = defineWorkflow({
    ...base,
    async run(ctx) {
      return (await ctx.codex.text('raw', { prompt: 'x', sandbox: 'workspace-write' })).output;
    },
  });
  await expect(
    runWorkflow(raw, { ...setup(), runId: 'raw-codex', harness: { invoke }, grants: ['all'] }),
  ).rejects.toThrow('strictProfiles');
  await runWorkflow(
    { ...raw, strictProfiles: false },
    { ...setup(), runId: 'raw-codex', resume: true, harness: { invoke } },
  );
  const unknown = defineWorkflow({
    ...base,
    async run(ctx) {
      return (await ctx.codex.text('bad', { prompt: 'x', profile: 'missing' as 'text' })).output;
    },
  });
  await expect(
    runWorkflow(unknown, { ...setup(), runId: 'unknown', harness: { invoke } }),
  ).rejects.toThrow('Unknown profile: missing');
});

it('preserves adapter error objects and explains a step-policy cap that wins over a profile', async () => {
  const error = new HarnessError({
    provider: 'claude',
    kind: 'turn-limit',
    exit: { code: 1, signal: null },
    failure: null,
    reason: 'cap',
    stderr: '',
    stdout: '',
  });
  const original = error.message;
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return (await ctx.claude.text('ask', { prompt: 'x' })).output;
    },
  });
  await expect(
    runWorkflow(definition, {
      ...setup(),
      harness: { invoke: () => Promise.reject(error) },
      policy: [{ match: 'ask', maxTurns: 3 }],
    }),
  ).rejects.toThrow(`--policy '{"match":"ask","maxTurns":6}'`);
  expect(error.message).toBe(original);
  expect((await readRun(setup())).error).toContain('turns=unknown; costUsd=unknown');
});

it('keeps denial diagnostics on successful envelopes with process failure', async () => {
  const error = new HarnessError({
    provider: 'claude',
    kind: 'process',
    exit: { code: 7, signal: null },
    failure: null,
    reason: 'process failure',
    stderr: '',
    stdout: '',
    permissionDenials: 2,
    turns: 4,
    usage: reply.usage,
  });
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return (await ctx.claude.text('ask', { prompt: 'x' })).output;
    },
  });
  await expect(
    runWorkflow(definition, { ...setup(), harness: { invoke: () => Promise.reject(error) } }),
  ).rejects.toBe(error);
  const saved = await readRun(setup());
  expect(saved.steps['ask']?.warnings).toEqual(['Profile text: 2 permission denials reported.']);
  expect(saved.steps['ask']?.failedAttempts?.[0]?.usage?.costUsd).toBe(0.31);
  expect(parseProfileOverride('text.maxBudgetUsd=1e-7')).toEqual({
    profile: 'text',
    maxBudgetUsd: 1e-7,
  });
});
