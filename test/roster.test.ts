// Rosters (ADR 0063 sections 3-4, #579): defineRoster entries compile to declared roles pinned to
// one harness, and ctx.roster.Name is that harness's client bound to the entry's profile, so its
// calls resolve, fingerprint and record as a `profile: 'Name'` call does.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect } from 'vitest';
import {
  capabilityManifest,
  defineHarness,
  defineRoster,
  defineWorkflow,
  HarnessError,
  readRun,
  z,
  type AgentRequest,
  type HarnessAdapter,
  type StepRecord,
} from '../src/index.js';
import {
  capabilityManifestSchema,
  profileGrantDigest,
  requireGrant,
  resolveCapabilities,
} from '../src/workflow/runtime/profiles.js';
import { compileRoster } from '../src/workflow/runtime/roster.js';
import { it } from './setup/state-dir.js';

const prompt = 'review the diff';
const Review = z.object({ verdict: z.string() });
const base = { version: '1', input: z.null(), output: z.unknown() } as const;
const reply = { text: '{"verdict":"ok"}', sessionId: null };
const third = defineHarness({
  name: 'third',
  revision: 1,
  options: z.object({
    prompt: z.string(),
    thinking: z.string().optional(),
    addDirs: z.array(z.string()).optional(),
    timeoutMs: z.number().positive().optional(),
  }),
  capabilities: { structuredOutput: 'native' },
  access: (options) => (options.thinking === 'tools' ? 'write' : 'read'),
  policy: ['timeoutMs'],
});

const roster = defineRoster(
  {
    Reviewer: {
      harness: 'claude',
      model: 'opus',
      effort: 'high',
      tools: ['Read', 'Grep'],
      maxTurns: 40,
      appendSystemPrompt: 'Review carefully.',
      description: 'Reads and reviews.',
    },
    Mechanic: {
      harness: 'codex',
      model: 'gpt-5-codex',
      effort: 'high',
      sandbox: 'workspace-write',
      timeoutMs: 1_800_000,
    },
    Clerk: { harness: 'claude', model: 'haiku', effort: 'low' },
    Scout: { harness: 'third', thinking: 'deep' },
  },
  { harnesses: [third] },
);

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'choir-roster-'));
  directories.push(directory);
  return directory;
}

/** A capturing adapter shared by the built-in fallback and the registered harness. */
function capture(text = reply.text) {
  const requests: AgentRequest[] = [];
  const adapter: HarnessAdapter = {
    // eslint-disable-next-line @typescript-eslint/require-await -- an immediate fake adapter
    invoke: async (request) => {
      requests.push(request);
      return { text, sessionId: null };
    },
  };
  return {
    requests,
    adapter,
    harness: {
      invoke: (request: AgentRequest) => adapter.invoke(request, new AbortController().signal),
    },
  };
}

function attempt(step: StepRecord | undefined) {
  const history = step?.attemptHistory ?? [];
  return history[history.length - 1];
}

