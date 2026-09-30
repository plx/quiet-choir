import { brandError, isBranded } from './error-brand.js';
import type { ErrorKind } from './model.js';
import type { ExecDiagnostics, ExecResult } from './exec-model.js';

/** Structured command failure; runtime attempt history retains its bounded diagnostics. */
export class ExecError extends Error {
  static {
    brandError(this, 'ExecError');
  }

  /** Recognize an instance from any quiet-choir module instance, such as a CLI workflow's own import. */
  public static override [Symbol.hasInstance](value: unknown): value is ExecError {
    return isBranded(this, value);
  }

  /** Retry classification. */
  public readonly kind: ErrorKind;
  /** Available process exit/output diagnostics. */
  public readonly diagnostics: ExecDiagnostics;

  public constructor(
    message: string,
    kind: ErrorKind,
    result?: ExecResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExecError';
    this.kind = kind;
    this.diagnostics = {
      code: result?.code ?? null,
      signal: result?.signal ?? null,
      stdoutTail: result?.stdout.slice(-1024) ?? '',
      stderrTail: result?.stderr.slice(-1024) ?? '',
      truncated: result?.truncated ?? false,
      durationMs: result?.durationMs ?? 0,
    };
  }
}
