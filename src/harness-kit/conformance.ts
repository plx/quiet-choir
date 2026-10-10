import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRequest, HarnessAdapter } from '../workflow/runtime/harness-model.js';
import type {
  AgentOptions,
  ExecutionPolicy,
  HarnessInvocation,
  HarnessProcess,
  JsonValue,
} from '../workflow/runtime/model.js';
import type { AgentProgress } from '../workflow/runtime/agent-stream-model.js';
import { errorKind } from '../workflow/runtime/step-error.js';
import { groupState } from '../processes/identity.js';

/**
 * Required fake CLI scenarios; do not point this suite at an inference-capable installation. In
 * `progress` the fake emits a burst of at least two progress-producing native events with no delay,
 * then succeeds with `options.text`; the suite's `onProgress` observer throws after recording each
 * event, and the call must still resolve. The adapter must report at least one event.
 */
export type HarnessConformanceCase =
  | 'text'
  | 'structured'
  | 'missing-usage'
  | 'protocol-error'
  | 'nonzero-stdout'
  | 'abort'
  | 'registration-before-input'
  | 'session'
  | 'transcript'
  | 'timeout'
  | 'rate-limit'
  | 'env'
  | 'progress';

/**
 * Absolute paths, in a private per-scenario directory, of the marker files a fake CLI writes so the
 * suite can observe it without parsing the CLI's protocol. A fake may write them in every scenario.
 */
export interface HarnessConformanceProbe {
  /** The scenario's private directory, removed after the scenario. */
  readonly directory: string;
  /** Created by the fake as soon as it starts, before it reads stdin. */
  readonly started: string;
  /** Created by the fake when stdin first yields data or reaches EOF. */
  readonly input: string;
  /** Written by the fake as `JSON.stringify(Object.keys(process.env))` in the env scenario. */
  readonly environment: string;
}

/** One test scenario's fake-backed installation and cleanup. */
export interface HarnessConformanceFixture<O extends AgentOptions> {
  /** Adapter connected only to test resources. */
  readonly adapter: HarnessAdapter<O>;
  /** Durable-shaped request for the scenario. */
  readonly request: AgentRequest<O>;
  /**
   * The exact stdout bytes the fake writes; required in the transcript scenario, where the bytes
   * the adapter delivers to `invocation.onOutput('stdout', ...)` must equal it.
   */
  readonly expectedStdout?: string | Uint8Array;
  /** Release caller-owned files after the invocation settles. */
  readonly dispose?: () => Promise<void>;
}

/** Adapter-specific fixture construction; the shared suite owns contract assertions. */
export interface HarnessConformanceOptions<O extends AgentOptions> {
  /**
   * Construct a fake-backed adapter and request for each scenario. Abort and timeout fakes must
   * remain running until stopped. The probe names the marker files the fake writes. The progress
   * fake emits a burst of native activity (at least two progress-producing events, no delay), then
   * succeeds. Every scenario also checks that `invocation.onProgress` deliveries respect the
   * throttle: after the first `init` event, at most one event per 100 ms.
   */
  readonly fixture: (
    scenario: HarnessConformanceCase,
    probe: HarnessConformanceProbe,
  ) => Promise<HarnessConformanceFixture<O>>;
  /** Expected plain response. */
  readonly text: string;
  /** Native failure reason expected in both protocol and nonzero-exit errors. */
  readonly failureReason: string;
  /** Expected JSON value in the structured response text. */
  readonly structured: JsonValue;
  /**
   * Milliseconds allowed to settle cancellation in the abort scenario; defaults to 2000. The
   * timeout scenario also uses it when {@link HarnessConformanceOptions.timeoutDeadlineMs} is unset.
   */
  readonly abortDeadlineMs?: number;
  /**
   * The timeout scenario's limit in milliseconds, set on both `request.options.timeoutMs` and
   * `invocation.policy.timeoutMs`; defaults to 250.
   */
  readonly timeoutMs?: number;
  /**
   * Milliseconds after `timeoutMs` that the timeout scenario allows the adapter to settle the
   * timed-out call; defaults to `abortDeadlineMs` (2000). It is independent of the abort scenario,
   * which keeps using `abortDeadlineMs`.
   */
  readonly timeoutDeadlineMs?: number;
}

const scenarios: readonly HarnessConformanceCase[] = [
  'text',
  'structured',
  'missing-usage',
  'protocol-error',
  'nonzero-stdout',
  'abort',
  'registration-before-input',
  'session',
  'transcript',
  'timeout',
  'rate-limit',
  'env',
  'progress',
];
/** Host agent-session variables the env scenario sets; none may reach the fake. */
const hostVariables = [
  'CLAUDECODE',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_PLUGIN_DATA',
  'CODEX_COMPANION_SESSION_ID',
  'CODEX_COMPANION_TRANSCRIPT_PATH',
] as const;
/**
 * Minimum gap, in milliseconds, between delivered progress events after the first `init` event. The
 * contract is one event per 100 ms (`createInvocationStream` throttles to it); the 20 ms of
 * slack covers the observer's timestamp lagging the adapter's throttle clock by a synchronous call
 * that a GC pause can stretch. Load only widens gaps, while an unthrottled burst lands within a few
 * milliseconds.
 */
