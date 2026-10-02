import type { WorkflowDescription } from '../harness-kit.js';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProcessSupervisor } from '../processes/supervisor.js';
import type {
  HarnessMetadata,
  InstructionSource,
  BuiltinHarnessRequestInput as HarnessRequestInput,
} from '../harness-kit.js';
import { childEnvironment } from './environment.js';
import { effortValues, codexEffortValues, permissionModeValues } from '../harness-kit.js';
import { prepareInvocation } from './invocation.js';
import { runProcess, type ProcessResult } from './process.js';
import { parseClaude, parseCodex } from './protocol.js';
import { detectCodexInstructionSources } from './codex-instructions.js';
import { readInheritedCodexConfig, type InheritedCodexConfig } from './doctor-config.js';
import { gradeHarnessVersion, testedHarnessVersions } from './tested-versions.js';

export { testedHarnessVersions };

/** One independently reported installation/contract check. */
export interface DoctorCheck {
  /** Native CLI checked, or config for inherited default inspection. */
  readonly harness: string;
  /** Stable check identifier. */
  readonly check: 'version' | 'argv' | 'hidden-flags' | 'enums' | 'inherited-defaults' | 'registry';
  /**
   * Check result. `warn` is reported only by the version check, for an untested patch of a tested
   * major.minor; every other drift, error or process warning is `fail`.
   */
  readonly status: 'pass' | 'warn' | 'fail';
  /** `status !== 'fail'`: a warning keeps the harness usable unless `strict` promoted it. */
  readonly ok: boolean;
  /** Bounded diagnostic without full config or prompt contents. */
  readonly message: string;
}
/** Inputs for diagnostic probes. Probes use pre-inference rejections, never ordinary tasks. */
export interface DoctorOptions {
  /** Optional live probe ownership for an embedder's force-stop handler; probes have no durable run. */
  readonly processSupervisor?: ProcessSupervisor;
  /** Probe TERM-to-KILL grace, defaults to 3000ms. */
  readonly killGraceMs?: number;
  /** Harness to check; defaults to both. */
  readonly harness?: 'claude' | 'codex' | 'all';
  /** Working directory used for read-only help/version probes; exact argv uses a temporary directory. */
  readonly cwd?: string;
  /** Override the Claude executable for installation/contract testing. */
  readonly claudeBinary?: string;
  /** Override the Codex executable for installation/contract testing. */
  readonly codexBinary?: string;
  /** Codex configuration directory; defaults to CODEX_HOME or ~/.codex. */
  readonly codexHome?: string;
  /** Native profile whose inherited model/effort should be inspected. */
  readonly codexProfile?: string;
  /** Deadline for each bounded probe; defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /** Cancellation forwarded to every probe. */
  readonly signal?: AbortSignal;
  /** Treat an untested patch version as a failure (status `fail`, verdict `blocked`). */
  readonly strict?: boolean;
}
/** Serializable contract report; ok is false only when the verdict is `blocked`. */
export interface DoctorReport {
  /** Workflow registry descriptions, when --workflow is supplied. */
  readonly registered?: WorkflowDescription['harnesses'];
  /** No check failed: `verdict !== 'blocked'`. Warnings alone leave it true. */
  readonly ok: boolean;
  /** `blocked` when any check fails, `usable-with-warnings` when any warns, otherwise `ok`. */
  readonly verdict: 'ok' | 'usable-with-warnings' | 'blocked';
  /** One `<harness> <check>: <message>` entry per check whose status is `warn`. */
  readonly warnings: readonly string[];
  /**
   * True only when every requested harness's exact-argv probe actually ran and proved a
   * zero-spend rejection; a skipped probe (the binary did not answer `--version`) counts as
   * unverified, not proven. The probe runs whatever version the binary reports.
   */
  readonly zeroInference: boolean;
  /** Five checks per requested harness. */
  readonly checks: readonly DoctorCheck[];
  /** Observed versions and configured executable names. */
  readonly harnesses: Record<string, HarnessMetadata>;
  /** Selected Codex config values, when inspection succeeded. */
  readonly inherited?: InheritedCodexConfig;
  /** User-level Codex instruction files restricted calls still load, as paths and digests only. */
  readonly codexInstructions?: readonly InstructionSource[];
}
/** Message suffix that marks a version warning promoted to a failure by `strict`. */
export const strictVersionFailure = '; --strict treats an untested patch version as a failure';
/** Derive the report-level result from per-check statuses; shared by the registry path. */
export function summarizeDoctorChecks(
  checks: readonly Pick<DoctorCheck, 'harness' | 'check' | 'status' | 'message'>[],
): Pick<DoctorReport, 'ok' | 'verdict' | 'warnings'> {
  const verdict = checks.some((entry) => entry.status === 'fail')
    ? 'blocked'
    : checks.some((entry) => entry.status === 'warn')
      ? 'usable-with-warnings'
      : 'ok';
  return {
    ok: verdict !== 'blocked',
    verdict,
    warnings: checks
      .filter((entry) => entry.status === 'warn')
      .map((entry) => `${entry.harness} ${entry.check}: ${entry.message}`),
  };
}
const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(-2048);
const codexHome = (options: DoctorOptions): string =>
  options.codexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
