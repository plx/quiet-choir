import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  CliHarness,
  capabilityManifest,
  defineWorkflow,
  readRun,
  runWorkflow,
  z,
  type Harness,
  type HarnessIsolation,
} from '../src/index.js';
import { testInvocation } from './harness-invocation.js';
import { childEnvironment } from '../src/harnesses/environment.js';
import { publicCapabilityManifest } from '../src/workflow/runtime/profiles.js';
import { validateAgentOptions } from '../src/workflow/runtime/options.js';
import { legacyAgentIdentity } from '../src/workflow/runtime/legacy-agent.js';
import type { BuiltinHarnessRequestInput } from '../src/workflow/runtime/model.js';

let directory: string;
const reply = {
  text: 'ok',
  sessionId: null,
  usage: { inputTokens: null, outputTokens: null, costUsd: null },
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'choir-isolation-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function fakeBinary(): Promise<string> {
  const name = 'fixture-agent';
  await writeFile(
    join(directory, name),
    `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('--version')){console.log('fixture 1.2.3');process.exit(0);}
let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
 const names=['CLAUDECODE','CLAUDE_CODE_MESSAGING_TOKEN','CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS','CODEX_THREAD_ID','TRACEPARENT','QC_REMOVE','QC_VALUE','ANTHROPIC_API_KEY','QUIET_CHOIR_RUN_ID'];
 fs.writeFileSync('capture.json',JSON.stringify({args,input,env:Object.fromEntries(names.map(k=>[k,process.env[k]??null]))}));
 console.log(args[0]==='exec'?[JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}}),JSON.stringify({type:'turn.completed'})].join('\\n'):JSON.stringify({type:'result',subtype:'success',result:'ok'}));
});`,
    { mode: 0o700 },
  );
  return name;
}

it.each(['claude', 'codex'] as const)(
  'launches restricted %s on PATH with scrubbed host context and explicit environment edits',
  async (provider) => {
    const binary = await fakeBinary();
    for (const name of [
      'CLAUDECODE',
      'CLAUDE_CODE_MESSAGING_TOKEN',
      'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
      'CODEX_THREAD_ID',
      'TRACEPARENT',
      'QC_REMOVE',
    ])
      vi.stubEnv(name, 'host-marker');
    vi.stubEnv('ANTHROPIC_API_KEY', 'inherited-auth-marker');
    const harness = new CliHarness({ claudeBinary: binary, codexBinary: binary });
    const options = {
      prompt: 'literal input',
      env: {
        set: {
          PATH: `${directory}${delimiter}${process.env['PATH'] ?? ''}`,
          QC_VALUE: 'explicit-secret-marker',
          CLAUDECODE: 'explicit-child',
        },
        unset: ['QC_REMOVE'],
      },
    };
    const request = { harness: provider, options, cwd: directory, outputSchema: null };
    const context = testInvocation();
    const metadata = await harness.metadata(request, context);
    expect(metadata.environment?.variables).toContain('ANTHROPIC_API_KEY');
    expect(metadata.environment?.scrubbed).toContain('CLAUDE_CODE_MESSAGING_TOKEN');
    expect(JSON.stringify(metadata)).not.toContain('inherited-auth-marker');
    await harness.invoke(request, context);
    const capture = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as {
      args: string[];
      env: Record<string, string | null>;
      input: string;
    };
    expect(capture.input).toBe('literal input');
    expect(capture.args).toEqual(
      expect.arrayContaining(
        provider === 'claude'
          ? ['--restricted', '--strict-mcp-config']
          : ['--ignore-user-config', '--ignore-rules'],
      ),
    );
    expect(capture.env).toMatchObject({
      CLAUDECODE: 'explicit-child',
      CLAUDE_CODE_MESSAGING_TOKEN: null,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: null,
      CODEX_THREAD_ID: null,
      TRACEPARENT: null,
      QC_REMOVE: null,
      QC_VALUE: 'explicit-secret-marker',
      ANTHROPIC_API_KEY: 'inherited-auth-marker',
      QUIET_CHOIR_RUN_ID: context.runId,
    });
    expect(process.env['CLAUDECODE']).toBe('host-marker');
  },
);