describe('defineRoster', () => {
  it('rejects names that are not identifiers of at most 64 characters', () => {
    for (const name of ['review-er', '1st', '_x', 'a b', `A${'b'.repeat(64)}`])
      expect(() => defineRoster({ [name]: { harness: 'claude' } } as never)).toThrow(
        'must be an identifier',
      );
    expect(() =>
      defineRoster({ [`A${'b'.repeat(63)}`]: { harness: 'claude' } } as never),
    ).not.toThrow();
  });

  it('rejects built-in preset names and reserved words', () => {
    for (const name of ['text', 'readonly', 'edit', 'all', 'none', 'read', 'write', 'exec'])
      expect(() => defineRoster({ [name]: { harness: 'claude' } } as never)).toThrow(
        `Roster entry name ${name} is reserved`,
      );
    expect(() => defineRoster({ constructor: { harness: 'claude' } } as never)).toThrow(
      'is reserved',
    );
  });

  it('requires a known harness: claude, codex or one passed in options.harnesses', () => {
    expect(() => defineRoster({ Scout: { harness: 'third' } } as never)).toThrow(
      'Roster entry Scout uses unknown harness third; pass its definition in defineRoster options.harnesses.',
    );
    expect(() => defineRoster({ Scout: {} } as never)).toThrow('must name its harness');
    expect(() =>
      defineRoster({ Scout: { harness: 'third' } }, { harnesses: [third] }),
    ).not.toThrow();
  });

  it.for([
    'prompt',
    'schema',
    'cwd',
    'worktree',
    'onError',
    'retry',
    'images',
    'profile',
    'extends',
    'access',
    'claude',
    'codex',
    'harnesses',
    'addDirRoots',
  ])('refuses the %s key', (key) => {
    expect(() => defineRoster({ Entry: { harness: 'claude', [key]: 'x' } } as never)).toThrow(
      `Roster entry Entry cannot set ${key}:`,
    );
  });

  it('returns a deep-frozen copy', () => {
    const tools = ['Read'];
    const frozen = defineRoster({ Reader: { harness: 'claude', tools } });
    tools.push('Bash');
    expect(frozen.Reader.tools).toEqual(['Read']);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.Reader)).toBe(true);
    expect(Object.isFrozen(frozen.Reader.tools)).toBe(true);
    expect({ ...frozen }).toEqual({ Reader: { harness: 'claude', tools: ['Read'] } });
  });

  it('compiles entries to profiles in the pinned harness block, limits top-level', () => {
    expect(compileRoster({ roster, harnesses: [third] })).toEqual({
      profiles: {
        Reviewer: {
          description: 'Reads and reviews.',
          maxTurns: 40,
          claude: {
            model: 'opus',
            effort: 'high',
            tools: ['Read', 'Grep'],
            appendSystemPrompt: 'Review carefully.',
          },
        },
        Mechanic: {
          timeoutMs: 1_800_000,
          codex: { model: 'gpt-5-codex', effort: 'high', sandbox: 'workspace-write' },
        },
        Clerk: { claude: { model: 'haiku', effort: 'low' } },
        Scout: { harnesses: { third: { thinking: 'deep' } } },
      },
      pins: { Reviewer: 'claude', Mechanic: 'codex', Clerk: 'claude', Scout: 'third' },
    });
  });
});

describe('definition errors', () => {
  const workflow = (extra: object) =>
    defineWorkflow({
      ...base,
      name: 'roster-errors',
      harnesses: [third],
      run: () => Promise.resolve(null),
      ...extra,
    } as never);

  it('rejects an entry named like a declared profile, at manifest and at run', async ({
    stateDir,
    runs,
  }) => {
    const definition = workflow({
      roster,
      profiles: { Reviewer: { extends: 'readonly' } },
    });
    expect(() => capabilityManifest(definition)).toThrow(
      'Roster entry Reviewer has the same name as a declared profile.',
    );
    await expect(runs.run(definition, { stateDir, runId: 'collide', input: null })).rejects.toThrow(
      'Roster entry Reviewer has the same name as a declared profile.',
    );
  });

  it('rejects a preset or reserved name even without defineRoster', () => {
    for (const name of ['text', 'readonly', 'edit', 'write'])
      expect(() =>
        capabilityManifest(workflow({ roster: { [name]: { harness: 'claude' } } })),
      ).toThrow(`Roster entry name ${name} is reserved`);
  });

  it('rejects defaults.profile naming an entry, and a profile extending one', () => {
    expect(() =>
      capabilityManifest(workflow({ roster, defaults: { profile: 'Reviewer' } })),
    ).toThrow('defaults.profile cannot name roster entry Reviewer');
    expect(() =>
      capabilityManifest(workflow({ roster, profiles: { wider: { extends: 'Reviewer' } } })),
    ).toThrow('Profile wider cannot extend roster entry Reviewer');
  });

  it('rejects a registered harness the workflow does not declare', () => {
    expect(() =>
      capabilityManifest(
        defineWorkflow({ ...base, name: 'no-third', roster, run: () => Promise.resolve(null) }),
      ),
    ).toThrow(
      "Roster entry Scout uses harness third, which workflow no-third does not declare; add its definition to the workflow's harnesses.",
    );
  });

  it('rejects an option the pinned harness does not accept', () => {
    expect(() =>
      capabilityManifest(
        workflow({ roster: { Odd: { harness: 'claude', sandbox: 'workspace-write' } } }),
      ),
    ).toThrow(/sandbox/u);
    expect(() =>
      capabilityManifest(workflow({ roster: { Odd: { harness: 'third', tools: ['Read'] } } })),
    ).toThrow(/tools/u);
  });

  it('rejects a roster that is not an object', () => {
    expect(() => capabilityManifest(workflow({ roster: [] }))).toThrow(
      'A roster must be an object of named entries.',
    );
  });
});