const warning = (result: ProcessResult): boolean =>
  result.warnings.length > 0 || /\bwarn(?:ing)?\b/iu.test(result.stderr);
const same = (actual: readonly string[], expected: readonly string[]): boolean =>
  JSON.stringify([...new Set(actual)].sort()) === JSON.stringify([...expected].sort());
function choices(help: string, flag: string): string[] {
  const start = help.indexOf(flag);
  if (start < 0) return [];
  const section = help.slice(start, start + 700).split(/\n\s+--/u)[0] ?? '';
  const parentheses = /\((?:choices:\s*)?([^)]*)\)/u.exec(section)?.[1];
  return (parentheses ?? '')
    .replaceAll('"', '')
    .split(/[,\s]+/u)
    .filter(Boolean);
}
function noMeasuredSpend(stdout: string): boolean {
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(visit);
    if (value !== null && typeof value === 'object')
      return Object.entries(value).every(([key, child]) => {
        if (
          [
            'total_cost_usd',
            'cost_usd',
            'costUsd',
            'input_tokens',
            'output_tokens',
            'total_tokens',
            'cache_read_input_tokens',
            'cache_creation_input_tokens',
            'thinking_tokens',
          ].includes(key) &&
          typeof child === 'number' &&
          child > 0
        )
          return false;
        return visit(child);
      });
    return true;
  };
  return stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .every((line) => {
      try {
        return visit(JSON.parse(line));
      } catch {
        return false;
      }
    });
}

