// Grants, grant pins and launch overrides on roster entries (ADR 0063 sections 4-5, #705/#708),
// which replaced the profile cases removed with profiles (#726), plus the counterparts of
// harness-controls.test.ts:667 and harness-registry.test.ts:232. defineRoster
// deep-freezes its entries, so a case that edits a role between runs builds a second definition
// from a factory. Every agent entry is a declared role, so the launch preflight refuses an ungranted
// elevated entry before the body runs and before any record exists; the call-time grant cause and
// hint are reached only through a raw class-only call in a workflow that has a roster.
import { join } from 'node:path';
import { describe, expect, vi } from 'vitest';
import {
  ConfigurationError,
  defineHarness,
  defineRoster,
  defineWorkflow,
  FileRunStore,
  HarnessError,
  readRun,
  WorkflowRunError,
  z,
  type Harness,
  type HarnessAdapter,
  type OwnedRunStore,
  type RunStore,
} from '../src/index.js';
import { GrantRequiredError } from '../src/workflow/runtime/configuration-error.js';
import {
  parseProfileOverride,
  profileGrantDigest,
  resolveCapabilities,
  validateProfileOverrides,
  capabilityManifest,
} from '../src/workflow/runtime/profiles.js';
import { runNextCommands } from '../src/workflow/loader/next-commands.js';
import { it } from './setup/state-dir.js';

const prompt = 'x';
const runId = 'roster-grants';
const base = { name: 'roster-grants', version: '1', input: z.null(), output: z.string() } as const;
const reply = {
  text: 'ok',
  sessionId: 'session',
  usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.31 },
};
const fixerMessage =
  'Role Fixer requires write access. Retry with --grant Fixer, --grant write, or --grant all.';
/** The write entry most cases grant: Claude with Read and Edit. */
const fixer = { harness: 'claude', tools: ['Read', 'Edit'] } as const;

/** A fake harness whose calls are counted; it answers `reply` unless told otherwise. */
function fake() {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  return { invoke, harness: { invoke } };
}

/** A Fixer workflow (ctx.now, then the entry), with the grant layer as given (#577). */
const fixerWorkflow = (requireGrants?: boolean) =>
  defineWorkflow({
    ...base,
    ...(requireGrants === undefined ? {} : { requireGrants }),
    roster: defineRoster({ Fixer: fixer }),
    async run(ctx) {
      await ctx.now('prepare');
      return (await ctx.roster.Fixer.text('fix', { prompt })).output;
    },
  });

/** {@link fixerWorkflow} with a second write entry, Builder, that the body never calls. */
const pairWorkflow = (requireGrants?: boolean) =>
  defineWorkflow({
    ...base,
    ...(requireGrants === undefined ? {} : { requireGrants }),
    roster: defineRoster({ Builder: fixer, Fixer: fixer }),
    async run(ctx) {
      await ctx.now('prepare');
      return (await ctx.roster.Fixer.text('fix', { prompt })).output;
    },
  });

/** The first GrantRequiredError on an error's cause chain. */
function grantCause(error: unknown): unknown {
  let cause = error;
  while (cause instanceof Error && !(cause instanceof GrantRequiredError)) cause = cause.cause;
  return cause;
}

