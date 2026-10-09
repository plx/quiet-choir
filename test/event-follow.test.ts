import { describe, expect, it } from 'vitest';
import {
  recordEventLines,
  type EventFollowCursor,
  type EventFollowStart,
} from '../src/workflow/loader/event-follow.js';
import { EVENT_LINE_MAX_BYTES, type EventLine } from '../src/workflow/loader/event-line.js';
import type { AttemptRecord, RunRecord, StepRecord } from '../src/workflow/runtime/record.js';
import { rootCauseSummary } from '../src/workflow/loader/failure-kind.js';
import type { ErrorKind } from '../src/workflow/runtime/model.js';
import type { ExecutionRecord, RunEvent } from '../src/workflow/runtime/observability-model.js';

/** Fields a test may set, including to undefined to model an older record that lacks them. */
type Loose<T> = { [K in keyof T]?: T[K] | undefined };
const at = (ms: number): string => new Date(Date.UTC(2026, 9, 1, 12, 0, 0, ms)).toISOString();

function execution(n: number, startedAt: number, endedAt: number | null = null): ExecutionRecord {
  return {
    n,
    pid: 1,
    startedAt: at(startedAt),
    endedAt: endedAt === null ? null : at(endedAt),
    outcome: endedAt === null ? 'running' : 'completed',
    error: null,
    errorStack: null,
  };
}
function event(type: RunEvent['type'], ms: number, fields: Partial<RunEvent> = {}): RunEvent {
  return {
    at: at(ms),
    execution: 1,
    type,
    phase: null,
    total: null,
    message: type === 'phase' || type === 'log' ? type : null,
    data: null,
    stepId: null,
    ...fields,
  };
}
function attempt(
  n: number,
  status: AttemptRecord['status'],
  finishedAt: number | null,
  fields: Loose<AttemptRecord> = {},
): AttemptRecord {
  return {
    attempt: n,
    fingerprint: 'f',
    startedAt: at(0),
    finishedAt: finishedAt === null ? null : at(finishedAt),
    status,
    error: status === 'failed' ? 'boom' : null,
    execution: 1,
    durationMs: finishedAt,
    ...fields,
  } as AttemptRecord;
}
function step(history: AttemptRecord[], fields: Loose<StepRecord> = {}): StepRecord {
  return {
    kind: 'step',
    fingerprint: 'f',
    status: 'completed',
    attempts: history.length,
    attemptHistory: history,
    output: null,
    error: null,
    wakeAt: null,
    ...fields,
  } as StepRecord;
}
function record(fields: Partial<RunRecord> = {}): RunRecord {
  return {
    formatVersion: 7,
    id: 'r1',
    workflow: { name: 'w', version: '1', fingerprint: null },
    cwd: '/',
    input: null,
    output: null,
    status: 'running',
    error: null,
    steps: {},
    createdAt: at(0),
    updatedAt: at(0),
    executions: [execution(1, 0)],
    events: [event('run.started', 0)],
    ...fields,
  };
}
const parse = (lines: readonly string[]): EventLine[] =>
  lines.map((line) => JSON.parse(line) as EventLine);
const brief = (lines: readonly string[]): string[] =>
  parse(lines).map(
    (line) =>
      `${line.ev}${line.step === undefined ? '' : ` ${line.step}`}${line.attempt === undefined ? '' : `#${String(line.attempt)}`}`,
  );
function read(
  run: RunRecord,
  start: EventFollowStart = 'all',
  cursor: EventFollowCursor | null = null,
): { lines: readonly string[]; cursor: EventFollowCursor } {
  return recordEventLines(run, cursor, start);
}

