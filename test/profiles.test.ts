import { WorkflowRunError } from '../src/index.js';
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
import {
  capabilityManifestSchema,
  parseProfileOverride,
  profileGrantDigest,
  publicCapabilityManifest,
  resolveCapabilities,
} from '../src/workflow/runtime/profiles.js';
import { digest } from '../src/workflow/runtime/json.js';
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
    isolation: 'restricted',
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
    invoke.mock.calls.map(([request]) => (request.options as { maxTurns?: number }).maxTurns),
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
      harness: 'claude',
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

// Compile-time contract: isolation is a per-call placement decision, not a profile property.
defineWorkflow({
  ...base,
  // @ts-expect-error Profile claude/codex options omit isolation; it belongs on the call itself.
  profiles: { r: { claude: { isolation: 'worktree' } } },
  async run(ctx) {
    return (await ctx.claude.text('ok', { prompt: 'x', profile: 'r' })).output;
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
    harness: 'claude',
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
    harness: 'claude',
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
  const failed: unknown = await runWorkflow(definition, {
    ...setup(),
    harness: { invoke: () => Promise.reject(error) },
  }).catch((cause: unknown) => cause);
  expect(failed).toBeInstanceOf(WorkflowRunError);
  if (!(failed instanceof WorkflowRunError)) throw failed;
  expect(failed.cause).toBe(error);
  const saved = await readRun(setup());
  expect(saved.steps['ask']?.warnings).toEqual(['Profile text: 2 permission denials reported.']);
  expect(saved.steps['ask']?.failedAttempts?.[0]?.usage?.costUsd).toBe(0.31);
  expect(parseProfileOverride('text.maxBudgetUsd=1e-7')).toEqual({
    profile: 'text',
    maxBudgetUsd: 1e-7,
  });
});

// Marker values prove that nothing sensitive reaches a public manifest or checkpoint.
const markers = {
  settings: 'marker-settings-theme',
  hook: 'marker-settings-hook',
  mcpCommand: 'marker-mcp-command',
  mcpToken: 'marker-mcp-token',
  agentDescription: 'marker-agent-description',
  agentPrompt: 'marker-agent-prompt',
  systemPrompt: 'marker-system-prompt',
  appendPrompt: 'marker-append-prompt',
  env: 'marker-env-value',
  codex: 'marker-codex-config',
};
const sensitiveProfile = (mcpToken = markers.mcpToken): AgentProfile => ({
  claude: {
    isolation: 'inherit',
    settings: { theme: markers.settings, hooks: { Stop: markers.hook } },
    mcpServers: { tracker: { command: markers.mcpCommand, env: { TOKEN: mcpToken } } },
    agents: {
      reviewer: { description: markers.agentDescription, prompt: markers.agentPrompt },
    },
    systemPrompt: markers.systemPrompt,
    appendSystemPrompt: markers.appendPrompt,
    env: { set: { PRIVATE: markers.env } },
  },
  codex: {
    isolation: 'inherit',
    config: { 'model_providers.x.base_url': markers.codex, model_verbosity: 'low' },
  },
});
const profileP = (manifest: ReturnType<typeof resolveCapabilities>) => {
  const profile = manifest.profiles['p'];
  if (!profile) throw new Error('Missing profile p.');
  return profile;
};
const sensitiveDefinition = (profiles: Record<string, AgentProfile>, fail: () => boolean) =>
  defineWorkflow({
    ...base,
    profiles,
    async run(ctx) {
      await ctx.claude.text('first', { prompt: 'one', profile: 'p' });
      await ctx.claude.text('second', { prompt: 'two', profile: 'p' });
      if (fail()) throw new Error('pause');
      return 'done';
    },
  });
// Captured on main before the redaction change (#103) for sensitiveProfile(); it must never move.
const sensitiveGrantDigest = '629539c408eb9f6d26dce10eda94f73ded2530a730458dbfcfc9047665e2d5f3';

it('reduces free-form controls to names and digests in public manifests only', () => {
  const definition = { profiles: { p: sensitiveProfile() } };
  const live = resolveCapabilities(definition);
  const raw = structuredClone(live);
  const manifest = capabilityManifest(definition);
  const text = JSON.stringify(manifest);
  for (const marker of Object.values(markers)) expect(text).not.toContain(marker);
  const profile = profileP(manifest);
  const liveProfile = profileP(live);
  expect(profile.redacted).toEqual({
    claude: {
      settings: { sha256: digest(liveProfile.claude.settings), keys: ['hooks', 'theme'] },
      mcpServers: { sha256: digest(liveProfile.claude.mcpServers), keys: ['tracker'] },
      agents: { sha256: digest(liveProfile.claude.agents), keys: ['reviewer'] },
      systemPrompt: { sha256: digest(markers.systemPrompt) },
      appendSystemPrompt: { sha256: digest(markers.appendPrompt) },
    },
    codex: {
      config: {
        sha256: digest(liveProfile.codex.config),
        keys: ['model_providers.x.base_url', 'model_verbosity'],
      },
    },
  });
  for (const field of ['settings', 'mcpServers', 'agents', 'systemPrompt', 'appendSystemPrompt'])
    expect(profile.claude).not.toHaveProperty(field);
  expect(profile.codex).not.toHaveProperty('config');
  expect(profile.environment?.claude.set).toEqual(['PRIVATE']);
  expect(profile.claude.isolation).toBe('inherit');
  expect(manifest.defaults).not.toHaveProperty('redacted');
  for (const [name, builtin] of Object.entries(manifest.profiles))
    if (name !== 'p') expect(builtin).not.toHaveProperty('redacted');
  expect(capabilityManifestSchema.parse(manifest)).toEqual(manifest);
  // The live manifest keeps raw values and the projection leaves its input untouched.
  expect(liveProfile.claude.mcpServers).toEqual(sensitiveProfile().claude?.mcpServers);
  expect(liveProfile.codex.config).toEqual(sensitiveProfile().codex?.config);
  expect(live).toEqual(raw);
  expect(publicCapabilityManifest(live)).toEqual(manifest);
  expect(publicCapabilityManifest(manifest)).toEqual(manifest);
});

it('keeps grant digests of the live profile stable across redaction', () => {
  const live = resolveCapabilities({ profiles: { p: sensitiveProfile() } });
  expect(profileGrantDigest(profileP(live))).toBe(sensitiveGrantDigest);
  const changed = resolveCapabilities({ profiles: { p: sensitiveProfile('other-token') } });
  expect(profileGrantDigest(profileP(changed))).not.toBe(sensitiveGrantDigest);
});

it('checkpoints redacted manifests, runs with raw controls and detects a redacted-only change on resume', async () => {
  let stop = true;
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = sensitiveDefinition({ p: sensitiveProfile() }, () => stop);
  const options = { ...setup(), harness: { invoke }, grants: ['p'] };
  await expect(runWorkflow(definition, options)).rejects.toThrow('pause');
  const saved = await readRun(setup());
  const text = JSON.stringify(saved);
  for (const marker of Object.values(markers)) expect(text).not.toContain(marker);
  expect(saved.capabilities?.profiles['p']?.redacted?.claude?.mcpServers?.keys).toEqual([
    'tracker',
  ]);
  expect(saved.grantedProfiles?.['p']).toBe(sensitiveGrantDigest);
  expect(invoke.mock.calls[0]?.[0].options).toMatchObject({
    settings: { theme: markers.settings },
    mcpServers: { tracker: { env: { TOKEN: markers.mcpToken } } },
    systemPrompt: markers.systemPrompt,
    env: { set: { PRIVATE: markers.env } },
  });
  // Unchanged resume replays both steps and finishes without a new invocation.
  stop = false;
  await expect(runWorkflow(definition, { ...options, resume: true })).resolves.toMatchObject({
    status: 'completed',
  });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('refuses a resume whose only change is a redacted value', async () => {
  const profiles = { p: sensitiveProfile() };
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = sensitiveDefinition(profiles, () => true);
  const options = { ...setup(), harness: { invoke }, grants: ['p'] };
  await expect(runWorkflow(definition, options)).rejects.toThrow('pause');
  profiles.p = sensitiveProfile('rotated-token');
  // A completed step that ran under the profile is detected by identity, even with a named grant.
  await expect(runWorkflow(definition, { ...options, resume: true })).rejects.toThrow(
    'option.mcpServers changed on a completed step',
  );
  await expect(
    runWorkflow(definition, { ...options, resume: true, grants: ['all'] }),
  ).rejects.toThrow('option.mcpServers changed on a completed step');
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('refuses a named grant for a pending step whose profile changed only in a redacted value', async () => {
  const profiles = { p: sensitiveProfile() };
  const invoke = vi.fn<Harness['invoke']>().mockRejectedValue(new Error('offline'));
  const definition = defineWorkflow({
    ...base,
    profiles,
    async run(ctx) {
      return (await ctx.claude.text('pending', { prompt: 'x', profile: 'p' })).output;
    },
  });
  const options = { ...setup(), harness: { invoke }, grants: ['p'] };
  await expect(runWorkflow(definition, options)).rejects.toThrow('offline');
  expect((await readRun(setup())).grantedProfiles?.['p']).toBe(sensitiveGrantDigest);
  profiles.p = sensitiveProfile('rotated-token');
  // The saved named grant keeps its old pin; passing --grant p again would re-pin the new value.
  await expect(
    runWorkflow(definition, { ...setup(), harness: { invoke }, resume: true }),
  ).rejects.toThrow('Retry with --grant p');
  expect(invoke).toHaveBeenCalledTimes(1);
  invoke.mockResolvedValue(reply);
  await expect(
    runWorkflow(definition, { ...options, resume: true, grants: ['all'] }),
  ).resolves.toMatchObject({ status: 'completed' });
});