describe('capability manifest', () => {
  const definition = defineWorkflow({
    ...base,
    name: 'roster-manifest',
    harnesses: [third],
    roster,
    defaults: { maxTurns: 12, claude: { model: 'sonnet' } },
    run: () => Promise.resolve(null),
  });

  it('lists entries with their harness, pinned access, limits and the applied baseline', () => {
    const manifest = capabilityManifest(definition);
    expect(capabilityManifestSchema.parse(manifest)).toEqual(manifest);
    const { Reviewer, Mechanic, Clerk, Scout } = manifest.profiles;
    expect(Reviewer).toMatchObject({
      name: 'Reviewer',
      harness: 'claude',
      access: 'read',
      description: 'Reads and reviews.',
      maxTurns: 40,
      maxBudgetUsd: 0.5,
      timeoutMs: 300_000,
      expectsToolUse: true,
      claude: { model: 'opus', effort: 'high', tools: ['Read', 'Grep'] },
      codex: { sandbox: 'read-only' },
    });
    expect(Mechanic).toMatchObject({
      harness: 'codex',
      access: 'write',
      timeoutMs: 1_800_000,
      maxTurns: 12,
      expectsToolUse: true,
      codex: { model: 'gpt-5-codex', effort: 'high', sandbox: 'workspace-write' },
      // The unpinned block stays at the text baseline: defaults.claude does not reach it.
      claude: { tools: [], allowedTools: [] },
    });
    expect(Mechanic?.claude).not.toHaveProperty('model');
    expect(Reviewer?.claude).toMatchObject({ model: 'opus' });
    expect(Clerk?.harnesses).toEqual({ third: {} });
    // A tool-less Claude entry is labelled by Claude alone, not raised to Codex's read baseline.
    expect(Clerk).toMatchObject({
      harness: 'claude',
      access: 'none',
      claudeAccess: 'none',
      codexAccess: 'read',
      expectsToolUse: false,
      maxTurns: 12,
      claude: { model: 'haiku', effort: 'low', tools: [] },
    });
    expect(Scout).toMatchObject({
      harness: 'third',
      access: 'read',
      harnessAccess: { third: 'read' },
      harnesses: { third: { thinking: 'deep' } },
    });
    // Profiles and built-ins carry no pin.
    expect(manifest.profiles['text']).not.toHaveProperty('harness');
    expect(manifest.defaults).not.toHaveProperty('harness');
  });

  it('redacts free-form controls of an entry as for any profile', () => {
    const reviewer = capabilityManifest(definition).profiles['Reviewer'];
    expect(reviewer?.claude).not.toHaveProperty('appendSystemPrompt');
    expect(reviewer?.redacted?.claude?.appendSystemPrompt?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('lists elevated entries in requiredGrants only under requireGrants', () => {
    expect(capabilityManifest(definition).requiredGrants).toEqual([]);
    expect(capabilityManifest(definition, { requireGrants: true }).requiredGrants).toEqual([
      'Mechanic',
    ]);
  });
});

describe('ctx.roster calls', () => {
  it('sends the request and fingerprint of a raw call that spells the entry', async ({ runs }) => {
    const sides = [];
    for (const raw of [true, false]) {
      const stateDir = await tempDir();
      const fake = capture();
      const definition = defineWorkflow({
        ...base,
        name: 'roster-parity',
        harnesses: [third],
        roster,
        async run(ctx) {
          if (raw)
            return [
              await ctx.claude.value('review', {
                prompt,
                schema: Review,
                model: 'opus',
                effort: 'high',
                tools: ['Read', 'Grep'],
                maxTurns: 40,
                appendSystemPrompt: 'Review carefully.',
              }),
              await ctx.codex.text('fix', {
                prompt,
                model: 'gpt-5-codex',
                effort: 'high',
                sandbox: 'workspace-write',
                timeoutMs: 1_800_000,
              }),
              await ctx.agent('third').text('scout', { prompt, thinking: 'deep' }),
            ].map((value) =>
              typeof value === 'object' && 'output' in value ? value.output : value,
            );
          return [
            await ctx.roster.Reviewer.value('review', { prompt, schema: Review }),
            (await ctx.roster.Mechanic.text('fix', { prompt })).output,
            (await ctx.roster.Scout.text('scout', { prompt })).output,
          ];
        },
      });
      const result = await runs.run(definition, {
        stateDir,
        runId: 'parity',
        input: null,
        harness: fake.harness,
        adapters: { third: fake.adapter },
      });
      sides.push({ result, fake, record: await readRun({ stateDir, runId: 'parity' }) });
    }
    const [left, right] = sides as [(typeof sides)[0], (typeof sides)[0]];
    expect(right.fake.requests).toEqual(left.fake.requests);
    expect(right.result.output).toEqual(left.result.output);
    for (const id of ['review', 'fix', 'scout'])
      expect(right.record.steps[id]?.fingerprint).toBe(left.record.steps[id]?.fingerprint);
    // The roster call records its entry as the role and its limits as profile values.
    expect(attempt(right.record.steps['review'])).toMatchObject({
      profile: 'Reviewer',
      sources: { maxTurns: 'profile:Reviewer' },
    });
    expect(attempt(left.record.steps['review'])).toMatchObject({
      profile: 'text',
      sources: { maxTurns: 'call-site' },
    });
    expect(right.fake.requests.map((request) => request.harness)).toEqual([
      'claude',
      'codex',
      'third',
    ]);
  });

  it('fills a required registered option from the entry', async ({ stateDir, runs }) => {
    const fake = capture('ok');
    const moded = defineHarness({
      name: 'moded',
      revision: 1,
      options: z.object({ prompt: z.string(), mode: z.string() }),
      capabilities: { structuredOutput: 'native' },
      access: () => 'read',
    });
    const definition = defineWorkflow({
      ...base,
      name: 'roster-required',
      harnesses: [moded],
      roster: defineRoster({ Deep: { harness: 'moded', mode: 'deep' } }, { harnesses: [moded] }),
      async run(ctx) {
        return (await ctx.roster.Deep.text('think', { prompt })).output;
      },
    });
    const result = await runs.run(definition, {
      stateDir,
      runId: 'required',
      input: null,
      adapters: { moded: fake.adapter },
    });
    expect(result.output).toBe('ok');
    expect(fake.requests[0]).toMatchObject({ harness: 'moded', options: { prompt, mode: 'deep' } });
    const record = await readRun({ stateDir, runId: 'required' });
    expect(attempt(record.steps['think'])?.profile).toBe('Deep');
  });

  it('validates a registered call with the entry limits, outside its identity', async ({
    runs,
  }) => {
    // The schema requires timeoutMs; maxTurns is a declared option but not harness policy, so it
    // would enter the identity if the entry's value stayed in the resolved options.
    const timed = defineHarness({
      name: 'timed',
      revision: 1,
      options: z.object({
        prompt: z.string(),
        timeoutMs: z.number().positive(),
        maxTurns: z.number().int().positive().optional(),
      }),
      capabilities: { structuredOutput: 'native' },
      access: () => 'read',
    });
    const limited = defineWorkflow({
      ...base,
      name: 'roster-limits',
      harnesses: [timed],
      roster: defineRoster(
        { Timed: { harness: 'timed', timeoutMs: 1_000, maxTurns: 5 } },
        { harnesses: [timed] },
      ),
      async run(ctx) {
        return (await ctx.roster.Timed.text('think', { prompt })).output;
      },
    });
    const open = defineWorkflow({
      ...base,
      name: 'roster-limits',
      harnesses: [timed],
      roster: defineRoster({ Timed: { harness: 'timed' } }, { harnesses: [timed] }),
      async run(ctx) {
        return (await ctx.roster.Timed.text('think', { prompt, timeoutMs: 1_000 })).output;
      },
    });
    const sides = [];
    for (const definition of [limited, open]) {
      const stateDir = await tempDir();
      const fake = capture('ok');
      const result = await runs.run(definition, {
        stateDir,
        runId: 'limits',
        input: null,
        adapters: { timed: fake.adapter },
      });
      expect(result.output).toBe('ok');
      sides.push({ fake, record: await readRun({ stateDir, runId: 'limits' }) });
    }
    const [left, right] = sides as [(typeof sides)[0], (typeof sides)[0]];
    expect(attempt(left.record.steps['think'])).toMatchObject({
      policy: { timeoutMs: 1_000, maxTurns: 5 },
      sources: { timeoutMs: 'profile:Timed', maxTurns: 'profile:Timed' },
    });
    expect(left.fake.requests[0]?.options).toMatchObject({ timeoutMs: 1_000, maxTurns: 5 });
    expect(left.record.steps['think']?.fingerprint).toBe(right.record.steps['think']?.fingerprint);
  });

  it('refuses a pinned entry on another harness', async ({ stateDir, runs }) => {
    const definition = defineWorkflow({
      ...base,
      name: 'roster-pin',
      roster: defineRoster({ Reviewer: { harness: 'claude', tools: ['Read'] } }),
      async run(ctx) {
        return (await ctx.codex.text('wrong', { prompt, profile: 'Reviewer' } as never)).output;
      },
    });
    await expect(
      runs.run(definition, { stateDir, runId: 'pin', input: null, harness: capture().harness }),
    ).rejects.toThrow('Roster entry Reviewer is pinned to harness claude; it cannot run on codex.');
  });

  it('appends call addDirs to the entry, lets the call deadline win, and keeps ctx.within', async ({
    stateDir,
    runs,
  }) => {
    const fake = capture('ok');
    const definition = defineWorkflow({
      ...base,
      name: 'roster-placement',
      harnesses: [third],
      roster: defineRoster(
        {
          Reader: { harness: 'claude', tools: ['Read'], addDirs: ['docs'], timeoutMs: 1_000 },
          Fixer: { harness: 'codex', addDirs: ['out'] },
          Probe: { harness: 'third', addDirs: ['a'] },
        },
        { harnesses: [third] },
      ),
      async run(ctx) {
        await ctx.roster.Reader.text('read', { prompt, addDirs: ['extra'], timeoutMs: 2_000 });
        await ctx.roster.Reader.text('plain', { prompt });
        await ctx.roster.Fixer.text('fix', { prompt, addDirs: ['more'] });
        await ctx.roster.Probe.text('probe', { prompt, addDirs: ['b'] });
        await ctx.within('outer').roster.Reader.text('inner', { prompt });
        return null;
      },
    });
    await runs.run(definition, {
      stateDir,
      runId: 'placement',
      input: null,
      harness: fake.harness,
      adapters: { third: fake.adapter },
    });
    const sent = Object.fromEntries(fake.requests.map((request) => [request.stepId, request]));
    expect(sent['read']?.options).toMatchObject({ addDirs: ['docs', 'extra'], timeoutMs: 2_000 });
    expect(sent['plain']?.options).toMatchObject({ addDirs: ['docs'], timeoutMs: 1_000 });
    expect(sent['fix']?.options).toMatchObject({ addDirs: ['out', 'more'] });
    expect(sent['probe']?.options).toMatchObject({ addDirs: ['a', 'b'] });
    expect(Object.keys(sent)).toContain('outer/inner');
    const record = await readRun({ stateDir, runId: 'placement' });
    expect(attempt(record.steps['read'])?.sources).toMatchObject({ timeoutMs: 'call-site' });
    expect(attempt(record.steps['plain'])?.sources).toMatchObject({
      timeoutMs: 'profile:Reader',
    });
    expect(attempt(record.steps['outer/inner'])?.profile).toBe('Reader');
  });

  it('resolves an inline child against its own roster', async ({ stateDir, runs }) => {
    const fake = capture('ok');
    const child = defineWorkflow({
      ...base,
      name: 'child',
      roster: defineRoster({ Reviewer: { harness: 'codex', model: 'gpt-5-codex' } }),
      async run(ctx) {
        const untyped = ctx.roster as Readonly<Record<string, unknown>>;
        const names: readonly string[] = ['Clerk', 'toString', 'constructor'];
        return {
          output: (await ctx.roster.Reviewer.text('review', { prompt })).output,
          missing: names.every((name) => untyped[name] === undefined),
        };
      },
    });
    const parent = defineWorkflow({
      ...base,
      name: 'parent',
      roster: defineRoster({
        Reviewer: { harness: 'claude', model: 'opus' },
        Clerk: { harness: 'claude' },
      }),
      async run(ctx) {
        const inner = await ctx.workflow('child', child, null);
        await ctx.roster.Reviewer.text('after', { prompt });
        return inner;
      },
    });
    const result = await runs.run(parent, {
      stateDir,
      runId: 'children',
      input: null,
      harness: fake.harness,
    });
    expect(result.output).toEqual({ output: 'ok', missing: true });
    const sent = Object.fromEntries(fake.requests.map((request) => [request.stepId, request]));
    expect(sent['child/review']).toMatchObject({
      harness: 'codex',
      options: { model: 'gpt-5-codex' },
    });
    expect(sent['after']).toMatchObject({ harness: 'claude', options: { model: 'opus' } });
  });

  it('gives a workflow without a roster an empty, frozen ctx.roster', async ({
    stateDir,
    runs,
  }) => {
    const definition = defineWorkflow({
      ...base,
      name: 'no-roster',
      run: (ctx) =>
        Promise.resolve({
          keys: Object.keys(ctx.roster),
          frozen: Object.isFrozen(ctx.roster),
          prototype: Object.getPrototypeOf(ctx.roster) as unknown,
        }),
    });
    const result = await runs.run(definition, { stateDir, runId: 'empty', input: null });
    expect(result.output).toEqual({ keys: [], frozen: true, prototype: null });
  });
});

describe('launch overrides and grants', () => {
  it('raises an entry limit on resume with a profile override and records the entry', async ({
    stateDir,
    runs,
  }) => {
    const turnLimit = new HarnessError({
      harness: 'claude',
      kind: 'turn-limit',
      exit: { code: 1, signal: null },
      stderr: '',
      stdout: '',
      reason: '',
      failure: {
        reason: 'limit reached',
        subtype: 'turn-limit',
        terminalReason: null,
        apiStatus: null,
        sessionId: 'failed',
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
        turns: 40,
      },
    });
    const sent: AgentRequest[] = [];
    let fail = true;
    const harness = {
      invoke: (request: AgentRequest) => {
        sent.push(request);
        return fail ? Promise.reject(turnLimit) : Promise.resolve({ text: 'ok', sessionId: null });
      },
    };
    const definition = defineWorkflow({
      ...base,
      name: 'roster-resume',
      roster: defineRoster({ Reviewer: { harness: 'claude', tools: ['Read'], maxTurns: 40 } }),
      async run(ctx) {
        return (await ctx.roster.Reviewer.text('review', { prompt })).output;
      },
    });
    const options = { stateDir, runId: 'resume', input: null, harness };
    await expect(runs.run(definition, options)).rejects.toThrow(
      '--resume --profile Reviewer.maxTurns=',
    );
    fail = false;
    const result = await runs.run(definition, {
      ...options,
      resume: true,
      profileOverrides: [{ profile: 'Reviewer', maxTurns: 60 }],
    });
    expect(result.output).toBe('ok');
    expect(sent.map((request) => (request.options as { maxTurns?: number }).maxTurns)).toEqual([
      40, 60,
    ]);
    const last = attempt((await readRun({ stateDir, runId: 'resume' })).steps['review']);
    expect(last).toMatchObject({
      profile: 'Reviewer',
      policy: { maxTurns: 60 },
      sources: { maxTurns: 'profile-override:0' },
    });
  });

  it('needs a grant for a write-capable entry under requireGrants', async ({ stateDir, runs }) => {
    const fake = capture('ok');
    const definition = defineWorkflow({
      ...base,
      name: 'roster-grants',
      requireGrants: true,
      roster: defineRoster({
        Mechanic: { harness: 'codex', sandbox: 'workspace-write' },
        Clerk: { harness: 'claude' },
      }),
      async run(ctx) {
        await ctx.roster.Clerk.text('note', { prompt });
        return (await ctx.roster.Mechanic.text('fix', { prompt })).output;
      },
    });
    await expect(
      runs.run(definition, { stateDir, runId: 'grants', input: null, harness: fake.harness }),
    ).rejects.toThrow('--grant Mechanic, --grant write, or --grant all');
    expect(fake.requests).toEqual([]);
    const result = await runs.run(definition, {
      stateDir,
      runId: 'granted',
      input: null,
      harness: fake.harness,
      grants: ['Mechanic'],
    });
    expect(result.output).toBe('ok');
    const record = await readRun({ stateDir, runId: 'granted' });
    expect(record.capabilities?.requiredGrants).toEqual(['Mechanic']);
    expect(Object.keys(record.grantedProfiles ?? {})).toEqual(['Mechanic']);
  });

  it('pins a named grant to the harness an entry is pinned to', () => {
    const role = (
      entry: object,
      harnesses: Parameters<typeof resolveCapabilities>[0]['harnesses'] = [],
    ) => {
      const resolved = resolveCapabilities({
        name: 'repinned',
        harnesses,
        roster: { Worker: entry },
      }).profiles['Worker'];
      if (!resolved) throw new Error('Worker did not resolve.');
      return resolved;
    };
    // Bare Claude and Codex entries have the same tools, rules and sandbox; only the pin differs.
    const claude = role({ harness: 'claude' });
    const codex = role({ harness: 'codex' });
    expect(profileGrantDigest(codex)).not.toBe(profileGrantDigest(claude));
    expect(() => {
      requireGrant(codex, ['Worker'], { Worker: profileGrantDigest(claude) }, 'write');
    }).toThrow('--grant Worker');
    // Two write-capable registered harnesses with identical controls: the grant follows the pin.
    const writer = (name: string) => defineHarness({ ...third, name, access: () => 'write' });
    const alpha = writer('alpha');
    const beta = writer('beta');
    const granted = role({ harness: 'alpha' }, [alpha, beta]);
    const repinned = role({ harness: 'beta' }, [alpha, beta]);
    expect(repinned.access).toBe('write');
    const pins = { Worker: profileGrantDigest(granted) };
    expect(() => {
      requireGrant(granted, ['Worker'], pins);
    }).not.toThrow();
    expect(() => {
      requireGrant(repinned, ['Worker'], pins);
    }).toThrow('--grant Worker');
    // A role without a pin keeps the digest it had before rosters, so saved grant pins hold.
    const edit = resolveCapabilities({}).profiles['edit'];
    if (!edit) throw new Error('edit did not resolve.');
    expect(profileGrantDigest(edit)).toBe(
      '4a87c86d2adce1b7712d584da2a0cf6a16c3daf76fc049310af0af38ef53f5f9',
    );
  });

  it('delegates a shared roster entry to an inline child under requireGrants', async ({
    stateDir,
    runs,
  }) => {
    const fake = capture('ok');
    const shared = defineRoster({ Mechanic: { harness: 'codex', sandbox: 'workspace-write' } });
    const child = defineWorkflow({
      ...base,
      name: 'child',
      roster: shared,
      async run(ctx) {
        return (await ctx.roster.Mechanic.text('fix', { prompt })).output;
      },
    });
    const wider = defineWorkflow({
      ...base,
      name: 'wider-child',
      roster: defineRoster({
        Mechanic: { harness: 'codex', sandbox: 'workspace-write', networkAccess: true },
      }),
      async run(ctx) {
        return (await ctx.roster.Mechanic.text('fix', { prompt })).output;
      },
    });
    const parent = (inner: typeof child | typeof wider) =>
      defineWorkflow({
        ...base,
        name: 'parent',
        requireGrants: true,
        roster: shared,
        run: (ctx) => ctx.workflow('child', inner, null),
      });
    const result = await runs.run(parent(child), {
      stateDir,
      runId: 'delegated',
      input: null,
      harness: fake.harness,
      grants: ['Mechanic'],
    });
    expect(result.output).toBe('ok');
    await expect(
      runs.run(parent(wider), {
        stateDir,
        runId: 'exceeds',
        input: null,
        harness: fake.harness,
        grants: ['Mechanic'],
      }),
    ).rejects.toThrow('Child profile wider-child.Mechanic exceeds parent profile Mechanic');
  });

  it('keeps defaults off unpinned blocks and holds a child to the parent entry pin', async ({
    stateDir,
    runs,
  }) => {
    const fake = capture('ok');
    const defaults = { codex: { sandbox: 'workspace-write' } } as const;
    const child = defineWorkflow({
      ...base,
      name: 'writer-child',
      defaults,
      roster: defineRoster({ Reviewer: { harness: 'codex', sandbox: 'workspace-write' } }),
      async run(ctx) {
        return (await ctx.roster.Reviewer.text('fix', { prompt })).output;
      },
    });
    const parent = defineWorkflow({
      ...base,
      name: 'reader-parent',
      requireGrants: true,
      defaults,
      roster: defineRoster({ Reviewer: { harness: 'claude', tools: ['Read'] } }),
      run: (ctx) => ctx.workflow('child', child, null),
    });
    // The Claude reader's Codex block stays read-only despite defaults.codex, so its pinned
    // access needs no grant and carries no Codex sandbox to a child.
    const manifest = capabilityManifest(parent, { requireGrants: true });
    expect(manifest.profiles['Reviewer']).toMatchObject({
      harness: 'claude',
      access: 'read',
      codexAccess: 'read',
      codex: { sandbox: 'read-only' },
    });
    expect(manifest.requiredGrants).toEqual(['text']);
    await expect(
      runs.run(parent, {
        stateDir,
        runId: 'repinned',
        input: null,
        harness: fake.harness,
        grants: ['text'],
      }),
    ).rejects.toThrow(
      'Child profile writer-child.Reviewer exceeds parent profile Reviewer: harness (codex; the parent role is pinned to claude)',
    );
    expect(fake.requests).toEqual([]);
  });

  it('refuses a child above a pinned parent entry, and ignores restrictions it cannot run under', async ({
    stateDir,
    runs,
  }) => {
    const fake = capture('ok');
    const reader = defineRoster({ Reviewer: { harness: 'claude', tools: ['Read'] } });
    const editor = defineWorkflow({
      ...base,
      name: 'editor-child',
      roster: defineRoster({ Reviewer: { harness: 'claude', tools: ['Read', 'Edit'] } }),
      async run(ctx) {
        return (await ctx.roster.Reviewer.text('edit', { prompt })).output;
      },
    });
    const parent = defineWorkflow({
      ...base,
      name: 'reader-parent',
      requireGrants: true,
      roster: reader,
      run: (ctx) => ctx.workflow('child', editor, null),
    });
    await expect(
      runs.run(parent, { stateDir, runId: 'editor', input: null, harness: fake.harness }),
    ).rejects.toThrow('Child profile editor-child.Reviewer exceeds parent profile Reviewer');
    // A Codex entry under an unpinned parent role need not repeat Claude-only restrictions.
    const restricted = { claude: { disallowedTools: ['Bash'], strictMcpConfig: true } } as const;
    const codexChild = defineWorkflow({
      ...base,
      name: 'codex-child',
      defaults: restricted,
      roster: defineRoster({ Fixer: { harness: 'codex' } }),
      async run(ctx) {
        return (await ctx.roster.Fixer.text('fix', { prompt })).output;
      },
    });
    const unpinned = defineWorkflow({
      ...base,
      name: 'profile-parent',
      requireGrants: true,
      defaults: restricted,
      profiles: { Fixer: {} },
      run: (ctx) => ctx.workflow('child', codexChild, null),
    });
    const result = await runs.run(unpinned, {
      stateDir,
      runId: 'unpinned',
      input: null,
      harness: fake.harness,
    });
    expect(result.output).toBe('ok');
  });
});