describe('recordEventLines derivation', () => {
  it('derives run events, settled attempts and opened questions like --events', () => {
    const run = record({
      status: 'failed',
      executions: [{ ...execution(1, 0, 90), outcome: 'failed', error: 'Step agent failed' }],
      events: [
        event('run.started', 0),
        event('phase', 1, { message: 'review', phase: 'review' }),
        event('log', 2, { message: 'Scanning', data: { count: 2 }, phase: 'review' }),
        event('run.failed', 90, { message: 'Step agent failed', stepId: 'agent' }),
      ],
      steps: {
        local: step([attempt(1, 'completed', 10)], { phase: 'review' }),
        agent: step(
          [
            attempt(1, 'failed', 20),
            attempt(2, 'completed', 30, {
              usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.25 },
            }),
          ],
          { kind: 'claude' },
        ),
        settled: step([attempt(1, 'failed', 40), attempt(2, 'failed', 50)], {
          status: 'settled-failed',
        }),
        cancelled: step([attempt(1, 'cancelled', 60)], { status: 'cancelled' }),
        interrupted: step([attempt(1, 'interrupted', 61), attempt(2, 'running', null)], {
          status: 'running',
        }),
        gate: step([], {
          kind: 'ask',
          status: 'waiting',
          attempts: 1,
          phase: 'review',
          question: {
            request: {
              title: null,
              prompt: 'Ship?',
              details: null,
              choices: [],
              audience: 'human',
              subject: null,
              schema: { type: 'boolean' },
            },
            askedAt: at(70),
            resolution: null,
            rejections: [],
          },
          wait: {
            notifiedAt: Date.parse(at(70)),
          } as StepRecord['wait'],
        }),
      },
    });
    const { lines } = read(run);
    expect(brief(lines)).toEqual([
      'run.started',
      'phase',
      'log',
      'step.completed local',
      'step.failed agent#1',
      'step.completed agent',
      'step.failed settled#1',
      'step.settled settled#2',
      'wait.opened gate',
      'run.failed agent',
    ]);
    const parsed = parse(lines);
    expect(parsed[0]).toEqual({ t: at(0), run: 'r1', ev: 'run.started', msg: 'Run started.' });
    expect(parsed[2]?.msg).toBe('Scanning {"count":2}');
    expect(lines[3]).toBe(
      `{"t":"${at(10)}","run":"r1","ev":"step.completed","step":"local","ms":10,"phase":"review"}`,
    );
    expect(parsed[4]).toMatchObject({
      harness: 'claude',
      attempt: 1,
      errorKind: null,
      retryable: false,
    });
    expect(parsed[4]).not.toHaveProperty('costUsd');
    expect(parsed[5]).toMatchObject({ harness: 'claude', costUsd: 0.25, ms: 30 });
    expect(parsed[5]).not.toHaveProperty('attempt');
    // Keys sorted like the runtime's canonical JSON for the live wait.opened payload.
    expect(parsed[8]?.msg).toBe(
      '{"audience":"human","choices":[],"details":null,"prompt":"Ship?","schema":{"type":"boolean"},"subject":null,"title":null}',
    );
    expect(parsed[8]).not.toHaveProperty('harness');
    expect(parsed[9]).toEqual({
      t: at(90),
      run: 'r1',
      ev: 'run.failed',
      step: 'agent',
      errorKind: null,
      retryable: false,
      ms: 90,
      msg: 'Step agent failed',
    });
  });

  it('omits fields the record cannot supply', () => {
    const run = record({
      steps: {
        legacy: step([attempt(1, 'completed', 5, { durationMs: undefined })]),
        agent: step([attempt(1, 'completed', 6, { usage: null })], {
          kind: 'agent',
          harness: 'codex',
        }),
      },
    });
    const [, legacy, agent] = parse(read(run).lines);
    expect(legacy).toEqual({ t: at(5), run: 'r1', ev: 'step.completed', step: 'legacy' });
    expect(agent).toEqual({
      t: at(6),
      run: 'r1',
      ev: 'step.completed',
      step: 'agent',
      harness: 'codex',
      ms: 6,
    });
  });

  it('carries toolUses per attempt and warnings only for the latest completed attempt', () => {
    const agentCall = { request: { harness: 'claude' } };
    const warning = 'no-tool-use: Profile readonly expects tool use, but it ran none.';
    const run = record({
      steps: {
        retried: step(
          [
            attempt(1, 'failed', 10, { ...agentCall, diagnostics: { toolUses: 3 } }),
            attempt(2, 'completed', 20, { ...agentCall, diagnostics: { toolUses: 0 } }),
          ],
          { kind: 'claude', warnings: [warning] },
        ),
        twice: step(
          [
            attempt(1, 'completed', 30, { ...agentCall, diagnostics: { toolUses: 2 } }),
            attempt(2, 'completed', 40, { ...agentCall, diagnostics: { toolUses: 0 } }),
          ],
          { kind: 'codex', warnings: ['Other', warning] },
        ),
        settled: step([attempt(1, 'failed', 50, { ...agentCall, diagnostics: { toolUses: 7 } })], {
          kind: 'claude',
          status: 'settled-failed',
          warnings: [warning],
        }),
        unknown: step(
          [
            attempt(1, 'completed', 60, { ...agentCall, diagnostics: { toolUses: null } }),
            attempt(2, 'failed', 61, { ...agentCall, diagnostics: { toolUses: -1 } }),
            attempt(3, 'completed', 62),
          ],
          { kind: 'claude', warnings: [] },
        ),
        local: step([attempt(1, 'completed', 70, { diagnostics: { toolUses: 4 } })], {
          warnings: ['not an agent'],
        }),
        waited: step([], { kind: 'ask', finishedAt: at(80) }),
      },
    });
    const lines = parse(read(run).lines).filter((line) => line.ev !== 'run.started');
    const pick = (name: string): Pick<EventLine, 'ev' | 'attempt' | 'toolUses' | 'msg'>[] =>
      lines
        .filter((line) => line.step === name)
        .map(({ ev, attempt, toolUses, msg }) => ({
          ev,
          ...(attempt === undefined ? {} : { attempt }),
          ...(toolUses === undefined ? {} : { toolUses }),
          ...(msg === undefined ? {} : { msg }),
        }));
    expect(pick('retried')).toEqual([
      { ev: 'step.failed', attempt: 1, toolUses: 3, msg: 'boom' },
      { ev: 'step.completed', toolUses: 0, msg: warning },
    ]);
    expect(pick('twice')).toEqual([
      { ev: 'step.completed', toolUses: 2 },
      { ev: 'step.completed', toolUses: 0, msg: `${warning}; Other` },
    ]);
    expect(pick('settled')).toEqual([{ ev: 'step.settled', attempt: 1, toolUses: 7, msg: 'boom' }]);
    expect(pick('unknown')).toEqual([
      { ev: 'step.completed' },
      { ev: 'step.failed', attempt: 2, msg: 'boom' },
      { ev: 'step.completed' },
    ]);
    // Neither field appears on non-agent warnings or history-less steps.
    expect(pick('local')).toEqual([{ ev: 'step.completed' }]);
    expect(pick('waited')).toEqual([{ ev: 'step.completed' }]);
  });

  it('reads toolUses from the recorded request of each attempt, not the current step kind', () => {
    const run = record({
      steps: {
        redefined: step(
          [
            attempt(1, 'failed', 10, {
              request: { harness: 'claude' },
              diagnostics: { toolUses: 3 },
            }),
            attempt(2, 'completed', 20, { diagnostics: { toolUses: 5 } }),
          ],
          { kind: 'local' },
        ),
      },
    });
    const lines = parse(read(run).lines).filter((line) => line.step === 'redefined');
    expect(lines.map(({ ev, toolUses }) => ({ ev, toolUses }))).toEqual([
      { ev: 'step.failed', toolUses: 3 },
      { ev: 'step.completed', toolUses: undefined },
    ]);
  });

  it('skips fork-reused steps and derives history-less settlements from the step', () => {
    const run = record({
      executions: [execution(1, 0, 10), execution(2, 20)],
      steps: {
        reused: step([attempt(1, 'completed', 5)], {
          reusedFrom: {
            runId: 'source',
            stateDir: '/s',
            stepId: 'reused',
            fingerprint: 'f',
            at: at(1),
          },
        }),
        answered: step([], { kind: 'ask', attempts: 1, finishedAt: at(25), durationMs: null }),
        old: step([], { status: 'settled-failed', attempts: 3, finishedAt: at(26) }),
        broken: step([], { status: 'failed', attempts: 2, finishedAt: at(27) }),
        open: step([], { status: 'waiting', finishedAt: null }),
      },
    });
    const all = read(run);
    expect(brief(all.lines)).toEqual([
      'run.started',
      'step.completed answered',
      'step.settled old#3',
      'step.failed broken#2',
    ]);
    // Attributed by time to the execution running when it settled.
    expect(brief(read(run, { afterExecution: 1 }).lines)).toEqual([
      'step.completed answered',
      'step.settled old#3',
      'step.failed broken#2',
    ]);
  });

  it('names a run.suspended message only for the latest execution', () => {
    const suspended = (n: number, ms: number): RunEvent =>
      event('run.suspended', ms, { execution: n });
    const run = record({
      status: 'suspended',
      executions: [execution(1, 0, 10), execution(2, 20, 30)],
      events: [
        event('run.started', 0),
        suspended(1, 10),
        event('run.started', 20, { execution: 2 }),
        suspended(2, 30),
      ],
    });
    const lines = parse(read(run).lines);
    expect(lines[1]).not.toHaveProperty('msg');
    expect(lines[3]?.msg).toBe('Run suspended for external conditions.');
    const interrupted = parse(
      read({ ...run, interruptedBy: { reason: 'Tick timeout reached.', at: at(30) } }).lines,
    );
    expect(interrupted[3]?.msg).toBe('Run interrupted; resumable: Tick timeout reached.');
    const stop = {
      stepId: 'two',
      metric: 'maxWindowUtilization',
      limit: 0.5,
      observed: 0.84,
      at: at(25),
      harness: 'claude',
      window: 'seven_day',
      resetsAt: 1_791_360_000,
    } as const;
    const gated = parse(read({ ...run, budgetStop: stop, nextWakeAt: 1_791_360_000_000 }).lines);
    expect(gated[3]?.msg).toBe(
      'Run suspended until 2026-10-07T08:00:00.000Z: claude seven_day window at 84% reached --max-window-utilization 0.5.',
    );
    // Another cap's stop never suspends, and a resumed run is no longer suspended by the gate.
    const capped = { ...run, budgetStop: { ...stop, metric: 'maxRunAgentAttempts' as const } };
    expect(parse(read(capped).lines)[3]?.msg).toBe('Run suspended for external conditions.');
  });
});

