// Opt-in native CLI regression. Fresh homes, dummy keys, and local fake APIs only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
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

const markers = {
  userAgents: 'USER_AGENTS_MARKER',
  projectAgents: 'PROJECT_AGENTS_MARKER',
  userSkill: 'USER_SKILL_MARKER',
  repoAgentsSkill: 'REPO_AGENTS_SKILL_MARKER',
  homeAgentsSkill: 'HOME_AGENTS_SKILL_MARKER',
  repoCodexSkill: 'REPO_CODEX_SKILL_MARKER',
  nestedUserSkill: 'NESTED_USER_SKILL_MARKER',
  memorySummary: 'MEMORY_SUMMARY_MARKER',
  memoryMd: 'MEMORY_MD_MARKER',
  userClaudeMd: 'USER_CLAUDE_MD_MARKER',
  homeClaudeMd: 'HOME_CLAUDE_MD_MARKER',
};
// Inert credentials: the fixture provider authenticates through env_key, so Codex never uses them.
// They exercise the private CODEX_HOME copy and write-back of instructions: 'none'.
const authJson = `${JSON.stringify({ OPENAI_API_KEY: 'sk-local-fixture-auth' })}\n`;
const listing = async (directory) =>
  (await readdir(directory, { recursive: true })).map(String).sort();
const isPlainObject = (value) =>
  typeof value === 'object' &&
  value !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
// Merges by object structure, not by TOML dotted path: plain objects merge, everything else replaces.
const mergeConfig = (base, override) =>
  Object.fromEntries(
    [...Object.keys(base), ...Object.keys(override).filter((key) => !(key in base))].map((key) => [
      key,
      !(key in override)
        ? base[key]
        : isPlainObject(base[key]) && isPlainObject(override[key])
          ? mergeConfig(base[key], override[key])
          : override[key],
    ]),
  );
/** Write a skill whose description carries the marker, creating its directories. */
const skill = async (directory, name, marker) => {
  await mkdir(join(directory, name), { recursive: true });
  await writeFile(
    join(directory, name, 'SKILL.md'),
    `---\nname: ${name.split('/').at(-1)}\ndescription: ${marker}\n---\nCanary skill body.\n`,
  );
};

