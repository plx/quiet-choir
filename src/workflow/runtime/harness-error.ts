import { brandError, isBranded } from './error-brand.js';
import type { AgentUsage, ErrorKind } from './model.js';
import type { AgentDiagnostics } from './agent-stream-model.js';

/**
 * Evidence an adapter attaches to an error it rethrows unchanged, such as a cancellation or an
 * infrastructure failure, so the runtime still records what the native call reported.
 */
export interface HarnessEvidence {
  /** Native session or thread identifier, or null when none was observed. */
  readonly sessionId: string | null;
  /** Usage reported before the failure, or null when unknown. */
  readonly usage: AgentUsage | null;
  /** Extensible bounded native diagnostics. */
  readonly diagnostics: AgentDiagnostics;
  /** Response text retained as evidence; bound it with {@link boundedResponse}. */
  readonly rawText: string | null;
  /** Whether `rawText` was cut to its evidence budget. */
  readonly responseTruncated: boolean;
}
/**
 * Evidence lives on a registry-symbol property, or for a frozen error in a registry-global
 * `WeakMap`, so the host reads what another quiet-choir module instance (a CLI workflow's own
 * import) attached, and the reverse. See ADR 0028.
 */
const evidenceKey = Symbol.for('quiet-choir.evidence');
const frozenEvidenceKey = Symbol.for('quiet-choir.frozenEvidence');

/**
 * The process-wide store of evidence for non-extensible errors. It is created only on a write, and
 * a value that is not a `WeakMap` (another version, foreign code) is ignored, never replaced.
 */
function frozenEvidenceStore(create: boolean): WeakMap<object, HarnessEvidence> | undefined {
  const scope = globalThis as unknown as Record<symbol, unknown>;
  if (create) scope[frozenEvidenceKey] ??= new WeakMap<object, HarnessEvidence>();
  const store = scope[frozenEvidenceKey];
  return store instanceof WeakMap ? (store as WeakMap<object, HarnessEvidence>) : undefined;
}

/**
 * Bound response evidence to 256 KiB without splitting a UTF-8 sequence. Returns the retained text
 * and whether it was truncated, ready to spread into {@link HarnessEvidence}.
 */
export function boundedResponse(text: string | null): {
  /** The retained text, or null when `text` was null. */
  rawText: string | null;
  /** Whether the text was cut to 256 KiB. */
  responseTruncated: boolean;
} {
  if (text === null) return { rawText: null, responseTruncated: false };
  const bytes = Buffer.from(text);
  if (bytes.length <= 262_144) return { rawText: text, responseTruncated: false };
  let end = 262_144;
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end--;
  return { rawText: bytes.subarray(0, end).toString('utf8'), responseTruncated: true };
}

/**
 * Attach native evidence to an error that must propagate unchanged, such as a cancellation, so its
 * identity and handling are kept while the runtime still records the session, usage and response.
 * Evidence is readable across quiet-choir module instances, frozen errors included; non-objects
 * are ignored.
 */