describe('recordEventLines step errors', () => {
  it('writes each failed attempt with its own recorded error as msg', () => {
    const run = record({
      steps: {
        flaky: step(
          [
            attempt(1, 'failed', 10, { error: 'first' }),
            attempt(2, 'failed', 20, { error: 'multi\nline\n    at foo (file.js:1:1)' }),
            attempt(3, 'completed', 30),
          ],
          { status: 'completed' },
        ),
      },
    });
    const lines = parse(read(run).lines).filter((line) => line.step === 'flaky');
    expect(lines.map((line) => [line.ev, line.attempt, line.msg])).toEqual([
      ['step.failed', 1, 'first'],
      ['step.failed', 2, 'multi line'],
      ['step.completed', undefined, undefined],
    ]);
  });

  it('writes the final attempt of a settled failure as step.settled with its error', () => {
    const run = record({
      steps: {
        soft: step(
          [attempt(1, 'failed', 10, { error: 'one' }), attempt(2, 'failed', 20, { error: 'two' })],
          {
            status: 'settled-failed',
          },
        ),
      },
    });
    const lines = parse(read(run).lines).filter((line) => line.step === 'soft');
    expect(lines.map((line) => [line.ev, line.attempt, line.msg])).toEqual([
      ['step.failed', 1, 'one'],
      ['step.settled', 2, 'two'],
    ]);
  });

  it('takes a history-less failure from the step error and omits a missing one', () => {
    const run = record({
      steps: {
        old: step([], {
          status: 'settled-failed',
          attempts: 2,
          finishedAt: at(26),
          error: 'old failure',
        }),
        broken: step([], { status: 'failed', attempts: 1, finishedAt: at(27), error: 'broken' }),
        silent: step([], { status: 'failed', attempts: 1, finishedAt: at(28), error: null }),
        done: step([], { status: 'completed', attempts: 1, finishedAt: at(29), error: 'ignored' }),
      },
    });
    const lines = parse(read(run).lines).filter((line) => line.step !== undefined);
    expect(lines.map((line) => [line.step, line.msg])).toEqual([
      ['old', 'old failure'],
      ['broken', 'broken'],
      ['silent', undefined],
      ['done', undefined],
    ]);
  });

  it('keeps a line with a long error within the byte cap and the msg budget', () => {
    const run = record({
      steps: { big: step([attempt(1, 'failed', 10, { error: 'e'.repeat(2000) })]) },
    });
    const [text] = read(run).lines.filter((line) => line.includes('"step":"big"'));
    expect(Buffer.byteLength(text ?? '')).toBeLessThanOrEqual(EVENT_LINE_MAX_BYTES);
    expect((JSON.parse(text ?? '') as EventLine).msg?.endsWith('…')).toBe(true);
  });
});

