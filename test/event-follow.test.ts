import { describe, expect, it } from 'vitest';
import {
  recordEventLines,
  type EventFollowCursor,
  type EventFollowStart,
} from '../src/workflow/loader/event-follow.js';
import { EVENT_LINE_MAX_BYTES, type EventLine } from '../src/workflow/loader/event-line.js';
import type { AttemptRecord, RunRecord, StepRecord } from '../src/workflow/runtime/record.js';
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
    expect(parsed[4]).toMatchObject({ harness: 'claude', attempt: 1 });
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
