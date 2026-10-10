import type { AgentDiagnostics } from './agent-stream-model.js';
import type { StepRecord } from './record.js';
import type { RunBudgetStop } from './run-budget.js';

// Subscription rate-limit windows that Claude Code reports in its stream (#156). One pure module
// owns the stored shape, its validation and its formatting, so the stream handler (recording), the
// inspection summary (projection) and the text views (printing) cannot drift apart. The
// `--max-window-utilization` gate (ADR 0053) evaluates a report with `windowStop`; the run budget
// owns the gate itself, and nothing here retries or suspends a run.

/** One rate-limit window as stored: a fraction of the window used and, when reported, its reset. @internal */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- stored as JSON: only an alias keeps the implicit index signature that JsonValue needs
export type RateLimitWindow = {
  /** Fraction of the window already used; Claude reports 0 to 1, and a value above 1 is kept. */
  utilization: number;
  /** Unix epoch seconds at which this window resets, exactly as reported. */
  resetsAt?: number;
};

/**
 * The latest rate-limit event of one attempt, stored under `diagnostics.rateLimit`. Strings are
 * cut to {@link maxRateLimitText} characters and at most {@link maxRateLimitWindows} windows are
 * kept. `resetsAt` is Unix epoch seconds as reported by Claude; only text views convert it.
 * @internal
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- stored as JSON: only an alias keeps the implicit index signature that JsonValue needs
export type RateLimitDiagnostics = {
  /** Native status such as `allowed`, `allowed_warning` or `rejected`; null when unreported. */
  status: string | null;
  /** The window that produced the event, such as `five_hour` or `seven_day`; null when unreported. */
  type: string | null;
  /** Unix epoch seconds of the event's reset time as reported; null when unreported. */
  resetsAt: number | null;
  /** Windows by native name, such as `five_hour` and `seven_day`. */
  windows: Record<string, RateLimitWindow>;
};

/** The latest valid rate-limit report of one harness in a run summary. @internal */
export type RateLimitSummary = RateLimitDiagnostics & {
  /** Step whose attempt carried the report. */
  stepId: string;
  /** Total attempt number of that step. */
  attempt: number;
  /** ISO time the attempt settled, or null for an attempt that never settled. */
  finishedAt: string | null;
};

/** Characters kept of the status, the type and each window name. @internal */
export const maxRateLimitText = 64;

/** Windows kept per event. @internal */
export const maxRateLimitWindows = 8;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | null {
  return typeof value === 'string'
    ? value.slice(0, maxRateLimitText).replace(/\p{Cc}/gu, ' ')
    : null;
}

function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Validate and bound a value in the stored shape. Returns undefined, which keeps any earlier
 * report, when it is not an object or nothing usable survives: no status, type or reset time and
 * no window with a valid utilization. Never throws. @internal
 */
export function normalizeRateLimit(value: unknown): RateLimitDiagnostics | undefined {
  const source = object(value);
  if (!source) return undefined;
  const windows: [string, RateLimitWindow][] = [];
  for (const [name, raw] of Object.entries(object(source['windows']) ?? {})) {
    if (windows.length >= maxRateLimitWindows) break;
    const window = object(raw);
    const utilization = amount(window?.['utilization']);
    if (utilization === null) continue;
    const resetsAt = amount(window?.['resetsAt']);
    windows.push([text(name) ?? '', { utilization, ...(resetsAt === null ? {} : { resetsAt }) }]);
  }
  const result: RateLimitDiagnostics = {
    status: text(source['status']),
    type: text(source['type']),
    resetsAt: amount(source['resetsAt']),
    // fromEntries defines own properties, so a window named `__proto__` stays plain data.
    windows: Object.fromEntries(windows),
  };
  return result.status === null &&
    result.type === null &&
    result.resetsAt === null &&
    windows.length === 0
    ? undefined
    : result;
}

