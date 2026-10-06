import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { testInvocation } from './harness-invocation.js';
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
  type ProjectInstructionsRecord,
} from '../src/index.js';
import {
  codexEffortValues,
  validateExtraArgs,
  validateConfig,
  tomlLiteral,
} from '../src/workflow/runtime/agent-controls.js';
import { snapshotImages } from '../src/workflow/runtime/images.js';
import {
  MAX_PROJECT_INSTRUCTIONS,
  withProjectInstructions,
} from '../src/workflow/runtime/record.js';
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
    { harness: 'claude', cwd: directory, outputSchema: null, options: controls },
    testInvocation(signal),
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
  expect(controls.env).toHaveProperty('PATH', result.parent);
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
    isolation: 'inherit',
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
    { harness: 'codex', cwd: directory, outputSchema: null, options },
    testInvocation(signal),
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

it.each(codexEffortValues)('sends Codex effort %s as model_reasoning_effort', async (effort) => {
  const path = await binary(capture);
  await new CliHarness({ codexBinary: path }).invoke(
    { harness: 'codex', cwd: directory, outputSchema: null, options: { prompt: 'x', effort } },
    testInvocation(signal),
  );
  const { args } = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as {
    args: string[];
  };
  expect(args).toContain(`model_reasoning_effort=${JSON.stringify(effort)}`);
  expect(args.filter((arg) => arg.startsWith('model_reasoning_effort='))).toHaveLength(1);
});