const progressFloorMs = 80;
/** The documented bound the throttle assertion enforces, for its failure message. */
const progressIntervalMs = 100;
/** How long registration waits for the fake's started marker before failing the fixture. */
const startDeadlineMs = 10_000;
/** How long registration is held, after the fake started, while watching for early input. */
const registrationHoldMs = 250;
const pollMs = 10;

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

interface Registration {
  /** Times the lease's release was called. */
  releases: number;
  /** Whether the process group was gone at each release. */
  readonly goneAtRelease: boolean[];
  /** Whether a release happened after invoke settled. */
  releasedLate: boolean;
}

/** What the suite's invocation observed during one scenario. */
class Recording {
  public settled = false;
  public readonly registrations: Registration[] = [];
  public readonly sessions: { readonly id: string; readonly late: boolean }[] = [];
  public readonly stdout: Uint8Array[] = [];
  public readonly progress: { readonly event: AgentProgress; readonly at: number }[] = [];
  /** What the throwing progress observer throws, so a rejection can be traced back to it. */
  public readonly observerFailure = new Error('conformance progress observer failure');
  /** Pending registration holds, awaited before assertions. */
  public readonly holds: Promise<void>[] = [];
  public inputBeforeRegistration = false;
  public fixtureError: string | undefined;

  public constructor(
    private readonly probe: HarnessConformanceProbe,
    private readonly hold: boolean,
    private readonly throwFromProgress: boolean,
  ) {}

  public invocation(
    request: AgentRequest,
    signal: AbortSignal,
    policy: ExecutionPolicy,
  ): HarnessInvocation {
    return {
      runId: 'conformance',
      stepId: request.stepId,
      attempt: request.attempt,
      signal,
      policy,
      sessionId: null,
      transcriptPath: join(this.probe.directory, 'transcript.log'),
      trackProcess: (child) => this.track(child),
      onSession: (id) => {
        this.sessions.push({ id, late: this.settled });
        return Promise.resolve();
      },
      onOutput: (stream, chunk) => {
        if (stream === 'stdout') this.stdout.push(Uint8Array.from(chunk));
        return Promise.resolve();
      },
      onProgress: (event) => {
        this.progress.push({ event, at: performance.now() });
        if (this.throwFromProgress) throw this.observerFailure;
      },
    };
  }

  private track(child: HarnessProcess): Promise<{ release(): Promise<void> }> {
    const registration: Registration = { releases: 0, goneAtRelease: [], releasedLate: false };
    this.registrations.push(registration);
    const lease = {
      release: () => {
        registration.releases++;
        registration.goneAtRelease.push(groupState(child) === 'dead');
        if (this.settled) registration.releasedLate = true;
        return Promise.resolve();
      },
    };
    if (!this.hold || this.registrations.length > 1) return Promise.resolve(lease);
    const held = this.watch().then(() => lease);
    this.holds.push(held.then(() => undefined));
    return held;
  }

  /** Hold the first registration open after the fake starts, noting any input that arrives. */
  private async watch(): Promise<void> {
    const startBy = performance.now() + startDeadlineMs;
    while (!existsSync(this.probe.started)) {
      if (performance.now() > startBy) {
        this.fixtureError = `fixture fake did not create probe.started within ${String(startDeadlineMs)}ms of spawn`;
        return;
      }
      await delay(pollMs);
    }
    const holdUntil = performance.now() + registrationHoldMs;
    for (;;) {
      if (existsSync(this.probe.input)) {
        this.inputBeforeRegistration = true;
        return;
      }
      if (performance.now() >= holdUntil) return;
      await delay(pollMs);
    }
  }
}

/** Rethrow any failure as an AssertionError that names the scenario and keeps the original as cause. */
function named(scenario: HarnessConformanceCase, error: unknown): assert.AssertionError {
  const detail = error instanceof Error ? error.message : String(error);
  const failure = new assert.AssertionError({
    message: `Conformance scenario ${scenario}: ${detail}`,
  });
  failure.cause = error;
  return failure;
}