it('supports explicit inherit and scrub policy overrides without changing the parent environment', () => {
  const harness = new CliHarness();
  for (const provider of ['claude', 'codex'] as const) {
    const plan = harness.plan({
      harness: provider,
      cwd: directory,
      outputSchema: null,
      options: { prompt: '', isolation: 'inherit' },
    });
    expect(plan.argv).not.toContain('--restricted');
    expect(plan.argv).not.toContain('--ignore-user-config');
  }
  const parent = { CLAUDECODE: 'parent', EXTRA_HOST: 'extra', ANTHROPIC_API_KEY: 'auth' };
  expect(childEnvironment(undefined, false, parent).env).toEqual(parent);
  const scrubbed = childEnvironment({ unset: ['ANTHROPIC_API_KEY'] }, ['EXTRA_HOST'], parent);
  expect(scrubbed.env).toEqual({});
  expect(scrubbed.summary.scrubbed).toEqual(['CLAUDECODE', 'EXTRA_HOST']);
  expect(parent.CLAUDECODE).toBe('parent');
});

it('resolves shared and provider-specific mode defaults and hides environment values in public manifests', () => {
  const manifest = capabilityManifest({
    defaults: {
      isolation: 'inherit',
      claude: { env: { set: { PRIVATE: 'secret-marker' }, unset: ['REMOVE'] } },
    },
    profiles: { reader: { isolation: 'restricted', codex: { isolation: 'inherit' } } },
  });
  expect(manifest.defaults.claude.isolation).toBe('inherit');
  expect(manifest.profiles['reader']?.claude.isolation).toBe('restricted');
  expect(manifest.profiles['reader']?.codex.isolation).toBe('inherit');
  const visible = publicCapabilityManifest(manifest);
  expect(JSON.stringify(visible)).not.toContain('secret-marker');
  expect(visible.defaults.environment?.claude).toMatchObject({
    set: ['PRIVATE'],
    unset: ['REMOVE'],
  });
  expect(manifest.defaults.claude).not.toHaveProperty('env');
});

it('keeps checkout placement out of profiles while accepting provider configuration modes', () => {
  for (const claude of [{ worktree: true }, { isolation: 'worktree' }])
    expect(() => capabilityManifest({ profiles: { r: { claude } as never } })).toThrow();
  expect(
    capabilityManifest({ profiles: { r: { claude: { isolation: 'inherit' } } } }).profiles['r']
      ?.claude.isolation,
  ).toBe('inherit');
});

it('rejects a Codex harnessProfile under restricted isolation but accepts it under inherit', () => {
  expect(() => capabilityManifest({ profiles: { p: { codex: { harnessProfile: 'p' } } } })).toThrow(
    'harnessProfile',
  );
  expect(
    capabilityManifest({
      profiles: { p: { codex: { isolation: 'inherit', harnessProfile: 'p' } } },
    }).profiles['p']?.codex.harnessProfile,
  ).toBe('p');
});