it('rejects a renamed reasoningEffort on a Codex call, profile or defaults before invoking', async () => {
  const renamed = 'reasoningEffort was renamed to effort';
  const legacy: object = { reasoningEffort: 'low' };
  await expect(
    new CliHarness({ codexBinary: '/absent' }).invoke(
      { harness: 'codex', cwd: directory, outputSchema: null, options: { prompt: 'x', ...legacy } },
      testInvocation(signal),
    ),
  ).rejects.toThrow(`Invalid codex options: ${renamed}`);
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const call = defineWorkflow({
    ...base,
    async run(ctx) {
      return (await ctx.codex.text('ask', { prompt: 'x', ...legacy })).output;
    },
  });
  await expect(runWorkflow(call, { ...setup(), harness: { invoke } })).rejects.toThrow(renamed);
  const declarations = [
    [{ profiles: { scout: { codex: legacy } } }, `Profile scout codex: ${renamed}`],
    [{ defaults: { codex: legacy } }, `defaults.codex: ${renamed}`],
  ] as const;
  for (const [index, [declaration, message]] of declarations.entries()) {
    const definition = defineWorkflow({
      ...base,
      ...(declaration as object),
      async run(ctx) {
        return (await ctx.codex.text('ask', { prompt: 'x' })).output;
      },
    });
    await expect(
      runWorkflow(definition, {
        ...setup(),
        runId: `renamed-${String(index)}`,
        harness: { invoke },
      }),
    ).rejects.toThrow(message);
  }
  expect(invoke).not.toHaveBeenCalled();
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
        harness: 'claude',
        cwd: directory,
        outputSchema: null,
        options: {
          prompt: 'x',
          systemPrompt: 'private',
          timeoutMs: mode === 'timeout' ? 1000 : 10_000,
        },
      },
      testInvocation(controller.signal),
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
    'restricted',
    'bare',
    'safe-mode',
    'setting-sources',
    'plugin-dir',
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
    'ignore-user-config',
    'ignore-rules',
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
          harness: provider,
          cwd: directory,
          outputSchema: null,
          options: { prompt: 'x', extraArgs: ['--model=x'] },
        },
        testInvocation(signal),
      ),
    ).rejects.toThrow('owned by model');
  },
);
it('rejects typed enum conflicts, bypass settings and config shadowing before spawn', async () => {
  const harness = new CliHarness({ claudeBinary: '/absent', codexBinary: '/absent' });
  const invalid: ['claude' | 'codex', object][] = [
    ['claude', { effort: 'ultra' }],
    ['claude', { permissionMode: 'bypassPermissions' }],
    [
      'claude',
      { agents: { bad: { description: 'x', prompt: 'x', permissionMode: 'bypassPermissions' } } },
    ],
    ['claude', { settings: { permissions: { defaultMode: 'bypassPermissions' } } }],
    ['codex', { effort: 'ultra' }],
    ['codex', { networkAccess: true }],
    ['codex', { config: { thing: null } }],
  ];
  for (const [provider, options] of invalid)
    await expect(
      harness.invoke(
        {
          harness: provider,
          cwd: directory,
          outputSchema: null,
          options: { prompt: 'x', ...options },
        },
        testInvocation(signal),
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

const semanticOptions: ['claude' | 'codex', object][] = [
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
  ['claude', { plugins: ['review-plugin'] }],
  ['claude', { env: { unset: ['REMOVE'] } }],
  ['claude', { isolation: 'inherit' }],
  ['claude', { fallbackModel: ['other'] }],
  ['claude', { addDirs: ['more'] }],
  ['claude', { extraArgs: ['--no-chrome'] }],
  ['claude', { env: { QC_TEST: 'value' } }],
  ['codex', { effort: 'xhigh' }],
  ['codex', { effort: 'none' }],
  ['codex', { networkAccess: true }],
  ['codex', { isolation: 'inherit', harnessProfile: 'native' }],
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

it.skipIf(process.platform === 'win32')(
  'rejects a FIFO image source promptly instead of blocking on it',
  async () => {
    const fifo = join(directory, 'pipe.png');
    execFileSync('mkfifo', [fifo]);
    const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
    const definition = defineWorkflow({
      ...base,
      async run(ctx) {
        return (await ctx.codex.text('fifo-image', { prompt: 'x', images: [fifo] })).output;
      },
    });
    await expect(runWorkflow(definition, { ...setup(), harness: { invoke } })).rejects.toThrow(
      'Step fifo-image: image snapshot failed: image source is not a regular file',
    );
    expect(invoke).not.toHaveBeenCalled();
    // The adapter's fallback snapshot applies the same rule.
    await expect(snapshotImages([fifo], directory, new AbortController().signal)).rejects.toThrow(
      'image source is not a regular file',
    );
  },
  5_000,
);

it('rejects an image snapshot with an aborted signal before reading', async () => {
  const reason = new Error('stop before reading');
  // A missing path would fail with ENOENT if the snapshot tried to open it.
  await expect(
    snapshotImages([join(directory, 'missing.png')], directory, AbortSignal.abort(reason)),
  ).rejects.toBe(reason);
});

it('reports run interruption during image snapshotting as cancellation, not a snapshot failure', async () => {
  const controller = new AbortController();
  const invoke = vi.fn<Harness['invoke']>().mockImplementation((request) => {
    // Interrupt after the first effect launches; its valid result still commits.
    if (request.harness === 'claude') controller.abort(new Error('interrupted'));
    return Promise.resolve(reply);
  });
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.claude.text('first', { prompt: 'x' });
      const missing = join(directory, 'missing.png');
      return (await ctx.codex.text('image', { prompt: 'x', images: [missing] })).output;
    },
  });
  const failure: unknown = await runWorkflow(definition, {
    ...setup(),
    harness: { invoke },
    signal: controller.signal,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).not.toContain('image snapshot failed');
  const saved = await readRun({ stateDir: join(directory, 'state'), runId: 'controls' });
  expect(saved.status).toBe('cancelled');
  expect(saved.steps['first']?.status).toBe('completed');
  expect(invoke).toHaveBeenCalledTimes(1);
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
    profiles: { careful: { extends: 'readonly', claude: { effort: 'low' } } },
    async run(ctx) {
      await ctx.claude.text('one', { prompt: 'x', effort: 'high' });
      await ctx.claude.text('three', { prompt: 'z', profile: 'careful' });
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
  expect(result.steps['one']?.attemptHistory?.[1]?.sources['effort']).toBe('call-site');
  expect(result.steps['three']?.attemptHistory?.[0]).toMatchObject({
    requested: { model: 'inherited', effort: 'low' },
    sources: { effort: 'profile:careful' },
  });
  expect(result.steps['two']?.attemptHistory?.[0]?.requested).toEqual({
    model: 'inherited',
    effort: 'inherited',
  });
  expect(result.steps['two']?.attemptHistory?.[0]?.sources).not.toHaveProperty('effort');
  expect((await readRun(setup())).harnesses?.['claude']).toEqual({ binary: 'fake', version: '2' });
  await runWorkflow(definition, { ...setup(), harness: { metadata, invoke }, resume: true });
  expect(metadata).toHaveBeenCalledTimes(2);
});

it('includes native controls in profile manifests, grants, and strict call-site checks', async () => {
  const manifest = capabilityManifest({
    profiles: {
      builder: {
        extends: 'edit',
        codex: { isolation: 'inherit', harnessProfile: 'native', effort: 'max' },
      },
      reader: { extends: 'readonly', claude: { appendSystemPrompt: 'role', effort: 'low' } },
    },
  });
  expect(manifest.profiles['builder']?.access).toBe('exec');
  expect(manifest.profiles['reader']?.access).toBe('read');
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const definition = defineWorkflow({
    ...base,
    strictProfiles: true,
    profiles: {
      builder: { extends: 'edit', codex: { isolation: 'inherit', harnessProfile: 'native' } },
    },
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
      // @ts-expect-error -- strictProfiles omits env at type level too; the runtime still rejects it.
      return (await ctx.claude.text('ask', { prompt: 'x', env: { QC_TEST: 'x' } })).output;
    },
  });
  await expect(runWorkflow(raw, { ...setup(), runId: 'raw', harness: { invoke } })).rejects.toThrow(
    'strictProfiles',
  );
});

it('lets a call-site Codex effort replace an inherited one and resolves inherited network sandbox', async () => {
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  const inherited = defineWorkflow({
    ...base,
    defaults: { codex: { effort: 'low' } },
    async run(ctx) {
      await ctx.codex.text('inherit', { prompt: 'y' });
      return (await ctx.codex.text('ask', { prompt: 'x', effort: 'high' })).output;
    },
  });
  const run = await runWorkflow(inherited, { ...setup(), harness: { invoke } });
  expect(invoke.mock.calls[0]?.[0].options).toMatchObject({ effort: 'low' });
  expect(invoke.mock.calls[1]?.[0].options).toMatchObject({ effort: 'high' });
  expect(run.steps['inherit']?.attemptHistory?.[0]).toMatchObject({
    effort: 'low',
    requested: { effort: 'low' },
    sources: { effort: 'profile:text' },
  });
  expect(run.steps['ask']?.attemptHistory?.[0]).toMatchObject({
    effort: 'high',
    requested: { effort: 'high' },
    sources: { effort: 'call-site' },
  });
  invoke.mockClear();
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
    (_request, { signal }) =>
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
        { concurrency: 2, cancelSiblings: true },
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

it('releases an aborted scope from stalled discovery and drains discovery before settling', async () => {
  let ready!: () => void;
  const discovered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const order: string[] = [];
  const metadata = vi.fn<NonNullable<Harness['metadata']>>().mockImplementation(
    (_request, { signal }) =>
      new Promise((_resolve, reject) => {
        // A well-behaved adapter that waits for its supplied signal and nothing else.
        signal.addEventListener(
          'abort',
          () => {
            order.push('discovery settled');
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
      await ctx.map('group', [0, 1], { concurrency: 2, cancelSiblings: true }, async (item) => {
        if (item === 0) {
          try {
            return (await ctx.claude.text('inside', { prompt: 'x' })).output;
          } finally {
            order.push('inside released');
          }
        }
        await discovered;
        throw new Error('map failure');
      });
      return 'unreachable';
    },
  });
  const failure = runWorkflow(definition, { ...setup(), harness: { metadata, invoke } }).finally(
    () => {
      order.push('run settled');
    },
  );
  await expect(failure).rejects.toThrow('map failure');
  expect(order).toEqual(['inside released', 'discovery settled', 'run settled']);
  expect(metadata).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
  const saved = await readRun(setup());
  expect(saved.status).toBe('failed');
  expect(saved.steps['inside']?.status).not.toBe('running');
});

/** A spy harness whose project detection reports one digest per cwd from `files`. */
function projectSpy(files = new Map<string, string>()) {
  const metadata = vi
    .fn<NonNullable<Harness['metadata']>>()
    .mockResolvedValue({ binary: 'fake', version: '1' });
  const projectInstructions = vi
    .fn<NonNullable<Harness['projectInstructions']>>()
    .mockImplementation((request) => {
      const text = files.get(basename(request.cwd));
      return Promise.resolve({
        sources:
          text === undefined
            ? []
            : [
                {
                  scope: 'project' as const,
                  kind: 'agents' as const,
                  path: join(request.cwd, 'AGENTS.md'),
                  sha256: createHash('sha256').update(text).digest('hex'),
                },
              ],
      });
    });
  const invoke = vi.fn<Harness['invoke']>().mockResolvedValue(reply);
  return { metadata, projectInstructions, invoke };
}

it('detects project instructions once per distinct cwd, sequentially and in a parallel map', async () => {
  const harness = projectSpy(new Map([['a', 'rules a']]));
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      for (const leaf of ['one', 'two', 'three'])
        await ctx.codex.text(leaf, { prompt: leaf, cwd: 'a' });
      await ctx.map('fan', [0, 1, 2, 3], { concurrency: 4 }, async (item) =>
        ctx.codex.text('call', { prompt: String(item), cwd: 'b' }),
      );
      return 'done';
    },
  });
  const run = await runWorkflow(definition, { ...setup(), harness });
  expect(run.status).toBe('completed');
  expect(harness.invoke).toHaveBeenCalledTimes(7);
  expect(harness.metadata).toHaveBeenCalledTimes(1);
  expect(harness.projectInstructions).toHaveBeenCalledTimes(2);
  // Detection gets the run's shared discovery signal, not the call's scope signal.
  const detectionSignal = harness.projectInstructions.mock.calls[0]?.[1].signal;
  expect(detectionSignal).not.toBe(harness.invoke.mock.calls[0]?.[1].signal);
  const record = await readRun(setup());
  expect(record.projectInstructions).toEqual([
    {
      harness: 'codex',
      cwd: join(record.cwd, 'a'),
      sources: [expect.objectContaining({ path: join(record.cwd, 'a', 'AGENTS.md') })],
    },
    { harness: 'codex', cwd: join(record.cwd, 'b'), sources: [] },
  ]);
});

it('detects again for the same cwd when the isolation mode differs, once per mode', async () => {
  const harness = projectSpy(new Map([['a', 'rules a']]));
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.codex.text('one', { prompt: 'one', cwd: 'a' });
      await ctx.codex.text('two', { prompt: 'two', cwd: 'a', isolation: 'restricted' });
      await ctx.codex.text('three', { prompt: 'three', cwd: 'a', isolation: 'inherit' });
      await ctx.codex.text('four', { prompt: 'four', cwd: 'a', isolation: 'inherit' });
      return 'done';
    },
  });
  expect((await runWorkflow(definition, { ...setup(), harness })).status).toBe('completed');
  // Unset and explicit restricted resolve to the same mode.
  expect(harness.projectInstructions).toHaveBeenCalledTimes(2);
  expect(
    harness.projectInstructions.mock.calls.map(
      ([request]) => (request.options as { readonly isolation?: string }).isolation,
    ),
  ).toEqual(['restricted', 'inherit']);
  // Both detections at one cwd keep one entry, the later one merged into it.
  const record = await readRun(setup());
  expect(record.projectInstructions).toEqual([
    {
      harness: 'codex',
      cwd: join(record.cwd, 'a'),
      sources: [expect.objectContaining({ path: join(record.cwd, 'a', 'AGENTS.md') })],
    },
  ]);
});

it('records only the inherit entry when restricted detection reports nothing', async () => {
  const claudeMd = {
    scope: 'user',
    kind: 'claude-md',
    path: '/home/fixture/.claude/CLAUDE.md',
    sha256: 'e'.repeat(64),
  } as const;
  const harness = {
    ...projectSpy(),
    // Like CliHarness for Claude: the user CLAUDE.md loads only in inherit mode.
    projectInstructions: vi
      .fn<NonNullable<Harness['projectInstructions']>>()
      .mockImplementation((request) =>
        Promise.resolve(
          (request.options as { readonly isolation?: string }).isolation === 'inherit'
            ? { sources: [claudeMd] }
            : undefined,
        ),
      ),
  };
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.claude.text('restricted', { prompt: 'one' });
      await ctx.claude.text('inherit', { prompt: 'two', isolation: 'inherit' });
      await ctx.claude.text('restricted-again', { prompt: 'three' });
      return 'done';
    },
  });
  expect((await runWorkflow(definition, { ...setup(), harness })).status).toBe('completed');
  expect(harness.projectInstructions).toHaveBeenCalledTimes(2);
  const record = await readRun(setup());
  expect(record.projectInstructions).toEqual([
    { harness: 'claude', cwd: record.cwd, sources: [claudeMd] },
  ]);
  expect(record.harnessWarnings ?? []).toEqual([]);
});

