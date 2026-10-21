import { brandError, isBranded } from './error-brand.js';
import type { ErrorKind, JsonValue } from './model.js';

/** Raw response evidence kept on a failed decision attempt. */
const maxRawTextBytes = 256 * 1024;

/** Details of a {@link DecisionError}. */
export interface DecisionErrorDetails {
  /** Provider name. */
  readonly provider: string;
  /** Failure category for retry and settled outcomes; `configuration` is recorded as `unknown`. */
  readonly kind: ErrorKind;
  /** HTTP status, or null when there was no response. */
  readonly status?: number | null;
  /** Human explanation; never include credentials. */
  readonly message: string;
  /** The response body, retained up to 256 KiB as evidence. */
  readonly rawText?: string | null;
  /** Validation issues of a rejected response. */
  readonly issues?: readonly JsonValue[];
}

/**
 * A decision provider failure: an HTTP error, a timeout or a response that failed validation.
 * `kind` drives retry filtering (`rate-limit` and `overloaded` are transient). Recognized across
 * quiet-choir module instances, like `HarnessError`.
 */
export class DecisionError extends Error {
  static {
    brandError(this, 'DecisionError');
  }

  /** Recognize an instance from any quiet-choir module instance, such as a CLI workflow's own import. */
  public static override [Symbol.hasInstance](value: unknown): value is DecisionError {
    return isBranded(this, value);
  }

  /** Provider name. */
  public readonly provider: string;
  /** Structured failure category. */
  public readonly kind: ErrorKind;
  /** HTTP status, or null when there was no response. */
  public readonly status: number | null;
  /** The response body, retained up to 256 KiB, or null. */
  public readonly rawText: string | null;
  /** Whether the response body exceeded its 256 KiB evidence budget. */
  public readonly responseTruncated: boolean;
  /** Validation issues of a rejected response, when any. */
  public readonly issues: readonly JsonValue[] | undefined;

  /** Construct an error from the provider, kind and evidence. */
  public constructor(details: DecisionErrorDetails) {
    super(`Decision provider ${details.provider}: ${details.message}`);
    this.name = 'DecisionError';
    this.provider = details.provider;
    this.kind = details.kind;
    this.status = details.status ?? null;
    const raw = details.rawText ?? null;
    const bytes = raw === null ? null : new TextEncoder().encode(raw);
    this.responseTruncated = bytes !== null && bytes.length > maxRawTextBytes;
    this.rawText =
      raw === null || bytes === null || !this.responseTruncated
        ? raw
        : new TextDecoder().decode(bytes.slice(0, maxRawTextBytes)).replace(/�$/u, '');
    this.issues = details.issues;
  }
}