it('pins the resolved mode and explicit environment identity while keeping checkpoint diagnostics free of values', async () => {
  let mode: HarnessIsolation | undefined,
    fail = true;
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const workflow = defineWorkflow({
    name: 'modes',
    version: '1',
    input: z.null(),
    output: z.string(),
    strictProfiles: false,
    defaults: { claude: { env: { set: { PRIVATE: 'secret-marker' } } } },
    async run(ctx) {
      const result = await ctx.claude.text('call', {
        prompt: 'same',
        ...(mode === undefined ? {} : { isolation: mode }),
      });
      if (fail) throw new Error('tail failure');
      return result.output;
    },
  });
  const options = {
    runId: 'modes',
    cwd: directory,
    stateDir: join(directory, 'runs'),
    grants: ['all'],
    harness: { invoke },
  };
  await expect(runWorkflow(workflow, { ...options, input: null })).rejects.toThrow('tail failure');
  const recorded = await readRun(options);
  expect(recorded.steps['call']?.request?.isolation).toBe('restricted');
  expect(recorded.steps['call']?.request?.environment?.set).toEqual(['PRIVATE']);
  expect(JSON.stringify(recorded)).not.toContain('secret-marker');
  expect(invoke.mock.calls[0]?.[0].options.env).toMatchObject({
    set: { PRIVATE: 'secret-marker' },
  });
  mode = 'inherit';
  await expect(runWorkflow(workflow, { ...options, resume: true })).rejects.toThrow(
    /changed|fingerprint|incompatible/u,
  );
  expect(invoke).toHaveBeenCalledTimes(1);
  mode = 'restricted';
  fail = false;
  await runWorkflow(workflow, { ...options, resume: true });
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('rejects conflicting or reserved environment edits without echoing secret values', () => {
  expect(() => {
    validateAgentOptions('claude', { prompt: '', env: { set: { A: 'same' }, unset: ['A'] } });
  }).toThrow('both set and unset');
  expect(() => {
    validateAgentOptions('claude', {
      prompt: '',
      env: { set: { QUIET_CHOIR_RUN_ID: 'secret-marker' } },
    });
  }).toThrow(/Invalid|Reserved/u);
  expect(() => {
    validateAgentOptions('claude', { prompt: '', env: { PRIVATE: 'secret-marker\0' } });
  }).toThrow();
  try {
    validateAgentOptions('claude', { prompt: '', env: { PRIVATE: 'secret-marker\0' } });
  } catch (error) {
    expect(String(error)).not.toContain('secret-marker');
  }
  expect(() => {
    validateAgentOptions('claude', { prompt: '', isolation: 'restricted', strictMcpConfig: false });
  }).toThrow('requires strictMcpConfig');
  expect(() => {
    validateAgentOptions('claude', { prompt: '', settings: { env: { PRIVATE: 'x' } } });
  }).toThrow('owned by typed');
});

it('warns on resumed host variable name changes without fingerprinting credential rotation', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'credential-one');
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
  let fail = true;
  const invoke = vi.fn<Harness['invoke']>(() => {
    if (fail) throw new Error('retry');
    return Promise.resolve(reply);
  });
  const harness: Harness = {
    invoke,
    metadata: () =>
      Promise.resolve({
        binary: 'fixture',
        version: '1',
        environment: childEnvironment(undefined, undefined).summary,
      }),
  };
  const workflow = defineWorkflow({
    name: 'host-names',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      return (await ctx.claude.text('call', { prompt: 'same' })).output;
    },
  });
  const options = {
    runId: 'host-names',
    stateDir: join(directory, 'runs'),
    cwd: directory,
    harness,
  };
  await expect(runWorkflow(workflow, { ...options, input: null })).rejects.toThrow('retry');
  vi.stubEnv('ANTHROPIC_API_KEY', 'credential-two');
  await expect(runWorkflow(workflow, { ...options, resume: true })).rejects.toThrow('retry');
  expect((await readRun(options)).harnessWarnings ?? []).toEqual([]);
  vi.stubEnv('CLAUDE_CONFIG_DIR', 'private-config-location');
  fail = false;
  const completed = await runWorkflow(workflow, { ...options, resume: true });
  expect(completed.harnessWarnings).toEqual([expect.stringContaining('variable names changed')]);
  expect(JSON.stringify(completed)).not.toMatch(
    /credential-one|credential-two|private-config-location/u,
  );
  expect(invoke).toHaveBeenCalledTimes(3);
});

it('rejects prototype-key environment edits instead of silently dropping them', () => {
  const env = { set: { ['__proto__']: 'private-marker' } };
  expect(() => childEnvironment(env, undefined, {})).toThrow('Unsupported environment name');
  expect(() => capabilityManifest({ defaults: { claude: { env } } })).toThrow(
    'Unsupported environment name',
  );
});