it('keeps project detection out of step identity and replay', async () => {
  const files = new Map([
    ['a', 'rules a'],
    ['b', 'rules b'],
  ]);
  let fail = true;
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      const first = await ctx.codex.text('first', { prompt: 'x', cwd: 'a' });
      await ctx.codex.text('second', { prompt: 'y', cwd: 'b' });
      await ctx.step('gate', {
        input: null,
        schema: z.null(),
        run() {
          if (fail) throw new Error('gate failure');
          return null;
        },
      });
      await ctx.codex.text('third', { prompt: 'z', cwd: 'a' });
      return first.output;
    },
  });
  // A mid-run failure: the completed calls replay on resume even though project files changed.
  const failing = projectSpy(files);
  await expect(runWorkflow(definition, { ...setup(), harness: failing })).rejects.toThrow(
    'gate failure',
  );
  const before = await readRun(setup());
  files.set('a', 'rules a, edited');
  files.set('b', 'rules b, edited');
  fail = false;
  const resumed = projectSpy(files);
  const completed = await runWorkflow(definition, { ...setup(), resume: true, harness: resumed });
  expect(completed.output).toBe('ok');
  // Only the new call runs live: one metadata and one project detection, for its cwd.
  expect(resumed.invoke).toHaveBeenCalledTimes(1);
  expect(resumed.metadata).toHaveBeenCalledTimes(1);
  expect(resumed.projectInstructions).toHaveBeenCalledTimes(1);
  expect(resumed.projectInstructions.mock.calls[0]?.[0].cwd).toBe(join(before.cwd, 'a'));
  for (const id of ['first', 'second']) {
    expect(completed.steps[id]?.fingerprint).toBe(before.steps[id]?.fingerprint);
    expect(completed.steps[id]?.attempts).toBe(1);
  }
  // The re-detected cwd replaces its entry and moves to the end instead of duplicating it.
  const digestOf = (text: string) => createHash('sha256').update(text).digest('hex');
  const saved = await readRun(setup());
  expect(
    saved.projectInstructions?.map((entry) => [basename(entry.cwd), entry.sources[0]?.sha256]),
  ).toEqual([
    ['b', digestOf('rules b')],
    ['a', digestOf('rules a, edited')],
  ]);

  // A completed-only replay launches nothing, whatever the files now hold.
  files.set('a', 'rules a, edited again');
  const replay = projectSpy(files);
  const replayed = await runWorkflow(definition, { ...setup(), resume: true, harness: replay });
  expect(replayed.output).toBe('ok');
  expect(replay.invoke).not.toHaveBeenCalled();
  expect(replay.metadata).not.toHaveBeenCalled();
  expect(replay.projectInstructions).not.toHaveBeenCalled();
  for (const id of ['first', 'second', 'third'])
    expect(replayed.steps[id]?.fingerprint).toBe(completed.steps[id]?.fingerprint);
  expect((await readRun(setup())).projectInstructions).toEqual(saved.projectInstructions);
});

