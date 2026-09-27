// Opt-in native CLI regression. Fresh homes, dummy keys, and local fake APIs only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliHarness } from '../dist/index.js';
import { materializeInvocation } from '../dist/harnesses/invocation.js';
import { runProcess } from '../dist/harnesses/process.js';
import { fakeApi } from './contracts/local-api.mjs';

assert(process.argv.slice(2).every((arg) => ['--claude', '--codex'].includes(arg)));
const providers =
  process.argv.length === 2
    ? ['claude', 'codex']
    : process.argv.slice(2).map((arg) => arg.slice(2));
const root = await mkdtemp(join(tmpdir(), 'choir-isolation-contract-'));
const report = {
  date: new Date().toISOString(),
  transport: 'local fake APIs and dummy keys; no inference',
  cases: [],
};

async function execute(provider, name, options = {}, tool) {
  const home = join(root, name),
    cwd = join(home, 'project'),
    config = join(home, 'config');
  await mkdir(join(cwd, '.claude'), { recursive: true });
  await mkdir(config);
  const events = join(home, 'hooks.txt');
  const hook = join(home, 'hook.mjs');
  await writeFile(
    hook,
    `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(events)}, process.argv[2]+String.fromCharCode(10));`,
  );
  const hookDefinition = (label) => [
    {
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)} ${label}`,
        },
      ],
    },
  ];
  await writeFile(
    join(config, 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: hookDefinition('user') } }),
  );
  const projectSettings = JSON.stringify({
    hooks: { SessionStart: hookDefinition('project'), UserPromptSubmit: hookDefinition('prompt') },
  });
  await writeFile(join(cwd, '.claude', 'settings.json'), projectSettings);
  await writeFile(join(cwd, 'CLAUDE.md'), 'PROJECT_INSTRUCTIONS_MARKER');
  const outside = join(home, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'file.txt'), 'OUTSIDE_CONTENT_MARKER');
  const plugin = join(home, 'plugin');
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
  await mkdir(join(plugin, 'skills', 'fixture'), { recursive: true });
  await writeFile(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'isolation-fixture', version: '1.0.0' }),
  );
  await writeFile(
    join(plugin, 'skills', 'fixture', 'SKILL.md'),
    '---\nname: fixture\ndescription: Local test fixture.\n---\nPLUGIN_INSTRUCTIONS_MARKER\n',
  );
  const serverFile = join(home, 'mcp.mjs');
  await writeFile(
    serverFile,
    `import readline from 'node:readline';const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'report',description:'Inert local fixture',inputSchema:{type:'object',properties:{}}}]}:{};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`,
  );
  // This inherited user config must not affect a restricted Codex call.
  await writeFile(
    join(config, 'config.toml'),
    'model_provider = "nonexistent-inherited-provider"\n',
  );
  const bodies = [];
  const api = await fakeApi(`${provider}-text-success`, {
    onRequest: (request) => {
      if (request.url.includes('/messages') || request.url.includes('/responses'))
        bodies.push(request.body);
    },
    tool: tool?.({ cwd, outside }),
  });
  const environment = {
    PATH: process.env['PATH'],
    HOME: home,
    TMPDIR: home,
    TERM: 'dumb',
    NO_COLOR: '1',
    ...(provider === 'claude'
      ? {
          CLAUDE_CONFIG_DIR: config,
          ANTHROPIC_BASE_URL: api.url,
          ANTHROPIC_API_KEY: 'sk-ant-local-fixture',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          DISABLE_AUTOUPDATER: '1',
        }
      : {
          CODEX_HOME: config,
          QUIET_CHOIR_FAKE_API_KEY: 'local-fixture',
          OTEL_SDK_DISABLED: 'true',
        }),
  };
  const explicit =
    typeof options === 'function'
      ? options({ cwd, outside, plugin, hookDefinition, serverFile })
      : options;
  const request = {
    harness: provider,
    cwd,
    outputSchema: null,
    options: {
      prompt: 'Follow the local fixture response.',
      model: provider === 'claude' ? 'haiku' : 'gpt-5.5',
      ...(provider === 'claude'
        ? { tools: [], maxTurns: 4, maxBudgetUsd: 0.1 }
        : {
            skipGitRepoCheck: true,
            config: {
              model_provider: 'fixture',
              model_providers: {
                fixture: {
                  name: 'Local fixture',
                  base_url: `${api.url}/v1`,
                  wire_api: 'responses',
                  env_key: 'QUIET_CHOIR_FAKE_API_KEY',
                  requires_openai_auth: false,
                  request_max_retries: 0,
                  stream_max_retries: 0,
                },
              },
            },
          }),
      ...explicit,
    },
  };
  let invocation;
  try {
    const plan = new CliHarness().plan(request);
    invocation = await materializeInvocation(plan, request);
    if (provider === 'claude') {
      const format = invocation.args.indexOf('--output-format');
      invocation.args[format + 1] = 'stream-json';
      invocation.args.push('--verbose');
    }
    const version = await runProcess({
      binary: provider,
      args: ['--version'],
      cwd,
      input: '',
      env: environment,
      inheritEnv: false,
      timeoutMs: 10_000,
      maxOutputBytes: 16_384,
      killGraceMs: 1000,
      signal: new AbortController().signal,
    });
    const result = await runProcess({
      binary: provider,
      args: invocation.args,
      cwd,
      input: plan.stdin,
      env: environment,
      inheritEnv: false,
      timeoutMs: 30_000,
      maxOutputBytes: 4 * 1024 * 1024,
      killGraceMs: 1000,
      signal: new AbortController().signal,
    });
    assert.equal(result.code, 0, `${name}: ${result.stderr}\n${result.stdout}`);
    assert(bodies.length > 0, 'The native CLI did not reach the local fake API.');
    const messages = result.stdout.split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const init = messages.find(
      (message) => message.type === 'system' && message.subtype === 'init',
    );
    const hooks = await readFile(events, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    const savedSettings = await readFile(join(cwd, '.claude', 'settings.json'), 'utf8');
    return {
      init,
      hooks,
      bodies,
      settingsUnchanged: savedSettings === projectSettings,
      version: version.stdout.trim(),
      apiCalls: bodies.length,
    };
  } finally {
    await invocation?.dispose();
    await api.close();
  }
}

try {
  if (providers.includes('claude')) {
    const inherited = await execute('claude', 'inherit', { isolation: 'inherit' });
    assert.match(inherited.hooks, /user/u);
    assert.match(inherited.hooks, /project/u);
    assert.match(inherited.hooks, /prompt/u);
    assert(JSON.stringify(inherited.bodies).includes('PROJECT_INSTRUCTIONS_MARKER'));
    const restricted = await execute('claude', 'restricted');
    assert.equal(restricted.hooks, '');
    assert.deepEqual(restricted.init.tools, []);
    assert.deepEqual(restricted.init.mcp_servers, []);
    assert(!JSON.stringify(restricted.bodies).includes('PROJECT_INSTRUCTIONS_MARKER'));
    assert(!Object.keys(restricted.init).some((key) => /memory/iu.test(key)));
    report.cases.push({
      name: 'claude-restricted',
      version: restricted.version,
      inheritedHooksExecuted: true,
      restrictedHooksExecuted: false,
      projectInstructionsExcluded: true,
      tools: [],
      mcpServers: [],
      memoryFieldPresent: false,
    });
    const restored = await execute(
      'claude',
      'explicit-opt-ins',
      ({ plugin, hookDefinition, serverFile, outside }) => ({
        tools: ['Read', 'Write', 'Bash'],
        appendSystemPrompt: 'EXPLICIT_PROMPT_MARKER',
        settings: { hooks: { SessionStart: hookDefinition('explicit') } },
        plugins: [plugin],
        addDirs: [outside],
        mcpServers: { fixture: { command: process.execPath, args: [serverFile] } },
      }),
    );
    assert.equal(restored.hooks.trim(), 'explicit');
    assert(restored.init.tools.includes('Bash'));
    assert(restored.init.tools.includes('Read'));
    assert(
      restored.init.mcp_servers.some(
        (server) => server.name === 'fixture' && server.status === 'connected',
      ),
    );
    assert(restored.init.plugins.some((plugin) => plugin.name === 'isolation-fixture'));
    assert(JSON.stringify(restored.bodies).includes('EXPLICIT_PROMPT_MARKER'));
    report.cases.push({
      name: 'claude-explicit-opt-ins',
      settingsHook: true,
      mcpServer: true,
      plugin: true,
      appendPrompt: true,
      namedBashTool: true,
    });
    const denied = await execute(
      'claude',
      'outside-denied',
      { tools: ['Read'] },
      ({ outside }) => ({ name: 'Read', input: { file_path: join(outside, 'file.txt') } }),
    );
    assert(!JSON.stringify(denied.bodies).includes('OUTSIDE_CONTENT_MARKER'));
    const allowed = await execute(
      'claude',
      'outside-allowed',
      ({ outside }) => ({ tools: ['Read'], addDirs: [outside] }),
      ({ outside }) => ({ name: 'Read', input: { file_path: join(outside, 'file.txt') } }),
    );
    assert(JSON.stringify(allowed.bodies).includes('OUTSIDE_CONTENT_MARKER'));
    const protectedWrite = await execute(
      'claude',
      'protected-write',
      { tools: ['Write'] },
      ({ cwd }) => ({
        name: 'Write',
        input: { file_path: join(cwd, '.claude', 'settings.json'), content: 'REPLACED' },
      }),
    );
    assert(protectedWrite.settingsUnchanged);
    report.cases.push({
      name: 'claude-file-boundaries',
      outsideReadDenied: true,
      addedDirectoryReadAllowed: true,
      protectedSettingsWriteDenied: true,
    });
  }
  if (providers.includes('codex')) {
    const codex = await execute('codex', 'codex-restricted');
    report.cases.push({
      name: 'codex-restricted',
      version: codex.version,
      inheritedProviderIgnored: true,
      explicitProviderReachedLocalApi: codex.apiCalls > 0,
    });
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