/** The assertion for a progress-scenario rejection, noting whether the observer's error escaped. */
function progressRejection(error: unknown, marker: Error): assert.AssertionError {
  let escaped = false;
  for (let current: unknown = error, depth = 0; depth < 8; depth++) {
    if (current === marker) escaped = true;
    current = current instanceof Error ? current.cause : undefined;
  }
  const detail = error instanceof Error ? error.message : String(error);
  const failure = new assert.AssertionError({
    message: `Adapter must swallow exceptions thrown by invocation.onProgress, but the call rejected with "${detail}"${escaped ? ' (the observer error escaped)' : ''}.`,
  });
  failure.cause = error;
  return failure;
}

/**
 * Fail when progress was delivered faster than the documented throttle: after the first `init`
 * event, at most one event per 100 ms may reach `invocation.onProgress`.
 */
function assertThrottled(
  progress: readonly { readonly event: AgentProgress; readonly at: number }[],
) {
  const firstInit = progress.findIndex(({ event }) => event.kind === 'init');
  for (let index = 1; index < progress.length; index++) {
    if (index === firstInit) continue;
    const gap = (progress[index]?.at ?? 0) - (progress[index - 1]?.at ?? 0);
    assert.ok(
      gap >= progressFloorMs,
      `Adapter delivered progress events ${String(Math.round(gap))}ms apart; after the first init event at most one event per ${String(progressIntervalMs)} ms may reach invocation.onProgress (createInvocationStream throttles this).`,
    );
  }
}

/**
 * Run portable adapter contract assertions against caller-owned fakes, without a test-framework
 * dependency. Every scenario passes the adapter a recording {@link HarnessInvocation} as its third
 * argument. The env scenario sets host-session variables in `process.env` and restores them
 * afterwards, so do not run this suite concurrently with environment-sensitive code in one process.
 */
