import { describe, expect, it } from 'vitest';

import { requestedFull, workflowErrorDocument } from '../src/cli/workflow-errors.js';
import { countSteps, summarizeRun } from '../src/workflow/loader/inspection.js';
import { workflowFailure } from '../src/workflow/loader/failure.js';
import { summarizeRunResult } from '../src/workflow/loader/run-result.js';
import type { RehearsalReport } from '../src/workflow/loader/rehearsal.js';
import type { AttemptRecord, RunRecord, StepRecord } from '../src/workflow/runtime/store.js';

const base = {
  formatVersion: 1,
  id: 'run-1',
  status: 'completed',
  workflow: { name: 'test', version: '1', fingerprint: null },
  cwd: '/project',
  input: {},
  output: { answer: 42 },
  error: null,
  steps: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
} satisfies RunRecord;

function step(status: StepRecord['status'], overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    kind: 'agent',
    harness: 'claude',
    fingerprint: 'f',
    status,
    attempts: 1,
    output: null,
    error: null,
    wakeAt: null,
    ...overrides,
  };
}

/** A failed agent step whose last attempt carries `kind`. */
function failedStep(kind: NonNullable<AttemptRecord['errorKind']>): StepRecord {
  return step('failed', {
    error: 'failed',
    attemptHistory: [
      { attempt: 1, status: 'failed', errorKind: 'unknown' },
      { attempt: 2, status: 'failed', errorKind: kind },
    ] as unknown as AttemptRecord[],
  });
}

/** An agent step whose single attempt reported complete usage. */
function agentStep(index: number): StepRecord {
  return step('completed', {
    output: { text: 'x'.repeat(2000), index },
    attemptHistory: [
      {
        attempt: 1,
        status: 'completed',
        request: { harness: 'claude' },
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      },
    ] as unknown as AttemptRecord[],
  });
}

function bigRun(count: number): RunRecord {
  return {
    ...base,
    steps: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`agent-${String(index)}`, agentStep(index)]),
    ),
  };
}

describe('countSteps', () => {
  it('matches the counts summarizeRun reports for a mixed-status record', () => {
    const run: RunRecord = {
      ...base,
      steps: {
        a: step('completed'),
        b: step('completed'),
        c: step('failed'),
        d: step('running'),
        e: step('waiting'),
        f: step('cancelled'),
        g: step('settled-failed'),
        h: step('superseded'),
        i: step('withdrawn'),
      },
    };
    const ownership = { locked: false, owner: null, processes: [], locks: [] };
    expect(countSteps(run)).toEqual({
      total: 9,
      completed: 2,
      failed: 1,
      running: 1,
      waiting: 1,
      cancelled: 1,
      'settled-failed': 1,
      superseded: 1,
      withdrawn: 1,
    });
    expect(countSteps(run)).toEqual(summarizeRun(run, ownership).counts);
  });
});

