import type { AgentUsage } from './model.js';

/** Terminal failure reported by a harness protocol, independent of process exit status. */
export interface ProtocolFailure {
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
  /** Adapter that performed the invocation. */
  readonly provider: 'claude' | 'codex';
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
  /** Adapter that performed the invocation. */
  public readonly provider: 'claude' | 'codex';
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
        : [
            failure.subtype,
            failure.terminalReason,
            failure.apiStatus === null ? null : `HTTP ${String(failure.apiStatus)}`,
            failure.reason,
          ]
            .filter(Boolean)
            .join(': ');
    super(
      `${details.provider} ${reason} [exit ${exit}]${stderrTail ? `; stderr: ${stderrTail}` : ''}${stdoutTail ? `; stdout tail: ${stdoutTail}` : ''}`,
    );
    this.name = 'HarnessError';
    this.provider = details.provider;
    this.exit = { ...details.exit };
    this.failure = failure;
    this.stderrTail = stderrTail;
    this.stdoutTail = stdoutTail;
    this.usage = failure?.usage ?? details.usage ?? null;
    this.sessionId = failure?.sessionId ?? details.sessionId ?? null;
  }
}
