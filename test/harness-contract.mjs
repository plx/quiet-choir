// Explicit opt-in. Real installed CLIs, fresh configuration, fake keys, and loopback-only APIs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliHarness, HarnessError } from '../dist/index.js';
import { materializeInvocation } from '../dist/harnesses/invocation.js';
import { parseClaude, parseCodex } from '../dist/harnesses/protocol.js';
import { fakeApi } from './contracts/local-api.mjs';

const refresh = process.argv.includes('--refresh');
const usage = process.argv.includes('--usage');
const stream = process.argv.includes('--stream');
const requestedSessionId = '5697cc90-cb47-5a1f-8896-cbf83255e506';
const selected = process.argv
  .find((arg) => arg.startsWith('--cases='))
  ?.slice(8)
  .split(',');
const scenarios = usage
  ? ['codex-usage-success']
  : [
      'claude-text-success',
      'claude-structured-success',
      'claude-turn-limit',
      'claude-api-error',
      'codex-text-success',
      'codex-structured-success',
      'codex-invalid-schema',
      'codex-reconnect-success',
    ];
assert(
  process.argv
    .slice(2)
    .every(
      (arg) => ['--refresh', '--stream', '--usage'].includes(arg) || arg.startsWith('--cases='),
    ),
  'Use --refresh, --stream, --usage and/or --cases=<comma-separated scenario names>.',
);
assert(
  !selected || selected.every((name) => scenarios.includes(name)),
  'Unknown contract scenario.',
);
const directory = await mkdtemp(join(tmpdir(), 'quiet-choir-contract-'));
const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