it('rejects malformed adapter scrub policies before probing or spawning', () => {
  expect(() => new CliHarness({ scrubEnv: ['INVALID=NAME'] })).toThrow('scrubEnv');
  expect(() => new CliHarness({ scrubEnv: 'NAME' as unknown as false })).toThrow('scrubEnv');
});

const userMarker = 'USER_AGENTS_CANARY_5521';
async function codexHome(): Promise<string> {
  const home = join(directory, 'codex-home');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'AGENTS.md'), userMarker);
  return home;
}
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

it.each(['stubbed host environment', 'per-call env.set'])(
  'reports the user-level Codex AGENTS.md from the child environment: %s',
  async (source) => {
    const binary = join(directory, await fakeBinary());
    const home = await codexHome();
    const hostHome = join(directory, 'host-home');
    vi.stubEnv('CODEX_HOME', source === 'stubbed host environment' ? home : hostHome);
    const harness = new CliHarness({ codexBinary: binary });
    const metadata = await harness.metadata(
      {
        harness: 'codex',
        cwd: directory,
        outputSchema: null,
        options: {
          prompt: 'x',
          ...(source === 'per-call env.set' ? { env: { set: { CODEX_HOME: home } } } : {}),
        },
      },
      testInvocation(),
    );
    expect(metadata.instructionSources).toEqual([
      { scope: 'user', kind: 'agents', path: join(home, 'AGENTS.md'), sha256: sha256(userMarker) },
    ]);
    expect(metadata.warnings).toEqual([expect.stringContaining(join(home, 'AGENTS.md'))]);
    expect(metadata.warnings?.[0]).toContain('every isolation mode, including restricted');
    expect(JSON.stringify(metadata)).not.toContain(userMarker);
  },
);

it('falls back to HOME/.codex, reports detection even when the version probe fails, and leaves Claude alone', async () => {
  const binary = join(directory, await fakeBinary());
  const home = join(directory, 'fake-home');
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex', 'AGENTS.override.md'), userMarker);
  vi.stubEnv('CODEX_HOME', undefined);
  vi.stubEnv('HOME', home);
  const request = (harness: 'claude' | 'codex') => ({
    harness,
    cwd: directory,
    outputSchema: null,
    options: { prompt: 'x' },
  });
  const failing = new CliHarness({ codexBinary: join(directory, 'missing-binary') });
  const failed = await failing.metadata(request('codex'), testInvocation());
  expect(failed.version).toBeNull();
  expect(failed.instructionSources).toEqual([
    expect.objectContaining({
      kind: 'agents-override',
      path: join(home, '.codex', 'AGENTS.override.md'),
    }),
  ]);
  expect(failed.warnings).toHaveLength(2);
  const claude = await new CliHarness({ claudeBinary: binary }).metadata(
    request('claude'),
    testInvocation(),
  );
  expect(claude).not.toHaveProperty('instructionSources');
  expect(JSON.stringify(claude)).not.toContain('AGENTS');
});

