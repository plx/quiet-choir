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
  testedHarnessVersions,
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
import { codexInstructionWarning } from '../src/harnesses/codex-instructions.js';
import { inspectRun } from '../src/workflow/loader/inspection.js';
import { formatRunSummary } from '../src/cli/inspection-view.js';

let directory: string;
const reply = {
  text: 'ok',
  sessionId: null,
  usage: { inputTokens: null, outputTokens: null, costUsd: null },
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'choir-isolation-'));
  // Instruction detection reads HOME/.agents/skills and HOME/.claude; keep the real ones out.
  vi.stubEnv('HOME', join(directory, 'user-home'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

/** Fake CLI that answers --version with a tested Codex version unless told otherwise. */
async function fakeBinary(version: string = testedHarnessVersions.codex.minimum): Promise<string> {
  const name = 'fixture-agent';
  await writeFile(
    join(directory, name),
    `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('--version')){console.log(${JSON.stringify(`fixture ${version}`)});process.exit(0);}
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
  for (const options of [
    { worktree: true },
    { worktree: { base: 'main' } },
    { worktree: { kind: 'worktree' } },
    { isolation: 'worktree' },
    { isolation: { kind: 'worktree', base: 'main' } },
  ]) {
    expect(() => capabilityManifest({ profiles: { r: { claude: options } as never } })).toThrow();
    expect(() => capabilityManifest({ profiles: { r: { codex: options } as never } })).toThrow();
    expect(() => capabilityManifest({ defaults: { claude: options } as never })).toThrow();
  }
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
    // Registration metadata holds only user-level sources; project files are recorded per cwd.
    expect(completed.harnesses?.['codex']?.instructionSources).toEqual([
      expect.objectContaining({ scope: 'user' }),
    ]);
    expect(first.projectInstructions).toEqual([{ harness: 'codex', cwd: first.cwd, sources: [] }]);
    expect(completed.projectInstructions).toEqual([
      {
        harness: 'codex',
        cwd: completed.cwd,
        sources:
          mode === 'project'
            ? [
                {
                  scope: 'project',
                  kind: 'agents',
                  path: join(completed.cwd, 'AGENTS.md'),
                  sha256: sha256('project instructions'),
                },
              ]
            : [],
      },
    ]);
  }
});

it('reports Codex project files through projectInstructions without spawning, and none for restricted Claude', async () => {
  const spawned = join(directory, 'spawned');
  const binary = join(directory, 'spawn-marker');
  await writeFile(
    binary,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(spawned)}, 'x');`,
    { mode: 0o700 },
  );
  const home = await codexHome();
  vi.stubEnv('CODEX_HOME', home);
  const repo = join(directory, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  await mkdir(join(repo, 'pkg'));
  await writeFile(join(repo, 'AGENTS.md'), 'root rules');
  await writeFile(join(repo, 'pkg', 'AGENTS.override.md'), 'pkg override');
  const harness = new CliHarness({ claudeBinary: binary, codexBinary: binary });
  const request = (name: 'claude' | 'codex') => ({
    harness: name,
    cwd: join(repo, 'pkg'),
    outputSchema: null,
    options: { prompt: 'x' },
  });
  expect(await harness.projectInstructions(request('codex'), testInvocation())).toEqual({
    sources: [
      {
        scope: 'project',
        kind: 'agents',
        path: join(repo, 'AGENTS.md'),
        sha256: sha256('root rules'),
      },
      {
        scope: 'project',
        kind: 'agents-override',
        path: join(repo, 'pkg', 'AGENTS.override.md'),
        sha256: sha256('pkg override'),
      },
    ],
  });
  expect(await harness.projectInstructions(request('claude'), testInvocation())).toBeUndefined();
  await expect(readFile(spawned)).rejects.toMatchObject({ code: 'ENOENT' });
  // Metadata from the same cwd reports the user file only.
  const metadata = await harness.metadata(request('codex'), testInvocation());
  expect(metadata.instructionSources).toEqual([
    expect.objectContaining({ scope: 'user', path: join(home, 'AGENTS.md') }),
  ]);
});

it('reports repository and HOME .agents skills for Codex at the right levels', async () => {
  const home = await codexHome();
  vi.stubEnv('CODEX_HOME', home);
  const userHome = join(directory, 'user-home');
  await mkdir(join(userHome, '.agents', 'skills', 'personal'), { recursive: true });
  await writeFile(join(userHome, '.agents', 'skills', 'personal', 'SKILL.md'), 'personal');
  const repo = join(directory, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  await mkdir(join(repo, '.agents', 'skills', 'review'), { recursive: true });
  await writeFile(join(repo, '.agents', 'skills', 'review', 'SKILL.md'), 'review');
  const harness = new CliHarness({ codexBinary: join(directory, 'missing-binary') });
  const request = {
    harness: 'codex',
    cwd: repo,
    outputSchema: null,
    options: { prompt: 'x' },
  } as const;
  expect(await harness.projectInstructions(request, testInvocation())).toEqual({
    sources: [
      {
        scope: 'project',
        kind: 'skill',
        path: join(repo, '.agents', 'skills', 'review', 'SKILL.md'),
        sha256: sha256('review'),
      },
    ],
  });
  const metadata = await harness.metadata(request, testInvocation());
  expect(metadata.instructionSources).toEqual([
    expect.objectContaining({ scope: 'user', kind: 'agents', path: join(home, 'AGENTS.md') }),
    {
      scope: 'user',
      kind: 'skill',
      path: join(userHome, '.agents', 'skills', 'personal', 'SKILL.md'),
      sha256: sha256('personal'),
    },
  ]);
  expect(metadata.warnings).toContainEqual(expect.stringContaining('1 skill description file'));
});

it('reports the user CLAUDE.md for inherit-mode Claude only, honoring CLAUDE_CONFIG_DIR', async () => {
  const userHome = join(directory, 'user-home');
  const text = 'CLAUDE_USER_RULES_CANARY';
  await mkdir(join(userHome, '.claude'), { recursive: true });
  await writeFile(join(userHome, '.claude', 'CLAUDE.md'), text);
  const configured = join(directory, 'configured');
  await mkdir(configured);
  await writeFile(join(configured, 'CLAUDE.md'), `${text} configured`);
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
  const harness = new CliHarness({ claudeBinary: join(directory, 'missing-binary') });
  const request = (options: Record<string, unknown>) => ({
    harness: 'claude' as const,
    cwd: directory,
    outputSchema: null,
    options: { prompt: 'x', ...options },
  });
  const claudeMd = (path: string, content: string) => ({
    sources: [{ scope: 'user', kind: 'claude-md', path, sha256: sha256(content) }],
  });
  expect(
    await harness.projectInstructions(request({ isolation: 'inherit' }), testInvocation()),
  ).toEqual(claudeMd(join(userHome, '.claude', 'CLAUDE.md'), text));
  // Restricted Claude never loads it, so nothing is reported.
  expect(await harness.projectInstructions(request({}), testInvocation())).toBeUndefined();
  expect(
    await harness.projectInstructions(request({ isolation: 'restricted' }), testInvocation()),
  ).toBeUndefined();
  // A per-call env.set wins over the inherited environment, as it does for the child.
  expect(
    await harness.projectInstructions(
      request({ isolation: 'inherit', env: { set: { CLAUDE_CONFIG_DIR: configured } } }),
      testInvocation(),
    ),
  ).toEqual(claudeMd(join(configured, 'CLAUDE.md'), `${text} configured`));
  vi.stubEnv('CLAUDE_CONFIG_DIR', configured);
  expect(
    await harness.projectInstructions(request({ isolation: 'inherit' }), testInvocation()),
  ).toEqual(claudeMd(join(configured, 'CLAUDE.md'), `${text} configured`));
});

it('records the Claude user CLAUDE.md for an inherit call after a restricted call at the same cwd', async () => {
  const binary = join(directory, await fakeBinary());
  const config = join(directory, 'claude-config');
  await mkdir(config);
  await writeFile(join(config, 'CLAUDE.md'), 'USER_CLAUDE_RULES');
  vi.stubEnv('CLAUDE_CONFIG_DIR', config);
  const workflow = defineWorkflow({
    name: 'claude-inherit',
    version: '1',
    strictProfiles: false,
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.claude.text('restricted', { prompt: 'one' });
      await ctx.claude.text('inherit', { prompt: 'two', isolation: 'inherit' });
      await ctx.claude.text('again', { prompt: 'three' });
      return null;
    },
  });
  const options = {
    runId: 'claude-inherit',
    stateDir: join(directory, 'runs'),
    cwd: directory,
    grants: ['all'],
    harness: new CliHarness({ claudeBinary: binary }),
  };
  expect((await runWorkflow(workflow, { ...options, input: null })).status).toBe('completed');
  const record = await readRun(options);
  expect(record.projectInstructions).toEqual([
    {
      harness: 'claude',
      cwd: record.cwd,
      sources: [
        {
          scope: 'user',
          kind: 'claude-md',
          path: join(config, 'CLAUDE.md'),
          sha256: sha256('USER_CLAUDE_RULES'),
        },
      ],
    },
  ]);
  expect(JSON.stringify(record)).not.toContain('USER_CLAUDE_RULES');
});

it('records project instruction sources for each distinct Codex cwd and warns about user files once', async () => {
  const binary = join(directory, await fakeBinary());
  const home = await codexHome();
  vi.stubEnv('CODEX_HOME', home);
  const repo = join(directory, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  await mkdir(join(repo, 'a'));
  await mkdir(join(repo, 'b'));
  const texts = { root: 'ROOT_RULES_1', a: 'A_RULES_2', b: 'B_OVERRIDE_3' };
  await writeFile(join(repo, 'AGENTS.md'), texts.root);
  await writeFile(join(repo, 'a', 'AGENTS.md'), texts.a);
  await writeFile(join(repo, 'b', 'AGENTS.override.md'), texts.b);
  await writeFile(join(repo, 'b', 'AGENTS.md'), 'replaced by the override');
  const workflow = defineWorkflow({
    name: 'per-cwd',
    version: '1',
    strictProfiles: false,
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.codex.text('a1', { prompt: 'one', cwd: 'a' });
      await ctx.codex.text('b1', { prompt: 'two', cwd: 'b' });
      await ctx.codex.text('a2', { prompt: 'three', cwd: 'a' });
      return null;
    },
  });
  const options = {
    runId: 'per-cwd',
    stateDir: join(directory, 'runs'),
    cwd: repo,
    grants: ['all'],
    harness: new CliHarness({ codexBinary: binary }),
  };
  const run = await runWorkflow(workflow, { ...options, input: null });
  expect(run.status).toBe('completed');
  const record = await readRun(options);
  const source = (kind: 'agents' | 'agents-override', path: string, text: string) => ({
    scope: 'project',
    kind,
    path: join(record.cwd, path),
    sha256: sha256(text),
  });
  expect(record.projectInstructions).toEqual([
    {
      harness: 'codex',
      cwd: join(record.cwd, 'a'),
      sources: [
        source('agents', 'AGENTS.md', texts.root),
        source('agents', 'a/AGENTS.md', texts.a),
      ],
    },
    {
      harness: 'codex',
      cwd: join(record.cwd, 'b'),
      sources: [
        source('agents', 'AGENTS.md', texts.root),
        source('agents-override', 'b/AGENTS.override.md', texts.b),
      ],
    },
  ]);
  expect(record.harnesses?.['codex']?.instructionSources).toEqual([
    expect.objectContaining({ scope: 'user', path: join(home, 'AGENTS.md') }),
  ]);
  expect(
    (record.harnessWarnings ?? []).filter((warning) => warning.includes('user-level instructions')),
  ).toHaveLength(1);
  const saved = JSON.stringify(record);
  for (const text of [...Object.values(texts), userMarker]) expect(saved).not.toContain(text);
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
  // #341 moved Codex effort from option.effort into the reasoningEffort slot (a documented one-time
  // change, 6f0a8d10… before). This is main's (c73138f) digest for the same request spelled
  // reasoningEffort: 'low', so the pin still comes from code before the change.
  codexOptions: 'd15fe1f7cbc171b389c671a8fd07b0dc5b6a5eda92e47f7a081e4d0e125ed99a',
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

it('fingerprints Codex instructions only when they are none', () => {
  const base = pinnedRequests.codexOptions;
  const identity = (instructions?: 'native' | 'none') =>
    legacyAgentIdentity(
      {
        ...base,
        options: { ...base.options, ...(instructions === undefined ? {} : { instructions }) },
      },
      { type: 'object' },
    );
  expect(identity('native')).toEqual(identity());
  expect(identityDigest(identity('native'))).toBe(pinnedDigests.codexOptions);
  const none = identity('none');
  const changed = Object.keys(none).filter((key) => none[key] !== identity()[key]);
  expect(changed).toEqual(['option.instructions']);
  expect(Object.keys(none).length).toBe(Object.keys(identity()).length + 1);
});

it('accepts Codex instructions only where they can mean none', () => {
  const codex =
    (options: Record<string, unknown>, resolved = true) =>
    () => {
      validateAgentOptions('codex', { prompt: '', ...options }, resolved);
    };
  expect(codex({ instructions: 'none' })).not.toThrow();
  expect(codex({ instructions: 'native', isolation: 'inherit' })).not.toThrow();
  expect(codex({ instructions: 'bogus' })).toThrow('instructions');
  expect(codex({ instructions: 'none', isolation: 'inherit' })).toThrow(
    "instructions 'none' requires restricted isolation; inherit loads CODEX_HOME configuration",
  );
  // A partial call-site check still rejects an explicit inherit.
  expect(codex({ instructions: 'none', isolation: 'inherit' }, false)).toThrow(
    'requires restricted',
  );
  // project_doc_max_bytes belongs to the mode only under none.
  for (const config of [{ project_doc_max_bytes: 1 }, { 'project_doc_max_bytes.x': 1 }])
    expect(codex({ instructions: 'none', config })).toThrow("owned by instructions 'none'");
  expect(codex({ config: { project_doc_max_bytes: 1 } })).not.toThrow();
  expect(codex({ instructions: 'native', config: { project_doc_max_bytes: 1 } })).not.toThrow();
  expect(codex({ instructions: 'none', config: { developer_instructions: 'x' } })).not.toThrow();

  expect(() => {
    validateAgentOptions('claude', { prompt: '', instructions: 'none' });
  }).toThrow('Unrecognized key(s) "instructions"');
  expect(() =>
    capabilityManifest({ profiles: { p: { claude: { instructions: 'none' } as never } } }),
  ).toThrow('instructions');
  expect(
    capabilityManifest({ profiles: { p: { codex: { instructions: 'none' } } } }).profiles['p']
      ?.codex.instructions,
  ).toBe('none');
  expect(() =>
    capabilityManifest({
      profiles: { p: { codex: { instructions: 'none', isolation: 'inherit' } } },
    }),
  ).toThrow('requires restricted');
  // instructions removes context and grants nothing, so it stays a read-only control.
  expect(
    capabilityManifest({ profiles: { p: { codex: { instructions: 'none' } } } }).profiles['p']
      ?.codexAccess,
  ).toBe('read');
});

it('plans none as a private CODEX_HOME plus project_doc_max_bytes=0', () => {
  const harness = new CliHarness();
  const plan = (instructions?: 'native' | 'none') =>
    harness.plan({
      harness: 'codex',
      cwd: directory,
      outputSchema: null,
      options: { prompt: '', ...(instructions === undefined ? {} : { instructions }) },
    });
  const none = plan('none');
  expect(none.codexHome).toBe('private');
  expect(none.argv.slice(0, 12)).toEqual([
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '--config',
    'approval_policy="never"',
    '--ephemeral',
    '--color',
    'never',
    '--ignore-user-config',
    '--ignore-rules',
    '--config',
  ]);
  expect(none.argv[12]).toBe('project_doc_max_bytes=0');
  for (const other of [plan(), plan('native')]) {
    expect(other).not.toHaveProperty('codexHome');
    expect(other.argv).toEqual(plan().argv);
    expect(other.argv.join(' ')).not.toContain('project_doc_max_bytes');
  }
});

it('records resolved Codex instructions, shows none in inspect, and pins none in identity', async () => {
  let instructions: 'native' | 'none' | undefined;
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const workflow = defineWorkflow({
    name: 'instructions-mode',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      // strictProfiles (the default) allows a call-site instructions choice.
      const result = await ctx.codex.text('call', {
        prompt: 'same',
        ...(instructions === undefined ? {} : { instructions }),
      });
      await ctx.claude.text('other', { prompt: 'same' });
      throw new Error(`tail failure ${result.output}`);
    },
  });
  const options = {
    runId: 'instructions-mode',
    cwd: directory,
    stateDir: join(directory, 'runs'),
    grants: ['all'],
    harness: { invoke },
  };
  await expect(runWorkflow(workflow, { ...options, input: null })).rejects.toThrow('tail failure');
  const recorded = await readRun(options);
  expect(recorded.steps['call']?.request?.instructions).toBe('native');
  expect(recorded.steps['other']?.request).not.toHaveProperty('instructions');
  instructions = 'native';
  await expect(runWorkflow(workflow, { ...options, resume: true })).rejects.toThrow('tail failure');
  expect(invoke).toHaveBeenCalledTimes(2);
  instructions = 'none';
  await expect(runWorkflow(workflow, { ...options, resume: true })).rejects.toThrow(
    /changed|fingerprint|incompatible/u,
  );

  // Inspect lists failed agent steps with their limits.
  invoke.mockRejectedValue(new Error('agent failure'));
  const fresh = { ...options, runId: 'instructions-none' };
  await expect(runWorkflow(workflow, { ...fresh, input: null })).rejects.toThrow('agent failure');
  expect((await readRun(fresh)).steps['call']?.request?.instructions).toBe('none');
  expect(formatRunSummary((await inspectRun(fresh)).summary)).toMatch(
    /failed call {2}codex .*restricted configuration, no native instructions/u,
  );
});

it('points the user-level instruction warning at the opt-out', () => {
  const warning = codexInstructionWarning({
    sources: [{ scope: 'user', kind: 'agents', path: '/home/AGENTS.md', sha256: 'a'.repeat(64) }],
    omittedSkills: 0,
    warnings: [],
  });
  expect(warning).toContain('every isolation mode, including restricted');
  expect(warning).toContain(
    "Set codex instructions: 'none' to run a call without the CODEX_HOME files; skills under $HOME/.agents/skills still load.",
  );
});

const untestedClaude = (() => {
  const [major = '', minor = '', patch = ''] = testedHarnessVersions.claude.maximum.split('.');
  return `${major}.${minor}.${String(Number(patch) + 1)}`;
})();

it('warns once per run when the CLI version is outside the tested range, and not when it is tested', async () => {
  for (const [version, expected] of [
    [untestedClaude, 1],
    [testedHarnessVersions.claude.minimum, 0],
  ] as const) {
    const binary = join(directory, await fakeBinary(version));
    let fail = true;
    const workflow = defineWorkflow({
      name: 'untested-version',
      version: '1',
      strictProfiles: false,
      input: z.null(),
      output: z.string(),
      async run(ctx) {
        await ctx.claude.text('first', { prompt: 'one' });
        await ctx.claude.text('second', { prompt: 'two' });
        await ctx.step('gate', {
          input: null,
          schema: z.null(),
          run() {
            if (fail) throw new Error('gate failure');
            return null;
          },
        });
        return (await ctx.claude.text('third', { prompt: 'three' })).output;
      },
    });
    const options = {
      runId: `version-${version.replaceAll('.', '-')}`,
      stateDir: join(directory, 'runs'),
      cwd: directory,
      grants: ['all'],
      harness: new CliHarness({ claudeBinary: binary }),
    };
    await expect(runWorkflow(workflow, { ...options, input: null })).rejects.toThrow(
      'gate failure',
    );
    fail = false;
    await runWorkflow(workflow, { ...options, resume: true });
    const warnings = (await readRun(options)).harnessWarnings ?? [];
    expect(warnings).toHaveLength(expected);
    if (expected > 0) {
      expect(warnings[0]).toContain('configuration doctor --harness claude');
      expect(warnings[0]).toContain(`@${version}`);
    }
  }
});

it('adds the untested-version warning in metadata() but not for a missing binary', async () => {
  const request = {
    harness: 'claude' as const,
    cwd: directory,
    outputSchema: null,
    options: { prompt: 'x' },
  };
  const untested = await new CliHarness({
    claudeBinary: join(directory, await fakeBinary(untestedClaude)),
  }).metadata(request, testInvocation());
  expect(untested.version).toBe(untestedClaude);
  expect(untested.warnings).toEqual([expect.stringContaining('contract-tested claude range')]);
  const tested = await new CliHarness({
    claudeBinary: join(directory, await fakeBinary(testedHarnessVersions.claude.minimum)),
  }).metadata(request, testInvocation());
  expect(tested).not.toHaveProperty('warnings');
  const missing = await new CliHarness({
    claudeBinary: join(directory, 'missing-binary'),
  }).metadata(request, testInvocation());
  expect(missing.warnings).toEqual([expect.stringContaining('version discovery failed')]);
});