/**
 * Map a Claude `rate_limit_event` line (`rate_limit_info` with `status`, `rateLimitType`,
 * `resetsAt` and `unifiedWindows`) to the stored shape. Other native fields differ between CLI
 * versions and are dropped. Returns undefined for a malformed or empty event. @internal
 */
export function parseClaudeRateLimitEvent(
  data: Record<string, unknown>,
): RateLimitDiagnostics | undefined {
  const info = object(data['rate_limit_info']);
  if (!info) return undefined;
  return normalizeRateLimit({
    status: info['status'],
    type: info['rateLimitType'],
    resetsAt: info['resetsAt'],
    windows: info['unifiedWindows'],
  });
}

/**
 * Read `diagnostics.rateLimit` back, re-validating it because diagnostics are loose records that
 * an older runtime or a custom adapter may have written. @internal
 */
export function readRateLimit(
  diagnostics: AgentDiagnostics | undefined,
): RateLimitDiagnostics | undefined {
  return normalizeRateLimit(diagnostics?.['rateLimit']);
}

// A Map, not an object literal: names such as `constructor` or `toString` must not match inherited
// Object.prototype properties.
const windowLabels: ReadonlyMap<string, string> = new Map([
  ['five_hour', '5h'],
  ['seven_day', '7d'],
]);

/**
 * Format the windows as `5h window 22%, 7d 67%`: the 5h and 7d windows first under those short
 * labels, then any other window by its own name, with the word `window` after the first label.
 * Returns null when there are no windows. @internal
 */
export function formatRateLimitWindows(
  value: Pick<RateLimitDiagnostics, 'windows'>,
): string | null {
  const entries = Object.entries(value.windows);
  const ordered = [
    ...[...windowLabels.keys()].flatMap((name) => entries.filter(([key]) => key === name)),
    ...entries.filter(([name]) => !windowLabels.has(name)),
  ];
  if (ordered.length === 0) return null;
  return ordered
    .map(([name, window], index) => {
      const percent = Math.round(window.utilization * 100);
      return `${windowLabels.get(name) ?? name}${index === 0 ? ' window' : ''} ${String(percent)}%`;
    })
    .join(', ');
}

/** Unix epoch seconds as an ISO time, or null when the date is out of range. */
function iso(seconds: number | null): string | null {
  return seconds === null ? null : isoMs(seconds * 1000);
}