describe('launch overrides and the manifest', () => {
  it('merges the entry, defaults, named launch rules and step policy in order', async ({
    stateDir,
    runs,
  }) => {
    const { invoke, harness } = fake();
    const definition = defineWorkflow({
      ...base,
      defaults: { maxTurns: 11, maxBudgetUsd: 0.8, claude: { model: 'sonnet' } },
      roster: defineRoster({
        Scout: {
          harness: 'claude',
          tools: ['Read', 'Grep', 'Glob'],
          maxTurns: 30,
          description: 'Reads source',
        },
      }),
      async run(ctx) {
        return (await ctx.roster.Scout.text('read', { prompt })).output;
      },
    });
    const run = await runs.run(definition, {
      stateDir,
      runId,
      input: null,
      harness,
      profileOverrides: [
        { profile: '*', maxTurns: 50, timeoutMs: 6000 },
        { profile: 'Scout', maxTurns: 60 },
      ],
      policy: [{ match: 'read', maxBudgetUsd: 4 }],
    });
    expect(invoke.mock.calls[0]?.[0].options).toEqual({
      isolation: 'restricted',
      prompt,
      model: 'sonnet',
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: ['Read', 'Grep', 'Glob'],
      maxTurns: 60,
      maxBudgetUsd: 4,
      timeoutMs: 6000,
    });
    expect(run.steps['read']?.attemptHistory?.[0]).toMatchObject({
      profile: 'Scout',
      requestedModel: 'sonnet',
      sources: {
        maxTurns: 'profile-override:1',
        maxBudgetUsd: 'override:0',
        timeoutMs: 'profile-override:0',
      },
    });
  });

  it('infers entry access from tools and narrower rules, and lists required grants', () => {
    const manifest = capabilityManifest(
      defineWorkflow({
        ...base,
        requireGrants: true,
        // Declared out of alphabetical order.
        roster: defineRoster({
          Fixer: {
            harness: 'claude',
            tools: ['Read', 'Edit', 'Bash'],
            allowedTools: ['Read', 'Edit', 'Bash(npm test:*)'],
          },
          Writer: { harness: 'claude', tools: ['Write'] },
          Custom: { harness: 'claude', tools: ['mcp__fixture__update'] },
        }),
        run: () => Promise.resolve('ok'),
      }),
    );
    expect(manifest.profiles['Fixer']?.access).toBe('exec');
    expect(manifest.profiles['Writer']).toMatchObject({
      access: 'write',
      claude: { allowedTools: ['Write'] },
    });
    expect(manifest.profiles['Custom']?.access).toBe('exec');
    expect(manifest.requiredGrants).toEqual(['Custom', 'Fixer', 'Writer']);
  });

  it('parses entry override rules and validates entry names for overrides and grants', async ({
    stateDir,
    runs,
  }) => {
    expect(parseProfileOverride('Reviewer.maxTurns=60')).toEqual({
      profile: 'Reviewer',
      maxTurns: 60,
    });
    expect(parseProfileOverride('*.timeoutMs=1800000')).toEqual({
      profile: '*',
      timeoutMs: 1_800_000,
    });
    const run = vi.fn(() => Promise.resolve('ok'));
    const definition = defineWorkflow({
      ...base,
      roster: defineRoster({ Reviewer: { harness: 'claude', tools: ['Read'] } }),
      run,
    });
    const capabilities = resolveCapabilities(definition);
    expect(validateProfileOverrides([{ profile: 'Reviewer', maxTurns: 60 }], capabilities)).toEqual(
      [{ profile: 'Reviewer', maxTurns: 60 }],
    );
    expect(() =>
      validateProfileOverrides([{ profile: 'Reviewr', maxTurns: 60 }], capabilities),
    ).toThrow('Unknown override profile');
    // The removed presets (#726) are unknown roles, so a saved rule naming one is refused too.
    for (const preset of ['readonly', 'edit'])
      expect(() =>
        validateProfileOverrides([{ profile: preset, maxTurns: 60 }], capabilities),
      ).toThrow(`Unknown override profile: ${preset}.`);
    const options = { stateDir, runId, input: null };
    await expect(
      runs.run(definition, { ...options, profileOverrides: [{ profile: 'Reviewr', maxTurns: 2 }] }),
    ).rejects.toThrow('Unknown override profile');
    await expect(runs.run(definition, { ...options, grants: ['Reviewr'] })).rejects.toThrow(
      'Unknown grant',
    );
    expect(run).not.toHaveBeenCalled();
  });

  it.for(['turn-limit', 'budget-limit'] as const)(
    'reports %s with the entry cap, reported turns/spend and a usable flag',
    async (kind, { stateDir, runs }) => {
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
        roster: defineRoster({
          Scout: { harness: 'claude', tools: ['Read'], maxTurns: 30, maxBudgetUsd: 2 },
        }),
        async run(ctx) {
          return (await ctx.roster.Scout.text('ask', { prompt })).output;
        },
      });
      await expect(
        runs.run(definition, {
          stateDir,
          runId,
          input: null,
          harness: { invoke: () => Promise.reject(error) },
        }),
      ).rejects.toThrow(
        `--resume --profile Scout.${kind === 'turn-limit' ? 'maxTurns=60' : 'maxBudgetUsd=4'}`,
      );
      const saved = await readRun({ stateDir, runId });
      expect(saved.error).toContain('turns=30; costUsd=0.31');
      expect(saved.steps['ask']?.failedAttempts?.[0]?.usage?.costUsd).toBe(0.31);
      expect(saved.steps['ask']?.attemptHistory?.[0]?.errorKind).toBe(kind);
    },
  );

  it('keeps entry names and limits outside identity, persists rules, and detects semantic changes', async ({
    stateDir,
    runs,
  }) => {
    let name: 'Old' | 'New' = 'Old';
    let stop = true;
    const { invoke, harness } = fake();
    const reader = { harness: 'claude', tools: ['Read', 'Grep', 'Glob'] } as const;
    const renamed = (model?: string) =>
      defineWorkflow({
        ...base,
        roster: defineRoster({
          Old: reader,
          New: model === undefined ? reader : { ...reader, model },
        }),
        async run(ctx) {
          await ctx.roster[name].text('saved', { prompt });
          await ctx.roster[name].text('pending', { prompt: 'y' });
          if (stop) throw new Error('pause');
          return 'ok';
        },
      });
    const options = { stateDir, runId, input: null, harness };
    invoke.mockResolvedValueOnce(reply).mockRejectedValueOnce(new Error('limit'));
    await expect(runs.run(renamed(), options)).rejects.toThrow('limit');
    name = 'New';
    const overrides = [{ profile: '*', maxTurns: 60 }];
    await expect(
      runs.run(renamed(), { ...options, resume: true, profileOverrides: overrides }),
    ).rejects.toThrow('pause');
    stop = false;
    const result = await runs.run(renamed(), { ...options, resume: true });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls[2]?.[0].options).toHaveProperty('maxTurns', 60);
    expect(result.profileOverrides).toEqual(overrides);
    expect(result.steps['pending']?.redefinitions).toBeUndefined();
    expect(result.steps['pending']?.attemptHistory?.map((attempt) => attempt.profile)).toEqual([
      'Old',
      'New',
    ]);
    await expect(
      runs.run(renamed('different'), { ...options, resume: true, acceptCodeChange: true }),
    ).rejects.toThrow('model changed');
  });
});