it('turns a failed project detection into a warning and still runs the call', async () => {
  const harness = {
    ...projectSpy(),
    projectInstructions: vi
      .fn<NonNullable<Harness['projectInstructions']>>()
      .mockRejectedValue(new Error(`unreadable ${'x'.repeat(400)}`)),
  };
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      return (await ctx.codex.text('ask', { prompt: 'x' })).output;
    },
  });
  const run = await runWorkflow(definition, { ...setup(), harness });
  expect(run.output).toBe('ok');
  expect(harness.invoke).toHaveBeenCalledTimes(1);
  const record = await readRun(setup());
  expect(record.projectInstructions).toBeUndefined();
  const warning = `codex project instruction detection failed for ${record.cwd}: unreadable `;
  expect(record.harnessWarnings).toEqual([`${warning}${'x'.repeat(300 - 'unreadable '.length)}`]);
});

it('records detection warnings and rejects malformed sources as a warning', async () => {
  const harness = {
    ...projectSpy(),
    projectInstructions: vi
      .fn<NonNullable<Harness['projectInstructions']>>()
      .mockImplementation((request) =>
        Promise.resolve(
          basename(request.cwd) === 'bad'
            ? {
                sources: [
                  { scope: 'project', kind: 'agents', path: '/x/AGENTS.md', sha256: 'not hex' },
                ],
              }
            : {
                sources: [],
                warnings: ['Could not inspect one file', 'Could not inspect one file'],
              },
        ),
      ),
  };
  const definition = defineWorkflow({
    ...base,
    async run(ctx) {
      await ctx.codex.text('good', { prompt: 'x', cwd: 'good' });
      return (await ctx.codex.text('bad', { prompt: 'y', cwd: 'bad' })).output;
    },
  });
  await expect(runWorkflow(definition, { ...setup(), harness })).resolves.toMatchObject({
    status: 'completed',
  });
  const record = await readRun(setup());
  expect(record.projectInstructions).toEqual([
    { harness: 'codex', cwd: join(record.cwd, 'good'), sources: [] },
  ]);
  expect(record.harnessWarnings).toEqual([
    'Could not inspect one file',
    expect.stringContaining(
      `codex project instruction detection failed for ${join(record.cwd, 'bad')}`,
    ),
  ]);
});

