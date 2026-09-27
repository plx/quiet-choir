import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, delimiter } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  CliHarness,
  capabilityManifest,
  defineWorkflow,
  readRun,
  runWorkflow,
  z,
  type ClaudeOptions,
  type CodexOptions,
  type Harness,
  type HarnessRequest,
} from '../src/index.js';
import {
  validateExtraArgs,
  validateConfig,
  tomlLiteral,
} from '../src/workflow/runtime/agent-controls.js';
import { parse } from 'smol-toml';
let directory: string;
const signal = new AbortController().signal;
const reply = {
  text: 'ok',
  sessionId: null,
  usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
};
const base = {
  name: 'controls',
  version: '1',
  input: z.null(),
  output: z.string(),
  strictProfiles: false,
};
const setup = () => ({
  runId: 'controls',
  stateDir: join(directory, 'state'),
  input: null,
  cwd: directory,
  grants: ['all'],
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'choir-controls-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function binary(body: string): Promise<string> {
  const path = join(directory, 'agent');
  await writeFile(path, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return path;
}
const capture = `const fs = require('node:fs');const args=process.argv.slice(2);let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 const files={};for(let i=0;i<args.length;i++){if(['--system-prompt-file','--append-system-prompt-file','--agents','--mcp-config','--settings','--output-schema'].includes(args[i])) files[args[i]]={path:args[i+1],mode:fs.statSync(args[i+1]).mode&511,text:fs.readFileSync(args[i+1],'utf8')}; if(args[i].startsWith('--image=')){const p=args[i].slice(8);files.image={path:p,mode:fs.statSync(p).mode&511,text:fs.readFileSync(p).toString('base64')};}}
 fs.writeFileSync('capture.json',JSON.stringify({args,input,files,env:process.env.QC_TEST,parent:process.env.PATH}));
 console.log(args[0]==='exec'?[JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}}),JSON.stringify({type:'turn.completed'})].join('\\n'):JSON.stringify({type:'result',subtype:'success',result:'ok'}));});`;

it('passes every Claude control literally and stores large/structured values in cleaned private files', async () => {
  const path = await binary(capture);
  const controls: ClaudeOptions = {
    prompt: 'task $(not a shell)',
    model: 'primary',
    tools: ['Read', 'Bash'],
    allowedTools: ['Read', 'Bash(npm test:*)'],
    disallowedTools: ['Bash(git push:*)'],
    permissionMode: 'acceptEdits',
    effort: 'xhigh',
    maxTurns: 12,
    maxBudgetUsd: 2,
    systemPrompt: 'role'.repeat(100_000),
    appendSystemPrompt: 'cacheable role',
    agent: 'reader',
    agents: { reader: { description: 'Reads', prompt: 'Read only', tools: ['Read'] } },
    mcpServers: { server: { command: 'node', args: ['fake.js'] } },
    strictMcpConfig: true,
    settings: { hooks: {} },
    fallbackModel: ['fallback-a', 'fallback-b'],
    addDirs: ['dir with spaces'],
    extraArgs: ['--no-chrome'],
    env: {
      QC_TEST: 'literal $SECRET',
      PATH: `${directory}${delimiter}${process.env['PATH'] ?? ''}`,
    },
  };
  await new CliHarness({ claudeBinary: basename(path) }).invoke(
    { provider: 'claude', cwd: directory, outputSchema: null, options: controls },
    signal,
  );
  const result = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as {
    args: string[];
    input: string;
    env: string;
    parent: string;
    files: Record<string, { path: string; mode: number; text: string }>;
  };
  expect(result.input).toBe(controls.prompt);
  expect(result.env).toBe('literal $SECRET');
  expect(result.parent).toBe(controls.env?.['PATH']);
  expect(result.args).toEqual(
    expect.arrayContaining([
      '--effort',
      'xhigh',
      '--permission-mode',
      'acceptEdits',
      '--agent',
      'reader',
      '--strict-mcp-config',
      '--fallback-model',
      'fallback-a,fallback-b',
      '--add-dir',
      join(directory, 'dir with spaces'),
      '--disallowedTools',
      'Bash(git push:*)',
      '--no-chrome',
    ]),
  );
  expect(result.args.join(' ')).not.toContain('cacheable role');
  expect(result.files['--system-prompt-file']?.text).toBe(controls.systemPrompt);
  expect(JSON.parse(result.files['--agents']?.text ?? '')).toEqual(controls.agents);
  expect(JSON.parse(result.files['--mcp-config']?.text ?? '')).toEqual({
    mcpServers: controls.mcpServers,
  });
  expect(JSON.parse(result.files['--settings']?.text ?? '')).toEqual(controls.settings);
  for (const file of Object.values(result.files)) {
    expect(file.mode).toBe(0o600);
    await expect(stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it('passes every Codex control, preserves TOML values, snapshots images, and separates the stdin marker', async () => {
  const path = await binary(capture);
  const image = join(directory, 'one.png');
  await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const options: CodexOptions = {
    prompt: 'stdin task',
    effort: 'max',
    model: 'model',
    sandbox: 'workspace-write',
    networkAccess: true,
    harnessProfile: 'native',
    config: {
      'features.test': true,
      settings: { text: 'quote " and newline\n', list: [1, false] },
    },
    images: [image],
    addDirs: ['extra'],
    skipGitRepoCheck: true,
    extraArgs: ['--strict-config'],
    env: { QC_TEST: 'overlay', PATH: `${directory}${delimiter}${process.env['PATH'] ?? ''}` },
  };
  await new CliHarness({ codexBinary: basename(path) }).invoke(
    { provider: 'codex', cwd: directory, outputSchema: null, options },
    signal,
  );
  const result = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as {
    args: string[];
    files: Record<string, { path: string; mode: number; text: string }>;
    input: string;
  };
  expect(result.args.slice(-3)).toEqual(['--strict-config', '--', '-']);
  expect(result.input).toBe('stdin task');
  expect(result.args).toEqual(
    expect.arrayContaining([
      '--profile',
      'native',
      'model_reasoning_effort="max"',
      'sandbox_workspace_write.network_access=true',
      'features.test=true',
      '--add-dir',
      join(directory, 'extra'),
      '--model',
      'model',
      '--skip-git-repo-check',
    ]),
  );
  expect(parse(result.args.find((value) => value.startsWith('settings=')) ?? '')).toEqual({
    settings: options.config?.['settings'],
  });
  expect(result.files['image']?.mode).toBe(0o600);
  expect(result.files['image']?.text).toBe(
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
  );
  await expect(stat(result.files['image']?.path ?? '')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['failure', 'timeout', 'abort'] as const)(
  'removes all prepared files on %s',
  async (mode) => {
    const path = await binary(
      `const fs=require('node:fs');const a=process.argv.slice(2);fs.writeFileSync('temp-path',a[a.indexOf('--system-prompt-file')+1]);${mode === 'failure' ? 'process.exit(1);' : 'setInterval(()=>{},1000);'}`,
    );
    const controller = new AbortController();
    const invocation = new CliHarness({ claudeBinary: path }).invoke(
      {
        provider: 'claude',
        cwd: directory,
        outputSchema: null,
        options: {
          prompt: 'x',
          systemPrompt: 'private',
          timeoutMs: mode === 'timeout' ? 1000 : 10_000,
        },
      },
      controller.signal,
    );
    if (mode === 'abort') {
      await vi.waitFor(
        async () => {
          expect(await stat(join(directory, 'temp-path'))).toBeDefined();
        },
        { timeout: 2000, interval: 5 },
      );
      controller.abort();
    }
    await expect(invocation).rejects.toThrow();
    const temp = await readFile(join(directory, 'temp-path'), 'utf8');
    await expect(stat(temp)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

const reserved = {
  claude: [
    'print',
    'output-format',
    'input-format',
    'json-schema',
    'no-session-persistence',
    'verbose',
    'session-id',
    'resume',
    'continue',
    'fork-session',
    'worktree',
    'dangerously-skip-permissions',
    'allow-dangerously-skip-permissions',
    'model',
    'effort',
    'tools',
    'allowedTools',
    'allowed-tools',
    'disallowedTools',
    'disallowed-tools',
    'permission-mode',
    'system-prompt',
    'system-prompt-file',
    'append-system-prompt',
    'append-system-prompt-file',
    'agent',
    'agents',
    'mcp-config',
    'strict-mcp-config',
    'settings',
    'fallback-model',
    'max-turns',
    'max-budget-usd',
    'add-dir',
  ],
  codex: [
    'json',
    'output-schema',
    'ephemeral',
    'color',
    'sandbox',
    'approve-for-me',
    'cd',
    'worktree',
    'model',
    'output-last-message',
    'dangerously-bypass-approvals-and-sandbox',
    'dangerously-bypass-hook-trust',
    'config',
    'profile',
    'image',
    'add-dir',
    'skip-git-repo-check',
    'ask-for-approval',
    'full-auto',
  ],
};
it.each(['claude', 'codex'] as const)(
  'rejects every owned %s long flag and equals variant, without spawning',
  async (provider) => {
    for (const name of reserved[provider])
      for (const arg of [`--${name}`, `--${name}=value`])
        expect(() => {
          validateExtraArgs(provider, [arg]);
        }).toThrow(/owned by/);
    for (const alias of provider === 'claude'
      ? ['p', 'r', 'c', 'w']
      : ['c', 'p', 'i', 's', 'C', 'm', 'o', 'a'])
      for (const arg of [`-${alias}`, `-${alias}=value`, `-${alias}value`, `-x${alias}`])
        expect(() => {
          validateExtraArgs(provider, [arg]);
        }).toThrow(/owned by/);
    for (const arg of [
      'exec',
      'resume',
      'review',
      'fork',
      '-',
      '--',
      'a value',
      '--flag',
      '--flag=value',
    ]) {
      if (arg.startsWith('--flag'))
        expect(() => {
          validateExtraArgs(provider, [arg]);
        }).not.toThrow();
      else
        expect(() => {
          validateExtraArgs(provider, [arg]);
        }).toThrow();
    }
    await expect(
      new CliHarness({ claudeBinary: '/absent', codexBinary: '/absent' }).invoke(
        {
          provider,
          cwd: directory,
          outputSchema: null,
          options: { prompt: 'x', extraArgs: ['--model=x'] },
        },
        signal,
      ),
    ).rejects.toThrow('owned by model');
  },
);
it('rejects typed enum conflicts, bypass settings and config shadowing before spawn', async () => {
  const harness = new CliHarness({ claudeBinary: '/absent', codexBinary: '/absent' });
  const invalid: [HarnessRequest['provider'], object][] = [
    ['claude', { effort: 'ultra' }],
    ['claude', { permissionMode: 'bypassPermissions' }],
    [
      'claude',
      { agents: { bad: { description: 'x', prompt: 'x', permissionMode: 'bypassPermissions' } } },
    ],
    ['claude', { settings: { permissions: { defaultMode: 'bypassPermissions' } } }],
    ['codex', { reasoningEffort: 'ultra' }],
    ['codex', { effort: 'high', reasoningEffort: 'low' }],
    ['codex', { networkAccess: true }],
    ['codex', { config: { thing: null } }],
  ];
  for (const [provider, options] of invalid)
    await expect(
      harness.invoke(
        {
          provider,
          cwd: directory,
          outputSchema: null,
          options: { prompt: 'x', ...options },
        },
        signal,
      ),
    ).rejects.not.toThrow('Cannot start');
  for (const key of [
    'approval_policy',
    'sandbox_mode',
    'model',
    'model_reasoning_effort',
    'sandbox_workspace_write.network_access',
    'sandbox_workspace_write',
    'sandbox_workspace_write.writable_roots',
    'profiles',
    'profile',
    '"model"',
  ])
    expect(() => {
      validateConfig({ [key]: 'value' });
    }).toThrow();
  expect(() => tomlLiteral({ value: [null] })).toThrow('null');
});

const semanticOptions: [HarnessRequest['provider'], object][] = [
  ['claude', { effort: 'high' }],
  ['claude', { disallowedTools: ['Bash'] }],
  ['claude', { permissionMode: 'plan' }],
  ['claude', { systemPrompt: 'role' }],
  ['claude', { appendSystemPrompt: 'role' }],
  ['claude', { agent: 'reader' }],
  ['claude', { agents: { reader: { description: 'x', prompt: 'x' } } }],
  ['claude', { mcpServers: { s: { command: 'node' } } }],
  ['claude', { strictMcpConfig: true }],
  ['claude', { settings: { hooks: {} } }],
  ['claude', { fallbackModel: ['other'] }],
  ['claude', { addDirs: ['more'] }],
  ['claude', { extraArgs: ['--no-chrome'] }],
  ['claude', { env: { QC_TEST: 'value' } }],
  ['codex', { effort: 'xhigh' }],
  ['codex', { reasoningEffort: 'none' }],
  ['codex', { networkAccess: true }],
  ['codex', { harnessProfile: 'native' }],
  ['codex', { config: { 'features.test': true } }],
  ['codex', { addDirs: ['more'] }],
  ['codex', { extraArgs: ['--strict-config'] }],
  ['codex', { env: { QC_TEST: 'value' } }],
];
it.each(semanticOptions)(
  'keeps new %s semantics in completed-step identity: %j',
  async (provider, change) => {
    let extra = {};
    const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        await ctx[provider].text('ask', {
          prompt: 'x',
          ...(provider === 'codex' ? { sandbox: 'workspace-write' as const } : {}),
          ...extra,
        });
        throw new Error('pause');
      },
    });
    const options = { ...setup(), harness: { invoke } };
    await expect(runWorkflow(definition, options)).rejects.toThrow('pause');
    extra = change;
    await expect(runWorkflow(definition, { ...options, resume: true })).rejects.toThrow(
      'changed on a completed step',
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  },
);

it('uses image contents for replay and supplies immutable bytes to custom harnesses', async () => {
  const first = join(directory, 'a.png');
  const renamed = join(directory, 'b.png');
  await writeFile(first, 'original');
  await writeFile(renamed, 'original');
  let image = first;
  let stop = true;
  const invoke = vi.fn<Harness['invoke']>().mockImplementation(async (request) => {
    await writeFile(first, 'changed during invocation');
    expect(Buffer.from(request.imageAttachments?.[0]?.base64 ?? '', 'base64').toString()).toBe(
      'original',
    );
    return reply;
  });
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      const result = await ctx.codex.text('image', { prompt: 'x', images: [image] });
      if (stop) throw new Error('pause');
      return result.output;
    },
  });
  await expect(runWorkflow(definition, { ...setup(), harness: { invoke } })).rejects.toThrow(
    'pause',
  );
  image = renamed;
  stop = false;
  await runWorkflow(definition, { ...setup(), harness: { invoke }, resume: true });
  expect(invoke).toHaveBeenCalledTimes(1);
  await writeFile(renamed, 'different');
  await expect(
    runWorkflow(definition, {
      ...setup(),
      harness: { invoke },
      resume: true,
      acceptCodeChange: true,
    }),
  ).rejects.toThrow('option.images changed');
});

it('names the step id when an attached image cannot be read for snapshotting', async () => {
  const missing = join(directory, 'missing.png');
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      const result = await ctx.codex.text('missing-image', { prompt: 'x', images: [missing] });
      return result.output;
    },
  });
  await expect(runWorkflow(definition, { ...setup(), harness: { invoke } })).rejects.toThrow(
    'Step missing-image: image snapshot failed:',
  );
  expect(invoke).not.toHaveBeenCalled();
});

it('captures first-use versions, warns on resumed drift, and records inherited/requested effort', async () => {
  let version = '1';
  const metadata = vi
    .fn<NonNullable<Harness['metadata']>>()
    .mockImplementation(() => Promise.resolve({ binary: 'fake', version }));
  const invoke = vi
    .fn<Harness['invoke']>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.claude.text('one', { prompt: 'x', effort: 'high' });
      return (await ctx.claude.text('two', { prompt: 'y' })).output;
    },
  });
  await expect(
    runWorkflow(definition, { ...setup(), harness: { metadata, invoke } }),
  ).rejects.toThrow('offline');
  version = '2';
  const result = await runWorkflow(definition, {
    ...setup(),
    harness: { metadata, invoke },
    resume: true,
  });
  expect(metadata).toHaveBeenCalledTimes(2);
  expect(result.warnings?.join(' ')).toContain('fake@1 to fake@2');
  expect(result.steps['one']?.attemptHistory?.[1]?.requested).toEqual({
    model: 'inherited',
    effort: 'high',
  });
  expect(result.steps['two']?.attemptHistory?.[0]?.requested).toEqual({
    model: 'inherited',
    effort: 'inherited',
  });
  expect((await readRun(setup())).harnesses?.claude).toEqual({ binary: 'fake', version: '2' });
  await runWorkflow(definition, { ...setup(), harness: { metadata, invoke }, resume: true });
  expect(metadata).toHaveBeenCalledTimes(2);
});

