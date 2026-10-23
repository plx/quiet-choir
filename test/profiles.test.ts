import { ConfigurationError, WorkflowRunError } from '../src/index.js';
import { GrantRequiredError } from '../src/workflow/runtime/configuration-error.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  capabilityManifest,
  claudeCapabilityKeys,
  codexCapabilityKeys,
  defineHarness,
  defineWorkflow,
  FileRunStore,
  HarnessError,
  readRun,
  runWorkflow,
  z,
  type AgentProfile,
  type Harness,
  type HarnessAdapter,
  type OwnedRunStore,
  type ProfileOverride,
  type RunStore,
} from '../src/index.js';
import {
  capabilityManifestSchema,
  parseProfileOverride,
  profileGrantDigest,
  publicCapabilityManifest,
  resolveCapabilities,
  resolveProfileCall,
} from '../src/workflow/runtime/profiles.js';
import { claudeDefinition, codexDefinition } from '../src/harnesses/builtins/definitions.js';
import { digest } from '../src/workflow/runtime/json.js';
import { parseClaude } from '../src/harnesses/protocol.js';
import { runNextCommands } from '../src/workflow/loader/next-commands.js';

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
    strictProfiles: false,
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
  // Access classes stay as labels; requiredGrants lists elevated roles only under requireGrants.
  const declared = {
    ...base,
    profiles: { fixer: { extends: 'edit' }, scout: { extends: 'readonly' } },
    run,
  } as const;
  const labels = capabilityManifest(defineWorkflow(declared));
  expect(labels.requiredGrants).toEqual([]);
  expect(labels.profiles['fixer']).toMatchObject({
    access: 'write',
    claudeAccess: 'write',
    codexAccess: 'write',
  });
  const opted = capabilityManifest(defineWorkflow({ ...declared, requireGrants: true }));
  expect(opted.requiredGrants).toEqual(['fixer']);
  expect({ ...opted, requiredGrants: [] }).toEqual(labels);
  expect(
    capabilityManifest(defineWorkflow(declared), { requireGrants: true }).requiredGrants,
  ).toEqual(['fixer']);
  expect(capabilityManifest({ strictProfiles: true }).strictProfiles).toBe(true);
  expect(run).not.toHaveBeenCalled();
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
      codex: { effort: 'medium' },
    },
    profiles: {
      ancestor: { extends: 'readonly', maxTurns: 20, codex: { effort: 'high' } },
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
    effort: 'high',
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
    effort: 'high',
    sources: { effort: 'profile:scout' },
  });
});

