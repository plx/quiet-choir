import { describe, expect, it } from 'vitest';
import {
  formatRateLimitDetail,
  formatRateLimitWindows,
  latestRateLimits,
  maxRateLimitText,
  maxRateLimitWindows,
  normalizeRateLimit,
  parseClaudeRateLimitEvent,
  RateLimitTracker,
  readRateLimit,
  type RateLimitDiagnostics,
} from '../src/workflow/runtime/rate-limit.js';
import type { StepRecord } from '../src/workflow/runtime/record.js';

const event = (info: unknown) => ({ type: 'rate_limit_event', rate_limit_info: info });

// Claude Code 2.1.286, from test/fixtures/harness/claude-rate-limit-success.json.
const current = {
  status: 'allowed_warning',
  resetsAt: 1791360000,
  rateLimitType: 'seven_day',
  utilization: 0.84,
  isUsingOverage: false,
  surpassedThreshold: 0.75,
  unifiedWindows: {
    five_hour: { utilization: 0.01, resetsAt: 1791014400 },
    seven_day: { utilization: 0.84, resetsAt: 1791360000 },
  },
};
// Claude Code 2.1.285, as quoted in #156: no per-window reset, an overageStatus field.
const earlier = {
  status: 'allowed',
  resetsAt: 1790742600,
  rateLimitType: 'five_hour',
  overageStatus: 'rejected',
  unifiedWindows: { five_hour: { utilization: 0.22 }, seven_day: { utilization: 0.67 } },
};

describe('parseClaudeRateLimitEvent', () => {
  it('stores the 2.1.286 shape and drops the other native fields', () => {
    expect(parseClaudeRateLimitEvent(event(current))).toEqual({
      status: 'allowed_warning',
      type: 'seven_day',
      resetsAt: 1791360000,
      windows: {
        five_hour: { utilization: 0.01, resetsAt: 1791014400 },
        seven_day: { utilization: 0.84, resetsAt: 1791360000 },
      },
    });
  });

  it('stores the 2.1.285 shape, whose windows carry no reset', () => {
    expect(parseClaudeRateLimitEvent(event(earlier))).toEqual({
      status: 'allowed',
      type: 'five_hour',
      resetsAt: 1790742600,
      windows: { five_hour: { utilization: 0.22 }, seven_day: { utilization: 0.67 } },
    });
  });

  it.each([
    ['a missing rate_limit_info', { type: 'rate_limit_event' }],
    ['a null rate_limit_info', event(null)],
    ['a string rate_limit_info', event('allowed')],
    ['an array rate_limit_info', event([current])],
    ['an empty rate_limit_info', event({})],
    ['unusable fields only', event({ status: 1, rateLimitType: {}, resetsAt: 'soon' })],
    ['an array of windows', event({ unifiedWindows: [{ utilization: 0.5 }] })],
    ['windows without a valid utilization', event({ unifiedWindows: { five_hour: {} } })],
  ])('ignores %s', (_name, data) => {
    expect(parseClaudeRateLimitEvent(data)).toBeUndefined();
  });

  it('keeps a status-only event, which still says whether the call was rejected', () => {
    expect(parseClaudeRateLimitEvent(event({ status: 'rejected' }))).toEqual({
      status: 'rejected',
      type: null,
      resetsAt: null,
      windows: {},
    });
  });

  it('nulls non-finite and negative numbers and drops a window with an invalid utilization', () => {
    const parsed = parseClaudeRateLimitEvent(
      event({
        status: 'allowed',
        resetsAt: -1,
        unifiedWindows: {
          five_hour: { utilization: '0.5' },
          seven_day: { utilization: -0.1 },
          month: { utilization: Number.NaN },
          year: { utilization: Infinity },
          ok: { utilization: 0.5, resetsAt: -5 },
          also: { utilization: 0, resetsAt: Number.POSITIVE_INFINITY },
          over: { utilization: 1.5, resetsAt: 7 },
        },
      }),
    );
    expect(parsed).toEqual({
      status: 'allowed',
      type: null,
      resetsAt: null,
      windows: {
        ok: { utilization: 0.5 },
        also: { utilization: 0 },
        over: { utilization: 1.5, resetsAt: 7 },
      },
    });
  });

  it('bounds strings, window names and the window count, and replaces control characters', () => {
    const long = 'x'.repeat(500);
    const windows = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`${String(index)}${long}`, { utilization: 0.5 }]),
    );
    const parsed = parseClaudeRateLimitEvent(
      event({ status: long, rateLimitType: `a\u0000b\nc${long}`, unifiedWindows: windows }),
    );
    expect(parsed?.status).toBe('x'.repeat(maxRateLimitText));
    expect(parsed?.type).toBe('a b c' + 'x'.repeat(maxRateLimitText - 5));
    expect(Object.keys(parsed?.windows ?? {})).toHaveLength(maxRateLimitWindows);
    for (const name of Object.keys(parsed?.windows ?? {}))
      expect(name.length).toBeLessThanOrEqual(maxRateLimitText);
  });

  it('keeps a window named __proto__ as plain data', () => {
    const info = JSON.parse(
      '{"status":"allowed","unifiedWindows":{"__proto__":{"utilization":0.5}}}',
    ) as unknown;
    const parsed = parseClaudeRateLimitEvent(event(info));
    expect(Object.keys(parsed?.windows ?? {})).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(parsed?.windows)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(parsed)) as unknown).toEqual(parsed);
  });

  it('never throws on hostile input', () => {
    for (const info of [undefined, 0, true, [], Symbol.for('x'), () => 1, { unifiedWindows: null }])
      expect(() => parseClaudeRateLimitEvent(event(info))).not.toThrow();
  });
});