it('records one user-level instruction warning per run, and flags a change on resume', async () => {
  const binary = join(directory, await fakeBinary());
  const home = await codexHome();
  vi.stubEnv('CODEX_HOME', home);
  let fail = true;
  const workflow = defineWorkflow({
    name: 'instructions',
    version: '1',
    strictProfiles: false,
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      await ctx.codex.text('first', { prompt: 'one' });
      await ctx.codex.text('second', { prompt: 'two', isolation: 'inherit' });
      await ctx.step('gate', {
        input: null,
        schema: z.null(),
        run() {
          if (fail) throw new Error('gate failure');
          return null;
        },
      });
      return (await ctx.codex.text('third', { prompt: 'three' })).output;
    },
  });
  const run = (runId: string) => ({
    runId,
    stateDir: join(directory, 'runs'),
    cwd: directory,
    grants: ['all'],
    harness: new CliHarness({ codexBinary: binary }),
  });
  const userWarnings = (warnings: readonly string[] | undefined) =>
    (warnings ?? []).filter((warning) => warning.includes('user-level instructions'));

  for (const mode of ['steady', 'edited', 'project'] as const) {
    const edit = mode === 'edited';
    await rm(join(directory, 'AGENTS.md'), { force: true });
    await writeFile(join(home, 'AGENTS.md'), userMarker);
    fail = true;
    const options = run(`instructions-${mode}`);
    await expect(runWorkflow(workflow, { ...options, input: null })).rejects.toThrow(
      'gate failure',
    );
    const first = await readRun(options);
    expect(userWarnings(first.harnessWarnings)).toHaveLength(1);
    expect(first.harnessWarnings?.[0]).toContain(join(home, 'AGENTS.md'));
    expect(first.harnesses?.['codex']?.instructionSources).toEqual([
      expect.objectContaining({ scope: 'user', sha256: sha256(userMarker) }),
    ]);
    expect(JSON.stringify(first)).not.toContain(userMarker);

    fail = false;
    if (edit) await writeFile(join(home, 'AGENTS.md'), `${userMarker} edited`);
    // A project file appearing between attempts is not a user-level change.
    if (mode === 'project') await writeFile(join(directory, 'AGENTS.md'), 'project instructions');
    const completed = await runWorkflow(workflow, { ...options, resume: true });
    const changed = (completed.harnessWarnings ?? []).filter((warning) =>
      warning.includes('instruction sources changed'),
    );
    if (edit) {
      expect(changed).toHaveLength(1);
      expect(userWarnings(completed.harnessWarnings)).toHaveLength(2);
    } else {
      expect(changed).toEqual([]);
      expect(userWarnings(completed.harnessWarnings)).toHaveLength(1);
    }
    expect(JSON.stringify(completed)).not.toContain(userMarker);
    if (mode === 'project')
      expect(completed.harnesses?.['codex']?.instructionSources).toContainEqual(
        expect.objectContaining({ scope: 'project', kind: 'agents' }),
      );
  }
});

// Pinned on main before Codex `instructions` existed (#130): unset and 'native' must keep these.
const pinnedRequests = {
  codexPlain: {
    harness: 'codex',
    cwd: '/pinned/cwd',
    outputSchema: null,
    options: { prompt: 'pinned prompt' },
  },
  codexOptions: {
    harness: 'codex',
    cwd: '/pinned/cwd',
    outputSchema: null,
    options: {
      prompt: 'pinned prompt',
      model: 'gpt-5',
      effort: 'low',
      sandbox: 'workspace-write',
      config: { 'features.x': true },
      env: { set: { A: 'b' } },
    },
  },
  claude: {
    harness: 'claude',
    cwd: '/pinned/cwd',
    outputSchema: null,
    options: { prompt: 'pinned prompt', tools: ['Read'], maxTurns: 3 },
  },
} as const satisfies Record<string, BuiltinHarnessRequestInput>;
const pinnedDigests = {
  codexPlain: '440c8defac487e76bb6686deb544bdf0553a52b56d91279b91ba6d01dbe148cc',
  codexOptions: '6f0a8d10ccd191cefbd2badb6a5679596ff9aa5ad324159dcec3848fda0bb7e1',
  claude: '2d5ee84d4ac85337d6dba576936f436acb2c7d1e2132eed426cdec62ddb3721a',
};
const identityDigest = (identity: Readonly<Record<string, string>>): string =>
  sha256(
    JSON.stringify(Object.entries(identity).sort(([left], [right]) => (left < right ? -1 : 1))),
  );

it('keeps pinned legacy agent identity digests', () => {
  for (const [name, request] of Object.entries(pinnedRequests))
    expect(identityDigest(legacyAgentIdentity(request, { type: 'object' })), name).toBe(
      pinnedDigests[name as keyof typeof pinnedDigests],
    );
});