export async function assertHarnessConformance<O extends AgentOptions>(
  options: HarnessConformanceOptions<O>,
): Promise<void> {
  for (const scenario of scenarios) {
    const directory = await mkdtemp(join(tmpdir(), 'quiet-choir-conformance-'));
    const probe: HarnessConformanceProbe = {
      directory,
      started: join(directory, 'started'),
      input: join(directory, 'input'),
      environment: join(directory, 'environment.json'),
    };
    const saved = new Map(hostVariables.map((name) => [name, process.env[name]]));
    try {
      if (scenario === 'env')
        for (const name of hostVariables) process.env[name] = `conformance-host-${name}`;
      await runScenario(options, scenario, probe);
    } catch (error) {
      throw named(scenario, error);
    } finally {
      for (const [name, value] of saved)
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function runScenario<O extends AgentOptions>(
  options: HarnessConformanceOptions<O>,
  scenario: HarnessConformanceCase,
  probe: HarnessConformanceProbe,
): Promise<void> {
  const fixture = await options.fixture(scenario, probe);
  const { adapter, dispose } = fixture;
  const timeoutMs = options.timeoutMs ?? 250;
  const request: AgentRequest<O> =
    scenario === 'timeout'
      ? { ...fixture.request, options: { ...fixture.request.options, timeoutMs } }
      : fixture.request;
  const controller = new AbortController();
  const recording = new Recording(
    probe,
    scenario === 'registration-before-input',
    scenario === 'progress',
  );
  const invocation = recording.invocation(
    request,
    controller.signal,
    scenario === 'timeout' ? { timeoutMs } : {},
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const raceDeadline = (ms: number) =>
    new Promise<'deadline'>((resolve) => {
      deadline = setTimeout(() => {
        resolve('deadline');
      }, ms);
    });
  try {
    if (scenario === 'transcript' && fixture.expectedStdout === undefined)
      throw new Error('The fixture must supply expectedStdout for the transcript scenario.');
    const invoked = Promise.resolve().then(() =>
      adapter.invoke(request, controller.signal, invocation),
    );
    const settle = () => {
      recording.settled = true;
    };
    invoked.then(settle, settle);
    if (scenario === 'abort') {
      timer = setTimeout(() => {
        controller.abort(new Error('conformance cancellation'));
      }, 25);
      const result = await Promise.race([
        invoked.then(
          () => 'resolved',
          () => (controller.signal.aborted ? 'aborted' : 'rejected-before-abort'),
        ),
        raceDeadline(options.abortDeadlineMs ?? 2000),
      ]);
      assert.notEqual(
        result,
        'rejected-before-abort',
        'Adapter rejected before cancellation; the abort fixture must stay running until aborted.',
      );
      assert.equal(result, 'aborted', 'Adapter must reject and promptly release work on abort.');
    } else if (scenario === 'timeout') {
      const timeoutDeadlineMs = options.timeoutDeadlineMs ?? options.abortDeadlineMs ?? 2000;
      const result = await Promise.race([
        invoked.then(
          () => ({ outcome: 'resolved' as const }),
          (error: unknown) => ({
            outcome: 'rejected' as const,
            error,
            aborted: controller.signal.aborted,
          }),
        ),
        raceDeadline(timeoutMs + timeoutDeadlineMs),
      ]);
      assert.ok(
        result !== 'deadline',
        `Adapter must enforce the ${String(timeoutMs)}ms timeout from request.options.timeoutMs or invocation.policy.timeoutMs; it was still running ${String(timeoutDeadlineMs)}ms after the timeout.`,
      );
      assert.equal(
        result.outcome,
        'rejected',
        'Adapter must reject a call that exceeds its timeout.',
      );
      assert.equal(result.aborted, false, 'The timeout must not depend on the abort signal.');
      assert.equal(
        errorKind(result.error),
        'timeout',
        `Adapter must report a timeout as error kind 'timeout'.`,
      );
    } else if (scenario === 'rate-limit') {
      const error = await invoked.then(
        () => undefined,
        (cause: unknown) => cause ?? new Error('rejected without a reason'),
      );
      assert.ok(error !== undefined, 'Adapter must reject a native 429 failure.');
      assert.equal(
        errorKind(error),
        'rate-limit',
        `Adapter must classify a native 429 failure as error kind 'rate-limit'.`,
      );
    } else if (scenario === 'protocol-error' || scenario === 'nonzero-stdout') {
      await assert.rejects(
        invoked,
        (error: unknown) => error instanceof Error && error.message.includes(options.failureReason),
        `Adapter must reject ${scenario}, preserving native failure evidence.`,
      );
    } else {
      const result = await (scenario === 'progress'
        ? invoked.catch((error: unknown) => {
            throw progressRejection(error, recording.observerFailure);
          })
        : invoked);
      assert.equal(typeof result.text, 'string');
      assert.ok(
        result.sessionId === null || typeof result.sessionId === 'string',
        'Native session identity must be a string or null.',
      );
      if (scenario === 'structured') assert.deepEqual(JSON.parse(result.text), options.structured);
      else assert.equal(result.text, options.text);
      if (scenario === 'missing-usage') {
        for (const field of ['inputTokens', 'outputTokens', 'costUsd'] as const)
          assert.equal(result.usage?.[field] ?? null, null, `Unavailable ${field} must stay null.`);
      }
      if (scenario === 'session') {
        assert.ok(
          typeof result.sessionId === 'string' && result.sessionId.length > 0,
          'The session fixture must report a native session ID in the response.',
        );
        assert.deepEqual(
          recording.sessions,
          [{ id: result.sessionId, late: false }],
          'Adapter must call invocation.onSession exactly once with the reported session ID before settling.',
        );
      }
      if (scenario === 'progress')
        assert.ok(
          recording.progress.length > 0,
          'The progress fixture must make the fake emit native activity that the adapter reports through invocation.onProgress; no event was delivered, so the swallow check would be vacuous.',
        );
      const expected = fixture.expectedStdout;
      if (scenario === 'transcript' && expected !== undefined)
        assert.ok(
          Buffer.concat(recording.stdout).equals(
            typeof expected === 'string' ? Buffer.from(expected) : Buffer.from(expected),
          ),
          `Adapter must deliver exactly the fake's stdout bytes to invocation.onOutput('stdout', ...).`,
        );
    }
    await Promise.all(recording.holds);
    if (recording.fixtureError !== undefined) throw new Error(recording.fixtureError);
    assert.ok(
      recording.sessions.length <= 1,
      'Adapter must call invocation.onSession at most once.',
    );
    assertThrottled(recording.progress);
    if (scenario === 'registration-before-input') {
      await invoked.then(
        () => undefined,
        () => undefined,
      );
      assert.ok(
        recording.registrations.length > 0,
        'Adapter never called invocation.trackProcess for its spawned process.',
      );
      assert.ok(
        !recording.inputBeforeRegistration,
        'Adapter sent input before invocation.trackProcess resolved; register the process before writing stdin.',
      );
      for (const registration of recording.registrations) {
        assert.equal(
          registration.releases,
          1,
          'Adapter must call release() exactly once for each registered process.',
        );
        assert.ok(!registration.releasedLate, 'Adapter must release its process before settling.');
        assert.ok(
          registration.goneAtRelease.every(Boolean),
          'Adapter released its process registration before the process group was reaped.',
        );
      }
    }
    if (scenario === 'env') {
      assert.ok(
        existsSync(probe.environment),
        'The env fixture must write its environment names to probe.environment.',
      );
      const names = JSON.parse(await readFile(probe.environment, 'utf8')) as unknown;
      assert.ok(
        Array.isArray(names),
        'probe.environment must hold a JSON array of environment names.',
      );
      const leaked = hostVariables.filter((name) => names.includes(name));
      assert.deepEqual(
        leaked,
        [],
        `Adapter leaked host-session environment to the fake: ${leaked.join(', ')}.`,
      );
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(deadline);
    controller.abort();
    await dispose?.();
  }
}
