import { brandError, isBranded } from './error-brand.js';
import type { ErrorKind, JsonValue } from './model.js';
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
  /**
   * `exec.json` only: the failed command's stdout parsed as JSON, when it was complete, at most
   * 16384 UTF-8 bytes and valid JSON. Not validated against the success schema.
   */
  public readonly parsed?: JsonValue;

  public constructor(
    message: string,
    kind: ErrorKind,
    result?: ExecResult,
    options?: ErrorOptions & { readonly parsed?: JsonValue | undefined },
  ) {
    super(message, options);
    this.name = 'ExecError';
    this.kind = kind;
    if (options?.parsed !== undefined) this.parsed = options.parsed;
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