it('keeps the 128 most recent project instruction entries and replaces a re-detected cwd', () => {
  const entry = (index: number) => ({
    harness: 'codex',
    cwd: `/dir-${String(index)}`,
    sources: [],
  });
  let entries: ProjectInstructionsRecord[] | undefined;
  for (let index = 0; index < 130; index++)
    entries = withProjectInstructions(entries, entry(index));
  expect(MAX_PROJECT_INSTRUCTIONS).toBe(128);
  expect(entries).toHaveLength(128);
  expect(entries?.[0]?.cwd).toBe('/dir-2');
  expect(entries?.at(-1)?.cwd).toBe('/dir-129');
  const before = entries;
  entries = withProjectInstructions(entries, { ...entry(5), sources: [] });
  expect(before).toHaveLength(128);
  expect(entries.filter((existing) => existing.cwd === '/dir-5')).toHaveLength(1);
  expect(entries.at(-1)?.cwd).toBe('/dir-5');
  expect(entries[0]?.cwd).toBe('/dir-2');
  // Another harness at the same cwd is a separate entry.
  entries = withProjectInstructions(entries, { ...entry(5), harness: 'claude' });
  expect(entries.filter((existing) => existing.cwd === '/dir-5')).toHaveLength(2);
  expect(entries[0]?.cwd).toBe('/dir-3');
});

