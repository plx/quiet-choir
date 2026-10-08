import { createHash } from 'node:crypto';
import { testInvocation } from './harness-invocation.js';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const codexHelp =
  '--json --output-schema --ephemeral --config --image --profile --add-dir --ignore-user-config --ignore-rules';
const claudeHelp =
  '--effort <level> effort (choices: "low", "medium", "high", "xhigh", "max")\n  --permission-mode <mode> permissions (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")';
/** The first untested patch above the tested maximum, on the same major.minor. */
const untestedPatch = (provider: 'claude' | 'codex'): string => {
  const [major = '', minor = '', patch = ''] = testedHarnessVersions[provider].maximum.split('.');
  return `${major}.${minor}.${String(Number(patch) + 1)}`;
};
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
const a=process.argv.slice(2), parts=${JSON.stringify(mode)}.split('+'), mode=parts[0], provider=${JSON.stringify(provider)};
const has=(part)=>parts.includes(part), model=parts.find((part)=>part.startsWith('model-'));
fs.appendFileSync(${JSON.stringify(join(directory, 'calls'))},JSON.stringify({harness:provider,args:a})+'\\n');
if(mode==='hang') {setInterval(()=>{},1000);return;}
if(a.includes('--version')) {if(mode==='cleanup')require('node:child_process').spawn('/bin/sleep',['30'],{stdio:'ignore'}).unref();console.log(mode==='version'?'9.9.9':mode==='garbage'?'no version here':has('patch')?${JSON.stringify(untestedPatch(provider))}:${JSON.stringify(testedHarnessVersions[provider].minimum)});process.exit(0);}
if(a.includes('--help')) {console.log(${JSON.stringify(provider === 'claude' ? claudeHelp : codexHelp)}.replace(mode==='enums'?'xhigh':'not-found', 'ultra'));process.exit(0);}
if(a.includes('abc')) {console.error(mode==='hidden'?'unknown option --max-turns':"argument 'abc' is invalid. must be a number");process.exit(1);}
if(a.some(v=>v.includes('quiet-choir-missing-'))) {console.error('System prompt file not found');process.exit(1);}
const paths = a.filter(v=>v.startsWith('--image=')).map(v=>v.slice(8));
for(let i=0;i<a.length;i++) if(['--system-prompt-file','--append-system-prompt-file','--agents','--settings','--mcp-config','--output-schema'].includes(a[i])) paths.push(a[i+1]);
if(provider==='codex') {paths.push(process.env.CODEX_HOME,process.env.CODEX_HOME+'/quiet-choir-probe.config.toml');if(fs.existsSync(process.env.CODEX_HOME+'/auth.json')) paths.push(process.env.CODEX_HOME+'/auth.json');}
fs.writeFileSync(${JSON.stringify(join(directory, `${provider}-paths`))},JSON.stringify(paths.map(path=>({path, mode:fs.statSync(path).mode&511}))));
if(provider==='codex'&&!(a.includes('model_reasoning_effort="bogus"')&&a.includes('--model')&&a[a.indexOf('--model')+1].startsWith('quiet-choir-nonexistent-'))) throw Error('probe could run inference');
if(provider==='claude'&&!a[a.indexOf('--model')+1].startsWith('claude-quiet-choir-nonexistent-')) throw Error('probe could run inference');
if(mode==='unknown') {console.error('unknown option --agents');process.exit(1);}
let out=${JSON.stringify(fixture.stdout)};
if(provider==='claude') out=out.replaceAll('claude-nonexistent-model-xyz',a[a.indexOf('--model')+1]);
if(mode==='auth') out=JSON.stringify({type:'result',is_error:true,subtype:'error',api_error_status:401,result:'Authentication failed',total_cost_usd:0});
if(mode==='cost') out=out.replace('"total_cost_usd":0','"total_cost_usd":0.25');
if(mode==='tokens') out=out.replace('"input_tokens":0','"input_tokens":1');
if(mode==='cache') out=out.replace('"cache_read_input_tokens":0','"cache_read_input_tokens":1');
if(has('warning')) console.error('Warning: unknown value ignored');
if(mode==='enums'&&provider==='codex') out=out.replaceAll("'xhigh'", "'ultra'");
if(provider==='codex'&&model){
  // The server rejects the unknown model before the effort. model-first and model-other mirror
  // codex-cli 0.160.0 against the local fake API (test/doctor-contract.mjs), which prints a 404 as
  // prose without a parsed status; model-envelope is a synthetic JSON envelope carrying status 404.
  const q=String.fromCharCode(96), sent=a[a.indexOf('--model')+1], named=model==='model-other'?'quiet-choir-nonexistent-other':sent;
  const text='The model '+q+named+q+' does not exist or you do not have access to it.';
  const error=model==='model-envelope'?JSON.stringify({type:'error',error:{type:'invalid_request_error',code:'model_not_found',message:text,param:null},status:404}):'unexpected status 404 Not Found: '+text+', url: http://127.0.0.1:12345/v1/responses';
  out=[{type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000000'},{type:'item.completed',item:{id:'item_0',type:'error',message:'Model metadata for '+q+sent+q+' not found. Defaulting to fallback metadata; this can degrade performance and cause issues.'}},{type:'turn.started'},{type:'error',message:error},{type:'turn.failed',error:{message:error}}].map((line)=>JSON.stringify(line)).join('\\n')+'\\n';
}
if(provider==='codex'&&(has('tokens')||has('output'))) out=out.replace('{"type":"turn.failed",','{"type":"turn.failed","usage":{"input_tokens":'+(has('tokens')?1:0)+',"cached_input_tokens":0,"output_tokens":'+(has('output')?1:0)+'},');
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
    .map((line) => JSON.parse(line) as { harness: string; args: string[] });
  const claude = calls.find(
    (call) => call.harness === 'claude' && call.args.includes('--json-schema'),
  )?.args;
  const codex = calls.find(
    (call) => call.harness === 'codex' && call.args.includes('--output-schema'),
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
  // The probe sends a fresh nonexistent model, never the configured one, beside the bogus effort.
  const codexArgs = codex ?? [];
  expect(codexArgs[codexArgs.indexOf('--model') + 1]).toMatch(/^quiet-choir-nonexistent-/u);
  expect(codex).not.toContain('configured-model');
  expect(codex).toContain('model_reasoning_effort="bogus"');
  expect(codex).toEqual(
    expect.arrayContaining([
      '--model',
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
const callsLog = async (): Promise<string> => readFile(join(directory, 'calls'), 'utf8');
const probeArgv = { claude: '--json-schema', codex: '--output-schema' } as const;
const version = (report: DoctorReport) => report.checks.find((check) => check.check === 'version');
const argv = (report: DoctorReport) => report.checks.find((check) => check.check === 'argv');
const probeOptions = async (provider: 'claude' | 'codex', mode: string) => ({
  harness: provider,
  claudeBinary: await binary('claude', mode),
  codexBinary: await binary('codex', mode),
  codexHome: directory,
});
it.each(['claude', 'codex'] as const)(
  'warns for an untested %s patch version, still runs the argv probe and stays usable',
  async (provider) => {
    const report = await probeHarnessContracts(await probeOptions(provider, 'patch'));
    expect(version(report)).toMatchObject({ status: 'warn', ok: true });
    expect(version(report)?.message).toContain('untested patch version');
    expect(argv(report)).toMatchObject({ status: 'pass', ok: true });
    expect(await callsLog()).toContain(probeArgv[provider]);
    expect(report).toMatchObject({
      ok: true,
      zeroInference: true,
      verdict: 'usable-with-warnings',
    });
    expect(report.warnings).toEqual([expect.stringContaining(`${provider} version:`)]);
    expect(report.harnesses[provider]?.version).toBe(untestedPatch(provider));
  },
);
it.each(['claude', 'codex'] as const)(
  'fails an untested %s patch version under strict and keeps the probe result',
  async (provider) => {
    const report = await probeHarnessContracts({
      ...(await probeOptions(provider, 'patch')),
      strict: true,
    });
    expect(version(report)).toMatchObject({ status: 'fail', ok: false });
    expect(version(report)?.message).toContain('--strict treats an untested patch version');
    expect(argv(report)?.status).toBe('pass');
    expect(report).toMatchObject({ ok: false, verdict: 'blocked', warnings: [] });
    expect(report.zeroInference).toBe(true);
  },
);
it.each([
  ['version', 'outside the tested range'],
  ['garbage', 'unparseable or prerelease version'],
] as const)('blocks a %s mismatch but still runs the argv probe', async (mode, phrase) => {
  const report = await probeHarnessContracts(await probeOptions('codex', mode));
  expect(version(report)).toMatchObject({ status: 'fail', ok: false });
  expect(version(report)?.message).toContain(phrase);
  expect(argv(report)).toMatchObject({ status: 'pass', ok: true });
  expect(await callsLog()).toContain('--output-schema');
  expect(report).toMatchObject({ ok: false, verdict: 'blocked', zeroInference: true });
});
const enums = (report: DoctorReport) => report.checks.find((check) => check.check === 'enums');
it('passes the Codex invalid-effort rejection and compares the reported effort values', async () => {
  const report = await probeHarnessContracts(await probeOptions('codex', 'ok'));
  expect(argv(report)).toMatchObject({ status: 'pass', ok: true });
  expect(argv(report)?.message).toContain('(invalid effort)');
  expect(enums(report)).toMatchObject({ status: 'pass', ok: true });
  expect(report).toMatchObject({ ok: true, zeroInference: true, verdict: 'ok' });
});
it.each(['model-first', 'model-envelope'])(
  'accepts a %s rejection of the sentinel model and warns that effort values are unverified',
  async (mode) => {
    const report = await probeHarnessContracts(await probeOptions('codex', mode));
    expect(argv(report)).toMatchObject({ status: 'pass', ok: true });
    expect(argv(report)?.message).toContain('(sentinel model)');
    expect(enums(report)).toMatchObject({ status: 'warn', ok: true });
    expect(enums(report)?.message).toContain('enum drift unverified');
    expect(report).toMatchObject({
      ok: true,
      zeroInference: true,
      verdict: 'usable-with-warnings',
    });
    expect(report.warnings).toEqual([
      expect.stringContaining('codex enums: Effort values unavailable'),
    ]);
  },
);
it('fails unverified Codex effort values under strict', async () => {
  const report = await probeHarnessContracts({
    ...(await probeOptions('codex', 'model-first')),
    strict: true,
  });
  expect(argv(report)?.status).toBe('pass');
  expect(enums(report)).toMatchObject({ status: 'fail', ok: false });
  expect(enums(report)?.message).toContain('--strict treats unverified effort values');
  expect(report).toMatchObject({ ok: false, zeroInference: true, verdict: 'blocked' });
});
it('fails a Codex model rejection that names a different model', async () => {
  const report = await probeHarnessContracts(await probeOptions('codex', 'model-other'));
  expect(argv(report)).toMatchObject({ status: 'fail', ok: false });
  expect(argv(report)?.message).toContain(
    'Expected zero-cost 400 invalid effort or 400/404 unknown sentinel model',
  );
  expect(enums(report)?.status).toBe('fail');
  expect(report).toMatchObject({ ok: false, zeroInference: false, verdict: 'blocked' });
});
it.each([
  ['ok', 'tokens'],
  ['ok', 'output'],
  ['model-first', 'tokens'],
  ['model-first', 'output'],
  ['model-envelope', 'tokens'],
])('fails zero inference for a Codex %s rejection that reports %s', async (mode, spend) => {
  const report = await probeHarnessContracts(await probeOptions('codex', `${mode}+${spend}`));
  expect(argv(report)).toMatchObject({ status: 'fail', ok: false });
  expect(report).toMatchObject({ ok: false, zeroInference: false });
});
it('fails the Codex argv check on a stderr warning but keeps zero inference', async () => {
  const report = await probeHarnessContracts(await probeOptions('codex', 'model-first+warning'));
  expect(argv(report)).toMatchObject({ status: 'fail', ok: false });
  expect(report.zeroInference).toBe(true);
});
it('blocks an argv probe failure and still reports the probe check', async () => {
  const report = await probeHarnessContracts(await probeOptions('claude', 'auth'));
  expect(argv(report)).toMatchObject({ status: 'fail', ok: false });
  expect(report).toMatchObject({ ok: false, verdict: 'blocked' });
  expect(await callsLog()).toContain('--json-schema');
});
it('retains an earlier cost failure across a later zero-cost provider', async () => {
  const report = await probeHarnessContracts({
    claudeBinary: await binary('claude', 'cost'),
    codexBinary: await binary('codex'),
    codexHome: directory,
  });
  expect(report.zeroInference).toBe(false);
  expect(
    report.checks.find((check) => check.harness === 'codex' && check.check === 'argv')?.ok,
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
  expect(missing.verdict).toBe('blocked');
  expect(argv(missing)).toMatchObject({ status: 'fail', ok: false });
  expect(argv(missing)?.message).toContain('skipped');
  expect(argv(missing)?.message).toContain('did not answer --version');
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
    harness: 'codex' as const,
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
async function runDoctor(
  provider: 'claude' | 'codex',
  mode: string,
  extra: readonly string[] = [],
): Promise<{ lines: string[]; error: unknown }> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((value) => {
    lines.push(String(value));
  });
  let error: unknown;
  try {
    await ConfigurationDoctor.run(
      [
        '--harness',
        provider,
        `--${provider}-binary`,
        await binary(provider, mode),
        '--codex-home',
        directory,
        ...extra,
      ],
      { root: projectRoot },
    );
  } catch (caught) {
    error = caught;
  }
  return { lines, error };
}
it.each([
  ['ok', [], 'ok', 'ok'],
  ['warning', [], 'blocked', 'fail'],
  ['patch', [], 'usable-with-warnings', 'ok'],
  ['patch', ['--strict'], 'blocked', 'fail'],
  ['version', [], 'blocked', 'fail'],
  ['garbage', [], 'blocked', 'fail'],
  ['auth', [], 'blocked', 'fail'],
] as const)(
  'prints machine-readable doctor JSON and exits nonzero only when blocked (%s %j)',
  async (mode, extra, verdict, outcome) => {
    const { lines, error } = await runDoctor('claude', mode, ['--json', ...extra]);
    const report = JSON.parse(lines.join('')) as DoctorReport;
    expect(report.verdict).toBe(verdict);
    expect(report.ok).toBe(outcome === 'ok');
    expect(report.warnings).toHaveLength(verdict === 'usable-with-warnings' ? 1 : 0);
    expect(report.checks).toHaveLength(5);
    if (outcome === 'ok') expect(error).toBeUndefined();
    else expect(error).toMatchObject({ oclif: { exit: 1 } });
  },
);
it.each([
  ['ok', [], /^ok$/u, undefined],
  [
    'patch',
    [],
    /^usable with warnings: .*untested patch version.*npm run test:contract/u,
    undefined,
  ],
  ['patch', ['--strict'], /^blocked: .*--strict.*npm run test:contract/u, 1],
  ['version', [], /^blocked: .*quiet-choir configuration doctor/u, 1],
  [
    'model-first',
    [],
    /^usable with warnings: codex effort values are unverified because the server rejected the sentinel model .*\(or pass --strict/u,
    undefined,
  ],
  [
    'model-first',
    ['--strict'],
    /^blocked: codex effort values are unverified .*--strict treats that as a failure \(or rerun without --strict\)$/u,
    1,
  ],
  [
    'patch+model-first',
    [],
    /^usable with warnings: codex \S+ is an untested patch version; .*test:contract.*; codex effort values are unverified/u,
    undefined,
  ],
] as const)(
  'ends text output with the verdict line and next command (%s %j)',
  async (mode, extra, last, exit) => {
    const { lines, error } = await runDoctor('codex', mode, extra);
    const output = lines.join('\n').split('\n');
    expect(output.at(-1)).toMatch(last);
    expect(output.slice(0, -1)).toHaveLength(5);
    expect(output[0]).toMatch(/^(PASS|WARN|FAIL) codex version: /u);
    if (mode === 'patch' && extra.length === 0) expect(output[0]).toMatch(/^WARN /u);
    if (mode === 'patch' && extra.length === 1) expect(output[0]).toMatch(/^FAIL /u);
    if (mode.includes('model-first'))
      expect(output).toContainEqual(
        expect.stringMatching(
          extra.length ? /^FAIL codex enums: Effort values unavailable/u : /^WARN codex enums: /u,
        ),
      );
    if (exit === undefined) expect(error).toBeUndefined();
    else expect(error).toMatchObject({ oclif: { exit } });
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

it('names user-level Codex instruction files in the inherited-defaults check without leaking contents', async () => {
  const home = join(directory, 'codex-home');
  await mkdir(home);
  // Keep the real ~/.agents/skills out of the user-level sources.
  vi.stubEnv('HOME', join(directory, 'user-home'));
  const options = {
    harness: 'codex',
    codexBinary: await binary('codex'),
    codexHome: home,
  } as const;
  const check = (report: DoctorReport) =>
    report.checks.find((entry) => entry.check === 'inherited-defaults');

  const absent = await probeHarnessContracts(options);
  expect(check(absent)?.ok).toBe(true);
  expect(check(absent)?.message).toContain('No user-level instruction files were found.');
  expect(absent.codexInstructions).toEqual([]);

  const canary = 'DOCTOR_AGENTS_CANARY_3310';
  await writeFile(join(home, 'AGENTS.md'), canary);
  const present = await probeHarnessContracts(options);
  const message = check(present)?.message ?? '';
  expect(check(present)?.ok).toBe(true);
  expect(message).toContain(join(home, 'AGENTS.md'));
  expect(message).toContain('AGENTS.override.md');
  expect(message).toContain('Codex still loads');
  expect(message).not.toContain('restricted calls ignore user configuration');
  expect(present.codexInstructions).toEqual([
    {
      scope: 'user',
      kind: 'agents',
      path: join(home, 'AGENTS.md'),
      sha256: createHash('sha256').update(canary).digest('hex'),
    },
  ]);
  expect(JSON.stringify(present)).not.toContain(canary);
});

it('names the inherit-only Claude user CLAUDE.md in the inherited-defaults check without leaking contents', async () => {
  const config = join(directory, 'claude-config');
  await mkdir(config);
  vi.stubEnv('CLAUDE_CONFIG_DIR', config);
  // A HOME that is not an ancestor of the cwd keeps the host's ~/.claude/CLAUDE.md out.
  vi.stubEnv('HOME', join(directory, 'user-home'));
  const options = { harness: 'claude', claudeBinary: await binary('claude') } as const;
  const check = (report: DoctorReport) =>
    report.checks.find((entry) => entry.check === 'inherited-defaults')?.message ?? '';

  const absent = check(await probeHarnessContracts(options));
  expect(absent).toContain('Restricted mode skips user/project settings');
  expect(absent).not.toContain('CLAUDE.md');

  const canary = 'DOCTOR_CLAUDE_MD_CANARY_5521';
  await writeFile(join(config, 'CLAUDE.md'), canary);
  const report = await probeHarnessContracts(options);
  const message = check(report);
  expect(message).toContain(
    `Inherit-mode calls also load the user instruction file ${join(config, 'CLAUDE.md')} (sha256 ${createHash('sha256').update(canary).digest('hex').slice(0, 12)}); restricted calls skip it.`,
  );
  expect(JSON.stringify(report)).not.toContain(canary);
});