export function attachHarnessEvidence(error: unknown, value: HarnessEvidence): void {
  if (typeof error !== 'object' || error === null) return;
  const attached = Reflect.defineProperty(error, evidenceKey, {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  if (!attached) frozenEvidenceStore(true)?.set(error, value);
}

/** Read adapter evidence without inferring error handling from cause chains. @internal */
export function harnessEvidence(error: unknown): HarnessEvidence | undefined {
  if (error instanceof HarnessError)
    return {
      sessionId: error.sessionId,
      usage: error.usage,
      diagnostics: error.diagnostics,
      rawText: error.rawText,
      responseTruncated: error.responseTruncated,
    };
  if (typeof error !== 'object' || error === null) return undefined;
  if (Object.hasOwn(error, evidenceKey))
    return Reflect.get(error, evidenceKey) as HarnessEvidence | undefined;
  return frozenEvidenceStore(false)?.get(error);
}

/** Terminal failure reported by a harness protocol, independent of process exit status. */
export interface ProtocolFailure {
  /** Agent turns reported by the terminal envelope. */
  readonly turns?: number;
  /** Count of denied tool requests reported by the envelope. */
  readonly permissionDenials?: number;
  /** Human-readable cause, including unwrapped API error messages. */
  readonly reason: string;
  /** Harness result subtype or terminal event name. */
  readonly subtype: string | null;
  /** Harness termination category, when available. */
  readonly terminalReason: string | null;
  /** HTTP status reported by the API, when available. */
  readonly apiStatus: number | null;
  /** Native session identifier for diagnostics. */
  readonly sessionId: string | null;
  /** Reported usage, including spend incurred before a failure. */
  readonly usage: AgentUsage | null;
  /**
   * Adapter-owned classification when protocol metadata such as `apiStatus` is insufficient, for
   * example a provider's own fixed rate-limit phrasing. It takes precedence over the status mapping.
   */
  readonly kind?: ErrorKind;
}

/** Process termination metadata, separate from protocol success or failure. */
export interface HarnessExit {
  /** Exit code, or null when terminated by a signal. */
  readonly code: number | null;
  /** Terminating signal, or null for an ordinary exit. */
  readonly signal: string | null;
}

/** Diagnostics supplied by an adapter when an invocation fails. */
export interface HarnessErrorDetails {
  /** Extensible bounded native diagnostics. */
  readonly diagnostics?: AgentDiagnostics;
  /** Rejected response, retained up to 256 KiB. */
  readonly rawText?: string | null;
  /** Preserve truncation when forwarding already bounded response evidence. */
  readonly responseTruncated?: boolean;
  /** Reported turns from an otherwise successful envelope followed by a process failure. */
  readonly turns?: number;
  /** Reported denial count from an otherwise successful envelope followed by a process failure. */
  readonly permissionDenials?: number;
  /**
   * Explicit adapter category when protocol metadata alone is insufficient. It wins over
   * `failure.kind`, which wins over the HTTP status and terminal-reason mapping.
   */
  readonly kind?: ErrorKind;
  /** Adapter that performed the invocation. */
  readonly harness: string;
  /** Observed process termination. */
  readonly exit: HarnessExit;
  /** Parsed protocol failure, or null for an invalid/missing protocol or exit-only failure. */
  readonly failure: ProtocolFailure | null;
  /** Protocol parsing or process failure explanation. */
  readonly reason: string;
  /** Captured stderr; only the final 1024 characters are retained. */
  readonly stderr: string;
  /** Captured stdout; only the final 1024 characters are retained for unparsed failures. */
  readonly stdout: string;
  /** Usage from a successful envelope followed by a failing process exit. */
  readonly usage?: AgentUsage;
  /** Session from a successful envelope followed by a failing process exit. */
  readonly sessionId?: string | null;
}

/** A failed harness invocation with bounded diagnostics and recoverable usage metadata. */
export class HarnessError extends Error {
  static {
    brandError(this, 'HarnessError');
  }

  /** Recognize an instance from any quiet-choir module instance, such as a CLI workflow's own import. */
  public static override [Symbol.hasInstance](value: unknown): value is HarnessError {
    return isBranded(this, value);
  }

  /** Extensible bounded native diagnostics. */
  public readonly diagnostics: AgentDiagnostics;
  /** Rejected response, retained up to 256 KiB. */
  public readonly rawText: string | null;
  /** Whether the rejected response exceeded its 256 KiB evidence budget. */
  public readonly responseTruncated: boolean;
  /** Reported turns, or null when unavailable. */
  public readonly turns: number | null;
  /** Reported denied requests, or null when unavailable. */
  public readonly permissionDenials: number | null;
  /** Structured failure category for settled outcomes and selective retries. */
  public readonly kind: ErrorKind;
  /** Adapter that performed the invocation. */
  public readonly harness: string;
  /** Observed process termination. */
  public readonly exit: HarnessExit;
  /** Parsed terminal failure, when available. */
  public readonly failure: ProtocolFailure | null;
  /** Bounded stderr diagnostic tail, never preferred over a protocol reason. */
  public readonly stderrTail: string;
  /** Bounded stdout diagnostic tail for failures without a parsed terminal failure. */
  public readonly stdoutTail: string;
  /** Reported usage, including failed-call spend. */
  public readonly usage: AgentUsage | null;
  /** Native session identifier, when available. */
  public readonly sessionId: string | null;

  /** Construct an error from process and protocol diagnostics. */
  public constructor(details: HarnessErrorDetails) {
    const failure = details.failure;
    const stderrTail = details.stderr.trim().slice(-1024);
    const stdoutTail = failure === null ? details.stdout.trim().slice(-1024) : '';
    const exit = details.exit.signal ?? `code ${String(details.exit.code)}`;
    const reason =
      failure === null
        ? details.reason
        : (() => {
            // A `success` subtype paired with `is_error: true` is not a success; never label the
            // message with it. Fall back to a generic "error" label when nothing else describes it.
            const label = [
              failure.subtype === 'success' ? null : failure.subtype,
              failure.terminalReason,
              failure.apiStatus === null ? null : `HTTP ${String(failure.apiStatus)}`,
            ].filter(Boolean);
            return [...(label.length > 0 ? label : ['error']), failure.reason]
              .filter(Boolean)
              .join(': ');
          })();
    super(
      `${details.harness} ${reason} [exit ${exit}]${stderrTail ? `; stderr: ${stderrTail}` : ''}${stdoutTail ? `; stdout tail: ${stdoutTail}` : ''}`,
    );
    this.name = 'HarnessError';
    this.diagnostics = details.diagnostics ?? {};
    const response = boundedResponse(details.rawText ?? null);
    this.rawText = response.rawText;
    this.responseTruncated = details.responseTruncated === true || response.responseTruncated;
    this.turns = failure?.turns ?? details.turns ?? null;
    this.permissionDenials = failure?.permissionDenials ?? details.permissionDenials ?? null;
    this.kind = details.kind ?? failure?.kind ?? protocolErrorKind(failure);
    this.harness = details.harness;
    this.exit = { ...details.exit };
    this.failure = failure;
    this.stderrTail = stderrTail;
    this.stdoutTail = stdoutTail;
    this.usage = failure?.usage ?? details.usage ?? null;
    this.sessionId = failure?.sessionId ?? details.sessionId ?? null;
  }
}

function protocolErrorKind(failure: ProtocolFailure | null): ErrorKind {
  if (failure === null) return 'protocol';
  if (failure.apiStatus === 429) return 'rate-limit';
  if (failure.apiStatus === 401) return 'authentication';
  if (failure.apiStatus === 403) return 'permission';
  if (failure.apiStatus === 408 || failure.apiStatus === 504) return 'timeout';
  if (failure.apiStatus !== null && [400, 404, 422].includes(failure.apiStatus))
    return 'invalid-request';
  if (failure.apiStatus !== null && [500, 502, 503, 529].includes(failure.apiStatus))
    return 'overloaded';
  const reasons = [failure.subtype, failure.terminalReason];
  if (reasons.includes('error_max_turns') || reasons.includes('max_turns')) return 'turn-limit';
  if (reasons.includes('error_max_budget_usd') || reasons.includes('budget_exhausted'))
    return 'budget-limit';
  return 'unknown';
}