describe('launch grants on named entries', () => {
  // A named elevated entry is a declared role, so the launch preflight refuses it before the body
  // runs; the profile case's call-time refusal is not reachable through ctx.roster.
  it.for(['Fixer', 'write', 'exec', 'all'])(
    'enforces launch grants and saves %s for resume',
    async (grant, { stateDir, runs }) => {
      let stop = true;
      const body = vi.fn();
      const { invoke, harness } = fake();
      const definition = defineWorkflow({
        ...base,
        requireGrants: true,
        roster: defineRoster({ Fixer: fixer }),
        async run(ctx) {
          body();
          await ctx.roster.Fixer.text('fix', { prompt });
          if (stop) throw new Error('pause');
          return 'ok';
        },
      });
      const options = { stateDir, runId, input: null, harness };
      await expect(runs.run(definition, options)).rejects.toThrow(
        '--grant Fixer, --grant write, or --grant all',
      );
      expect(body).not.toHaveBeenCalled();
      await expect(runs.run(definition, { ...options, grants: [grant] })).rejects.toThrow('pause');
      stop = false;
      const result = await runs.run(definition, { ...options, resume: true });
      expect(result.grants).toEqual([grant]);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect((await readRun({ stateDir, runId })).capabilities?.requiredGrants).toEqual(['Fixer']);
    },
  );

  // Refused at launch, not at the call (the call-time refusal is covered by the raw class-only call
  // below): no record, no body effect, and the same launch with the grant runs.
  it.for([
    { label: 'the definition', flag: true, extra: {} },
    { label: 'RunOptions', flag: undefined, extra: { requireGrants: true } },
  ] as const)(
    'refuses an ungranted entry before the body when $label opts in',
    async ({ flag, extra }, { stateDir, runs }) => {
      const { invoke, harness } = fake();
      const options = { stateDir, runId, input: null, harness, ...extra };
      const error: unknown = await runs
        .run(fixerWorkflow(flag), options)
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(GrantRequiredError);
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).toMatchObject({ profile: 'Fixer', access: 'write' });
      expect((error as Error).message).toBe(fixerMessage);
      expect(invoke).not.toHaveBeenCalled();
      await expect(readRun({ stateDir, runId })).rejects.toThrow();
      await expect(
        runs.run(fixerWorkflow(flag), { ...options, grants: ['Fixer'] }),
      ).resolves.toMatchObject({ status: 'completed' });
      expect((await readRun({ stateDir, runId })).capabilities?.requiredGrants).toEqual(['Fixer']);
    },
  );

  it('names exec access and the exec grant for an exec entry', async ({ stateDir, runs }) => {
    const definition = defineWorkflow({
      ...base,
      requireGrants: true,
      roster: defineRoster({ Runner: { harness: 'claude', tools: ['Bash'] } }),
      async run(ctx) {
        return (await ctx.roster.Runner.text('run', { prompt })).output;
      },
    });
    const { harness } = fake();
    const error: unknown = await runs
      .run(definition, { stateDir, runId, input: null, harness })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GrantRequiredError);
    expect((error as Error).message).toBe(
      'Role Runner requires exec access. Retry with --grant Runner, --grant exec, or --grant all.',
    );
  });

  // The preflight checks every declared elevated entry, called or not, and one refusal names all
  // that lack a grant, so a single retry can grant them.
  it('names every ungranted entry in one refusal', async ({ stateDir, runs }) => {
    const { invoke, harness } = fake();
    const options = { stateDir, runId, input: null, harness };
    const error: unknown = await runs
      .run(pairWorkflow(true), options)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GrantRequiredError);
    expect(error).toMatchObject({
      profile: 'Builder',
      access: 'write',
      missing: [
        { profile: 'Builder', access: 'write' },
        { profile: 'Fixer', access: 'write' },
      ],
    });
    expect((error as Error).message).toBe(
      'Roles Builder and Fixer require write access. Retry with --grant Builder --grant Fixer, --grant write, or --grant all.',
    );
    // With one of them granted, the refusal is the single-entry one.
    await expect(
      runs.run(pairWorkflow(true), { ...options, grants: ['Builder'] }),
    ).rejects.toMatchObject({ message: fixerMessage, profile: 'Fixer' });
    expect(invoke).not.toHaveBeenCalled();
    await expect(
      runs.run(pairWorkflow(true), { ...options, grants: ['Builder', 'Fixer'] }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // write does not cover exec, so only the highest class named admits every missing entry.
  it('names exec as the class grant when the missing entries need write and exec', async ({
    stateDir,
    runs,
  }) => {
    const { invoke, harness } = fake();
    const definition = defineWorkflow({
      ...base,
      requireGrants: true,
      roster: defineRoster({ Builder: fixer, Runner: { harness: 'claude', tools: ['Bash'] } }),
      async run(ctx) {
        return (await ctx.roster.Builder.text('build', { prompt })).output;
      },
    });
    const options = { stateDir, runId, input: null, harness };
    const error: unknown = await runs.run(definition, options).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GrantRequiredError);
    expect((error as Error).message).toBe(
      'Role Builder requires write access and role Runner requires exec access. Retry with --grant Builder --grant Runner, --grant exec, or --grant all.',
    );
    await expect(runs.run(definition, { ...options, grants: ['write'] })).rejects.toMatchObject({
      message:
        'Role Runner requires exec access. Retry with --grant Runner, --grant exec, or --grant all.',
    });
    expect(invoke).not.toHaveBeenCalled();
    await expect(runs.run(definition, { ...options, grants: ['exec'] })).resolves.toMatchObject({
      status: 'completed',
    });
  });

  // Refused at launch: --grant write does not cover an exec entry.
  it('does not treat write as exec permission for an entry', async ({ stateDir, runs }) => {
    const { invoke, harness } = fake();
    const definition = defineWorkflow({
      ...base,
      requireGrants: true,
      roster: defineRoster({ Runner: { harness: 'claude', tools: ['Bash'] } }),
      async run(ctx) {
        return (await ctx.roster.Runner.text('run', { prompt })).output;
      },
    });
    const options = { stateDir, runId, input: null, harness };
    await expect(runs.run(definition, { ...options, grants: ['write'] })).rejects.toThrow(
      'requires exec access',
    );
    expect(invoke).not.toHaveBeenCalled();
    await expect(runs.run(definition, { ...options, grants: ['exec'] })).resolves.toMatchObject({
      status: 'completed',
    });
  });

  // Refused at launch: a Codex entry with inherited native configuration is exec.
  it('includes native Codex controls in entry access and grants (harness-controls.test.ts:667)', async ({
    stateDir,
    runs,
  }) => {
    const manifest = capabilityManifest(
      defineWorkflow({
        ...base,
        roster: defineRoster({
          Builder: {
            harness: 'codex',
            isolation: 'inherit',
            harnessProfile: 'native',
            effort: 'max',
          },
          Reader: {
            harness: 'claude',
            tools: ['Read', 'Grep', 'Glob'],
            appendSystemPrompt: 'role',
            effort: 'low',
          },
        }),
        run: () => Promise.resolve('ok'),
      }),
    );
    expect(manifest.profiles['Builder']?.access).toBe('exec');
    expect(manifest.profiles['Reader']?.access).toBe('read');
    const { invoke, harness } = fake();
    const definition = defineWorkflow({
      ...base,
      strictProfiles: true,
      requireGrants: true,
      roster: defineRoster({
        Builder: { harness: 'codex', isolation: 'inherit', harnessProfile: 'native' },
      }),
      async run(ctx) {
        return (await ctx.roster.Builder.text('ask', { prompt })).output;
      },
    });
    const options = { stateDir, runId, input: null, harness };
    await expect(runs.run(definition, { ...options, grants: ['write'] })).rejects.toThrow(
      'requires exec',
    );
    expect(invoke).not.toHaveBeenCalled();
    const result = await runs.run(definition, { ...options, grants: ['Builder'] });
    expect(result.output).toBe('ok');
  });

  // Refused at launch: the registered harness reports exec for the entry's tools.
  it('uses registered harness access for an entry grant (harness-registry.test.ts:232)', async ({
    stateDir,
    runs,
  }) => {
    const tool = defineHarness({
      name: 'tool',
      revision: 1,
      options: z.object({ prompt: z.string(), tools: z.array(z.string()).optional() }),
      capabilities: { structuredOutput: 'none' },
      capabilityKeys: ['tools'],
      access: (options) => (options.tools?.length ? 'exec' : 'none'),
    });
    const invoke = vi
      .fn<HarnessAdapter['invoke']>()
      .mockResolvedValue({ text: 'done', sessionId: null });
    const definition = defineWorkflow({
      ...base,
      requireGrants: true,
      harnesses: [tool],
      roster: defineRoster(
        { Worker: { harness: 'tool', tools: ['shell'] } },
        { harnesses: [tool] },
      ),
      async run(ctx) {
        return (await ctx.roster.Worker.text('work', { prompt })).output;
      },
    });
    const options = { stateDir, runId, input: null, adapters: { tool: { invoke } } };
    await expect(runs.run(definition, options)).rejects.toThrow('requires exec access');
    expect(invoke).not.toHaveBeenCalled();
    const result = await runs.run(definition, { ...options, grants: ['Worker'] });
    expect(result.output).toBe('done');
    expect(invoke.mock.calls[0]?.[0].options).toMatchObject({ tools: ['shell'] });
  });

  // Refused at launch: a fork is a new run, so it holds no grant of its source.
  it('does not pass an entry grant to a fork', async ({ stateDir, runs }) => {
    const { invoke, harness } = fake();
    const definition = fixerWorkflow(true);
    const options = { stateDir, runId, input: null, harness };
    await runs.run(definition, { ...options, grants: ['Fixer'] });
    await expect(
      runs.run(definition, { ...options, runId: 'fork', forkFrom: { runId } }),
    ).rejects.toThrow('--grant Fixer');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('call-time grant cause through a raw class-only call', () => {
  // A named entry never reaches the call-time check (it is refused at launch), so these cases run a
  // raw call with call-site tools in a workflow whose roster has a granted write entry. The launch
  // grant of Fixer passes the preflight; the raw call drops named grants and needs a class grant.
  const rawEdit = (requireGrants?: boolean, prepare = true) =>
    defineWorkflow({
      ...base,
      ...(requireGrants === undefined ? {} : { requireGrants }),
      roster: defineRoster({ Fixer: fixer }),
      async run(ctx) {
        if (prepare)
          await ctx.step('prepare', { input: null, schema: z.string(), run: () => 'ready' });
        return (await ctx.claude.text('edit', { prompt, tools: ['Edit'] })).output;
      },
    });
  const classOnly = { kind: 'grant', profile: 'text', access: 'write', classOnly: true };

  it.for([
    { label: 'the definition', flag: true, extra: {} },
    { label: 'RunOptions', flag: undefined, extra: { requireGrants: true } },
  ] as const)(
    'advises an access-class grant, not a code change, when $label opts in',
    async ({ flag, extra }, { stateDir, runs }) => {
      const { invoke, harness } = fake();
      const definition = rawEdit(flag);
      const options = { stateDir, runId, input: null, harness, ...extra };
      const error: unknown = await runs
        .run(definition, { ...options, grants: ['Fixer'] })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(WorkflowRunError);
      const message = (error as Error).message;
      expect(message).toMatch(/^Step edit \(claude\) failed:/u);
      expect(message).toContain('Retry with --grant write or --grant all.');
      expect(message).not.toContain('--grant Fixer');
      expect(message).not.toContain('accept-code-change');
      const grant = grantCause(error);
      expect(grant).toBeInstanceOf(GrantRequiredError);
      expect(grant).toBeInstanceOf(ConfigurationError);
      expect(grant).toMatchObject({ profile: 'text', access: 'write', classOnly: true });
      const saved = await readRun({ stateDir, runId });
      expect(saved.steps['edit']).toBeUndefined();
      // Refused before any attempt, so the root cause names a configuration kind (#311).
      expect(saved.rootCause).toMatchObject({
        stepId: 'edit',
        effect: 'claude',
        errorKind: 'configuration',
      });
      expect(saved.recoveryCause).toEqual(classOnly);
      expect(saved.recoveryHint).toContain('--resume --grant write (or --grant all)');
      expect(saved.recoveryHint).not.toContain('--grant Fixer');
      expect(saved.recoveryHint).not.toContain('accept-code-change');
      // An embedded run stores no entrypoint, so give it one to see the CLI's next entry.
      const launch = { entrypoint: join(stateDir, 'w.mts'), tsconfig: null };
      const [entry, ...rest] = runNextCommands({ ...saved, launch }, 'failed', stateDir);
      expect(rest).toEqual([]);
      expect(entry?.argv.slice(-2)).toEqual(['--grant', 'write']);
      // The entry grant repeats the failure; the emitted access-class grant completes the run.
      await expect(
        runs.run(definition, { ...options, resume: true, grants: ['Fixer'] }),
      ).rejects.toThrow('Retry with --grant write or --grant all.');
      await expect(
        runs.run(definition, { ...options, resume: true, grants: ['write'] }),
      ).resolves.toMatchObject({ status: 'completed' });
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it('saves the cause but no recovery hint when the raw call is the first effect', async ({
    stateDir,
    runs,
  }) => {
    const { invoke, harness } = fake();
    const error: unknown = await runs
      .run(rawEdit(true, false), { stateDir, runId, input: null, harness, grants: ['Fixer'] })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(WorkflowRunError);
    // The message itself still carries the grant advice; there is nothing recorded to resume.
    expect((error as Error).message).toMatch(
      /^Step edit \(claude\) failed:.*--grant write or --grant all/u,
    );
    expect((error as Error).message).not.toContain('(unknown)');
    const saved = await readRun({ stateDir, runId });
    expect(saved.recoveryHint).toBeUndefined();
    expect(saved.recoveryCause).toEqual(classOnly);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('grant pins on entries', () => {
  it('pins an entry grant to its capabilities across explicit source acceptance', async ({
    stateDir,
    runs,
  }) => {
    const body = vi.fn(() => Promise.resolve('ok'));
    const widened = (tools: readonly string[]) =>
      defineWorkflow({
        ...base,
        requireGrants: true,
        roster: defineRoster({ Fixer: { harness: 'claude', tools } }),
        run: body,
      });
    const options = { stateDir, runId, input: null };
    await runs.run(widened(['Read', 'Edit']), { ...options, grants: ['Fixer'] });
    const exec = widened(['Read', 'Edit', 'Bash']);
    await expect(
      runs.run(exec, { ...options, resume: true, acceptCodeChange: true }),
    ).rejects.toThrow('requires exec access');
    expect(body).toHaveBeenCalledTimes(1);
    await runs.run(exec, { ...options, resume: true, acceptCodeChange: true, grants: ['Fixer'] });
    // Once on the accepted-replay preflight's disposable copy and once for real (#215).
    expect(body).toHaveBeenCalledTimes(3);
  });

  it('refuses a saved entry grant for a pending step whose mcpServers token rotated', async ({
    stateDir,
    runs,
  }) => {
    const sensitive = (token: string) => {
      // defineRoster's DeepReadonlyOption recurses through the JsonValue type of mcpServers
      // (TS2589), so the entry hides the key from its static type; the runtime still sees it.
      const entry = {
        harness: 'claude',
        isolation: 'inherit',
        mcpServers: { tracker: { command: 'tracker', env: { TOKEN: token } } },
      } as { readonly harness: 'claude'; readonly isolation: 'inherit' };
      return defineWorkflow({
        ...base,
        requireGrants: true,
        roster: defineRoster({ P: entry }),
        async run(ctx) {
          return (await ctx.roster.P.text('pending', { prompt })).output;
        },
      });
    };
    const { invoke, harness } = fake();
    invoke.mockRejectedValue(new Error('offline'));
    const options = { stateDir, runId, input: null, harness };
    await expect(runs.run(sensitive('token'), { ...options, grants: ['P'] })).rejects.toThrow(
      'offline',
    );
    // Entry digests include the harness pin, so the profile-era constant does not apply.
    expect((await readRun({ stateDir, runId })).grantedProfiles?.['P']).toMatch(/^[a-f0-9]{64}$/u);
    // The saved entry grant keeps its old pin; passing --grant P again would re-pin the new value.
    await expect(runs.run(sensitive('rotated'), { ...options, resume: true })).rejects.toThrow(
      'Retry with --grant P',
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    invoke.mockResolvedValue(reply);
    await expect(
      runs.run(sensitive('rotated'), { ...options, resume: true, grants: ['all'] }),
    ).resolves.toMatchObject({ status: 'completed' });
  });

  it.for(['P', 'all'])(
    'refuses a saved entry grant whose sensitive registered option rotated, until --grant %s',
    async (grant, { stateDir, runs }) => {
      const vault = defineHarness({
        name: 'vault',
        revision: 1,
        options: z.object({
          prompt: z.string(),
          headers: z.record(z.string(), z.string()).optional(),
          token: z.string().optional(),
        }),
        capabilities: { structuredOutput: 'none' },
        capabilityKeys: ['headers'],
        sensitiveOptions: ['headers', 'token'],
        access: (options) => (options.headers ? 'write' : 'none'),
      });
      const vaultWorkflow = (header: string) =>
        defineWorkflow({
          ...base,
          requireGrants: true,
          harnesses: [vault],
          roster: defineRoster(
            { P: { harness: 'vault', headers: { Authorization: header }, token: 'token' } },
            { harnesses: [vault] },
          ),
          async run(ctx) {
            return (await ctx.roster.P.text('pending', { prompt })).output;
          },
        });
      const invoke = vi.fn<HarnessAdapter['invoke']>().mockRejectedValue(new Error('offline'));
      const options = { stateDir, runId, input: null, adapters: { vault: { invoke } } };
      await expect(
        runs.run(vaultWorkflow('header'), { ...options, grants: ['P'] }),
      ).rejects.toThrow('offline');
      expect((await readRun({ stateDir, runId })).grantedProfiles?.['P']).toMatch(
        /^[a-f0-9]{64}$/u,
      );
      await expect(
        runs.run(vaultWorkflow('rotated'), { ...options, resume: true }),
      ).rejects.toThrow('Retry with --grant P');
      expect(invoke).toHaveBeenCalledTimes(1);
      invoke.mockResolvedValue(reply);
      await expect(
        runs.run(vaultWorkflow('rotated'), { ...options, resume: true, grants: [grant] }),
      ).resolves.toMatchObject({ status: 'completed' });
    },
  );
});

// ADR 0063 §5 (#577) on entries: grants, pins and the run-level flag are opt-in. Every refusal here
// is the launch preflight's: Fixer is a declared role, so it is refused before the body runs.
describe('requireGrants opt-in on entries (#577)', () => {
  it('runs a write entry without a grant by default', async ({ stateDir, runs }) => {
    const { invoke, harness } = fake();
    const run = await runs.run(fixerWorkflow(), { stateDir, runId, input: null, harness });
    expect(run.status).toBe('completed');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0].options).toMatchObject({ tools: ['Read', 'Edit'] });
    const saved = await readRun({ stateDir, runId });
    expect(saved.grants).toEqual([]);
    expect(saved).not.toHaveProperty('requireGrants');
    expect(saved.capabilities).toMatchObject({ requiredGrants: [], strictProfiles: false });
    expect(saved.capabilities?.profiles['Fixer']?.access).toBe('write');
  });

  it('records and pins entry grants with the layer off and still rejects unknown names', async ({
    stateDir,
    runs,
  }) => {
    const { harness } = fake();
    await runs.run(fixerWorkflow(), { stateDir, runId, input: null, harness, grants: ['Fixer'] });
    const saved = await readRun({ stateDir, runId });
    expect(saved.grants).toEqual(['Fixer']);
    const entry = resolveCapabilities(fixerWorkflow()).profiles['Fixer'];
    if (!entry) throw new Error('Fixer missing');
    expect(saved.grantedProfiles).toEqual({ Fixer: profileGrantDigest(entry) });
    await expect(
      runs.run(fixerWorkflow(), { stateDir, runId: 'typo', input: null, grants: ['Fixr'] }),
    ).rejects.toThrow('Unknown grant: Fixr.');
  });

  it('keeps the run-level flag across resumes and does not pass it to a fork', async ({
    stateDir,
    runs,
  }) => {
    // A first launch refused at the preflight leaves no record, so the flag would have nothing to
    // stick to. Start from a run that exists: the layer is off and the call fails, then resumes
    // add the flag, which takes the preflight's existing-record path.
    const { invoke, harness } = fake();
    invoke.mockRejectedValueOnce(new Error('offline'));
    const options = { stateDir, runId, input: null, harness };
    await expect(runs.run(fixerWorkflow(), options)).rejects.toThrow('offline');
    await expect(
      runs.run(fixerWorkflow(), { ...options, resume: true, requireGrants: true }),
    ).rejects.toBeInstanceOf(GrantRequiredError);
    expect((await readRun({ stateDir, runId })).requireGrants).toBe(true);
    // A resume without the option keeps the layer on, so the ungranted entry is refused again.
    await expect(runs.run(fixerWorkflow(), { ...options, resume: true })).rejects.toThrow(
      '--grant Fixer',
    );
    // requireGrants: false does not turn it off either.
    await expect(
      runs.run(fixerWorkflow(), { ...options, resume: true, requireGrants: false }),
    ).rejects.toThrow('--grant Fixer');
    expect(invoke).toHaveBeenCalledTimes(1);
    // A fork is a new run: it does not inherit the flag and needs no grant.
    await expect(
      runs.run(fixerWorkflow(), { ...options, runId: 'fork', forkFrom: { runId } }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(await readRun({ stateDir, runId: 'fork' })).not.toHaveProperty('requireGrants');
    expect(invoke).toHaveBeenCalledTimes(2);
    // The emitted grant resume completes without repeating the flag.
    await expect(
      runs.run(fixerWorkflow(), { ...options, resume: true, grants: ['Fixer'] }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect((await readRun({ stateDir, runId })).requireGrants).toBe(true);
  });

  it('refreshes the manifest when the flag is first given to a completed run', async ({
    stateDir,
    runs,
  }) => {
    const { invoke, harness } = fake();
    const options = { stateDir, runId, input: null, harness };
    await runs.run(fixerWorkflow(), options);
    const first = await readRun({ stateDir, runId });
    expect(first).not.toHaveProperty('requireGrants');
    expect(first.capabilities?.requiredGrants).toEqual([]);
    const resumed = await runs.run(fixerWorkflow(), {
      ...options,
      resume: true,
      requireGrants: true,
      grants: ['Fixer'],
    });
    expect(resumed.requireGrants).toBe(true);
    expect(resumed.capabilities?.requiredGrants).toEqual(['Fixer']);
    const saved = await readRun({ stateDir, runId });
    expect(saved.requireGrants).toBe(true);
    expect(saved.capabilities?.requiredGrants).toEqual(['Fixer']);
    // A later resume with no options leaves the manifest as it is.
    await runs.run(fixerWorkflow(), { ...options, resume: true });
    const again = await readRun({ stateDir, runId });
    expect(again.requireGrants).toBe(true);
    expect(again.capabilities).toEqual(saved.capabilities);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('refreshes the manifest of a completed run after a grant refusal already saved the flag', async ({
    stateDir,
    runs,
  }) => {
    const { invoke, harness } = fake();
    const options = { stateDir, runId, input: null, harness };
    await runs.run(fixerWorkflow(), options);
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(
      runs.run(fixerWorkflow(), { ...options, resume: true, requireGrants: true }),
    ).rejects.toBeInstanceOf(GrantRequiredError);
    const refused = await readRun({ stateDir, runId });
    expect(refused.requireGrants).toBe(true);
    expect(refused.capabilities?.requiredGrants).toEqual([]);
    const resumed = await runs.run(fixerWorkflow(), {
      ...options,
      resume: true,
      grants: ['Fixer'],
    });
    expect(resumed.requireGrants).toBe(true);
    expect(resumed.capabilities?.requiredGrants).toEqual(['Fixer']);
    const saved = await readRun({ stateDir, runId });
    expect(saved.requireGrants).toBe(true);
    expect(saved.capabilities?.requiredGrants).toEqual(['Fixer']);
    await runs.run(fixerWorkflow(), { ...options, resume: true });
    expect((await readRun({ stateDir, runId })).capabilities).toEqual(saved.capabilities);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('saves the run-level flag when a resume that first gives it is refused before the body', async ({
    stateDir,
    runs,
  }) => {
    const { invoke, harness } = fake();
    invoke.mockRejectedValueOnce(new Error('offline'));
    const options = { stateDir, runId, input: null, harness };
    // With the layer off the write entry runs ungranted, and this run fails.
    await expect(runs.run(fixerWorkflow(), options)).rejects.toThrow('offline');
    const failed = await readRun({ stateDir, runId });
    expect(failed.status).toBe('failed');
    expect(failed).not.toHaveProperty('requireGrants');
    const refused: unknown = await runs
      .run(fixerWorkflow(), { ...options, resume: true, requireGrants: true })
      .catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(GrantRequiredError);
    expect((refused as Error).message).toBe(fixerMessage);
    expect(invoke).toHaveBeenCalledTimes(1);
    // Only the flag is saved: the status, grants and policy are those of the failed run.
    const saved = await readRun({ stateDir, runId });
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
    await expect(runs.run(fixerWorkflow(), { ...options, resume: true })).rejects.toThrow(
      GrantRequiredError,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(
      runs.run(fixerWorkflow(), { ...options, resume: true, grants: ['Fixer'] }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(invoke).toHaveBeenCalledTimes(2);
    const completed = await readRun({ stateDir, runId });
    expect(completed.requireGrants).toBe(true);
    expect(completed.capabilities?.requiredGrants).toEqual(['Fixer']);
  });

  it.for([
    {
      entries: 'one entry',
      workflow: fixerWorkflow,
      message:
        'Role Fixer requires write access. Retry with --require-grants and --grant Fixer, --grant write, or --grant all.',
    },
    {
      entries: 'every missing entry',
      workflow: pairWorkflow,
      message:
        'Roles Builder and Fixer require write access. Retry with --require-grants and --grant Builder --grant Fixer, --grant write, or --grant all.',
    },
  ])(
    'repeats --require-grants in the retry text for $entries when the refusal cannot save the flag',
    async ({ workflow, message }, { stateDir, runs }) => {
      const definition = workflow();
      const { invoke, harness } = fake();
      invoke.mockRejectedValueOnce(new Error('offline'));
      await expect(runs.run(definition, { stateDir, runId, input: null, harness })).rejects.toThrow(
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
      const refused: unknown = await runs
        .run(definition, {
          stateDir,
          runId,
          input: null,
          harness,
          store,
          resume: true,
          requireGrants: true,
        })
        .catch((cause: unknown) => cause);
      expect(refused).toBeInstanceOf(AggregateError);
      const grant = (refused as AggregateError).errors[0] as unknown;
      expect(grant).toBeInstanceOf(GrantRequiredError);
      expect((grant as Error).message).toBe(message);
      expect((refused as Error).message).toContain('disk full');
      expect(await readRun({ stateDir, runId })).not.toHaveProperty('requireGrants');
    },
  );
});
