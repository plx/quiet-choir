import { isAbsolute } from 'node:path';
import type {
  Harness,
  HarnessRequestInput,
  HarnessResponse,
  HarnessMetadata,
  HarnessInvocation,
} from '../workflow/runtime/model.js';
import type { ExecutionPolicy } from '../workflow/runtime/policy.js';
import { HarnessError } from '../workflow/runtime/harness-error.js';
import { ConfigurationError } from '../workflow/runtime/configuration-error.js';
import { runProcess } from './process.js';
import { invocationRequest, materializeInvocation, planInvocation } from './invocation.js';
import type { CliArgumentPlan } from './invocation.js';
import { parseClaude, parseCodex } from './protocol.js';
import {
  childEnvironment,
  validateScrubEnvironment,
  type ScrubEnvironment,
} from './environment.js';

const defaultTimeoutMs = 300_000;
const defaultMaxTurns = 10;
const defaultMaxBudgetUsd = 0.5;

/** Executable overrides and resource limits for headless harness processes. */
export interface CliHarnessOptions {
  /** Extend the default host-session scrub list, or explicitly disable it with false. */
  readonly scrubEnv?: ScrubEnvironment;
  /** Claude executable, resolved through PATH by default. */
  readonly claudeBinary?: string;
  /** Codex executable, resolved through PATH by default. */
  readonly codexBinary?: string;
  /** Combined stdout/stderr limit per process; defaults to 8 MiB. */
  readonly maxOutputBytes?: number;
  /** Milliseconds to wait after SIGTERM before SIGKILL; defaults to 3000. */
  readonly killGraceMs?: number;
}

/** Pure, serializable process plan; planning never probes binaries or creates files. */
export interface CliHarnessPlan extends CliArgumentPlan {
  /** Selected executable. */
  readonly binary: string;
  /** Absolute working directory. */
  readonly cwd: string;
  /** Prompt sent through stdin. */
  readonly stdin: string;
  /** Resolved per-call deadline in milliseconds. */
  readonly timeoutMs: number;
  /** Combined stdout/stderr byte limit. */
  readonly maxOutputBytes: number;
  /** Grace period before forced termination. */
  readonly killGraceMs: number;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function timerDuration(value: number, name: string): number {
  positive(value, name);
  if (value > 2_147_483_647) throw new Error(`${name} must not exceed 2147483647ms.`);
  return value;
}

/** Invoke installed Claude Code and Codex CLIs with subscription authentication and bounded processes. */
export class CliHarness implements Harness {
  /** Native CLI execution provenance. */
  public readonly kind = 'cli';
  private readonly options: CliHarnessOptions;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;

  /** Configure executable paths or retain the CLIs found on PATH. */
  public constructor(options: CliHarnessOptions = {}) {
    validateScrubEnvironment(options.scrubEnv);
    this.options = {
      ...options,
      ...(options.scrubEnv !== undefined && options.scrubEnv !== false
        ? { scrubEnv: [...options.scrubEnv] }
        : {}),
    };
    this.maxOutputBytes = positive(options.maxOutputBytes ?? 8 * 1024 * 1024, 'maxOutputBytes');
    this.killGraceMs = timerDuration(options.killGraceMs ?? 3000, 'killGraceMs');
  }

  /** Adapter-owned defaults exposed to the runtime for accurate per-attempt policy records. */
  public policyDefaults(provider: HarnessRequestInput['provider']): ExecutionPolicy {
    return {
      timeoutMs: defaultTimeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      killGraceMs: this.killGraceMs,
      binary:
        provider === 'claude'
          ? (this.options.claudeBinary ?? 'claude')
          : (this.options.codexBinary ?? 'codex'),
      ...(provider === 'claude'
        ? { maxTurns: defaultMaxTurns, maxBudgetUsd: defaultMaxBudgetUsd }
        : {}),
    };
  }

  /** Validate and describe the exact invocation without filesystem writes or child processes. */
  public plan(request: HarnessRequestInput): CliHarnessPlan {
    // Validation before launch rejects as configuration, never as a settled effect failure;
    // planInvocation applies the same rule to option and output-schema validation.
    if (!isAbsolute(request.cwd))
      throw new ConfigurationError('Harness cwd must be an absolute path.');
    return {
      ...planInvocation(request),
      binary:
        request.provider === 'claude'
          ? (this.options.claudeBinary ?? 'claude')
          : (this.options.codexBinary ?? 'codex'),
      cwd: request.cwd,
      stdin: request.options.prompt,
      timeoutMs: request.options.timeoutMs ?? defaultTimeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      killGraceMs: this.killGraceMs,
    };
  }