function execute(binary, argv, input, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      problem;
    const stop = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* The child group already exited. */
      }
    };
    const timer = setTimeout(() => {
      problem = new Error(`${binary} contract exceeded 60s`);
      stop();
    }, 60_000);
    for (const [name, stream] of [
      ['stdout', child.stdout],
      ['stderr', child.stderr],
    ])
      stream.on('data', (bytes) => {
        if (name === 'stdout') stdout += bytes;
        else stderr += bytes;
        if (stdout.length + stderr.length > 16 * 1024 * 1024) {
          problem = new Error('Contract capture exceeds 16 MiB');
          stop();
        }
      });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      stop();
      if (problem) reject(problem);
      else resolve({ code, signal, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
function sanitize(text) {
  return text
    .replaceAll(directory, '/fixture')
    .replace(
      /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu,
      '00000000-0000-4000-8000-000000000000',
    )
    .replace(/127\.0\.0\.1:\d+/gu, '127.0.0.1:12345')
    .replace(/sk-(?:ant-)?quiet-choir-fake/gu, '<fake-key>');
}
try {
  for (const name of scenarios.filter((name) => !selected || selected.includes(name))) {
    const provider = name.startsWith('claude') ? 'claude' : 'codex';
    const cwd = join(directory, name);
    await mkdir(cwd);
    const config = join(cwd, 'configuration');
    await mkdir(config);
    const api = await fakeApi(name);
    const environment = {
      PATH: process.env['PATH'],
      HOME: cwd,
      TMPDIR: cwd,
      TERM: 'dumb',
      NO_COLOR: '1',
      ...(provider === 'claude'
        ? {
            CLAUDE_CONFIG_DIR: config,
            ANTHROPIC_BASE_URL: api.url,
            ANTHROPIC_API_KEY: 'sk-ant-quiet-choir-fake',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_TELEMETRY: '1',
            DISABLE_ERROR_REPORTING: '1',
            DISABLE_AUTOUPDATER: '1',
          }
        : { CODEX_HOME: config, QUIET_CHOIR_FAKE_API_KEY: 'sk-quiet-choir-fake' }),
    };
    if (provider === 'codex')
      await writeFile(
        join(config, 'config.toml'),
        `model_provider = "fixture"\nmodel = "gpt-5.5"\n[model_providers.fixture]\nname = "Local contract API"\nbase_url = "${api.url}/v1"\nwire_api = "responses"\nenv_key = "QUIET_CHOIR_FAKE_API_KEY"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 2\n`,
      );
    const structured =
      name.includes('structured') ||
      name === 'claude-turn-limit' ||
      name === 'codex-invalid-schema';
    const request = {
      harness: provider,
      cwd,
      outputSchema: structured ? schema : null,
      options:
        provider === 'claude'
          ? {
              prompt: 'Local contract fixture only.',
              tools: [],
              allowedTools: [],
              model: 'haiku',
              maxTurns: 2,
              maxBudgetUsd: 0.05,
              mcpServers: {},
              strictMcpConfig: true,
              settings: { disableAllHooks: true },
            }
          : {
              prompt: 'Local contract fixture only.',
              isolation: 'inherit',
              skipGitRepoCheck: true,
              model: 'gpt-5.5',
            },
    };
    const plan = new CliHarness().plan(
      request,
      stream && provider === 'claude' ? { sessionId: requestedSessionId } : undefined,
    );
    const invocation = await materializeInvocation(plan, request);
    if (!stream && provider === 'claude') {
      // Keep the historical envelope fixtures alongside the current streaming contract.
      invocation.args[invocation.args.indexOf('--output-format') + 1] = 'json';
      invocation.args.splice(invocation.args.indexOf('--verbose'), 1);
    }
    try {
      const versionResult = await execute(provider, ['--version'], '', cwd, environment);
      const version = /\b\d+\.\d+\.\d+\b/u.exec(versionResult.stdout)?.[0];
      assert(version, 'Missing CLI version');
      const result = await execute(provider, invocation.args, plan.stdin, cwd, environment);
      if (stream && provider === 'claude') {
        const events = result.stdout
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
        const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
        const terminal = events.findLast((event) => event.type === 'result');
        assert.equal(
          init?.session_id,
          requestedSessionId,
          'Requested session ID must work with --no-session-persistence.',
        );
        assert.equal(terminal?.session_id, requestedSessionId);
        if (name === 'claude-structured-success')
          assert.deepEqual(terminal.structured_output, { answer: 'captured answer' });
      }
      const parsed =
        provider === 'claude' ? parseClaude(result.stdout, structured) : parseCodex(result.stdout);
      const success = name.endsWith('-success');
      assert.equal(result.code, success ? 0 : 1, `${name}: ${result.stderr}\n${result.stdout}`);
      assert.equal(
        parsed.kind,
        success ? 'success' : 'failure',
        `${name}: ${JSON.stringify(parsed)}`,
      );
      assert(
        api.requests.some((request) => /messages|responses/u.test(request.url)),
        'No request reached the isolated local API',
      );
      if (name === 'claude-turn-limit') assert.equal(parsed.failure.subtype, 'error_max_turns');
      if (name === 'codex-invalid-schema') assert.match(result.stdout, /invalid_json_schema/u);
      if (name === 'codex-reconnect-success')
        assert(parsed.response.warnings.some((warning) => /Reconnecting/u.test(warning)));
      if (name === 'codex-usage-success') {
        const terminal = result.stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .findLast((entry) => entry.type === 'turn.completed');
        assert.deepEqual(terminal.usage, {
          input_tokens: 100,
          cached_input_tokens: 40,
          cache_write_input_tokens: 20,
          output_tokens: 30,
          reasoning_output_tokens: 12,
        });
      }
      if (success && structured)
        assert.deepEqual(JSON.parse(parsed.response.text), { answer: 'captured answer' });
      const capture = {
        provider,
        version,
        code: result.code,
        signal: result.signal,
        structured,
        ...(stream
          ? { stream: true, ...(provider === 'claude' ? { requestedSessionAccepted: true } : {}) }
          : {}),
        stdout: sanitize(result.stdout),
        stderr: sanitize(result.stderr),
        ...(success
          ? {}
          : {
              expected: {
                reason:
                  name === 'claude-turn-limit'
                    ? 'Reached maximum number of turns'
                    : name === 'claude-api-error'
                      ? 'Contract fixture API error'
                      : 'Invalid schema for response_format',
                terminalReason: parsed.failure.terminalReason,
                apiStatus: parsed.failure.apiStatus,
                kind: new HarnessError({
                  harness: provider,
                  exit: { code: result.code, signal: result.signal },
                  failure: parsed.failure,
                  reason: parsed.failure.reason,
                  stderr: result.stderr,
                  stdout: '',
                }).kind,
              },
            }),
      };
      const captureDirectory = new URL(
        `./fixtures/${usage ? 'harness-usage' : stream ? 'harness-stream' : 'harness'}/`,
        import.meta.url,
      );
      if (refresh) await mkdir(captureDirectory, { recursive: true });
      const path = new URL(`${name}.json`, captureDirectory);
      if (refresh) await writeFile(path, JSON.stringify(capture, null, 2) + '\n');
      else {
        const previous = JSON.parse(await readFile(path, 'utf8'));
        assert.equal(previous.code, result.code, `${name}: process contract drift`);
        if (previous.version !== version)
          console.error(
            `Version drift: ${provider} ${previous.version} -> ${version}; use --refresh after reviewing captures.`,
          );
      }
      console.log(
        `${name}: ${provider}@${version}, exit ${result.code}, ${api.requests.length} local requests${refresh ? ', capture refreshed' : ''}`,
      );
    } finally {
      await invocation.dispose();
      await api.close();
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