describe('normalizeRateLimit and readRateLimit', () => {
  const stored: RateLimitDiagnostics = {
    status: 'allowed',
    type: 'five_hour',
    resetsAt: 5,
    windows: { five_hour: { utilization: 0.2, resetsAt: 6 } },
  };

  it('round-trips a stored value', () => {
    expect(normalizeRateLimit(stored)).toEqual(stored);
    expect(readRateLimit({ rateLimit: stored })).toEqual(stored);
  });

  it.each([undefined, null, 'x', 3, [], {}, { windows: 'x' }, { windows: {} }])(
    'treats %j as no report',
    (value) => {
      expect(normalizeRateLimit(value)).toBeUndefined();
      expect(readRateLimit({ rateLimit: value as never })).toBeUndefined();
    },
  );

  it('re-bounds loose diagnostics written by another adapter', () => {
    const loose = {
      status: 'ok',
      windows: { a: { utilization: 'high' }, b: { utilization: 0.4 } },
      junk: 1,
    };
    expect(readRateLimit({ rateLimit: loose })).toEqual({
      status: 'ok',
      type: null,
      resetsAt: null,
      windows: { b: { utilization: 0.4 } },
    });
    expect(readRateLimit(undefined)).toBeUndefined();
    expect(readRateLimit({})).toBeUndefined();
  });
});

describe('formatRateLimitWindows', () => {
  const windows = (value: Record<string, number>): Pick<RateLimitDiagnostics, 'windows'> => ({
    windows: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, { utilization: v }])),
  });

  it('prints 5h and 7d first with the word window after the first label', () => {
    expect(formatRateLimitWindows(windows({ seven_day: 0.67, five_hour: 0.22 }))).toBe(
      '5h window 22%, 7d 67%',
    );
    expect(formatRateLimitWindows(windows({ five_hour: 0.01, seven_day: 0.84 }))).toBe(
      '5h window 1%, 7d 84%',
    );
  });

  it('puts other windows after the known ones, in insertion order, under their own names', () => {
    expect(formatRateLimitWindows(windows({ opus: 0.5, seven_day: 0.1, sonnet: 0.25 }))).toBe(
      '7d window 10%, opus 50%, sonnet 25%',
    );
    expect(formatRateLimitWindows(windows({ opus: 0.5 }))).toBe('opus window 50%');
  });

  it('treats names that exist on Object.prototype as ordinary windows', () => {
    const report = normalizeRateLimit({
      windows: {
        constructor: { utilization: 0.1 },
        toString: { utilization: 0.2 },
        ['__proto__']: { utilization: 0.3 },
      },
    });
    expect(formatRateLimitWindows(report ?? { windows: {} })).toBe(
      'constructor window 10%, toString 20%, __proto__ 30%',
    );
    const mixed = normalizeRateLimit({
      windows: { constructor: { utilization: 0.5 }, five_hour: { utilization: 0.22 } },
    });
    expect(formatRateLimitWindows(mixed ?? { windows: {} })).toBe('5h window 22%, constructor 50%');
    const only = normalizeRateLimit({ windows: { constructor: { utilization: 0.4 } } });
    expect(formatRateLimitWindows(only ?? { windows: {} })).toBe('constructor window 40%');
  });

  it('rounds to a whole percent and keeps values above 100%', () => {
    expect(formatRateLimitWindows(windows({ five_hour: 0.004, seven_day: 1.234 }))).toBe(
      '5h window 0%, 7d 123%',
    );
    expect(formatRateLimitWindows(windows({ five_hour: 0.995 }))).toBe('5h window 100%');
  });

  it('returns null without windows', () => {
    expect(formatRateLimitWindows({ windows: {} })).toBeNull();
  });
});