/** Execute version, exact-argv, hidden-flag, enum and inherited-config probes for CI or the CLI. */
export async function probeHarnessContracts(options: DoctorOptions = {}): Promise<DoctorReport> {
  const providers =
    options.harness === undefined || options.harness === 'all'
      ? (['claude', 'codex'] as const)
      : [options.harness];
  const signal = options.signal ?? new AbortController().signal;
  const supervisor = options.processSupervisor ?? new ProcessSupervisor();
  const killGraceMs = options.killGraceMs ?? 3000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error('Doctor timeoutMs must be a positive bounded integer.');
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs <= 0 || killGraceMs > 2_147_483_647)
    throw new Error('Doctor killGraceMs must be a positive bounded integer.');
  const checks: DoctorCheck[] = [];
  const harnesses: DoctorReport['harnesses'] = {};
  let inherited: InheritedCodexConfig | undefined;
  let codexInstructions: readonly InstructionSource[] | undefined;
  let zeroInference = true;
  for (const harness of providers) {
    signal.throwIfAborted();
    const binary =
      harness === 'claude' ? (options.claudeBinary ?? 'claude') : (options.codexBinary ?? 'codex');
    const probe = (
      args: readonly string[],
      cwd = options.cwd ?? process.cwd(),
      env?: Readonly<Record<string, string>>,
    ): Promise<ProcessResult> =>
      runProcess({
        binary,
        args,
        cwd,
        input: 'quiet-choir contract probe; do not perform any task',
        timeoutMs,
        maxOutputBytes: 2 * 1024 * 1024,
        killGraceMs,
        trackProcess: (child) => {
          const forget = supervisor.track(child);
          return Promise.resolve({
            release: () => {
              forget();
              return Promise.resolve();
            },
          });
        },
        signal,
        env: env ?? childEnvironment(undefined, undefined).env,
        inheritEnv: false,
      });
    // Set once --version resolves, so the argv probe runs for any binary that answered.
    let responded = false;
    const check = async (
      name: DoctorCheck['check'],
      run: () => Promise<{ ok: boolean; message: string; warn?: boolean }>,
    ): Promise<void> => {
      try {
        const { ok, message: text, warn } = await run();
        checks.push({
          harness,
          check: name,
          status: !ok ? 'fail' : warn ? 'warn' : 'pass',
          ok,
          message: text,
        });
      } catch (error) {
        signal.throwIfAborted();
        checks.push({
          harness,
          check: name,
          status: 'fail',
          ok: false,
          message: message(error),
        });
      }
    };
    await check('version', async () => {
      const result = await probe(['--version']);
      const version =
        /\b[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?\b/u.exec(result.stdout)?.[0] ?? null;
      harnesses[harness] = { binary, version };
      responded = true;
      const tested = testedHarnessVersions[harness];
      const clean = result.code === 0 && result.signal === null && !warning(result);
      const grade = clean ? gradeHarnessVersion(version, tested) : 'fail';
      const strictFail = grade === 'warn' && options.strict === true;
      const phrase = !clean
        ? ''
        : grade === 'warn'
          ? '; untested patch version'
          : grade === 'pass'
            ? ''
            : version !== null && /^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)
              ? '; outside the tested range'
              : '; unparseable or prerelease version';
      return {
        ok: grade === 'pass' || (grade === 'warn' && !strictFail),
        warn: grade === 'warn' && !strictFail,
        message: `${binary}@${version ?? 'unknown'}; tested ${tested.minimum}..${tested.maximum}${phrase}${strictFail ? strictVersionFailure : ''}${result.warnings.length ? `; process warnings: ${result.warnings.join(' ')}` : ''}${result.stderr ? `; stderr: ${result.stderr.slice(-1024)}` : ''}`,
      };
    });
    let help = '';
    let exact: ProcessResult | undefined;
    let rejection = '';
    await check('argv', async () => {
      const previousZeroInference = zeroInference;
      zeroInference = false;
      if (!responded)
        throw new Error(`Exact-argv probe skipped: ${binary} did not answer --version.`);
      const directory = await mkdtemp(join(tmpdir(), 'quiet-choir-doctor-'));
      try {
        const image = join(directory, 'probe.png');
        await writeFile(
          image,
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=',
            'base64',
          ),
          { mode: 0o600 },
        );
        // Exercise --profile without adding files to the user's configuration directory.
        // Only the two native auth/config files are copied; no directory scan or secret logging.
        const probeHome = join(directory, 'codex-home');
        let inheritedModel: string | null = null;
        if (harness === 'codex') {
          inheritedModel = (
            await readInheritedCodexConfig(codexHome(options), options.codexProfile)
          ).model;
          await mkdir(probeHome, { mode: 0o700 });
          for (const name of ['config.toml', 'auth.json']) {
            try {
              await writeFile(
                join(probeHome, name),
                await readFile(join(codexHome(options), name)),
                { mode: 0o600 },
              );
            } catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                throw error;
            }
          }
          await writeFile(join(probeHome, 'quiet-choir-probe.config.toml'), '', { mode: 0o600 });
        }
        const invalidModel = `claude-quiet-choir-nonexistent-${randomUUID()}`;
        const request: HarnessRequestInput =
          harness === 'claude'
            ? {
                harness,
                cwd: directory,
                outputSchema: {
                  type: 'object',
                  properties: { ok: { type: 'boolean' } },
                  required: ['ok'],
                  additionalProperties: false,
                },
                options: {
                  prompt: '',
                  model: invalidModel,
                  effort: 'low',
                  tools: ['Read'],
                  allowedTools: ['Read'],
                  disallowedTools: ['Bash'],
                  permissionMode: 'dontAsk',
                  maxTurns: 1,
                  maxBudgetUsd: 0.01,
                  systemPrompt: 'Contract probe only.',
                  appendSystemPrompt: 'Do not run tools.',
                  agent: 'probe',
                  agents: { probe: { description: 'Contract probe', prompt: 'Do not run tools.' } },
                  mcpServers: {},
                  strictMcpConfig: true,
                  settings: {},
                  fallbackModel: invalidModel,
                  addDirs: [directory],
                  env: { QUIET_CHOIR_DOCTOR: '1' },
                  extraArgs: ['--no-chrome'],
                },
              }
            : {
                harness,
                cwd: directory,
                outputSchema: {
                  type: 'object',
                  properties: { ok: { type: 'boolean' } },
                  required: ['ok'],
                  additionalProperties: false,
                },
                options: {
                  prompt: '',
                  sandbox: 'workspace-write',
                  effort: 'low',
                  model: inheritedModel ?? 'gpt-5',
                  // harnessProfile selects a config.toml profile, so probing it needs the
                  // inherited role restricted mode would otherwise skip; CODEX_HOME still
                  // points at the private probeHome copy, never the caller's real home.
                  isolation: 'inherit',
                  harnessProfile: 'quiet-choir-probe',
                  skipGitRepoCheck: true,
                  networkAccess: false,
                  addDirs: [directory],
                  images: [image],
                  config: { 'features.remote_models': false },
                  env: { QUIET_CHOIR_DOCTOR: '1' },
                  extraArgs: ['--strict-config'],
                },
              };
        const invocation = await prepareInvocation(request, signal);
        try {
          // Deliberately invalid effort is possible only in this diagnostic, after ordinary validation.
          if (harness === 'codex') {
            const index = invocation.args.findIndex((arg) =>
              arg.startsWith('model_reasoning_effort='),
            );
            if (index < 0) throw new Error('Doctor could not locate the adapter effort argument.');
            invocation.args[index] = 'model_reasoning_effort="bogus"';
          }
          const env = {
            ...childEnvironment(request.options.env, undefined).env,
            ...(harness === 'codex' ? { CODEX_HOME: probeHome } : {}),
          };
          exact = await probe(invocation.args, directory, env);
          const parsed =
            harness === 'claude' ? parseClaude(exact.stdout, true) : parseCodex(exact.stdout);
          rejection = parsed.kind === 'failure' ? parsed.failure.reason : '';
          const zero =
            parsed.kind === 'failure' &&
            noMeasuredSpend(exact.stdout) &&
            (harness === 'claude'
              ? parsed.failure.apiStatus === 404 &&
                parsed.failure.usage?.costUsd === 0 &&
                rejection.includes(invalidModel)
              : parsed.failure.apiStatus === 400 &&
                rejection.includes("Invalid value: 'bogus'") &&
                rejection.includes('Supported values are:'));
          // Retain earlier harness failures rather than allowing a later successful probe to erase them.
          zeroInference = zero && previousZeroInference;
          return {
            ok: zero && exact.code === 1 && exact.signal === null && !warning(exact),
            message: zero
              ? `Verified pre-inference rejection with zero reported spend${warning(exact) ? `; process/stderr warning: ${[...exact.warnings, exact.stderr.slice(-1024)].filter(Boolean).join('; ')}` : ''}.`
              : `Expected zero-cost ${harness === 'claude' ? '404 invalid model' : '400 invalid effort'}; received ${parsed.kind === 'failure' ? rejection : parsed.kind}${exact.stderr ? `; stderr: ${exact.stderr.slice(-1024)}` : ''}`,
          };
        } finally {
          await invocation.dispose();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    await check('hidden-flags', async () => {
      if (harness === 'codex') {
        const result = await probe(['exec', '--help']);
        help = result.stdout;
        const missing = [
          '--json',
          '--output-schema',
          '--ephemeral',
          '--config',
          '--image',
          '--profile',
          '--add-dir',
          '--ignore-user-config',
          '--ignore-rules',
        ].filter((flag) => !help.includes(flag));
        return {
          ok: result.code === 0 && missing.length === 0 && !warning(result),
          message: missing.length
            ? `Missing flags: ${missing.join(', ')}`
            : `Required exec plumbing flags present${warning(result) ? '; process/stderr warning' : ''}.`,
        };
      }
      const absent = join(tmpdir(), `quiet-choir-missing-${randomUUID()}`);
      const probes = [
        ['--print', '--max-turns', 'abc'],
        ['--print', '--system-prompt-file', absent],
        ['--print', '--append-system-prompt-file', absent],
      ];
      for (const [index, args] of probes.entries()) {
        const result = await probe(args);
        const output = `${result.stdout}\n${result.stderr}`;
        if (
          result.code === 0 ||
          warning(result) ||
          /unknown option/iu.test(output) ||
          !(
            index === 0 ? /must be a number/iu : /(?:system prompt|prompt).*file.*not found/iu
          ).test(output)
        )
          return {
            ok: false,
            message: `Hidden-flag probe ${args[1] ?? ''} drifted: ${output.slice(-1024)}`,
          };
      }
      return {
        ok: true,
        message: 'max-turns and both prompt-file flags reject invalid values before inference.',
      };
    });
    await check('enums', async () => {
      if (harness === 'codex') {
        const list = rejection.split('Supported values are:')[1]?.split('.')[0] ?? '';
        const values = [...list.matchAll(/'([^']+)'/gu)].flatMap((match) =>
          match[1] ? [match[1]] : [],
        );
        return {
          ok: same(values, codexEffortValues),
          message: `Reported effort values: ${values.join(', ') || 'unavailable'}.`,
        };
      }
      const result = await probe(['--help']);
      help = result.stdout;
      const efforts = choices(help, '--effort');
      const modes = choices(help, '--permission-mode');
      const expectedModes = [...permissionModeValues, 'auto', 'manual', 'bypassPermissions'];
      return {
        ok:
          result.code === 0 &&
          !warning(result) &&
          same(efforts, effortValues) &&
          same(modes, expectedModes),
        message: `Effort: ${efforts.join(', ')}; permission modes: ${modes.join(', ')}. Interactive/bypass modes are deliberately unexposed${warning(result) ? '; process/stderr warning' : ''}.`,
      };
    });
    await check('inherited-defaults', async () => {
      if (harness === 'claude')
        return {
          ok: true,
          message:
            'Restricted mode skips user/project settings; omitted model/effort use remaining native defaults. Doctor does not read Claude authentication/settings secrets.',
        };
      const home = codexHome(options);
      inherited = await readInheritedCodexConfig(home, options.codexProfile);
      const detection = await detectCodexInstructionSources({
        codexHome: home,
        cwd: options.cwd ?? process.cwd(),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      codexInstructions = detection.sources.filter((source) => source.scope === 'user');
      const found = codexInstructions.filter((source) => source.kind !== 'skill');
      const skills = codexInstructions.length - found.length + detection.omittedSkills;
      const named = [
        ...found.map((source) => `${source.path} (sha256 ${source.sha256.slice(0, 12)})`),
        ...(skills ? [`${String(skills)} skill description file${skills === 1 ? '' : 's'}`] : []),
      ];
      return {
        ok: true,
        message: `User/profile configuration: model=${inherited.model ?? 'inherited CLI default'}, effort=${inherited.effort ?? 'inherited CLI default'}, profile=${inherited.profile ?? 'none'}. These are inherit-mode diagnostics; restricted calls skip config.toml (model, provider, profiles) and execpolicy rules, but Codex still loads CODEX_HOME/AGENTS.md (or AGENTS.override.md), CODEX_HOME/skills descriptions, and project AGENTS.md files from the Git root to the working directory. ${named.length ? `User-level instruction sources found: ${named.join(', ')}.` : 'No user-level instruction files were found.'}${detection.warnings.length ? ` ${detection.warnings.join(' ')}` : ''} Project/managed layers may further override native defaults.`,
      };
    });
  }
  return {
    ...summarizeDoctorChecks(checks),
    zeroInference,
    checks,
    harnesses,
    ...(inherited ? { inherited } : {}),
    ...(codexInstructions ? { codexInstructions } : {}),
  };
}
