import { testInvocation } from './harness-invocation.js';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  probeHarnessContracts,
  readInheritedCodexConfig,
  testedHarnessVersions,
  CliHarness,
  type DoctorReport,
} from '../src/index.js';
import ConfigurationDoctor from '../src/commands/configuration/doctor.js';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'choir-doctor-test-'));
});
afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const codexHelp =
  '--json --output-schema --ephemeral --config --image --profile --add-dir --ignore-user-config --ignore-rules';
const claudeHelp =
  '--effort <level> effort (choices: "low", "medium", "high", "xhigh", "max")\n  --permission-mode <mode> permissions (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")';
async function binary(provider: 'claude' | 'codex', mode = 'ok'): Promise<string> {
  const fixture = JSON.parse(
    await readFile(
      join(
        projectRoot,
        'test/fixtures/harness',
        provider === 'claude' ? 'claude-unknown-model.json' : 'codex-invalid-effort.json',
      ),
      'utf8',
    ),
  ) as { stdout: string };
  const path = join(directory, provider);
  await writeFile(
    path,
    `#!${process.execPath}
const fs = require('node:fs');
const a=process.argv.slice(2), mode=${JSON.stringify(mode)}, provider=${JSON.stringify(provider)};
fs.appendFileSync(${JSON.stringify(join(directory, 'calls'))},JSON.stringify({provider,args:a})+'\\n');
if(mode==='hang') {setInterval(()=>{},1000);return;}
if(a.includes('--version')) {if(mode==='cleanup')require('node:child_process').spawn('/bin/sleep',['30'],{stdio:'ignore'}).unref();console.log(mode==='version'?'9.9.9':${JSON.stringify(testedHarnessVersions[provider].minimum)});process.exit(0);}
if(a.includes('--help')) {console.log(${JSON.stringify(provider === 'claude' ? claudeHelp : codexHelp)}.replace(mode==='enums'?'xhigh':'not-found', 'ultra'));process.exit(0);}
if(a.includes('abc')) {console.error(mode==='hidden'?'unknown option --max-turns':"argument 'abc' is invalid. must be a number");process.exit(1);}
if(a.some(v=>v.includes('quiet-choir-missing-'))) {console.error('System prompt file not found');process.exit(1);}
const paths = a.filter(v=>v.startsWith('--image=')).map(v=>v.slice(8));
for(let i=0;i<a.length;i++) if(['--system-prompt-file','--append-system-prompt-file','--agents','--settings','--mcp-config','--output-schema'].includes(a[i])) paths.push(a[i+1]);
if(provider==='codex') {paths.push(process.env.CODEX_HOME,process.env.CODEX_HOME+'/quiet-choir-probe.config.toml');if(fs.existsSync(process.env.CODEX_HOME+'/auth.json')) paths.push(process.env.CODEX_HOME+'/auth.json');}
fs.writeFileSync(${JSON.stringify(join(directory, `${provider}-paths`))},JSON.stringify(paths.map(path=>({path, mode:fs.statSync(path).mode&511}))));
if(provider==='codex'&&!a.includes('model_reasoning_effort="bogus"')) throw Error('probe could run inference');
if(provider==='claude'&&!a[a.indexOf('--model')+1].startsWith('claude-quiet-choir-nonexistent-')) throw Error('probe could run inference');
if(mode==='unknown') {console.error('unknown option --agents');process.exit(1);}
let out=${JSON.stringify(fixture.stdout)};
if(provider==='claude') out=out.replaceAll('claude-nonexistent-model-xyz',a[a.indexOf('--model')+1]);
if(mode==='auth') out=JSON.stringify({type:'result',is_error:true,subtype:'error',api_error_status:401,result:'Authentication failed',total_cost_usd:0});
if(mode==='cost') out=out.replace('"total_cost_usd":0','"total_cost_usd":0.25');
if(mode==='tokens') out=out.replace('"input_tokens":0','"input_tokens":1');
if(mode==='cache') out=out.replace('"cache_read_input_tokens":0','"cache_read_input_tokens":1');
if(mode==='warning') console.error('Warning: unknown value ignored');
if(mode==='enums'&&provider==='codex') out=out.replaceAll("'xhigh'", "'ultra'");
process.stdout.write(out);process.exit(1);
`,
    { mode: 0o700 },
  );
  return path;
}