it('infers permissions from the final exposure list and permits narrower rules', () => {
  const manifest = capabilityManifest({
    requireGrants: true,
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
  { defaults: { idleTimeoutMs: 0 } },
  { profiles: { bad: { idleTimeoutMs: 2_147_483_648 } } },
  { strictProfiles: 'true' },
])('rejects invalid profile declarations before the body: %j', (config) => {
  expect(() => capabilityManifest(config as Parameters<typeof capabilityManifest>[0])).toThrow();
});

it('accepts idleTimeoutMs as a profile limit on defaults, profiles and overrides', () => {
  const manifest = capabilityManifest({
    defaults: { idleTimeoutMs: 100 },
    profiles: { scout: { extends: 'readonly', idleTimeoutMs: 250 } },
  });
  expect(manifest.defaults.idleTimeoutMs).toBe(100);
  expect(manifest.profiles['readonly']?.idleTimeoutMs).toBe(100);
  expect(manifest.profiles['scout']?.idleTimeoutMs).toBe(250);
  expect(capabilityManifest({}).defaults.idleTimeoutMs).toBeUndefined();
});

it('defaults expectsToolUse to roles that grant more than the text baseline', () => {
  const manifest = capabilityManifest({
    profiles: {
      writer: { codex: { sandbox: 'workspace-write' } },
      reader: { codex: { sandbox: 'read-only' } },
      quiet: { extends: 'readonly', expectsToolUse: false },
      eager: { expectsToolUse: true },
    },
  });
  const expects = (name: string) => manifest.profiles[name]?.expectsToolUse;
  expect(expects('text')).toBe(false);
  expect(expects('readonly')).toBe(true);
  expect(expects('edit')).toBe(true);
  expect(expects('writer')).toBe(true);
  expect(expects('reader')).toBe(false);
  expect(expects('quiet')).toBe(false);
  expect(expects('eager')).toBe(true);
});

it('rejects idleTimeoutMs inside a registered harness profile block', () => {
  const tool = defineHarness({
    name: 'tool',
    revision: 1,
    options: z.object({ prompt: z.string() }),
    capabilities: { structuredOutput: 'none' },
    access: () => 'none',
  });
  expect(() =>
    capabilityManifest({
      harnesses: [tool],
      profiles: { worker: { harnesses: { tool: { idleTimeoutMs: 100 } } } },
    }),
  ).toThrow('cannot set harness tool.idleTimeoutMs');
});

it.each(['fixer', 'write', 'exec', 'all'])(
  'enforces launch grants and saves %s for resume',
  async (grant) => {
    let stop = true;
    const body = vi.fn();
    const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
    const definition = defineWorkflow({
      ...base,
      requireGrants: true,
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

it('advises a grant, not a code change, for a grant failure and names the agent harness', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    requireGrants: true,
    async run(ctx) {
      await ctx.step('prepare', { input: null, schema: z.string(), run: () => 'ready' });
      return (await ctx.claude.text('edit', { prompt: 'x', profile: 'edit' })).output;
    },
  });
  const error: unknown = await runWorkflow(definition, { ...setup(), harness: { invoke } }).catch(
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(WorkflowRunError);
  const failure = error as WorkflowRunError;
  expect(failure.message).toMatch(/^Step edit \(claude\) failed:/u);
  expect(failure.message).toContain('--grant edit');
  expect(failure.message).not.toContain('accept-code-change');
  let grant: unknown = failure;
  while (grant instanceof Error && !(grant instanceof GrantRequiredError)) grant = grant.cause;
  expect(grant).toBeInstanceOf(GrantRequiredError);
  expect(grant).toBeInstanceOf(ConfigurationError);
  expect(grant).toMatchObject({ profile: 'edit', access: 'write' });
  const saved = await readRun(setup());
  expect(saved.steps['edit']).toBeUndefined();
  // Refused before any attempt, so the root cause names a configuration kind (#311).
  expect(saved.rootCause).toMatchObject({
    stepId: 'edit',
    effect: 'claude',
    errorKind: 'configuration',
  });
  expect(saved.recoveryHint).toContain('--resume --grant edit');
  expect(saved.recoveryHint).not.toContain('accept-code-change');
  expect(saved.recoveryCause).toEqual({ kind: 'grant', profile: 'edit', access: 'write' });
  expect(invoke).not.toHaveBeenCalled();
});

it('saves no recovery hint for a grant failure on the first effect', async () => {
  const definition = defineWorkflow({
    ...base,
    requireGrants: true,
    async run(ctx) {
      return (await ctx.claude.text('edit', { prompt: 'x', profile: 'edit' })).output;
    },
  });
  const error: unknown = await runWorkflow(definition, {
    ...setup(),
    harness: { invoke: vi.fn<Harness['invoke']>().mockResolvedValue(reply) },
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(WorkflowRunError);
  // The message itself still carries the grant advice; there is nothing recorded to resume.
  expect((error as Error).message).toMatch(/^Step edit \(claude\) failed:.*--grant edit/u);
  expect((error as Error).message).not.toContain('(unknown)');
  const saved = await readRun(setup());
  expect(saved.recoveryHint).toBeUndefined();
  // The cause is saved even without a hint; a run that recorded nothing gets no next entry.
  expect(saved.recoveryCause).toEqual({ kind: 'grant', profile: 'edit', access: 'write' });
});

it('advises an access-class grant when call-site capability overrides ignore profile grants', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    requireGrants: true,
    strictProfiles: false,
    async run(ctx) {
      await ctx.step('prepare', { input: null, schema: z.string(), run: () => 'ready' });
      return (await ctx.claude.text('edit', { prompt: 'x', tools: ['Edit'] })).output;
    },
  });
  const error: unknown = await runWorkflow(definition, { ...setup(), harness: { invoke } }).catch(
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(WorkflowRunError);
  expect((error as Error).message).toContain('Retry with --grant write or --grant all.');
  expect((error as Error).message).not.toContain('--grant text');
  const saved = await readRun(setup());
  expect(saved.recoveryCause).toEqual({
    kind: 'grant',
    profile: 'text',
    access: 'write',
    classOnly: true,
  });
  expect(saved.recoveryHint).toContain('--resume --grant write (or --grant all)');
  expect(saved.recoveryHint).not.toContain('--grant text');
  // An embedded run stores no entrypoint, so give it one to see the CLI's next entry.
  const launch = { entrypoint: join(stateDir, 'w.mts'), tsconfig: null };
  const [entry, ...rest] = runNextCommands({ ...saved, launch }, 'failed', stateDir);
  expect(rest).toEqual([]);
  expect(entry?.argv.slice(-2)).toEqual(['--grant', 'write']);
  // A grant of the profile repeats the failure; the emitted access-class grant completes the run.
  await expect(
    runWorkflow(definition, { ...setup(), resume: true, harness: { invoke }, grants: ['text'] }),
  ).rejects.toThrow('Retry with --grant write or --grant all.');
  await expect(
    runWorkflow(definition, { ...setup(), resume: true, harness: { invoke }, grants: ['write'] }),
  ).resolves.toMatchObject({ status: 'completed' });
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('pins named grants to capabilities across explicit source acceptance', async () => {
  const profiles: Record<string, AgentProfile> = { fixer: { extends: 'edit' } };
  const body = vi.fn(() => Promise.resolve('ok'));
  const definition = defineWorkflow({ ...base, requireGrants: true, profiles, run: body });
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
  // Once on the accepted-replay preflight's disposable copy and once for real (#215).
  expect(body).toHaveBeenCalledTimes(3);
});

it('checks elevated built-ins at invocation and does not treat write as exec permission', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    requireGrants: true,
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
    requireGrants: true,
    profiles: { runner: { claude: { tools: ['Bash'] } } },
    run: () => Promise.resolve('ok'),
  });
  await expect(runWorkflow(exec, { ...setup(), runId: 'exec', grants: ['write'] })).rejects.toThrow(
    'requires exec access',
  );
});

it.each([
  ['claude', claudeDefinition.capabilityKeys, claudeCapabilityKeys],
  ['codex', codexDefinition.capabilityKeys, codexCapabilityKeys],
] as const)(
  'rejects every shared %s capability key at strict call sites, and only those',
  (harness, declared, shared) => {
    // One list drives the definition, the runtime check and the call-site types.
    expect(declared).toBe(shared);
    const manifest = capabilityManifest(
      defineWorkflow({ ...base, strictProfiles: true, run: () => Promise.resolve('') }),
    );
    const call = (options: Record<string, unknown>) => () =>
      resolveProfileCall(manifest, harness, { prompt: 'x', ...options }, [], {}, true);
    for (const key of shared) {
      // The strict check reads only the key's presence; isolation is raw only when inherited.
      const value = key === 'isolation' ? 'inherit' : [];
      expect(call({ [key]: value }), key).toThrow(`strictProfiles forbids call-site ${key};`);
    }
    expect(call({ isolation: 'restricted', model: 'm', effort: 'low' })).not.toThrow();
  },
);

it('rejects raw capabilities under strictProfiles; escape-hatch calls still require class grants', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    strictProfiles: true,
    requireGrants: true,
    async run(ctx) {
      // @ts-expect-error -- strictProfiles omits tools at type level too; the runtime still rejects it.
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
  expect(parseProfileOverride('scout.idleTimeoutMs=20')).toEqual({
    profile: 'scout',
    idleTimeoutMs: 20,
  });
  for (const value of [
    'scout.model=sonnet',
    'scout.maxTurns=0',
    'scout.maxTurns=1.5',
    'scout.timeoutMs=2147483648',
    'scout.idleTimeoutMs=0',
    'scout.idleTimeoutMs=2147483648',
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

// Compile-time contract: checkout placement is a per-call decision, not a profile property, and
// profile isolation is only the configuration mode (the legacy worktree shorthand is rejected).
const profileRun = () => Promise.resolve('ok');
defineWorkflow({
  ...base,
  // @ts-expect-error Profile isolation is only the configuration mode.
  profiles: { r: { claude: { isolation: 'worktree' } } },
  run: profileRun,
});
defineWorkflow({
  ...base,
  // @ts-expect-error Profiles never select a checkout.
  profiles: { r: { claude: { worktree: true } } },
  run: profileRun,
});
defineWorkflow({
  ...base,
  // @ts-expect-error Profiles never select a checkout, with a base either.
  profiles: { r: { codex: { worktree: { base: 'main' } } } },
  run: profileRun,
});

it('checks raw Codex sandbox calls, unknown runtime names, and fresh fork grants', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    requireGrants: true,
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
    strictProfiles: true,
    async run(ctx) {
      // @ts-expect-error -- strictProfiles omits sandbox at type level too; the runtime still rejects it.
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
  expect(publicCapabilityManifest(live, [])).toEqual(manifest);
  // A second pass changes nothing; registered env digests are covered with their own harness (#248).
  expect(publicCapabilityManifest(manifest, [])).toEqual(manifest);
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
    requireGrants: true,
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

const role = (manifest: ReturnType<typeof resolveCapabilities>, name: string) => {
  const profile = manifest.profiles[name];
  if (!profile) throw new Error(`missing profile ${name}`);
  return profile;
};

// Registered harness sensitiveOptions (#247): headers is sensitive and a capability key, token is
// sensitive only, and region is neither.
const vaultMarkers = {
  header: 'marker-vault-header',
  trace: 'marker-vault-trace',
  token: 'marker-vault-token',
};
const vault = defineHarness({
  name: 'vault',
  revision: 1,
  options: z.object({
    prompt: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    token: z.string().optional(),
    region: z.string().optional(),
  }),
  capabilities: { structuredOutput: 'none' },
  capabilityKeys: ['headers'],
  sensitiveOptions: ['headers', 'token'],
  access: (options) => (options.headers ? 'write' : 'none'),
});
const vaultHeaders = (header = vaultMarkers.header) => ({
  Authorization: header,
  'X-Trace': vaultMarkers.trace,
});
const vaultProfile = (header?: string, token = vaultMarkers.token): AgentProfile => ({
  harnesses: { vault: { headers: vaultHeaders(header), token, region: 'eu-west' } },
});
// Captured on main b707169 before #247 for vaultProfile() under the same registration without
// sensitiveOptions (access 'write'), and with the header rotated to 'other'; neither may move.
const vaultGrantDigest = '74877c78d0261e0b6c35d6c480438597cbb275344cfd02977477d655622d9613';
const rotatedVaultGrantDigest = '53f34a784c3da809af2498cc76cc878ae9beebda6d01f033a2d44eaf37ec1999';
const vaultDefinition = (profiles: Record<string, AgentProfile>, fail: () => boolean) =>
  defineWorkflow({
    ...base,
    harnesses: [vault],
    profiles,
    async run(ctx) {
      await ctx.agent('vault').text('first', { prompt: 'one', profile: 'p' });
      await ctx.agent('vault').text('second', { prompt: 'two', profile: 'p' });
      if (fail()) throw new Error('pause');
      return 'done';
    },
  });

it('moves declared sensitive harness options to redacted digests in public manifests only', () => {
  const definition = {
    harnesses: [vault],
    profiles: { p: vaultProfile(), child: { extends: 'p' } },
  };
  const live = resolveCapabilities(definition);
  const raw = structuredClone(live);
  const manifest = capabilityManifest(definition);
  const text = JSON.stringify(manifest);
  for (const marker of Object.values(vaultMarkers)) expect(text).not.toContain(marker);
  for (const name of ['p', 'child']) {
    const profile = role(manifest, name);
    expect(profile.redacted).toEqual({
      harnesses: {
        vault: {
          headers: { sha256: digest(vaultHeaders()), keys: ['Authorization', 'X-Trace'] },
          token: { sha256: digest(vaultMarkers.token) },
        },
      },
    });
    // The non-sensitive option stays in plaintext; the capability copy loses the sensitive key.
    expect(profile.harnesses?.['vault']).toEqual({ region: 'eu-west' });
    expect(profile.harnessCapabilities?.['vault']).toEqual({});
  }
  expect(manifest.defaults).not.toHaveProperty('redacted');
  for (const [name, profile] of Object.entries(manifest.profiles))
    if (name !== 'p' && name !== 'child') expect(profile).not.toHaveProperty('redacted');
  expect(capabilityManifestSchema.parse(manifest)).toEqual(manifest);
  // The live manifest keeps raw values for execution, grants and identity, and is not mutated.
  expect(live).toEqual(raw);
  expect(role(live, 'p').harnessCapabilities?.['vault']).toEqual({ headers: vaultHeaders() });
  expect(role(live, 'p').harnesses?.['vault']).toMatchObject({ token: vaultMarkers.token });
  expect(publicCapabilityManifest(live, [vault])).toEqual(manifest);
  // A second pass changes nothing; registered env digests are covered separately (#248).
  expect(publicCapabilityManifest(manifest, [vault])).toEqual(manifest);
  // Without the declarations, the projection leaves registered options alone.
  expect(publicCapabilityManifest(live, undefined).profiles['p']?.harnesses?.['vault']).toEqual(
    role(live, 'p').harnesses?.['vault'],
  );
});

// Registered harness env (#248): env is a capability key and the only free-form option digested
// outside `redacted`; secret is a declared sensitive option so one manifest mixes both paths.
const envMarkers = { env: 'marker-env-harness-value', secret: 'marker-env-harness-secret' };
const envHarness = defineHarness({
  name: 'envh',
  revision: 1,
  options: z.object({
    prompt: z.string(),
    env: z.record(z.string(), z.string()).optional(),
    secret: z.string().optional(),
  }),
  capabilities: { structuredOutput: 'none' },
  capabilityKeys: ['env', 'secret'],
  sensitiveOptions: ['secret'],
  access: () => 'none',
});
const envProfile = (env: Record<string, string> = { TOKEN: envMarkers.env }): AgentProfile => ({
  ...sensitiveProfile(),
  harnesses: { envh: { env, secret: envMarkers.secret } },
});

describe('registered harness env digest (#248)', () => {
  const definition = { harnesses: [envHarness], profiles: { p: envProfile() } };

  it('digests env once in harnessCapabilities and drops the raw copy', () => {
    const live = resolveCapabilities(definition);
    expect(role(live, 'p').harnessCapabilities?.['envh']).toMatchObject({
      env: { TOKEN: envMarkers.env },
    });
    const manifest = capabilityManifest(definition);
    const profile = role(manifest, 'p');
    expect(profile.harnessCapabilities?.['envh']).toEqual({
      env: { sha256: digest({ TOKEN: envMarkers.env }) },
    });
    expect(profile.harnesses?.['envh']).not.toHaveProperty('env');
    const text = JSON.stringify(manifest);
    for (const marker of Object.values(envMarkers)) expect(text).not.toContain(marker);
    expect(capabilityManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('is idempotent with built-in controls, declared sensitive options and registered env', () => {
    const live = resolveCapabilities(definition);
    const raw = structuredClone(live);
    for (const declarations of [[envHarness], undefined]) {
      const once = publicCapabilityManifest(live, declarations);
      expect(publicCapabilityManifest(once, declarations)).toEqual(once);
      expect(
        publicCapabilityManifest(publicCapabilityManifest(once, declarations), declarations),
      ).toEqual(once);
      expect(capabilityManifestSchema.parse(once)).toEqual(once);
      expect(role(once, 'p').harnessCapabilities?.['envh']?.['env']).toEqual({
        sha256: digest({ TOKEN: envMarkers.env }),
      });
    }
    // Built-in redactions and the declared sensitive option are in the same manifest.
    const once = publicCapabilityManifest(live, [envHarness]);
    expect(role(once, 'p').redacted?.claude?.settings).toBeDefined();
    expect(role(once, 'p').redacted?.harnesses?.['envh']?.['secret']).toEqual({
      sha256: digest(envMarkers.secret),
    });
    expect(live).toEqual(raw);
  });

  it('digests a live env shaped like a digest and then leaves the digest alone', () => {
    const lookalike = { sha256: 'a'.repeat(64) };
    const live = resolveCapabilities({
      harnesses: [envHarness],
      profiles: { p: envProfile(lookalike) },
    });
    expect(role(live, 'p').harnessCapabilities?.['envh']?.['env']).toEqual(lookalike);
    const once = publicCapabilityManifest(live, [envHarness]);
    const expected = { sha256: digest(lookalike) };
    expect(role(once, 'p').harnessCapabilities?.['envh']?.['env']).toEqual(expected);
    expect(publicCapabilityManifest(once, [envHarness])).toEqual(once);
    expect(publicCapabilityManifest(once, undefined)).toEqual(once);
  });

  it('still digests a public-looking env that is not a digest', () => {
    const once = publicCapabilityManifest(resolveCapabilities(definition), [envHarness]);
    const bogus = { sha256: 'short', extra: 'marker-forged' };
    const forged = {
      ...once,
      profiles: {
        ...once.profiles,
        p: { ...role(once, 'p'), harnessCapabilities: { envh: { env: bogus } } },
      },
    };
    expect(
      role(publicCapabilityManifest(forged, [envHarness]), 'p').harnessCapabilities?.['envh'],
    ).toEqual({ env: { sha256: digest(bogus) } });
  });
});

it('gives sensitive array options a digest only and leaves undeclared profiles unredacted', () => {
  const lister = defineHarness({
    name: 'lister',
    revision: 1,
    options: z.object({ prompt: z.string(), scopes: z.array(z.string()).optional() }),
    capabilities: { structuredOutput: 'none' },
    sensitiveOptions: ['scopes'],
    access: () => 'none',
  });
  const manifest = capabilityManifest({
    harnesses: [lister],
    profiles: { p: { harnesses: { lister: { scopes: ['marker-scope'] } } }, q: {} },
  });
  expect(role(manifest, 'p').redacted).toEqual({
    harnesses: { lister: { scopes: { sha256: digest(['marker-scope']) } } },
  });
  expect(JSON.stringify(manifest)).not.toContain('marker-scope');
  expect(role(manifest, 'q')).not.toHaveProperty('redacted');
  // A registration without sensitiveOptions publishes its options as before.
  const open = defineHarness({ ...lister, sensitiveOptions: [] });
  expect(
    capabilityManifest({
      harnesses: [open],
      profiles: { p: { harnesses: { lister: { scopes: ['visible'] } } } },
    }).profiles['p'],
  ).toMatchObject({ harnesses: { lister: { scopes: ['visible'] } } });
});

it('keeps grant digests of sensitive registered options stable and sensitive to rotation', () => {
  const live = resolveCapabilities({ harnesses: [vault], profiles: { p: vaultProfile() } });
  expect(profileGrantDigest(role(live, 'p'))).toBe(vaultGrantDigest);
  const rotated = resolveCapabilities({
    harnesses: [vault],
    profiles: { p: vaultProfile('other') },
  });
  expect(profileGrantDigest(role(rotated, 'p'))).toBe(rotatedVaultGrantDigest);
});

it('checkpoints redacted registered options, invokes with raw values and replays an unchanged resume', async () => {
  let stop = true;
  const invoke = vi.fn<HarnessAdapter['invoke']>().mockResolvedValue(reply);
  const definition = vaultDefinition({ p: vaultProfile() }, () => stop);
  const options = { ...setup(), adapters: { vault: { invoke } }, grants: ['p'] };
  await expect(runWorkflow(definition, options)).rejects.toThrow('pause');
  const saved = await readRun(setup());
  const text = JSON.stringify(saved);
  for (const marker of Object.values(vaultMarkers)) expect(text).not.toContain(marker);
  expect(
    saved.capabilities?.profiles['p']?.redacted?.harnesses?.['vault']?.['headers']?.keys,
  ).toEqual(['Authorization', 'X-Trace']);
  expect(saved.grantedProfiles?.['p']).toBe(vaultGrantDigest);
  expect(invoke.mock.calls[0]?.[0].options).toMatchObject({
    headers: vaultHeaders(),
    token: vaultMarkers.token,
    region: 'eu-west',
  });
  stop = false;
  await expect(runWorkflow(definition, { ...options, resume: true })).resolves.toMatchObject({
    status: 'completed',
  });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each([
  ['the capability-key header', () => vaultProfile('rotated-header')],
  ['the token', () => vaultProfile(undefined, 'rotated-token')],
])(
  'refuses a resume whose only change is a rotated sensitive option (%s)',
  async (_label, rotate) => {
    const profiles = { p: vaultProfile() };
    const invoke = vi.fn<HarnessAdapter['invoke']>().mockResolvedValue(reply);
    const definition = vaultDefinition(profiles, () => true);
    const options = { ...setup(), adapters: { vault: { invoke } }, grants: ['p'] };
    await expect(runWorkflow(definition, options)).rejects.toThrow('pause');
    profiles.p = rotate();
    // Step identity still sees the raw value, even under --grant all.
    await expect(
      runWorkflow(definition, { ...options, resume: true, grants: ['all'] }),
    ).rejects.toThrow('Step first: options changed on a completed step');
    await expect(runWorkflow(definition, { ...options, resume: true })).rejects.toThrow(
      'Step first: options changed on a completed step',
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  },
);

it('refuses a saved named grant for a pending step whose sensitive capability option rotated', async () => {
  const profiles = { p: vaultProfile() };
  const invoke = vi.fn<HarnessAdapter['invoke']>().mockRejectedValue(new Error('offline'));
  const definition = defineWorkflow({
    ...base,
    requireGrants: true,
    harnesses: [vault],
    profiles,
    async run(ctx) {
      return (await ctx.agent('vault').text('pending', { prompt: 'x', profile: 'p' })).output;
    },
  });
  const options = { ...setup(), adapters: { vault: { invoke } }, grants: ['p'] };
  await expect(runWorkflow(definition, options)).rejects.toThrow('offline');
  expect((await readRun(setup())).grantedProfiles?.['p']).toBe(vaultGrantDigest);
  profiles.p = vaultProfile('rotated-header');
  await expect(
    runWorkflow(definition, { ...setup(), adapters: { vault: { invoke } }, resume: true }),
  ).rejects.toThrow('Retry with --grant p');
  expect(invoke).toHaveBeenCalledTimes(1);
  invoke.mockResolvedValue(reply);
  await expect(
    runWorkflow(definition, { ...options, resume: true, grants: ['all'] }),
  ).resolves.toMatchObject({ status: 'completed' });
});

// Rooted call-site directories were removed (#707; ADRs 0054 and 0062 record the old form).
it('refuses claude.addDirRoots in profiles and defaults, naming the replacement', async () => {
  // The definitions are cast past the types, which no longer admit the key.
  const roots = ['runs'];
  const cases: readonly (readonly [object, string])[] = [
    [{ defaults: { claude: { addDirRoots: roots } } }, 'defaults.claude.addDirRoots:'],
    [
      { profiles: { reader: { claude: { addDirRoots: roots } } } },
      'Profile reader claude.addDirRoots:',
    ],
    // An empty list is refused for the same reason, not as a schema error.
    [
      { profiles: { reader: { claude: { addDirRoots: [] } } } },
      'Profile reader claude.addDirRoots:',
    ],
  ];
  for (const [definition, where] of cases) {
    for (const resolve of [resolveCapabilities, capabilityManifest]) {
      expect(() => resolve(definition as never)).toThrow(where);
      expect(() => resolve(definition as never)).toThrow(
        'rooted call-site directories were removed',
      );
      expect(() => resolve(definition as never)).toThrow('addDirs on a roster entry');
    }
  }
  // An inline child is refused when it loads, before any effect.
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const child = defineWorkflow({
    ...base,
    name: 'rooted-child',
    profiles: { reader: { extends: 'readonly', claude: { addDirRoots: roots } as never } },
    run: async (ctx) => (await ctx.claude.text('read', { prompt: 'x', profile: 'reader' })).output,
  });
  const parent = defineWorkflow({
    ...base,
    run: (ctx) => ctx.workflow('child', child, null),
  });
  await expect(runWorkflow(parent, { ...setup(), harness: { invoke } })).rejects.toThrow(
    'Profile reader claude.addDirRoots: rooted call-site directories were removed',
  );
  expect(invoke).not.toHaveBeenCalled();
});

it('refuses strict call-site Claude addDirs at runtime under every role', async () => {
  const manifest = resolveCapabilities({
    strictProfiles: true,
    profiles: { reader: { extends: 'readonly', claude: { addDirs: ['docs'] } } },
  });
  for (const profile of [undefined, 'readonly', 'reader'])
    expect(
      () =>
        resolveProfileCall(
          manifest,
          'claude',
          { prompt: 'x', ...(profile === undefined ? {} : { profile }), addDirs: ['runs/a'] },
          [],
          {},
          true,
        ),
      String(profile),
    ).toThrow('strictProfiles forbids call-site addDirs;');
  // The role's own static addDirs still reach the harness when the call passes none.
  expect(
    resolveProfileCall(manifest, 'claude', { prompt: 'x', profile: 'reader' }, [], {}, true).options
      .addDirs,
  ).toEqual(['docs']);
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    strictProfiles: true,
    profiles: { reader: { extends: 'readonly', claude: { addDirs: ['docs'] } } },
    async run(ctx) {
      const options = { prompt: 'x', profile: 'reader', addDirs: ['runs/a'] } as never;
      return (await ctx.claude.text('read', options)).output;
    },
  });
  await expect(runWorkflow(definition, { ...setup(), harness: { invoke } })).rejects.toThrow(
    'strictProfiles forbids call-site addDirs;',
  );
  expect(invoke).not.toHaveBeenCalled();
});

it('rejects codex.addDirRoots in profiles and defaults with the reason', () => {
  const roots = ['runs'];
  const cases: readonly (readonly [object, string])[] = [
    [
      { profiles: { writer: { codex: { addDirRoots: roots } } } },
      'Profile writer codex.addDirRoots:',
    ],
    [{ defaults: { codex: { addDirRoots: roots } } }, 'defaults.codex.addDirRoots:'],
  ];
  for (const [definition, where] of cases) {
    for (const resolve of [resolveCapabilities, capabilityManifest]) {
      expect(() => resolve(definition as never)).toThrow(where);
      expect(() => resolve(definition as never)).toThrow('Codex addDirs are writable roots');
      expect(() => resolve(definition as never)).toThrow('list them statically in codex.addDirs');
    }
  }
});

it('keeps grant digests of profiles without roots', () => {
  const manifest = resolveCapabilities({
    profiles: { docsEditor: { extends: 'edit', claude: { addDirs: ['docs'] } } },
  });
  // Computed on unmodified main 4c3ebf5 (see test/fixtures/schema-revision/README.md).
  expect(profileGrantDigest(role(manifest, 'edit'))).toBe(
    '4a87c86d2adce1b7712d584da2a0cf6a16c3daf76fc049310af0af38ef53f5f9',
  );
  expect(profileGrantDigest(role(manifest, 'readonly'))).toBe(
    '19aaa56680b71d1d6cba7dccaa13695368d337a391bd36ce4519707dcf0ab8b3',
  );
  expect(profileGrantDigest(role(manifest, 'docsEditor'))).toBe(
    '7ce299811063fa4dfd34efcb9bb75f06c3b0552cc2882f7a87d34e6d1ca8a65c',
  );
});

it('still reads a stored manifest whose role carries claude.addDirRoots', () => {
  // Records written before #707 may carry rooted roles; the persisted schema keeps the field.
  const manifest = capabilityManifest({ profiles: { scout: { extends: 'readonly' } } });
  const scout = role(manifest, 'scout');
  const stored = {
    ...manifest,
    profiles: {
      ...manifest.profiles,
      scout: { ...scout, claude: { ...scout.claude, addDirRoots: ['runs'] } },
    },
  };
  const parsed = capabilityManifestSchema.parse(stored);
  expect(parsed).toEqual(stored);
  expect(parsed.profiles['scout']?.claude).toMatchObject({ addDirRoots: ['runs'] });
  expect(() =>
    capabilityManifestSchema.parse({
      ...stored,
      profiles: { scout: { ...scout, claude: { ...scout.claude, addDirRoots: [] } } },
    }),
  ).toThrow();
});

it('passes static Claude addDirs of a profile to the request, and none otherwise', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    profiles: { docs: { extends: 'readonly', claude: { addDirs: ['docs'] } } },
    async run(ctx) {
      await ctx.claude.text('docs', { prompt: 'x', profile: 'docs' });
      return (await ctx.claude.text('plain', { prompt: 'x' })).output;
    },
  });
  await runWorkflow(definition, { ...setup(), harness: { invoke } });
  const [docs, plain] = invoke.mock.calls.map(([request]) => request.options);
  expect(docs?.addDirs).toEqual(['docs']);
  expect(plain).not.toHaveProperty('addDirs');
  const saved = await readRun(setup());
  expect(saved.steps['docs']?.request?.addDirs).toEqual(['docs']);
  expect(saved.steps['plain']?.request).not.toHaveProperty('addDirs');
});

it('never accepts addDirRoots as a call option, even with strictProfiles: false', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    strictProfiles: false,
    async run(ctx) {
      const options = { prompt: 'x', addDirRoots: ['/'] } as { prompt: string };
      return (await ctx.claude.text('read', options)).output;
    },
  });
  await expect(runWorkflow(definition, { ...setup(), harness: { invoke } })).rejects.toThrow(
    'Unrecognized key(s) "addDirRoots"',
  );
  expect(invoke).not.toHaveBeenCalled();
});

// ADR 0063 §5 (#577): grants, pins and strict call sites are opt-in.
describe('requireGrants and strictProfiles opt-in (#577)', () => {
  const fixerDefinition = (requireGrants?: boolean) =>
    defineWorkflow({
      ...base,
      ...(requireGrants === undefined ? {} : { requireGrants }),
      profiles: { fixer: { extends: 'edit' } },
      async run(ctx) {
        await ctx.now('prepare');
        return (await ctx.claude.text('fix', { prompt: 'x', profile: 'fixer' })).output;
      },
    });
  const editAfterPrepare = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.now('prepare');
      return (await ctx.claude.text('edit', { prompt: 'x', profile: 'edit' })).output;
    },
  });

  it('runs an edit-class role without a grant by default', async () => {
    const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
    const run = await runWorkflow(fixerDefinition(), { ...setup(), harness: { invoke } });
    expect(run.status).toBe('completed');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0].options).toMatchObject({
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
    });
    const saved = await readRun(setup());
    expect(saved.grants).toEqual([]);
    expect(saved).not.toHaveProperty('requireGrants');
    expect(saved.capabilities).toMatchObject({ requiredGrants: [], strictProfiles: false });
    expect(saved.capabilities?.profiles['fixer']?.access).toBe('write');
    // The built-in edit preset needs no grant at the call either.
    await expect(
      runWorkflow(editAfterPrepare, { ...setup(), runId: 'edit', harness: { invoke } }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['the definition', true, {}],
    ['RunOptions', undefined, { requireGrants: true }],
  ] as const)(
    'refuses an ungranted declared role before the body when %s opts in',
    async (_label, flag, extra) => {
      const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
      const error: unknown = await runWorkflow(fixerDefinition(flag), {
        ...setup(),
        ...extra,
        harness: { invoke },
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(GrantRequiredError);
      expect((error as Error).message).toBe(
        'Profile fixer requires write access. Retry with --grant fixer, --grant write, or --grant all.',
      );
      expect(invoke).not.toHaveBeenCalled();
      // Refused before any record exists, so the same launch with the grant creates the run.
      await expect(
        runWorkflow(fixerDefinition(flag), {
          ...setup(),
          ...extra,
          harness: { invoke },
          grants: ['fixer'],
        }),
      ).resolves.toMatchObject({ status: 'completed' });
      expect((await readRun(setup())).capabilities?.requiredGrants).toEqual(['fixer']);
    },
  );

  it.each([
    ['the definition', { ...editAfterPrepare, requireGrants: true }, {}],
    ['RunOptions', editAfterPrepare, { requireGrants: true }],
  ] as const)(
    'refuses an ungranted call with the grant cause and hint when %s opts in',
    async (_label, definition, extra) => {
      const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
      const error: unknown = await runWorkflow(definition, {
        ...setup(),
        ...extra,
        harness: { invoke },
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(WorkflowRunError);
      expect((error as Error).message).toContain(
        'Profile edit requires write access. Retry with --grant edit, --grant write, or --grant all.',
      );
      expect(invoke).not.toHaveBeenCalled();
      const saved = await readRun(setup());
      expect(saved.recoveryCause).toEqual({ kind: 'grant', profile: 'edit', access: 'write' });
      expect(saved.recoveryHint).toContain('--resume --grant edit');
      const launch = { entrypoint: join(stateDir, 'w.mts'), tsconfig: null };
      expect(runNextCommands({ ...saved, launch }, 'failed', stateDir)[0]?.argv.slice(-2)).toEqual([
        '--grant',
        'edit',
      ]);
    },
  );

  it('records and pins grants with the layer off and still rejects unknown names', async () => {
    const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
    await runWorkflow(fixerDefinition(), { ...setup(), harness: { invoke }, grants: ['fixer'] });
    const saved = await readRun(setup());
    expect(saved.grants).toEqual(['fixer']);
    const fixer = resolveCapabilities(fixerDefinition()).profiles['fixer'];
    if (!fixer) throw new Error('fixer missing');
    expect(saved.grantedProfiles).toEqual({ fixer: profileGrantDigest(fixer) });
    await expect(
      runWorkflow(fixerDefinition(), { ...setup(), runId: 'typo', grants: ['fixr'] }),
    ).rejects.toThrow('Unknown grant: fixr.');
  });

  it('keeps the run-level flag across resumes and does not pass it to a fork', async () => {
    const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
    const options = { ...setup(), harness: { invoke } };
    await expect(
      runWorkflow(editAfterPrepare, { ...options, requireGrants: true }),
    ).rejects.toThrow('--grant edit');
    expect((await readRun(setup())).requireGrants).toBe(true);
    // A resume without the option keeps the layer on, so the ungranted call is refused again.
    await expect(runWorkflow(editAfterPrepare, { ...options, resume: true })).rejects.toThrow(
      '--grant edit',
    );
    // requireGrants: false does not turn it off either.
    await expect(
      runWorkflow(editAfterPrepare, { ...options, resume: true, requireGrants: false }),
    ).rejects.toThrow('--grant edit');
    expect(invoke).not.toHaveBeenCalled();
    // A fork is a new run: it does not inherit the flag and needs no grant.
    await expect(
      runWorkflow(editAfterPrepare, { ...options, runId: 'fork', forkFrom: { runId: 'profiles' } }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(await readRun({ stateDir, runId: 'fork' })).not.toHaveProperty('requireGrants');
    expect(invoke).toHaveBeenCalledTimes(1);
    // The emitted grant resume completes without repeating the flag.
    await expect(
      runWorkflow(editAfterPrepare, { ...options, resume: true, grants: ['edit'] }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect((await readRun(setup())).requireGrants).toBe(true);
  });

  it('saves the run-level flag when it is first given to a completed run', async () => {
    const definition = defineWorkflow({ ...base, run: () => Promise.resolve('ok') });
    await runWorkflow(definition, setup());
    expect(await readRun(setup())).not.toHaveProperty('requireGrants');
    await runWorkflow(definition, { ...setup(), resume: true, requireGrants: true });
    expect((await readRun(setup())).requireGrants).toBe(true);
  });

  it('refreshes the manifest when the flag is first given to a completed run', async () => {
    const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
    const options = { ...setup(), harness: { invoke } };
    await runWorkflow(fixerDefinition(), options);
    const first = await readRun(setup());
    expect(first).not.toHaveProperty('requireGrants');
    expect(first.capabilities?.requiredGrants).toEqual([]);
    const resumed = await runWorkflow(fixerDefinition(), {
      ...options,
      resume: true,
      requireGrants: true,
      grants: ['fixer'],
    });
    expect(resumed.requireGrants).toBe(true);
    expect(resumed.capabilities?.requiredGrants).toEqual(['fixer']);
    const saved = await readRun(setup());
    expect(saved.requireGrants).toBe(true);
    expect(saved.capabilities?.requiredGrants).toEqual(['fixer']);
    // A later resume with no options leaves the manifest as it is.
    await runWorkflow(fixerDefinition(), { ...options, resume: true });
    const again = await readRun(setup());
    expect(again.requireGrants).toBe(true);
    expect(again.capabilities).toEqual(saved.capabilities);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('refreshes the manifest of a completed run after a grant refusal already saved the flag', async () => {
    const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
    const options = { ...setup(), harness: { invoke } };
    await runWorkflow(fixerDefinition(), options);
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(
      runWorkflow(fixerDefinition(), { ...options, resume: true, requireGrants: true }),
    ).rejects.toBeInstanceOf(GrantRequiredError);
    const refused = await readRun(setup());
    expect(refused.requireGrants).toBe(true);
    expect(refused.capabilities?.requiredGrants).toEqual([]);
    const resumed = await runWorkflow(fixerDefinition(), {
      ...options,
      resume: true,
      grants: ['fixer'],
    });
    expect(resumed.requireGrants).toBe(true);
    expect(resumed.capabilities?.requiredGrants).toEqual(['fixer']);
    const saved = await readRun(setup());
    expect(saved.requireGrants).toBe(true);
    expect(saved.capabilities?.requiredGrants).toEqual(['fixer']);
    await runWorkflow(fixerDefinition(), { ...options, resume: true });
    expect((await readRun(setup())).capabilities).toEqual(saved.capabilities);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('saves the run-level flag when a resume that first gives it is refused before the body', async () => {
    const invoke = vi
      .fn<Harness['invoke']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(reply);
    const options = { ...setup(), harness: { invoke } };
    // With the layer off the declared write role runs ungranted, and this run fails.
    await expect(runWorkflow(fixerDefinition(), options)).rejects.toThrow('offline');
    const failed = await readRun(setup());
    expect(failed.status).toBe('failed');
    expect(failed).not.toHaveProperty('requireGrants');
    const refused: unknown = await runWorkflow(fixerDefinition(), {
      ...options,
      resume: true,
      requireGrants: true,
    }).catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(GrantRequiredError);
    expect((refused as Error).message).toBe(
      'Profile fixer requires write access. Retry with --grant fixer, --grant write, or --grant all.',
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    // Only the flag is saved: the status, grants and policy are those of the failed run.
    const saved = await readRun(setup());
    expect(saved.requireGrants).toBe(true);
    expect(saved).toMatchObject({
      status: 'failed',
      grants: [],
      grantedProfiles: {},
      policy: failed.policy,
      capabilities: failed.capabilities,
    });
    // The printed retry without --require-grants still enforces, so a resume with no grant is
    // refused again, and one with only the grant completes.
    await expect(runWorkflow(fixerDefinition(), { ...options, resume: true })).rejects.toThrow(
      GrantRequiredError,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(
      runWorkflow(fixerDefinition(), { ...options, resume: true, grants: ['fixer'] }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(invoke).toHaveBeenCalledTimes(2);
    const completed = await readRun(setup());
    expect(completed.requireGrants).toBe(true);
    expect(completed.capabilities?.requiredGrants).toEqual(['fixer']);
  });

  it('repeats --require-grants in the retry text when the refusal cannot save the flag', async () => {
    const definition = fixerDefinition();
    const invoke = vi.fn<Harness['invoke']>().mockRejectedValueOnce(new Error('offline'));
    await expect(runWorkflow(definition, { ...setup(), harness: { invoke } })).rejects.toThrow(
      'offline',
    );
    const file = new FileRunStore(stateDir);
    const store: RunStore = {
      stateDir: file.stateDir,
      read: (id) => file.read(id),
      list: () => file.list(),
      open: async (id, openOptions): Promise<OwnedRunStore> => {
        const owned = await file.open(id, openOptions);
        return {
          read: () => owned.read(),
          append: () => Promise.reject(new Error('disk full')),
          compact: () => owned.compact(),
          artifacts: (stepId, attempt) => owned.artifacts(stepId, attempt),
          trackProcess: (invocation, process) => owned.trackProcess(invocation, process),
          release: () => owned.release(),
        };
      },
    };
    const refused: unknown = await runWorkflow(definition, {
      ...setup(),
      harness: { invoke },
      store,
      resume: true,
      requireGrants: true,
    }).catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(AggregateError);
    const grant = (refused as AggregateError).errors[0] as unknown;
    expect(grant).toBeInstanceOf(GrantRequiredError);
    expect((grant as Error).message).toBe(
      'Profile fixer requires write access. Retry with --require-grants and --grant fixer, --grant write, or --grant all.',
    );
    expect((refused as Error).message).toContain('disk full');
    expect(await readRun(setup())).not.toHaveProperty('requireGrants');
  });

  it('rejects a requireGrants that is not a boolean before the body', async () => {
    const run = vi.fn(() => Promise.resolve('ok'));
    const definition = { ...defineWorkflow({ ...base, run }), requireGrants: 'yes' as never };
    await expect(runWorkflow(definition, setup())).rejects.toThrow(
      'Workflow profiles requireGrants must be a boolean.',
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('runs raw call-site capabilities when strictProfiles is omitted', async () => {
    const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        await ctx.claude.text('t', { prompt: 'x', tools: ['Read'] });
        return (await ctx.codex.text('c', { prompt: 'y', sandbox: 'workspace-write' })).output;
      },
    });
    await expect(
      runWorkflow(definition, { ...setup(), harness: { invoke } }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(invoke.mock.calls[0]?.[0].options).toMatchObject({
      tools: ['Read'],
      allowedTools: ['Read'],
    });
    expect(invoke.mock.calls[1]?.[0].options).toMatchObject({ sandbox: 'workspace-write' });
    // The same calls stay refused under an explicit strictProfiles: true.
    await expect(
      runWorkflow(
        { ...definition, strictProfiles: true },
        { ...setup(), runId: 'strict', harness: { invoke } },
      ),
    ).rejects.toThrow('strictProfiles forbids call-site tools; declare a named profile.');
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