describe('recordEventLines failure kinds', () => {
  const failed = (...kinds: (ErrorKind | undefined)[]): AttemptRecord[] =>
    kinds.map((errorKind, index) =>
      attempt(index + 1, 'failed', 10 * (index + 1), {
        errorKind,
      }),
    );
  const pairOf = (line: EventLine | undefined): unknown => [line?.errorKind, line?.retryable];

  it('writes each failed attempt with its own recorded kind and retryable flag', () => {
    const run = record({
      steps: { flaky: step(failed('rate-limit', 'schema', undefined), { status: 'failed' }) },
    });
    const lines = parse(read(run).lines).filter((line) => line.step === 'flaky');
    expect(lines.map((line) => [line.ev, line.attempt, line.errorKind, line.retryable])).toEqual([
      ['step.failed', 1, 'rate-limit', true],
      ['step.failed', 2, 'schema', false],
      ['step.failed', 3, null, false],
    ]);
    expect(read(run).lines[1]).toBe(
      `{"t":"${at(10)}","run":"r1","ev":"step.failed","step":"flaky","attempt":1,"errorKind":"rate-limit","retryable":true,"ms":10,"msg":"boom"}`,
    );
  });

  it('matches the step kind for the last failed attempt and leaves step.settled alone', () => {
    const history = failed('timeout', 'unknown');
    const run = record({
      steps: {
        soft: step(history, { status: 'settled-failed' }),
        hard: step(failed('timeout', 'idle-timeout'), { status: 'failed' }),
      },
    });
    const lines = parse(read(run).lines);
    const soft = lines.filter((line) => line.step === 'soft');
    expect(soft.map((line) => [line.ev, line.errorKind, line.retryable])).toEqual([
      ['step.failed', 'timeout', true],
      ['step.settled', undefined, undefined],
    ]);
    const hard = lines.filter((line) => line.step === 'hard').at(-1);
    expect(pairOf(hard)).toEqual(['idle-timeout', true]);
  });

  it('writes null and false for a failed step without attempt history', () => {
    const run = record({
      steps: {
        broken: step([], { status: 'failed', attempts: 1, finishedAt: at(27), error: 'broken' }),
        old: step([], { status: 'settled-failed', attempts: 1, finishedAt: at(28) }),
        done: step([], { status: 'completed', attempts: 1, finishedAt: at(29) }),
      },
    });
    const lines = parse(read(run).lines);
    expect(lines.find((line) => line.step === 'broken')).toMatchObject({
      ev: 'step.failed',
      errorKind: null,
      retryable: false,
    });
    for (const id of ['old', 'done']) {
      const found = lines.find((line) => line.step === id);
      expect(found).not.toHaveProperty('errorKind');
      expect(found).not.toHaveProperty('retryable');
    }
  });

  it('gives run.failed the root cause kind in the latest execution, as rootCause reports', () => {
    const run = record({
      status: 'failed',
      executions: [{ ...execution(1, 0, 90), outcome: 'failed' }],
      events: [event('run.started', 0), event('run.failed', 90, { stepId: 'a' })],
      rootCause: { stepId: 'a', error: 'boom', errorKind: 'overloaded', effect: null },
      steps: { a: step(failed('overloaded'), { status: 'failed' }) },
    });
    const last = parse(read(run).lines).at(-1);
    expect(last).toMatchObject({ ev: 'run.failed', step: 'a' });
    expect(pairOf(last)).toEqual([rootCauseSummary(run)?.errorKind, true]);
    // An older record without the stored kind falls back through the root step's last attempt.
    const legacy = parse(
      read({ ...run, rootCause: { stepId: 'a', error: 'boom', effect: null } }).lines,
    ).at(-1);
    expect(pairOf(legacy)).toEqual(['overloaded', true]);
  });

  it('writes no pair on run.failed without a root effect', () => {
    const run = record({
      status: 'failed',
      executions: [{ ...execution(1, 0, 90), outcome: 'failed' }],
      events: [event('run.started', 0), event('run.failed', 90)],
      rootCause: { stepId: null, error: 'body', errorKind: null, effect: null },
    });
    const last = parse(read(run).lines).at(-1);
    expect(last).toMatchObject({ ev: 'run.failed' });
    expect(last).not.toHaveProperty('errorKind');
    expect(last).not.toHaveProperty('retryable');
  });

  it('takes an earlier execution run.failed kind from the root step attempt in that execution', () => {
    const run = record({
      status: 'failed',
      executions: [
        { ...execution(1, 0, 50), outcome: 'failed' },
        { ...execution(2, 60, 120), outcome: 'failed' },
      ],
      events: [
        event('run.started', 0),
        event('run.failed', 50, { stepId: 'a' }),
        event('run.started', 60, { execution: 2 }),
        event('run.failed', 120, { execution: 2, stepId: 'b' }),
        event('run.failed', 55, { execution: 1, stepId: 'gone' }),
      ],
      // A later resume replaced the root cause with another step's.
      rootCause: { stepId: 'b', error: 'boom', errorKind: 'schema', effect: null },
      steps: {
        a: step(
          [
            attempt(1, 'failed', 20, { errorKind: 'rate-limit', execution: 1 }),
            attempt(2, 'failed', 40, { errorKind: 'timeout', execution: 1 }),
            attempt(3, 'completed', 80, { execution: 2 }),
          ],
          { status: 'completed' },
        ),
        b: step([attempt(1, 'failed', 100, { errorKind: 'schema', execution: 2 })], {
          status: 'failed',
        }),
      },
    });
    const failures = parse(read(run).lines).filter((line) => line.ev === 'run.failed');
    expect(failures.map((line) => [line.step, line.errorKind, line.retryable])).toEqual([
      ['a', 'timeout', true],
      ['gone', undefined, undefined],
      ['b', 'schema', false],
    ]);
    expect(failures[1]).not.toHaveProperty('errorKind');
  });

  it('omits the pair for an earlier run.failed when the record has no attempt in that execution', () => {
    const run = record({
      status: 'failed',
      executions: [
        { ...execution(1, 0, 50), outcome: 'failed' },
        { ...execution(2, 60, 120), outcome: 'failed' },
      ],
      events: [event('run.started', 0), event('run.failed', 50, { stepId: 'a' })],
      rootCause: null,
      steps: {
        a: step([attempt(1, 'failed', 90, { errorKind: 'timeout', execution: 2 })], {
          status: 'failed',
        }),
      },
    });
    const earlier = parse(read(run).lines).find((line) => line.ev === 'run.failed');
    expect(earlier).toMatchObject({ step: 'a' });
    expect(earlier).not.toHaveProperty('errorKind');
  });

  it('keeps an oversized step.failed line within 512 bytes and keeps the pair', () => {
    const run = record({
      steps: {
        [`${'a/'.repeat(200)}x`]: step(
          [attempt(1, 'failed', 10, { error: 'e'.repeat(2000), errorKind: 'timeout' })],
          { status: 'failed', phase: 'p'.repeat(300) },
        ),
      },
    });
    const [text] = read(run).lines.filter((line) => line.includes('"ev":"step.failed"'));
    expect(Buffer.byteLength(text ?? '')).toBeLessThanOrEqual(EVENT_LINE_MAX_BYTES);
    expect(JSON.parse(text ?? '')).toMatchObject({ errorKind: 'timeout', retryable: true });
  });
});