describe('formatRateLimitDetail', () => {
  it('shows status, type and the ISO reset time, each only when present', () => {
    expect(
      formatRateLimitDetail({ status: 'allowed_warning', type: 'seven_day', resetsAt: 1791360000 }),
    ).toBe('(allowed_warning; seven_day resets 2026-10-07T08:00:00.000Z)');
    expect(formatRateLimitDetail({ status: 'allowed', type: null, resetsAt: 0 })).toBe(
      '(allowed; resets 1970-01-01T00:00:00.000Z)',
    );
    expect(formatRateLimitDetail({ status: null, type: 'five_hour', resetsAt: null })).toBe(
      '(five_hour)',
    );
    expect(formatRateLimitDetail({ status: 'rejected', type: null, resetsAt: null })).toBe(
      '(rejected)',
    );
    expect(formatRateLimitDetail({ status: null, type: null, resetsAt: null })).toBe('');
  });

  it('omits a reset time that is not a date', () => {
    expect(formatRateLimitDetail({ status: 'allowed', type: null, resetsAt: 1e300 })).toBe(
      '(allowed)',
    );
  });
});

describe('latestRateLimits', () => {
  const report = (utilization: number, status = 'allowed') => ({
    rateLimit: { status, type: null, resetsAt: null, windows: { five_hour: { utilization } } },
  });
  const attempt = (
    n: number,
    at: string | null,
    diagnostics: unknown,
    extra: Record<string, unknown> = {},
  ) => ({
    attempt: n,
    startedAt: '2026-10-01T00:00:00.000Z',
    finishedAt: at,
    status: 'completed',
    request: { harness: 'claude' },
    diagnostics,
    ...extra,
  });
  const step = (kind: string, attempts: unknown[], extra: Record<string, unknown> = {}) =>
    ({
      kind,
      attempts: attempts.length,
      attemptHistory: attempts,
      ...extra,
    }) as unknown as StepRecord;
  const run = (...steps: StepRecord[]): [string, StepRecord][] =>
    steps.map((value, index) => [`s${String(index)}`, value]);

  it('is empty without any report', () => {
    expect(
      latestRateLimits(run(step('claude', [attempt(1, '2026-10-01T00:01:00.000Z', {})]))),
    ).toEqual({});
    expect(latestRateLimits([])).toEqual({});
  });

  it('takes the report that settled last, whatever the step order, failed attempts included', () => {
    const result = latestRateLimits(
      run(
        step('claude', [
          attempt(1, '2026-10-01T00:05:00.000Z', report(0.2)),
          attempt(2, '2026-10-01T00:06:00.000Z', report(0.9, 'rejected'), { status: 'failed' }),
        ]),
        step('claude', [attempt(1, '2026-10-01T00:02:00.000Z', report(0.5))]),
      ),
    );
    expect(result).toEqual({
      claude: {
        stepId: 's0',
        attempt: 2,
        finishedAt: '2026-10-01T00:06:00.000Z',
        status: 'rejected',
        type: null,
        resetsAt: null,
        windows: { five_hour: { utilization: 0.9 } },
      },
    });
  });

  it('breaks a tie by later start, then later attempt, and falls back to the start time', () => {
    const at = '2026-10-01T00:05:00.000Z';
    const later = { startedAt: '2026-10-01T00:03:00.000Z' };
    expect(
      latestRateLimits(
        run(step('claude', [attempt(1, at, report(0.1), later), attempt(2, at, report(0.2))])),
      )['claude']?.windows['five_hour']?.utilization,
    ).toBe(0.1);
    expect(
      latestRateLimits(
        run(step('claude', [attempt(1, at, report(0.1)), attempt(2, at, report(0.2))])),
      )['claude']?.windows['five_hour']?.utilization,
    ).toBe(0.2);
    const unsettled = attempt(2, null, report(0.7), {
      startedAt: '2026-10-01T00:30:00.000Z',
      status: 'interrupted',
    });
    expect(
      latestRateLimits(run(step('claude', [attempt(1, at, report(0.1)), unsettled])))['claude']
        ?.attempt,
    ).toBe(2);
  });

  it('keeps one entry per harness and ignores reports on other step kinds', () => {
    const codex = { request: { harness: 'codex' } };
    const result = latestRateLimits(
      run(
        step('claude', [attempt(1, '2026-10-01T00:01:00.000Z', report(0.3))]),
        step('codex', [attempt(1, '2026-10-01T00:02:00.000Z', report(0.4), codex)]),
        step('exec', [attempt(1, '2026-10-01T00:09:00.000Z', report(0.8))]),
      ),
    );
    expect(Object.keys(result).sort()).toEqual(['claude', 'codex']);
    expect(result['codex']?.windows['five_hour']?.utilization).toBe(0.4);
  });

  it('excludes fork-reused steps', () => {
    const reused = step('claude', [attempt(1, '2026-10-01T00:09:00.000Z', report(0.8))], {
      reusedFrom: { runId: 'earlier' },
    });
    expect(latestRateLimits(run(reused))).toEqual({});
  });

  it('names the harness of an agent step without a request, and skips invalid reports', () => {
    const noRequest = { request: undefined };
    const result = latestRateLimits(
      run(
        step('agent', [attempt(1, '2026-10-01T00:01:00.000Z', report(0.3), noRequest)], {
          harness: 'custom',
        }),
        step('claude', [attempt(1, '2026-10-01T00:09:00.000Z', { rateLimit: { windows: 'bad' } })]),
      ),
    );
    expect(Object.keys(result)).toEqual(['custom']);
  });

  // The run budget keeps this projection incrementally as attempts settle (#378).
  describe('RateLimitTracker', () => {
    const codex = { request: { harness: 'codex' } };
    const tied = (seq: number, utilization: number) =>
      step('codex', [attempt(1, '2026-10-01T00:02:00.000Z', report(utilization), codex)], { seq });
    const steps = (): [string, StepRecord][] => [
      [
        'retried',
        step(
          'claude',
          [
            attempt(1, '2026-10-01T00:05:00.000Z', report(0.2)),
            attempt(2, '2026-10-01T00:06:00.000Z', report(0.9, 'rejected'), { status: 'failed' }),
          ],
          { seq: 1 },
        ),
      ],
      [
        'unsettled',
        step(
          'claude',
          [
            attempt(1, null, report(0.7), {
              startedAt: '2026-10-01T00:07:00.000Z',
              status: 'interrupted',
            }),
          ],
          { seq: 2 },
        ),
      ],
      [
        'reused',
        step('claude', [attempt(1, '2026-10-01T00:09:00.000Z', report(0.8))], {
          seq: 3,
          reusedFrom: { runId: 'earlier' },
        }),
      ],
      ['exec', step('exec', [attempt(1, '2026-10-01T00:09:00.000Z', report(0.8))], { seq: 4 })],
      [
        'custom',
        step(
          'agent',
          [attempt(1, '2026-10-01T00:01:00.000Z', report(0.3), { request: undefined })],
          {
            seq: 5,
            harness: 'custom',
          },
        ),
      ],
      ['first-tie', tied(6, 0.4)],
      ['second-tie', tied(7, 0.5)],
    ];
    function* permutations<T>(items: readonly T[]): Generator<T[]> {
      if (items.length <= 1) {
        yield [...items];
        return;
      }
      for (const [index, item] of items.entries())
        for (const rest of permutations(items.filter((_, other) => other !== index)))
          yield [item, ...rest];
    }

    it('folds steps in every observation order to the same projection as latestRateLimits', () => {
      const expected = latestRateLimits(steps());
      expect(
        Object.fromEntries(
          Object.entries(expected).map(([harness, value]) => [
            harness,
            `${value.stepId}#${String(value.attempt)}`,
          ]),
        ),
      ).toEqual({ claude: 'unsettled#1', custom: 'custom#1', codex: 'second-tie#1' });
      let orders = 0;
      for (const order of permutations(steps())) {
        const tracker = new RateLimitTracker();
        for (const [stepId, value] of order) expect(tracker.observeStep(stepId, value)).toBe(true);
        expect(tracker.toRecord()).toEqual(expected);
        orders++;
      }
      expect(orders).toBe(5040);
    });

    it('resolves a full rank tie between steps to the higher seq', () => {
      for (const order of [
        [tied(2, 0.9), tied(1, 0.1)],
        [tied(1, 0.1), tied(2, 0.9)],
      ])
        expect(latestRateLimits(run(...order))['codex']?.windows['five_hour']?.utilization).toBe(
          0.9,
        );
    });

    it('reports the steps it holds and is idempotent when a step is observed again', () => {
      const tracker = new RateLimitTracker();
      for (const [stepId, value] of steps()) tracker.observeStep(stepId, value);
      expect(tracker.holds('unsettled')).toBe(true);
      expect(tracker.holds('retried')).toBe(false);
      expect(tracker.holds('missing')).toBe(false);
      const before = tracker.toRecord();
      for (const [stepId, value] of steps()) expect(tracker.observeStep(stepId, value)).toBe(true);
      expect(tracker.toRecord()).toEqual(before);
      expect(tracker.get('claude')?.stepId).toBe('unsettled');
      expect(tracker.get('constructor')).toBeUndefined();
    });

    it('replaces an attempt that settled since it was observed', () => {
      const tracker = new RateLimitTracker();
      const running = step('claude', [attempt(1, null, report(0.3))], { seq: 1 });
      tracker.observeStep('s', running);
      const [only] = running.attemptHistory ?? [];
      if (!only) throw new Error('missing attempt');
      only.finishedAt = '2026-10-01T00:04:00.000Z';
      only.diagnostics = report(0.6);
      expect(tracker.observeStep('s', running)).toBe(true);
      expect(tracker.get('claude')).toMatchObject({
        finishedAt: '2026-10-01T00:04:00.000Z',
        windows: { five_hour: { utilization: 0.6 } },
      });
    });

    it.each([
      ['its kind left the projection', (value: StepRecord) => (value.kind = 'step')],
      ['it became a fork reuse', (value: StepRecord) => (value.reusedFrom = {} as never)],
      [
        'its attempt moved to another harness',
        (value: StepRecord) => {
          value.attemptHistory = (value.attemptHistory ?? []).map((entry) => ({
            ...entry,
            request: { harness: 'codex' } as never,
          }));
        },
      ],
    ])('refuses to fold a step whose held report no longer stands when %s', (_name, rewrite) => {
      const tracker = new RateLimitTracker();
      const holder = step('claude', [attempt(1, '2026-10-01T00:09:00.000Z', report(0.3))], {
        seq: 2,
      });
      const other = step('claude', [attempt(1, '2026-10-01T00:01:00.000Z', report(0.8))], {
        seq: 1,
      });
      tracker.observeStep('other', other);
      tracker.observeStep('holder', holder);
      rewrite(holder);
      expect(tracker.observeStep('holder', holder)).toBe(false);
      expect(tracker.observeStep('holder', undefined)).toBe(false);
      // A step that holds nothing is folded in place.
      other.kind = 'step';
      expect(tracker.observeStep('other', other)).toBe(true);
    });
  });
});