/** Epoch milliseconds as an ISO time, or null when the date is out of range. */
function isoMs(milliseconds: number): string | null {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The parenthetical after the windows: the native status, the type and the ISO form of the
 * reset time, each only when present, as `(allowed_warning; seven_day resets 2026-10-09T...Z)`.
 * Returns an empty string when none is present. @internal
 */
export function formatRateLimitDetail(
  value: Pick<RateLimitDiagnostics, 'status' | 'type' | 'resetsAt'>,
): string {
  const reset = iso(value.resetsAt);
  const when = [value.type, reset === null ? null : `resets ${reset}`]
    .filter((part) => part !== null)
    .join(' ');
  const parts = [value.status, when === '' ? null : when].filter((part) => part !== null);
  return parts.length === 0 ? '' : `(${parts.join('; ')})`;
}

/** One attempt's valid report, keyed by harness and ranked against the others. @internal */
export interface RateLimitCandidate {
  /** Harness the attempt ran on, with the agent summary's fallbacks. */
  readonly harness: string;
  /** `[settled or started ms, started ms, attempt, step seq]`; a greater rank is later. */
  readonly rank: readonly number[];
  /** The report as {@link latestRateLimits} returns it. */
  readonly summary: RateLimitSummary;
}

/**
 * The attempts of one step that {@link latestRateLimits} considers, in history order: none for a
 * fork-reused step or a non-agent kind, and only attempts whose `rateLimit` is valid. @internal
 */
export function rateLimitCandidates(stepId: string, step: StepRecord): RateLimitCandidate[] {
  if (step.reusedFrom) return [];
  if (step.kind !== 'claude' && step.kind !== 'codex' && step.kind !== 'agent') return [];
  const candidates: RateLimitCandidate[] = [];
  for (const attempt of step.attemptHistory ?? []) {
    const report = readRateLimit(attempt.diagnostics);
    if (!report) continue;
    const harness =
      attempt.request?.harness ??
      step.request?.harness ??
      (step.kind === 'agent' ? step.harness : undefined) ??
      step.kind;
    candidates.push({
      harness,
      rank: [
        Date.parse(attempt.finishedAt ?? attempt.startedAt),
        Date.parse(attempt.startedAt),
        attempt.attempt,
        step.seq ?? 0,
      ],
      summary: { stepId, attempt: attempt.attempt, finishedAt: attempt.finishedAt, ...report },
    });
  }
  return candidates;
}

/**
 * The {@link latestRateLimits} projection, folded one step at a time so a caller can keep it as
 * attempts settle instead of rescanning every step. The rank orders distinct attempts of steps
 * with distinct `seq` totally, so the result does not depend on the order steps are observed in
 * (only a full tie between steps without `seq` falls back to the later observation). @internal
 */
export class RateLimitTracker {
  // A Map, so a harness named `constructor` or `__proto__` is plain data.
  readonly #best = new Map<string, RateLimitCandidate>();

  /**
   * Fold every attempt of `step` (undefined for a step that is gone) into the projection.
   * Observing a step again is idempotent, and an attempt whose rank grew (it settled since) replaces
   * its earlier copy. Returns false, folding nothing, when an entry this step holds no longer
   * stands: its attempt lost its report, moved to another harness, left the projection with a kind
   * or reuse change, or its rank fell. Only a full rescan finds that harness's runner-up, so the
   * caller must then discard the tracker.
   */
  public observeStep(stepId: string, step: StepRecord | undefined): boolean {
    const candidates = step ? rateLimitCandidates(stepId, step) : [];
    for (const [harness, held] of this.#best) {
      if (held.summary.stepId !== stepId) continue;
      const fresh = candidates.find(
        (candidate) =>
          candidate.harness === harness && candidate.summary.attempt === held.summary.attempt,
      );
      if (!fresh || compare(fresh.rank, held.rank) < 0) return false;
    }
    for (const candidate of candidates) {
      const previous = this.#best.get(candidate.harness);
      if (previous && compare(candidate.rank, previous.rank) < 0) continue;
      this.#best.set(candidate.harness, candidate);
    }
    return true;
  }

  /** The latest report of `harness`, or undefined when none was observed. */
  public get(harness: string): RateLimitSummary | undefined {
    return this.#best.get(harness)?.summary;
  }

  /** Whether the latest report of any harness came from `stepId`. */
  public holds(stepId: string): boolean {
    for (const { summary } of this.#best.values()) if (summary.stepId === stepId) return true;
    return false;
  }

  /** The projection as a plain record by harness, in first-observation order. */
  public toRecord(): Record<string, RateLimitSummary> {
    return Object.fromEntries([...this.#best].map(([harness, { summary }]) => [harness, summary]));
  }
}

/**
 * For each harness, the attempt with a valid `rateLimit` that settled last (the start time breaks
 * ties and stands in for an attempt that never settled, then the attempt number, then the step's
 * `seq`, so an exact tie between steps goes to the later step). Failed attempts count: a rejected
 * status on a 429 is the most useful report. Fork-reused steps are excluded, as usage excludes
 * them. Harnesses come from the attempt's request and fall back as the agent summary does. Step IDs
 * are unique, as in `Object.entries(record.steps)`. The run budget keeps the same projection
 * incrementally with {@link RateLimitTracker}. @internal
 */
export function latestRateLimits(
  steps: Iterable<readonly [string, StepRecord]>,
): Record<string, RateLimitSummary> {
  const tracker = new RateLimitTracker();
  for (const [stepId, step] of steps) tracker.observeStep(stepId, step);
  return tracker.toRecord();
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (const [index, left] of a.entries()) {
    const right = b[index] ?? 0;
    const delta = (Number.isNaN(left) ? 0 : left) - (Number.isNaN(right) ? 0 : right);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** The window that closes the utilization gate, as {@link windowStop} found it. @internal */
export interface WindowStop {
  /** Native window name, such as `seven_day`. */
  readonly window: string;
  /** Reported utilization of that window; may exceed 1. */
  readonly observed: number;
  /** Unix epoch seconds at which the window resets, as reported; null when unknown. */
  readonly resetsAt: number | null;
  /**
   * Epoch milliseconds at which the window resets (`resetsAt * 1000`, rounded up), or null when
   * the reset is unknown or later than `maxWakeMs`. Null means the run cannot wait for it.
   */
  readonly wakeAt: number | null;
}

/**
 * Evaluate the `--max-window-utilization` gate against one harness's latest report. A window's
 * reset is its own `resetsAt`, or the event's `resetsAt` when the event's `type` names that window.
 * A window whose known reset is at or before `nowMs` has expired and is ignored; a window with an
 * unknown reset never expires. A live window is exceeded when its utilization is not below `limit`,
 * the rule the other run caps use. Without a report or an exceeded window the gate admits
 * (undefined). When any exceeded window has no known reset, the first such window is the stop and
 * has no wake; otherwise the exceeded window with the latest reset is the stop, so the run wakes
 * once every exceeded window has reset. `status` is never consulted. @internal
 */
export function windowStop(
  report: Pick<RateLimitDiagnostics, 'type' | 'resetsAt' | 'windows'> | undefined,
  limit: number,
  nowMs: number,
  maxWakeMs: number,
): WindowStop | undefined {
  if (!report) return undefined;
  let unknown: WindowStop | undefined;
  let latest: (WindowStop & { readonly resetsAt: number }) | undefined;
  for (const [window, value] of Object.entries(report.windows)) {
    const resetsAt = value.resetsAt ?? (report.type === window ? report.resetsAt : null);
    if (resetsAt !== null && resetsAt * 1000 <= nowMs) continue;
    if (value.utilization < limit) continue;
    if (resetsAt === null) {
      unknown ??= { window, observed: value.utilization, resetsAt: null, wakeAt: null };
      continue;
    }
    if (latest && latest.resetsAt >= resetsAt) continue;
    const wake = Math.ceil(resetsAt * 1000);
    latest = {
      window,
      observed: value.utilization,
      resetsAt,
      wakeAt: Number.isSafeInteger(wake) && wake <= maxWakeMs ? wake : null,
    };
  }
  return unknown ?? latest;
}

/** A fraction as a whole percentage, such as `84%`. */
function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}

/** `claude seven_day window at 84% reached --max-window-utilization 0.5`. */
function windowStopSummary(stop: RunBudgetStop): string {
  return `${stop.harness ?? 'agent'} ${stop.window ?? 'rate-limit'} window at ${percent(stop.observed)} reached --max-window-utilization ${String(stop.limit)}`;
}

/**
 * The `run.suspended` message of a run the utilization gate suspended, shared by the runtime's
 * notification and `--events` so both say the same thing; the CLI adds `runId`. @internal
 */
export function windowSuspensionMessage(
  stop: RunBudgetStop,
  nextWakeAt: number | null,
  runId?: string,
): string {
  const wake = nextWakeAt === null ? null : isoMs(nextWakeAt);
  return `Run${runId === undefined ? '' : ` ${runId}`} suspended${wake === null ? '' : ` until ${wake}`}: ${windowStopSummary(stop)}.`;
}

/**
 * The gate's part of a refusal message: which window was at what utilization, and when it resets
 * or that it reported no usable reset time, so the run cannot wait for it. @internal
 */
export function windowStopDescription(stop: RunBudgetStop, wakeAt: number | null): string {
  const reset = wakeAt === null ? null : isoMs(wakeAt);
  return `${windowStopSummary(stop)}; ${
    reset === null
      ? 'the window reported no usable reset time, so the run cannot wait for it'
      : `the window resets at ${reset}`
  }`;
}