it('runs five checks per harness using full adapter argv and proves zero inference before cleanup', async () => {
  await writeFile(
    join(directory, 'config.toml'),
    'model="configured-model"\nmodel_reasoning_effort="xhigh"\n',
  );
  await writeFile(join(directory, 'auth.json'), 'private-auth-copy', { mode: 0o600 });
  const report = await probeHarnessContracts({
    claudeBinary: await binary('claude'),
    codexBinary: await binary('codex'),
    codexHome: directory,
  });
  expect(report.ok, JSON.stringify(report.checks)).toBe(true);
  expect(report.zeroInference).toBe(true);
  expect(report.checks).toHaveLength(10);
  expect(report.inherited).toMatchObject({
    model: 'configured-model',
    effort: 'xhigh',
    profile: null,
  });
  const calls = (await readFile(join(directory, 'calls'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { provider: string; args: string[] });
  const claude = calls.find(
    (call) => call.provider === 'claude' && call.args.includes('--json-schema'),
  )?.args;
  const codex = calls.find(
    (call) => call.provider === 'codex' && call.args.includes('--output-schema'),
  )?.args;
  expect(claude).toEqual(
    expect.arrayContaining([
      '--model',
      '--effort',
      '--agent',
      '--agents',
      '--restricted',
      '--strict-mcp-config',
      '--settings',
      '--fallback-model',
      '--add-dir',
      '--no-chrome',
    ]),
  );
  expect(codex).toEqual(
    expect.arrayContaining([
      '--model',
      'configured-model',
      '--profile',
      'quiet-choir-probe',
      '--strict-config',
      'sandbox_workspace_write.network_access=false',
    ]),
  );
  // The profile probe needs the inherited role restricted isolation would skip.
  expect(codex).not.toContain('--ignore-user-config');
  expect(codex).not.toContain('--ignore-rules');
  expect(codex?.slice(-2)).toEqual(['--', '-']);
  for (const provider of ['claude', 'codex']) {
    const files = JSON.parse(await readFile(join(directory, `${provider}-paths`), 'utf8')) as {
      path: string;
      mode: number;
    }[];
    for (const file of files) {
      expect([0o600, 0o700]).toContain(file.mode);
      await expect(stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }
  expect(await readFile(join(directory, 'auth.json'), 'utf8')).toBe('private-auth-copy');
  expect(JSON.stringify(report)).not.toContain('private-auth-copy');
});

it.each(['auth', 'cost', 'tokens', 'cache', 'unknown', 'warning'])(
  'fails the exact-argv check for %s',
  async (mode) => {
    const report = await probeHarnessContracts({
      harness: 'claude',
      claudeBinary: await binary('claude', mode),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.check === 'argv')?.ok).toBe(false);
    expect(report.zeroInference).toBe(mode === 'warning');
  },
);
it.each(['claude', 'codex'] as const)('detects %s enum drift', async (provider) => {
  const path = await binary(provider, 'enums');
  const report = await probeHarnessContracts({
    harness: provider,
    claudeBinary: path,
    codexBinary: path,
    codexHome: directory,
  });
  expect(report.checks.find((check) => check.check === 'enums')?.ok).toBe(false);
  expect(report.ok).toBe(false);
});
it('detects hidden flag drift', async () => {
  const report = await probeHarnessContracts({
    harness: 'claude',
    claudeBinary: await binary('claude', 'hidden'),
  });
  expect(report.checks.find((check) => check.check === 'hidden-flags')?.ok).toBe(false);
});
it('reports version drift and skips the potentially unsafe inference probe', async () => {
  const report = await probeHarnessContracts({
    harness: 'codex',
    codexBinary: await binary('codex', 'version'),
    codexHome: directory,
  });
  expect(report.ok).toBe(false);
  expect(report.zeroInference).toBe(false);
  expect(report.checks.find((check) => check.check === 'argv')?.message).toContain(
    'contract-tested',
  );
  const calls = await readFile(join(directory, 'calls'), 'utf8');
  expect(calls).not.toContain('--output-schema');
});
it('retains an earlier cost failure across a later zero-cost provider', async () => {
  const report = await probeHarnessContracts({
    claudeBinary: await binary('claude', 'cost'),
    codexBinary: await binary('codex'),
    codexHome: directory,
  });
  expect(report.zeroInference).toBe(false);
  expect(
    report.checks.find((check) => check.provider === 'codex' && check.check === 'argv')?.ok,
  ).toBe(true);
});
it('bounds missing executables, timeouts, invalid deadlines, and cancellation', async () => {
  const missing = await probeHarnessContracts({
    harness: 'codex',
    codexBinary: join(directory, 'missing'),
    codexHome: directory,
  });
  expect(missing.ok).toBe(false);
  expect(missing.zeroInference).toBe(false);
  expect(missing.checks).toHaveLength(5);
  const timeout = await probeHarnessContracts({
    harness: 'codex',
    codexBinary: await binary('codex', 'hang'),
    codexHome: directory,
    timeoutMs: 40,
  });
  expect(timeout.ok).toBe(false);
  await expect(probeHarnessContracts({ timeoutMs: 0 })).rejects.toThrow('positive bounded');
  await expect(probeHarnessContracts({ killGraceMs: 0 })).rejects.toThrow('positive bounded');
  await expect(
    probeHarnessContracts({ signal: AbortSignal.abort(new Error('stop')) }),
  ).rejects.toThrow('stop');
});

it('reads TOML strings, comments, native profiles, and legacy profile precedence without leaking other values', async () => {
  await writeFile(
    join(directory, 'config.toml'),
    `model = 'base#model' # comment\nmodel_reasoning_effort="low"\nprofile="review"\nsecret="never-print"\n[profiles.review]\nmodel="legacy-model"\nmodel_reasoning_effort="max"\n`,
  );
  expect(await readInheritedCodexConfig(directory)).toMatchObject({
    model: 'legacy-model',
    effort: 'max',
    profile: 'review',
  });
  await writeFile(join(directory, 'review.config.toml'), 'model="native\\tmodel"\n');
  const native = await readInheritedCodexConfig(directory);
  expect(native).toMatchObject({
    model: 'native\tmodel',
    effort: 'low',
    files: [join(directory, 'config.toml'), join(directory, 'review.config.toml')],
  });
  expect(JSON.stringify(native)).not.toContain('never-print');
  await expect(readInheritedCodexConfig(directory, 'absent')).rejects.toThrow('no profile');
  await expect(readInheritedCodexConfig(directory, '../escape')).rejects.toThrow('Invalid');
  await writeFile(join(directory, 'config.toml'), 'secret="unterminated secret');
  await expect(readInheritedCodexConfig(directory)).rejects.toThrow('Invalid TOML');
  await expect(readInheritedCodexConfig(join(directory, 'config.toml'))).rejects.toThrow(
    'Cannot read',
  );
  expect(await readInheritedCodexConfig(join(directory, 'empty'))).toEqual({
    files: [],
    profile: null,
    model: null,
    effort: null,
  });
});
it('exports version discovery with nonfatal diagnostics and cancellation', async () => {
  const request = {
    provider: 'codex' as const,
    cwd: directory,
    options: { prompt: '' },
    outputSchema: null,
  };
  const harness = new CliHarness({ codexBinary: await binary('codex') });
  expect(
    await harness.metadata(request, testInvocation(new AbortController().signal)),
  ).toMatchObject({
    version: '0.157.1',
  });
  const missing = await new CliHarness({ codexBinary: join(directory, 'missing') }).metadata(
    request,
    testInvocation(new AbortController().signal),
  );
  expect(missing.version).toBeNull();
  expect(missing.warnings?.[0]).toContain('failed');
  await expect(
    harness.metadata(request, testInvocation(AbortSignal.abort(new Error('cancelled')))),
  ).rejects.toThrow('cancelled');
});
it.each(['ok', 'warning'])(
  'prints machine-readable doctor JSON and exits nonzero only for drift (%s)',
  async (mode) => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => {
      lines.push(String(value));
    });
    let error: unknown;
    try {
      await ConfigurationDoctor.run(
        ['--harness', 'claude', '--claude-binary', await binary('claude', mode), '--json'],
        { root: projectRoot },
      );
    } catch (caught) {
      error = caught;
    }
    const report = JSON.parse(lines.join('')) as DoctorReport;
    expect(report.ok).toBe(mode === 'ok');
    expect(report.checks).toHaveLength(5);
    if (mode === 'ok') expect(error).toBeUndefined();
    else expect(error).toMatchObject({ oclif: { exit: 1 } });
  },
);

it.skipIf(process.platform === 'win32')(
  'rejects native process cleanup warnings during contract discovery',
  async () => {
    const report = await probeHarnessContracts({
      harness: 'claude',
      claudeBinary: await binary('claude', 'cleanup'),
    });
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.message).toContain('process warnings');
  },
);