// extras.prepare({ home, project, config }) adjusts the instruction layout; extras.subdir
// runs the call from a directory below the project; extras.env({ home }) overrides child
// environment variables such as HOME; extras.timeoutMs shortens the call's deadline.
async function execute(provider, name, options = {}, tool, extras = {}) {
  const home = join(root, name),
    project = join(home, 'project'),
    cwd = extras.subdir ? join(project, extras.subdir) : project,
    config = join(home, 'config');
  await mkdir(join(project, '.claude'), { recursive: true });
  await mkdir(cwd, { recursive: true });
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
  await writeFile(join(project, '.claude', 'settings.json'), projectSettings);
  await writeFile(join(project, 'CLAUDE.md'), 'PROJECT_INSTRUCTIONS_MARKER');
  if (provider === 'claude') {
    // User-level CLAUDE.md in the configured config dir, and one in HOME/.claude that a configured
    // CLAUDE_CONFIG_DIR should make Claude ignore.
    await writeFile(join(config, 'CLAUDE.md'), markers.userClaudeMd);
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'CLAUDE.md'), markers.homeClaudeMd);
  }
  if (provider === 'codex') {
    // Codex instruction canaries: user-level AGENTS.md and skill, and a project AGENTS.md. With no
    // .git entry above the project, Codex reads the working directory only.
    await writeFile(join(config, 'AGENTS.md'), markers.userAgents);
    await mkdir(join(config, 'skills', 'canary'), { recursive: true });
    await writeFile(
      join(config, 'skills', 'canary', 'SKILL.md'),
      `---\nname: canary\ndescription: ${markers.userSkill}\n---\nCanary skill body.\n`,
    );
    await writeFile(join(project, 'AGENTS.md'), markers.projectAgents);
    // Further skill and memory canaries (#227): repository .agents/skills, HOME .agents/skills, the
    // repository .codex/skills, a nested user skill, and CODEX_HOME memories.
    await skill(join(project, '.agents', 'skills'), 'repo-canary', markers.repoAgentsSkill);
    await skill(join(home, '.agents', 'skills'), 'home-canary', markers.homeAgentsSkill);
    await skill(join(project, '.codex', 'skills'), 'legacy-canary', markers.repoCodexSkill);
    await skill(join(config, 'skills'), 'group/nested', markers.nestedUserSkill);
    await mkdir(join(config, 'memories'));
    await writeFile(
      join(config, 'memories', 'memory_summary.md'),
      `v1\n${markers.memorySummary}\n`,
    );
    await writeFile(join(config, 'memories', 'MEMORY.md'), `${markers.memoryMd}\n`);
  }
  await extras.prepare?.({ home, project, config });
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
  if (provider === 'codex') await writeFile(join(config, 'auth.json'), authJson, { mode: 0o600 });
  let configBefore;
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
  // An undefined override removes the variable.
  for (const [key, value] of Object.entries(extras.env?.({ home }) ?? {}))
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  // An explicit Codex config is merged over this fixture provider, and explicit keys win.
  const providerConfig = {
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
            config: providerConfig,
          }),
      ...explicit,
      ...(provider === 'codex'
        ? {
            config: isPlainObject(explicit.config)
              ? mergeConfig(providerConfig, explicit.config)
              : providerConfig,
          }
        : {}),
    },
  };
  let invocation;
  try {
    const plan = new CliHarness().plan(request);
    invocation = await materializeInvocation(plan, request, { codexHome: config });
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
    // After the version probe, which runs against the real home as harness metadata does.
    configBefore = await listing(config);
    // A timeout keeps its captured output, so the assertions below report it as a failure.
    const result = await runProcess({
      binary: provider,
      args: invocation.args,
      cwd,
      input: plan.stdin,
      env: { ...environment, ...invocation.env },
      inheritEnv: false,
      timeoutMs: extras.timeoutMs ?? 30_000,
      maxOutputBytes: 4 * 1024 * 1024,
      killGraceMs: 1000,
      signal: new AbortController().signal,
    }).catch((error) => {
      if (error?.code === 'ETIMEDOUT' && error.processResult) return error.processResult;
      throw error;
    });
    assert(
      bodies.length > 0,
      `${name}: the native CLI did not reach the local fake API (Codex: an explicit config may have moved model_provider or the fixture base_url away from the local fixture)\n${result.stderr}\n${result.stdout}`,
    );
    assert.equal(result.code, 0, `${name}: ${result.stderr}\n${result.stdout}`);
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
    const savedSettings = await readFile(join(project, '.claude', 'settings.json'), 'utf8');
    const warnings = await invocation.settle();
    return {
      plan,
      warnings,
      configUnchanged: JSON.stringify(await listing(config)) === JSON.stringify(configBefore),
      configDiff: (await listing(config)).filter((name) => !configBefore.includes(name)),
      authUnchanged:
        provider !== 'codex' || (await readFile(join(config, 'auth.json'), 'utf8')) === authJson,
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
    // #227: inherit loads <CLAUDE_CONFIG_DIR>/CLAUDE.md, which CliHarness then reports.
    assert(JSON.stringify(inherited.bodies).includes(markers.userClaudeMd));
    const restricted = await execute('claude', 'restricted');
    assert.equal(restricted.hooks, '');
    assert.deepEqual(restricted.init.tools, []);
    assert.deepEqual(restricted.init.mcp_servers, []);
    assert(!JSON.stringify(restricted.bodies).includes('PROJECT_INSTRUCTIONS_MARKER'));
    assert(!Object.keys(restricted.init).some((key) => /memory/iu.test(key)));
    assert(!JSON.stringify(restricted.bodies).includes(markers.userClaudeMd));
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
    // HOME is an ancestor of cwd in the calls above, so HOME/.claude/CLAUDE.md can also load as an
    // ancestor directory's CLAUDE.md. These two calls move HOME off cwd's ancestors.
    const movedHome = ({ home }) => join(home, 'user');
    const moveHome = (env) => ({
      env: (paths) => ({ HOME: movedHome(paths), ...env }),
      prepare: async (paths) => {
        await mkdir(join(movedHome(paths), '.claude'), { recursive: true });
        await writeFile(
          join(movedHome(paths), '.claude', 'CLAUDE.md'),
          'MOVED_HOME_CLAUDE_MD_MARKER',
        );
      },
    });
    const withConfigDir = await execute(
      'claude',
      'inherit-config-dir',
      { isolation: 'inherit' },
      undefined,
      moveHome({}),
    );
    const withoutConfigDir = await execute(
      'claude',
      'inherit-default-dir',
      { isolation: 'inherit' },
      undefined,
      moveHome({ CLAUDE_CONFIG_DIR: undefined }),
    );
    const claudeReached = (run, marker) => JSON.stringify(run.bodies).includes(marker);
    // Asserted, because CliHarness detects exactly this file: CLAUDE_CONFIG_DIR replaces
    // HOME/.claude. The ancestor fact is recorded only; ancestor CLAUDE.md files are not detected.
    assert(claudeReached(withConfigDir, markers.userClaudeMd));
    assert(!claudeReached(withConfigDir, 'MOVED_HOME_CLAUDE_MD_MARKER'));
    assert(claudeReached(withoutConfigDir, 'MOVED_HOME_CLAUDE_MD_MARKER'));
    report.cases.push({
      name: 'claude-user-instructions',
      version: inherited.version,
      userClaudeMdReachedInherit: true,
      userClaudeMdReachedRestricted: false,
      homeClaudeMdReachedWithConfigDir: false,
      homeClaudeMdReachedWithoutConfigDir: true,
      ancestorHomeClaudeMdReachedWithConfigDir: claudeReached(inherited, markers.homeClaudeMd),
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
    const reached = (run, marker) => JSON.stringify(run.bodies).includes(marker);
    // Codex wraps the loaded AGENTS.md files in a message headed with this text, so a blank file
    // (which has no marker to look for) still shows whether any instructions message was sent.
    const instructionsMessage = (run) => reached(run, 'AGENTS.md instructions for');
    // Skill and memory sources (#227), recorded rather than asserted in the cases that carry the
    // default canaries.
    const sourceFacts = (run) => ({
      repoAgentsSkillReachedRequest: reached(run, markers.repoAgentsSkill),
      homeAgentsSkillReachedRequest: reached(run, markers.homeAgentsSkill),
      repoCodexSkillReachedRequest: reached(run, markers.repoCodexSkill),
      nestedUserSkillReachedRequest: reached(run, markers.nestedUserSkill),
      memorySummaryReachedRequest: reached(run, markers.memorySummary),
      memoryMdReachedRequest: reached(run, markers.memoryMd),
    });
    // instructions: 'none' (#130): a private CODEX_HOME holding only auth.json, and
    // project_doc_max_bytes=0. Asserted, because quiet-choir promises this boundary.
    const none = await execute('codex', 'codex-instructions-none', { instructions: 'none' });
    assert.equal(none.plan.codexHome, 'private');
    assert(none.plan.argv.includes('project_doc_max_bytes=0'));
    assert(!reached(none, markers.userAgents), 'user AGENTS.md reached a none call');
    assert(!reached(none, markers.projectAgents), 'project AGENTS.md reached a none call');
    assert(!reached(none, markers.userSkill), 'a user skill reached a none call');
    assert(
      none.configUnchanged,
      `a none call wrote to the real CODEX_HOME: ${JSON.stringify(none.configDiff)}`,
    );
    assert(none.authUnchanged, 'a none call changed auth.json');
    assert.deepEqual(none.warnings, []);
    report.cases.push({
      name: 'codex-instructions-none',
      version: none.version,
      explicitProviderReachedLocalApi: none.apiCalls > 0,
      userInstructionsReachedRequest: false,
      projectInstructionsReachedRequest: false,
      userSkillReachedRequest: false,
      realCodexHomeUnchanged: true,
      authJsonUnchanged: true,
      ...sourceFacts(none),
    });
    const native = await execute('codex', 'codex-instructions-native', { instructions: 'native' });
    assert.equal(native.plan.codexHome, undefined);
    assert(reached(native, markers.userAgents), 'user AGENTS.md missed a native call');
    assert(reached(native, markers.projectAgents), 'project AGENTS.md missed a native call');
    report.cases.push({
      name: 'codex-instructions-native',
      version: native.version,
      userInstructionsReachedRequest: true,
      projectInstructionsReachedRequest: true,
      userSkillReachedRequest: reached(native, markers.userSkill),
      ...sourceFacts(native),
    });
    const codex = await execute('codex', 'codex-restricted');
    // Unset matches 'native'; Codex's native loading is the documented default.
    assert(reached(codex, markers.userAgents), 'user AGENTS.md missed an unset call');
    assert(reached(codex, markers.projectAgents), 'project AGENTS.md missed an unset call');
    // The layout and blank-file facts below are recorded, not asserted: a change in Codex's native
    // instruction loading shows up as a fixture diff, and the metadata warning and doctor text
    // describe them. instructionsMessageReachedRequest is true here so a rewording of the header in
    // a future Codex shows up as a diff rather than silently turning the blank-file facts false.
    report.cases.push({
      name: 'codex-restricted',
      version: codex.version,
      inheritedProviderIgnored: true,
      explicitProviderReachedLocalApi: codex.apiCalls > 0,
      userInstructionsReachedRequest: reached(codex, markers.userAgents),
      projectInstructionsReachedRequest: reached(codex, markers.projectAgents),
      userSkillReachedRequest: reached(codex, markers.userSkill),
      instructionsMessageReachedRequest: instructionsMessage(codex),
      ...sourceFacts(codex),
    });
    // Per-directory override precedence, and project discovery from a .git root down to cwd.
    const overrides = await execute('codex', 'codex-restricted-layout', {}, undefined, {
      subdir: 'pkg',
      prepare: async ({ project, config }) => {
        await mkdir(join(project, '.git'));
        await writeFile(join(project, 'pkg', 'AGENTS.md'), 'PKG_AGENTS_MARKER');
        await writeFile(join(project, 'AGENTS.override.md'), 'PROJECT_OVERRIDE_MARKER');
        await writeFile(join(config, 'AGENTS.override.md'), 'USER_OVERRIDE_MARKER');
      },
    });
    report.cases.push({
      name: 'codex-restricted-layout',
      version: overrides.version,
      userOverrideReachedRequest: reached(overrides, 'USER_OVERRIDE_MARKER'),
      userAgentsReplacedByOverride: !reached(overrides, markers.userAgents),
      projectOverrideReachedRequest: reached(overrides, 'PROJECT_OVERRIDE_MARKER'),
      projectAgentsReplacedByOverride: !reached(overrides, markers.projectAgents),
      gitRootToCwdReachedRequest: reached(overrides, 'PKG_AGENTS_MARKER'),
    });
    const empty = await execute('codex', 'codex-restricted-empty-override', {}, undefined, {
      prepare: async ({ project, config }) => {
        await writeFile(join(config, 'AGENTS.override.md'), '');
        await writeFile(join(project, 'AGENTS.override.md'), '');
      },
    });
    report.cases.push({
      name: 'codex-restricted-empty-override',
      version: empty.version,
      userAgentsReachedRequest: reached(empty, markers.userAgents),
      projectAgentsReachedRequest: reached(empty, markers.projectAgents),
    });
    // Whitespace-only files. 'blank' mixes spaces, tabs, LF and CRLF.
    const blank = '  \n\t\n   \r\n';
    const whitespace = await execute(
      'codex',
      'codex-restricted-whitespace-override',
      {},
      undefined,
      {
        prepare: async ({ project, config }) => {
          await writeFile(join(config, 'AGENTS.override.md'), blank);
          await writeFile(join(project, 'AGENTS.override.md'), blank);
        },
      },
    );
    report.cases.push({
      name: 'codex-restricted-whitespace-override',
      version: whitespace.version,
      userAgentsReachedRequest: reached(whitespace, markers.userAgents),
      projectAgentsReachedRequest: reached(whitespace, markers.projectAgents),
    });
    const whitespaceUser = await execute(
      'codex',
      'codex-restricted-whitespace-user-agents',
      {},
      undefined,
      {
        prepare: async ({ project, config }) => {
          await writeFile(join(config, 'AGENTS.md'), blank);
          await rm(join(project, 'AGENTS.md'));
        },
      },
    );
    report.cases.push({
      name: 'codex-restricted-whitespace-user-agents',
      version: whitespaceUser.version,
      instructionsMessageReachedRequest: instructionsMessage(whitespaceUser),
    });
    const whitespaceProject = await execute(
      'codex',
      'codex-restricted-whitespace-project-agents',
      {},
      undefined,
      {
        prepare: async ({ project, config }) => {
          await writeFile(join(project, 'AGENTS.md'), blank);
          await rm(join(config, 'AGENTS.md'));
        },
      },
    );
    report.cases.push({
      name: 'codex-restricted-whitespace-project-agents',
      version: whitespaceProject.version,
      instructionsMessageReachedRequest: instructionsMessage(whitespaceProject),
    });
    // Repository skill layout (#227). The Git root is project/pkg, so project (not HOME) sits above
    // the root; the call runs from project/pkg/mid/leaf.
    const skillLayout = await execute('codex', 'codex-restricted-skill-layout', {}, undefined, {
      subdir: 'pkg/mid/leaf',
      prepare: async ({ project }) => {
        const root = join(project, 'pkg'),
          mid = join(root, 'mid'),
          leaf = join(mid, 'leaf');
        await mkdir(join(root, '.git'));
        await skill(join(root, '.agents', 'skills'), 'root-canary', 'ROOT_AGENTS_SKILL_MARKER');
        await skill(join(mid, '.agents', 'skills'), 'mid-canary', 'MID_AGENTS_SKILL_MARKER');
        const leafSkills = join(leaf, '.agents', 'skills');
        await skill(leafSkills, 'leaf-canary', 'LEAF_AGENTS_SKILL_MARKER');
        await skill(leafSkills, '.hidden', 'DOT_AGENTS_SKILL_MARKER');
        await skill(leafSkills, 'g2/depth2', 'DEPTH2_AGENTS_SKILL_MARKER');
        await skill(leafSkills, 'g4/a/b/depth4', 'DEPTH4_AGENTS_SKILL_MARKER');
        await skill(leafSkills, 'g6/a/b/c/d/depth6', 'DEPTH6_AGENTS_SKILL_MARKER');
        await skill(leafSkills, 'g7/a/b/c/d/e/depth7', 'DEPTH7_AGENTS_SKILL_MARKER');
        await skill(leafSkills, 'g8/a/b/c/d/e/f/depth8', 'DEPTH8_AGENTS_SKILL_MARKER');
        await skill(leafSkills, 'outer', 'OUTER_AGENTS_SKILL_MARKER');
        await skill(leafSkills, 'outer/inner', 'INNER_AGENTS_SKILL_MARKER');
        await skill(join(root, '.codex', 'skills'), 'root-codex', 'ROOT_CODEX_SKILL_MARKER');
        await skill(join(leaf, '.codex', 'skills'), 'leaf-codex', 'LEAF_CODEX_SKILL_MARKER');
      },
    });
    report.cases.push({
      name: 'codex-restricted-skill-layout',
      version: skillLayout.version,
      aboveGitRootAgentsSkillReachedRequest: reached(skillLayout, markers.repoAgentsSkill),
      gitRootAgentsSkillReachedRequest: reached(skillLayout, 'ROOT_AGENTS_SKILL_MARKER'),
      intermediateAgentsSkillReachedRequest: reached(skillLayout, 'MID_AGENTS_SKILL_MARKER'),
      cwdAgentsSkillReachedRequest: reached(skillLayout, 'LEAF_AGENTS_SKILL_MARKER'),
      dotDirectorySkillReachedRequest: reached(skillLayout, 'DOT_AGENTS_SKILL_MARKER'),
      depth2SkillReachedRequest: reached(skillLayout, 'DEPTH2_AGENTS_SKILL_MARKER'),
      depth4SkillReachedRequest: reached(skillLayout, 'DEPTH4_AGENTS_SKILL_MARKER'),
      depth6SkillReachedRequest: reached(skillLayout, 'DEPTH6_AGENTS_SKILL_MARKER'),
      depth7SkillReachedRequest: reached(skillLayout, 'DEPTH7_AGENTS_SKILL_MARKER'),
      depth8SkillReachedRequest: reached(skillLayout, 'DEPTH8_AGENTS_SKILL_MARKER'),
      skillInsideSkillReachedRequest: reached(skillLayout, 'INNER_AGENTS_SKILL_MARKER'),
      homeAgentsSkillReachedRequest: reached(skillLayout, markers.homeAgentsSkill),
      aboveGitRootCodexSkillReachedRequest: reached(skillLayout, markers.repoCodexSkill),
      gitRootCodexSkillReachedRequest: reached(skillLayout, 'ROOT_CODEX_SKILL_MARKER'),
      cwdCodexSkillReachedRequest: reached(skillLayout, 'LEAF_CODEX_SKILL_MARKER'),
    });
    // Without a .git entry, and with HOME moved off the project's ancestors: whether the parent of
    // cwd and the former HOME still contribute .agents skills, and whether HOME is a skill root.
    const noGit = await execute('codex', 'codex-restricted-skill-no-git', {}, undefined, {
      subdir: 'pkg',
      env: ({ home }) => ({ HOME: join(home, 'user') }),
      prepare: async ({ home, project }) => {
        await skill(
          join(home, 'user', '.agents', 'skills'),
          'user-home',
          'MOVED_HOME_SKILL_MARKER',
        );
        await skill(join(project, 'pkg', '.agents', 'skills'), 'cwd', 'NO_GIT_CWD_SKILL_MARKER');
      },
    });
    report.cases.push({
      name: 'codex-restricted-skill-no-git',
      version: noGit.version,
      cwdAgentsSkillReachedRequest: reached(noGit, 'NO_GIT_CWD_SKILL_MARKER'),
      parentAgentsSkillReachedRequest: reached(noGit, markers.repoAgentsSkill),
      nonHomeAncestorAgentsSkillReachedRequest: reached(noGit, markers.homeAgentsSkill),
      homeAgentsSkillReachedRequest: reached(noGit, 'MOVED_HOME_SKILL_MARKER'),
    });
    // CODEX_HOME memories with the feature explicitly enabled.
    const memories = await execute('codex', 'codex-restricted-memories-enabled', {
      config: { 'features.memories': true },
    });
    report.cases.push({
      name: 'codex-restricted-memories-enabled',
      version: memories.version,
      memorySummaryReachedRequest: reached(memories, markers.memorySummary),
      memoryMdReachedRequest: reached(memories, markers.memoryMd),
    });
    // An explicit nested key wins over the fixture default while its sibling keys survive the merge:
    // the call stays on the fixture provider and env_key but targets a closed local port, so the
    // contract must fail with the reach message. Asserted only; not a report case. Codex keeps
    // retrying a refused connection ("Reconnecting...") despite the zero retry settings, so the call
    // gets a short deadline and the timeout counts as not reaching the API.
    const closed = createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address();
    await new Promise((resolve) => closed.close(resolve));
    await assert.rejects(
      execute(
        'codex',
        'codex-explicit-config-unreached',
        {
          config: { model_providers: { fixture: { base_url: `http://127.0.0.1:${port}/v1` } } },
        },
        undefined,
        { timeoutMs: 8000 },
      ),
      /did not reach the local fake API/u,
    );
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