it('includes native controls in profile manifests, grants, and strict call-site checks', async () => {
  const manifest = capabilityManifest({
    profiles: {
      builder: { extends: 'edit', codex: { harnessProfile: 'native', effort: 'max' } },
      reader: { extends: 'readonly', claude: { appendSystemPrompt: 'role', effort: 'low' } },
    },
  });
  expect(manifest.profiles['builder']?.access).toBe('exec');
  expect(manifest.profiles['reader']?.access).toBe('read');
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    strictProfiles: true,
    profiles: { builder: { extends: 'edit', codex: { harnessProfile: 'native' } } },
    async run(ctx) {
      return (await ctx.codex.text('ask', { prompt: 'x', profile: 'builder' })).output;
    },
  });
  await expect(
    runWorkflow(definition, { ...setup(), grants: ['write'], harness: { invoke } }),
  ).rejects.toThrow('requires exec');
  const result = await runWorkflow(definition, {
    ...setup(),
    grants: ['builder'],
    harness: { invoke },
  });
  expect(result.output).toBe('ok');
  const raw = defineWorkflow({
    ...base,
    strictProfiles: true,
    async run(ctx) {
      return (await ctx.claude.text('ask', { prompt: 'x', env: { QC_TEST: 'x' } })).output;
    },
  });
  await expect(runWorkflow(raw, { ...setup(), runId: 'raw', harness: { invoke } })).rejects.toThrow(
    'strictProfiles',
  );
});

