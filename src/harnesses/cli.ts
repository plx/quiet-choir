import { isAbsolute } from 'node:path';
import type {
  Harness,
  HarnessRequest,
  HarnessResponse,
  HarnessMetadata,
} from '../workflow/runtime/model.js';
import type { ExecutionPolicy } from '../workflow/runtime/policy.js';
import { HarnessError } from '../workflow/runtime/harness-error.js';
import { ConfigurationError } from '../workflow/runtime/configuration-error.js';
import { runProcess } from './process.js';
import { prepareInvocation } from './invocation.js';
import { parseClaude, parseCodex } from './protocol.js';

const defaultTimeoutMs = 300_000;
const defaultMaxTurns = 10;
const defaultMaxBudgetUsd = 0.5;

/** Executable overrides and resource limits for headless harness processes. */
export interface CliHarnessOptions {
  /** Claude executable, resolved through PATH by default. */
  readonly claudeBinary?: string;
  /** Codex executable, resolved through PATH by default. */
  readonly codexBinary?: string;
  /** Combined stdout/stderr limit per process; defaults to 8 MiB. */
  readonly maxOutputBytes?: number;
  /** Milliseconds to wait after SIGTERM before SIGKILL; defaults to 250. */
  readonly killGraceMs?: number;
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
  private readonly options: CliHarnessOptions;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;

  /** Configure executable paths or retain the CLIs found on PATH. */
  public constructor(options: CliHarnessOptions = {}) {
    this.options = { ...options };
    this.maxOutputBytes = positive(options.maxOutputBytes ?? 8 * 1024 * 1024, 'maxOutputBytes');
    this.killGraceMs = timerDuration(options.killGraceMs ?? 250, 'killGraceMs');
  }

  /** Adapter-owned defaults exposed to the runtime for accurate per-attempt policy records. */
  public policyDefaults(provider: HarnessRequest['provider']): ExecutionPolicy {
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

  /** Read the selected executable version without inference; failures become diagnostics. */
  public async metadata(request: HarnessRequest, signal: AbortSignal): Promise<HarnessMetadata> {
    const binary =
      request.provider === 'claude'
        ? (this.options.claudeBinary ?? 'claude')
        : (this.options.codexBinary ?? 'codex');
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
        ...(request.options.env === undefined ? {} : { env: request.options.env }),
      });
      const version =
        result.code === 0
          ? /\b[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?\b/u.exec(result.stdout)?.[0]
          : undefined;
      return {
        binary,
        version: version ?? null,
        ...(version === undefined || result.stderr.trim()
          ? {
              warnings: [
                `${binary} version discovery: ${result.stderr.trim().slice(-1024) || 'unrecognized version output'}`,
              ],
            }
          : {}),
      };
    } catch (error) {
      signal.throwIfAborted();
      return {
        binary,
        version: null,
        warnings: [
          `${binary} version discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  /** Execute a fresh headless session, rejecting cancellation, limits, and protocol failures. */
  public async invoke(request: HarnessRequest, signal: AbortSignal): Promise<HarnessResponse> {
    signal.throwIfAborted();
    // Validation before launch rejects as configuration, never as a settled effect failure;
    // prepareInvocation applies the same rule to option and output-schema validation.
    if (!isAbsolute(request.cwd))
      throw new ConfigurationError('Harness cwd must be an absolute path.');
    const timeoutMs = request.options.timeoutMs ?? defaultTimeoutMs;
    const binary =
      request.provider === 'claude'
        ? (this.options.claudeBinary ?? 'claude')
        : (this.options.codexBinary ?? 'codex');
    const invocation = await prepareInvocation(request, signal);
    try {
      const result = await runProcess({
        binary,
        args: invocation.args,
        cwd: request.cwd,
        input: request.options.prompt,
        timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        killGraceMs: this.killGraceMs,
        signal,
        ...(request.options.env === undefined ? {} : { env: request.options.env }),
      });
      const outcome =
        request.provider === 'claude'
          ? parseClaude(result.stdout, request.outputSchema !== null)
          : parseCodex(result.stdout);
      if (result.code === 0 && result.signal === null && outcome.kind === 'success')
        return { ...outcome.response, text: invocation.decode(outcome.response.text) };
      throw new HarnessError({
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
    } finally {
      await invocation.dispose();
    }
  }
}