describe('summarizeRunResult', () => {
  it('returns identity, status, output, usage, counts, root cause and warnings', () => {
    const run = bigRun(3);
    expect(summarizeRunResult(run, '/state')).toEqual({
      runId: 'run-1',
      stateDir: '/state',
      status: 'completed',
      output: { answer: 42 },
      usage: { costUsd: 0.03, attempts: 3, undercounted: false },
      counts: expect.objectContaining({ total: 3, completed: 3 }) as unknown,
      rootCause: null,
      warnings: [],
    });
  });

  it('keeps a recorded root cause and a null state directory', () => {
    const rootCause = { stepId: 'a', error: 'boom', errorKind: 'rate-limit' } as const;
    const run: RunRecord = { ...base, status: 'failed', rootCause };
    const result = summarizeRunResult(run, null);
    expect(result.stateDir).toBeNull();
    expect(result.rootCause).toEqual(rootCause);
  });

  it('reports a null kind for a recorded body failure, even when steps ran', () => {
    const run: RunRecord = {
      ...base,
      status: 'failed',
      steps: { a: failedStep('timeout') },
      rootCause: { stepId: null, error: 'bug', errorKind: null },
    };
    expect(summarizeRunResult(run, null).rootCause).toEqual({
      stepId: null,
      error: 'bug',
      errorKind: null,
    });
  });

  it('falls back to the root step last attempt for a record without a stored kind', () => {
    const run: RunRecord = {
      ...base,
      status: 'failed',
      steps: { a: failedStep('authentication') },
      rootCause: { stepId: 'a', error: 'boom' },
    };
    expect(summarizeRunResult(run, null).rootCause).toEqual({
      stepId: 'a',
      error: 'boom',
      errorKind: 'authentication',
    });
  });

  it.each([
    ['a body failure', { stepId: null, error: 'bug' }, {}],
    ['a root step with no attempt history', { stepId: 'a', error: 'boom' }, { a: step('failed') }],
    ['a root step missing from the record', { stepId: 'gone', error: 'boom' }, {}],
  ])('has no kind without evidence for %s in an older record', (_name, rootCause, steps) => {
    const run: RunRecord = { ...base, status: 'failed', steps, rootCause };
    expect(summarizeRunResult(run, null).rootCause).toEqual({ ...rootCause, errorKind: null });
  });

  it('keeps rootCause null when the run has none', () => {
    expect(summarizeRunResult({ ...base, rootCause: null }, null).rootCause).toBeNull();
    expect(summarizeRunResult(base, null).rootCause).toBeNull();
  });

  it.each([
    ['an attempt without a reported cost', { inputTokens: 1, outputTokens: 1, costUsd: null }],
    ['an attempt without usage', null],
  ])('flags undercounting for %s', (_name, usage) => {
    const run: RunRecord = {
      ...base,
      steps: {
        a: step('completed', {
          attemptHistory: [
            { attempt: 1, status: 'completed', request: { harness: 'claude' }, usage },
          ] as unknown as AttemptRecord[],
        }),
      },
    };
    expect(summarizeRunResult(run, '/state').usage.undercounted).toBe(true);
  });

  it('flags undercounting for legacy attempts that carry no history', () => {
    const run: RunRecord = {
      ...base,
      steps: { a: step('completed', { kind: 'claude', output: null }) },
    };
    const { usage } = summarizeRunResult(run, '/state');
    expect(usage.attempts).toBe(1);
    expect(usage.undercounted).toBe(true);
  });

  it('prefers the invocation warnings the runner returned', () => {
    const run = { ...base, policyWarnings: ['recorded'], warnings: ['invocation'] };
    expect(summarizeRunResult(run, '/state').warnings).toEqual(['invocation']);
  });

  it('otherwise collects the record warnings once each, tolerating legacy records', () => {
    const run = {
      ...base,
      policyWarnings: ['p', 'dup'],
      replayWarnings: ['r', 'dup'],
      harnessWarnings: ['h'],
      worktreeWarnings: ['w'],
      waitWarnings: ['n'],
    };
    expect(summarizeRunResult(run, '/state').warnings).toEqual(['p', 'dup', 'r', 'h', 'w', 'n']);
    expect(summarizeRunResult(base, '/state').warnings).toEqual([]);
  });

  it('caps warnings at 20 plus one overflow note', () => {
    const warnings = Array.from({ length: 27 }, (_, index) => `warning ${String(index)}`);
    const result = summarizeRunResult({ ...base, warnings }, '/state');
    expect(result.warnings).toHaveLength(21);
    expect(result.warnings.slice(0, 20)).toEqual(warnings.slice(0, 20));
    expect(result.warnings[20]).toBe('7 more warnings; use --full or workflow inspect');
  });

  it('serializes a 180-step record to a few kilobytes', () => {
    const run = bigRun(180);
    expect(Buffer.byteLength(JSON.stringify(run))).toBeGreaterThan(300_000);
    const result = summarizeRunResult(run, '/state');
    expect(result.counts.total).toBe(180);
    expect(result.usage.attempts).toBe(180);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8192);
  });
});

describe('workflowErrorDocument', () => {
  const run = bigRun(2);
  const failure = workflowFailure('workflow.failed', 'failed', {
    run: { ...run, status: 'failed' },
    runId: 'run-1',
    stateDir: '/state',
  });

  it('keeps the whole run when no options are given', () => {
    const document = workflowErrorDocument(failure);
    expect(document).toHaveProperty('run', failure.run);
    expect(document).not.toHaveProperty('summary');
  });

  it('replaces the run with a summary when compact', () => {
    const document = workflowErrorDocument(failure, { compact: true });
    expect(document).not.toHaveProperty('run');
    expect(document).toMatchObject({
      kind: 'workflow.error',
      ok: false,
      exitCode: 1,
      runId: 'run-1',
      stateDir: '/state',
      status: 'failed',
      summary: { runId: 'run-1', stateDir: '/state', status: 'failed' },
    });
  });

  it('carries a null summary when no record was readable', () => {
    const document = workflowErrorDocument(workflowFailure('run.not_found', 'missing'), {
      compact: true,
    });
    expect(document).toMatchObject({ status: null, summary: null });
    expect(document).not.toHaveProperty('run');
  });

  it('keeps the run of a rehearsal failure even when compact', () => {
    const rehearsal = { kind: 'workflow.rehearsal' } as unknown as RehearsalReport;
    const document = workflowErrorDocument({ ...failure, rehearsal }, { compact: true });
    expect(document).toHaveProperty('run', failure.run);
    expect(document).toHaveProperty('rehearsal', rehearsal);
    expect(document).not.toHaveProperty('summary');
  });
});

describe('requestedFull', () => {
  it('detects --full before the argument separator only', () => {
    expect(requestedFull(['run', '--json', '--full'])).toBe(true);
    expect(requestedFull(['run', '--json'])).toBe(false);
    expect(requestedFull(['run', '--', '--full'])).toBe(false);
  });
});