it('rejects conflicting inherited effort controls before invocation and resolves inherited network sandbox', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const conflict = defineWorkflow({
    ...base,
    defaults: { codex: { reasoningEffort: 'low' } },
    async run(ctx) {
      return (await ctx.codex.text('ask', { prompt: 'x', effort: 'high' })).output;
    },
  });
  await expect(runWorkflow(conflict, { ...setup(), harness: { invoke } })).rejects.toThrow(
    'never both',
  );
  expect(invoke).not.toHaveBeenCalled();
  const network = defineWorkflow({
    ...base,
    defaults: { profile: 'edit' },
    async run(ctx) {
      return (await ctx.codex.text('ask', { prompt: 'x', networkAccess: true })).output;
    },
  });
  await runWorkflow(network, { ...setup(), runId: 'network', harness: { invoke } });
  expect(invoke.mock.calls[0]?.[0].options).toMatchObject({
    sandbox: 'workspace-write',
    networkAccess: true,
  });
});

it('keeps shared version discovery alive when its first map subtree aborts', async () => {
  let ready!: () => void;
  const discovered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let releaseFailure!: () => void;
  const fail = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  let finish!: () => void;
  const metadata = vi.fn<NonNullable<Harness['metadata']>>().mockImplementation(
    (_request, signal) =>
      new Promise((resolve, reject) => {
        finish = () => {
          resolve({ binary: 'fake', version: '1' });
        };
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('discovery aborted', { cause: signal.reason }));
          },
          { once: true },
        );
        ready();
      }),
  );
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      const mapped = ctx.map(
        'group',
        [0, 1],
        { concurrency: 2, onError: 'abort' },
        async (item) => {
          if (item === 0) return (await ctx.claude.text('inside', { prompt: 'x' })).output;
          await discovered;
          await fail;
          ctx.signal.addEventListener(
            'abort',
            () => {
              queueMicrotask(finish);
            },
            { once: true },
          );
          throw new Error('map failure');
        },
      );
      await discovered;
      const outside = ctx.claude.text('outside', { prompt: 'y' });
      releaseFailure();
      await Promise.all([mapped, outside]);
      return 'unreachable';
    },
  });
  await expect(
    runWorkflow(definition, { ...setup(), harness: { metadata, invoke } }),
  ).rejects.toThrow('map failure');
  expect(metadata).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0]?.[0].options.prompt).toBe('y');
  expect((await readRun(setup())).steps['outside']?.status).toBe('completed');
});
