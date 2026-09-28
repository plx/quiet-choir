import { isAbsolute } from 'node:path';
import type {
  Harness,
  HarnessRequestInput,
  HarnessResponse,
  HarnessMetadata,
  HarnessInvocation,
} from '../workflow/runtime/model.js';
import type { ExecutionPolicy } from '../workflow/runtime/policy.js';
import {
  attachHarnessEvidence,
  boundedResponse,
  HarnessError,
} from '../workflow/runtime/harness-error.js';
import { ConfigurationError } from '../workflow/runtime/configuration-error.js';
import { runProcess } from './process.js';
import type { ProcessResult } from './process.js';
import { invocationRequest, materializeInvocation, planInvocation } from './invocation.js';
import type { CliArgumentPlan } from './invocation.js';
import { HarnessStream } from './stream.js';
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
  /** Legacy alias for maxRetainedBytes. */
  readonly maxOutputBytes?: number;
  /** Retained parser state and single-line limit; defaults to 8 MiB. */
  readonly maxRetainedBytes?: number;
  /** Combined raw stdout/stderr safety cap; defaults to 1 GiB. */
  readonly maxStreamBytes?: number;
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
  /** Legacy alias for maxRetainedBytes. */
  readonly maxOutputBytes: number;
  /** Retained parser state and single-line byte limit. */
  readonly maxRetainedBytes: number;
  /** Combined raw stdout/stderr safety cap. */
  readonly maxStreamBytes: number;
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
  private readonly maxStreamBytes: number;
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
    if (options.maxOutputBytes !== undefined) positive(options.maxOutputBytes, 'maxOutputBytes');
    this.maxOutputBytes = positive(
      options.maxRetainedBytes ?? options.maxOutputBytes ?? 8 * 1024 * 1024,
      'maxRetainedBytes',
    );
    if (this.maxOutputBytes > 2_147_483_647)
      throw new Error('maxRetainedBytes must not exceed 2147483647.');
    this.maxStreamBytes = positive(options.maxStreamBytes ?? 1024 ** 3, 'maxStreamBytes');
    this.killGraceMs = timerDuration(options.killGraceMs ?? 3000, 'killGraceMs');
  }

  /** Adapter-owned defaults exposed to the runtime for accurate per-attempt policy records. */
  public policyDefaults(provider: HarnessRequestInput['provider']): ExecutionPolicy {
    return {
      timeoutMs: defaultTimeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      maxRetainedBytes: this.maxOutputBytes,
      maxStreamBytes: this.maxStreamBytes,
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
  public plan(
    request: HarnessRequestInput,
    context?: Pick<HarnessInvocation, 'sessionId' | 'policy'>,
  ): CliHarnessPlan {
    // Validation before launch rejects as configuration, never as a settled effect failure;
    // planInvocation applies the same rule to option and output-schema validation.
    if (!isAbsolute(request.cwd))
      throw new ConfigurationError('Harness cwd must be an absolute path.');
    return {
      ...planInvocation(request, context?.sessionId),
      binary:
        request.provider === 'claude'
          ? (this.options.claudeBinary ?? 'claude')
          : (this.options.codexBinary ?? 'codex'),
      cwd: request.cwd,
      stdin: request.options.prompt,
      timeoutMs: request.options.timeoutMs ?? defaultTimeoutMs,
      maxOutputBytes:
        context?.policy?.maxRetainedBytes ?? context?.policy?.maxOutputBytes ?? this.maxOutputBytes,
      maxRetainedBytes:
        context?.policy?.maxRetainedBytes ?? context?.policy?.maxOutputBytes ?? this.maxOutputBytes,
      maxStreamBytes: positive(
        context?.policy?.maxStreamBytes ?? this.maxStreamBytes,
        'maxStreamBytes',
      ),
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
    const plan = this.plan(input, context);
    const stream = new HarnessStream(
      request.provider,
      request.outputSchema !== null,
      plan.maxRetainedBytes,
      context,
    );
    const invocation = await materializeInvocation(plan, input);
    let processResult: ProcessResult | undefined;
    try {
      const result = await runProcess({
        binary: plan.binary,
        args: invocation.args,
        cwd: plan.cwd,
        input: plan.stdin,
        timeoutMs: plan.timeoutMs,
        maxOutputBytes: plan.maxOutputBytes,
        stream: {
          maxBytes: plan.maxStreamBytes,
          stdout: (chunk) => stream.stdout(chunk),
          stderr: (chunk) => stream.stderr(chunk),
        },
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
      processResult = result;
      const outcome = await stream.finish();
      const diagnostics = stream.diagnostics(result.stderr, result.warnings);
      if (result.code === 0 && result.signal === null && outcome.kind === 'success')
        return {
          ...outcome.response,
          sessionId: outcome.response.sessionId ?? stream.protocol.sessionId,
          diagnostics,
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
            ? !stream.sawStdout && (result.code !== 0 || result.signal !== null)
              ? `exited with ${result.signal ?? `code ${String(result.code)}`} (no protocol output)`
              : outcome.reason
            : 'process failed after a successful protocol result',
        stderr: result.stderr,
        stdout: stream.stdoutTail,
        diagnostics,
        rawText: stream.protocol.text,
        sessionId: stream.protocol.sessionId,
        ...(stream.protocol.usage === null ? {} : { usage: stream.protocol.usage }),
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
    } catch (error) {
      const captured =
        processResult ??
        (error instanceof Error && 'processResult' in error
          ? (error.processResult as ProcessResult)
          : undefined);
      if (error instanceof Error && 'code' in error && error.code === 'QUIET_CHOIR_PROTOCOL')
        throw new HarnessError({
          provider: request.provider,
          exit: { code: captured?.code ?? null, signal: captured?.signal ?? null },
          failure: null,
          reason: error.message,
          stderr: captured?.stderr ?? '',
          stdout: stream.stdoutTail,
          sessionId: stream.protocol.sessionId,
          ...(stream.protocol.usage === null ? {} : { usage: stream.protocol.usage }),
          diagnostics: stream.diagnostics(captured?.stderr ?? '', captured?.warnings),
          rawText: stream.protocol.text,
        });
      attachHarnessEvidence(error, {
        sessionId: stream.protocol.sessionId,
        usage: stream.protocol.usage,
        diagnostics: stream.diagnostics(captured?.stderr ?? '', captured?.warnings),
        ...boundedResponse(stream.protocol.text),
      });
      throw error;
    } finally {
      await invocation.dispose();
    }
  }
}