describe('recordEventLines following', () => {
  it('treats the first read as the baseline by default and prints only later lines', () => {
    const run = record({ steps: { a: step([attempt(1, 'completed', 5)]) } });
    const first = read(run, 'end');
    expect(first.lines).toEqual([]);
    expect(read(run, 'end', first.cursor).lines).toEqual([]);
    run.steps['b'] = step([attempt(1, 'failed', 8)], { status: 'failed' });
    run.events?.push(event('log', 9));
    const second = read(run, 'end', first.cursor);
    expect(brief(second.lines)).toEqual(['step.failed b#1', 'log']);
    expect(read(run, 'end', second.cursor).lines).toEqual([]);
    // A retry of b adds only its new attempt.
    run.steps['b'] = step([attempt(1, 'failed', 8), attempt(2, 'completed', 12)]);
    expect(brief(read(run, 'end', second.cursor).lines)).toEqual(['step.completed b']);
  });

  it('prints everything first with --from-start', () => {
    const run = record({ steps: { a: step([attempt(1, 'completed', 5)]) } });
    const first = read(run, 'all');
    expect(brief(first.lines)).toEqual(['run.started', 'step.completed a']);
    expect(read(run, 'all', first.cursor).lines).toEqual([]);
  });

  it('survives eviction past 500 events without repeating or hiding lines', () => {
    const events = [event('run.started', 0)];
    for (let index = 1; index < 500; index++)
      events.push(event('log', index, { message: `line ${String(index)}` }));
    const run = record({ events });
    const first = read(run, 'all');
    expect(first.lines).toHaveLength(500);
    // The runtime splices the oldest payloads when it appends past the cap.
    const evicted = events.slice(10);
    for (let index = 500; index < 510; index++)
      evicted.push(event('log', index, { message: `line ${String(index)}` }));
    const second = read({ ...run, events: evicted }, 'all', first.cursor);
    expect(parse(second.lines).map((line) => line.msg)).toEqual(
      Array.from({ length: 10 }, (_, offset) => `line ${String(500 + offset)}`),
    );
    // The cursor holds only keys still present in the record.
    expect(second.cursor.seen.size).toBe(500);
    expect(read({ ...run, events: evicted }, 'all', second.cursor).lines).toEqual([]);
  });

  it('counts identical log entries instead of collapsing them', () => {
    const same = (): RunEvent => event('log', 5, { message: 'tick' });
    const run = record({ events: [event('run.started', 0), same(), same()] });
    const first = read(run, 'all');
    expect(brief(first.lines)).toEqual(['run.started', 'log', 'log']);
    run.events?.push(same());
    expect(brief(read(run, 'all', first.cursor).lines)).toEqual(['log']);
  });

  it('prints tolerated poll errors once, before the wait settles and the run ends', () => {
    const tolerated = (wait: string, ms: number, consecutive: number): RunEvent =>
      event('wait.tolerated', ms, {
        stepId: wait,
        phase: 'watch',
        message: 'HTTP 502',
        data: { consecutive, tolerate: 3 },
      });
    const run = record({
      events: [event('run.started', 0), tolerated('ci', 5, 1)],
      steps: {
        ci: step([], { kind: 'wait', status: 'waiting', phase: 'watch', attempts: 1 }),
      },
    });
    const first = read(run);
    expect(parse(first.lines)).toEqual([
      expect.objectContaining({ ev: 'run.started' }),
      {
        t: at(5),
        run: 'r1',
        ev: 'wait.tolerated',
        step: 'ci',
        phase: 'watch',
        msg: 'tolerated 1/3: HTTP 502',
      },
    ]);
    // A later read prints only the new entries; the wait completes in the same millisecond as
    // its second tolerated error, and the run completes after it.
    run.events?.push(tolerated('ci', 9, 2), event('run.completed', 9));
    run.status = 'completed';
    run.executions = [execution(1, 0, 9)];
    run.steps['ci'] = step([], {
      kind: 'wait',
      status: 'completed',
      phase: 'watch',
      attempts: 1,
      finishedAt: at(9),
    });
    const second = read(run, 'all', first.cursor);
    expect(brief(second.lines)).toEqual([
      'wait.tolerated ci',
      'step.completed ci',
      'run.completed',
    ]);
    expect(read(run, 'all', second.cursor).lines).toEqual([]);
  });

  it('keeps identical tolerated errors of two waits at the same time apart', () => {
    const same = (wait: string): RunEvent =>
      event('wait.tolerated', 5, {
        stepId: wait,
        message: 'HTTP 502',
        data: { consecutive: 1, tolerate: 3 },
      });
    const run = record({ events: [event('run.started', 0), same('a'), same('b')] });
    const first = read(run);
    expect(brief(first.lines)).toEqual(['run.started', 'wait.tolerated a', 'wait.tolerated b']);
    expect(first.cursor.seen.size).toBe(3);
    // The wait ID is part of the identity, not only the occurrence count: once the first wait's
    // entry is evicted, the second wait's identical entry is still a new line.
    const only = read(record({ events: [event('run.started', 0), same('a')] }));
    const evicted = read(
      record({ events: [event('run.started', 0), same('b')] }),
      'all',
      only.cursor,
    );
    expect(brief(evicted.lines)).toEqual(['wait.tolerated b']);
  });

  it('prints only later executions with afterExecution, and treats unknown executions as earlier', () => {
    const run = record({
      status: 'completed',
      executions: [execution(1, 0, 10), execution(2, 20, 40)],
      events: [
        event('run.started', 0),
        event('run.suspended', 10),
        event('run.started', 20, { execution: 2 }),
        event('run.completed', 40, { execution: 2 }),
      ],
      steps: {
        old: step([attempt(1, 'completed', 5)]),
        unknown: step([attempt(1, 'completed', 6, { execution: undefined })]),
        retried: step([attempt(1, 'failed', 7), attempt(2, 'completed', 30, { execution: 2 })]),
      },
    });
    expect(brief(read(run, { afterExecution: 1 }).lines)).toEqual([
      'run.started',
      'step.completed retried',
      'run.completed',
    ]);
    expect(brief(read(run, 'all').lines)).toContain('step.completed unknown');
    expect(read(run, { afterExecution: 2 }).lines).toEqual([]);
  });

  it('sorts by time, stably, with run.started first and the latest terminal line last', () => {
    const run = record({
      status: 'completed',
      executions: [execution(1, 0, 10)],
      events: [
        event('log', 0, { message: 'same time as start' }),
        event('run.started', 0),
        // A skewed clock can stamp the terminal event before the last step settles.
        event('run.completed', 9),
      ],
      steps: {
        b: step([attempt(1, 'completed', 10)]),
        a: step([attempt(1, 'completed', 5)]),
        c: step([attempt(1, 'completed', 5)]),
      },
    });
    expect(brief(read(run).lines)).toEqual([
      'run.started',
      'log',
      'step.completed a',
      'step.completed c',
      'step.completed b',
      'run.completed',
    ]);
  });

  it('keeps every line within 512 bytes with an oversized message and step ID', () => {
    const long = `items/${'x'.repeat(300)}`;
    const run = record({
      events: [
        event('run.started', 0),
        event('log', 1, { message: '日本語'.repeat(700), data: { detail: 'y'.repeat(2_000) } }),
        event('run.failed', 2, { stepId: long, message: 'e'.repeat(2_048) }),
      ],
      steps: {
        [long]: step([attempt(1, 'failed', 3)], {
          status: 'failed',
          phase: `phase ${'ü'.repeat(400)}`,
          kind: 'codex',
        }),
      },
    });
    const { lines } = read(run);
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(EVENT_LINE_MAX_BYTES);
      expect(JSON.parse(line)).toHaveProperty('run', 'r1');
    }
  });
});