it('merges a project instruction entry by kind and path, the newer digest winning', () => {
  const source = (path: string, digit: string) =>
    ({ scope: 'user', kind: 'claude-md', path, sha256: digit.repeat(64) }) as const;
  const other = { harness: 'claude', cwd: '/other', sources: [] };
  let entries = withProjectInstructions(undefined, {
    harness: 'claude',
    cwd: '/work',
    sources: [source('/a/CLAUDE.md', 'a'), source('/b/CLAUDE.md', 'b')],
  });
  entries = withProjectInstructions(entries, other);
  entries = withProjectInstructions(
    entries,
    {
      harness: 'claude',
      cwd: '/work',
      sources: [source('/b/CLAUDE.md', 'c'), source('/d/CLAUDE.md', 'd')],
    },
    true,
  );
  expect(entries).toEqual([
    other,
    {
      harness: 'claude',
      cwd: '/work',
      sources: [
        source('/a/CLAUDE.md', 'a'),
        source('/b/CLAUDE.md', 'c'),
        source('/d/CLAUDE.md', 'd'),
      ],
    },
  ]);
  // Without an earlier entry, a merge records the entry as given.
  expect(withProjectInstructions(undefined, other, true)).toEqual([other]);
});

it('releases an aborted scope from stalled project detection and drains it before settling', async () => {
  let ready!: () => void;
  const detecting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const order: string[] = [];
  const signals: AbortSignal[] = [];
  const projectInstructions = vi
    .fn<NonNullable<Harness['projectInstructions']>>()
    .mockImplementation(
      (_request, { signal }) =>
        new Promise((_resolve, reject) => {
          signals.push(signal);
          // A well-behaved adapter that waits for its supplied signal and nothing else.
          signal.addEventListener(
            'abort',
            () => {
              order.push('detection settled');
              reject(new Error('detection aborted', { cause: signal.reason }));
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
      await ctx.map('group', [0, 1], { concurrency: 2, cancelSiblings: true }, async (item) => {
        if (item === 0) {
          try {
            return (await ctx.codex.text('inside', { prompt: 'x' })).output;
          } finally {
            order.push('inside released');
          }
        }
        await detecting;
        throw new Error('map failure');
      });
      return 'unreachable';
    },
  });
  const failure = runWorkflow(definition, {
    ...setup(),
    harness: { projectInstructions, invoke },
  }).finally(() => {
    order.push('run settled');
  });
  await expect(failure).rejects.toThrow('map failure');
  expect(order).toEqual(['inside released', 'detection settled', 'run settled']);
  expect(signals).toHaveLength(1);
  expect(signals[0]?.aborted).toBe(true);
  expect(projectInstructions).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
  const saved = await readRun(setup());
  expect(saved.status).toBe('failed');
  expect(saved.projectInstructions).toBeUndefined();
  expect(saved.harnessWarnings ?? []).toEqual([]);
});