  /** Read the selected executable version without inference; failures become diagnostics. */
  public async metadata(
    request: HarnessRequestInput,
    context: HarnessInvocation,
  ): Promise<HarnessMetadata> {
    const { signal } = context;
    const binary =
      request.provider === 'claude'
        ? (this.options.claudeBinary ?? 'claude')
        : (this.options.codexBinary ?? 'codex');
    const environment = childEnvironment(request.options.env, this.options.scrubEnv);
    try {
      const result = await runProcess({
        binary,
        args: ['--version'],
        cwd: request.cwd,
        input: '',
        timeoutMs: 10_000,
        maxOutputBytes: 16_384,
        killGraceMs: this.killGraceMs,
        signal,
        trackProcess: (child) => context.trackProcess(child),
        env: environment.env,
        inheritEnv: false,
      });
      const version =
        result.code === 0
          ? /\b[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?\b/u.exec(result.stdout)?.[0]
          : undefined;
      const warnings = [...result.warnings];
      if (version === undefined || result.stderr.trim())
        warnings.push(
          `${binary} version discovery: ${result.stderr.trim().slice(-1024) || 'unrecognized version output'}`,
        );
      return {
        binary,
        version: version ?? null,
        environment: environment.summary,
        ...(warnings.length ? { warnings } : {}),
      };
    } catch (error) {
      signal.throwIfAborted();
      return {
        binary,
        version: null,
        environment: environment.summary,
        warnings: [
          `${binary} version discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  /** Execute a fresh headless session, rejecting cancellation, limits, and protocol failures. */
  public async invoke(
    request: HarnessRequestInput,
    context: HarnessInvocation,
  ): Promise<HarnessResponse> {
    const { signal } = context;
    signal.throwIfAborted();
    // Reject a relative cwd as configuration before any image is snapshotted against it.
    if (!isAbsolute(request.cwd))
      throw new ConfigurationError('Harness cwd must be an absolute path.');
    const input = await invocationRequest(request, signal);
    const plan = this.plan(input);
    const invocation = await materializeInvocation(plan, input);
    try {
      const result = await runProcess({
        binary: plan.binary,
        args: invocation.args,
        cwd: plan.cwd,
        input: plan.stdin,
        timeoutMs: plan.timeoutMs,
        maxOutputBytes: plan.maxOutputBytes,
        killGraceMs: plan.killGraceMs,
        signal,
        trackProcess: (child) => context.trackProcess(child),
        env: {
          ...childEnvironment(request.options.env, this.options.scrubEnv).env,
          QUIET_CHOIR_RUN_ID: context.runId,
          QUIET_CHOIR_STEP_ID: context.stepId,
          QUIET_CHOIR_ATTEMPT: String(context.attempt),
          QUIET_CHOIR_IDEMPOTENCY_KEY: `${context.runId}/${context.stepId}`,
        },
        inheritEnv: false,
      });
      const outcome =
        request.provider === 'claude'
          ? parseClaude(result.stdout, request.outputSchema !== null)
          : parseCodex(result.stdout);
      if (result.code === 0 && result.signal === null && outcome.kind === 'success')
        return {
          ...outcome.response,
          text: invocation.decode(outcome.response.text),
          ...((outcome.response.warnings?.length ?? 0) + result.warnings.length
            ? { warnings: [...(outcome.response.warnings ?? []), ...result.warnings] }
            : {}),
        };
      const failure = new HarnessError({
        provider: request.provider,
        exit: { code: result.code, signal: result.signal },
        failure: outcome.kind === 'failure' ? outcome.failure : null,
        reason:
          outcome.kind === 'unparseable'
            ? result.stdout.trim() === '' && (result.code !== 0 || result.signal !== null)
              ? `exited with ${result.signal ?? `code ${String(result.code)}`} (no protocol output)`
              : outcome.reason
            : 'process failed after a successful protocol result',
        stderr: result.stderr,
        stdout: result.stdout,
        ...(outcome.kind === 'success'
          ? {
              kind: 'process',
              ...(outcome.response.turns === undefined ? {} : { turns: outcome.response.turns }),
              ...(outcome.response.permissionDenials === undefined
                ? {}
                : { permissionDenials: outcome.response.permissionDenials }),
              usage: outcome.response.usage,
              sessionId: outcome.response.sessionId,
            }
          : {}),
      });
      if (result.warnings.length) failure.message += ` Cleanup: ${result.warnings.join(' ')}`;
      throw failure;
    } finally {
      await invocation.dispose();
    }
  }
}
