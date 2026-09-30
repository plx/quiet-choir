import { describe, expect, it, vi } from 'vitest';

import type { RequestSummary } from '../src/workflow/runtime/observability-model.js';
import type { StepRecord } from '../src/workflow/runtime/record.js';
import {
  decideReplay,
  forkReuseValid,
  legacyKind,
  replayRefusalMessage,
  type ReplayDecision,
  type ReplayInput,
  type ReplayRefusal,
} from '../src/workflow/runtime/replay-decision.js';

// Replay and redefinition rules as a pure table: no state directory, store or workflow run.
const identity = { kind: 'k', onError: 'o', input: 'i1', schema: 's' };

const defaults: Omit<ReplayInput, 'forkCandidate' | 'legacyFingerprint'> = {
  id: 'step',
  kind: 'step',
  prior: undefined,
  identity,
  fingerprint: 'fp',
  onError: 'throw',
  request: null,
  forkedFrom: false,
  rehearsal: false,
  isolated: false,
  strictHealedDivergence: false,
};

function step(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    kind: 'step',
    fingerprint: 'fp',
    status: 'completed',
    attempts: 1,
    output: 1,
    error: null,
    wakeAt: null,
    identity,
    ...overrides,
  };
}

/** An original format-one record: no identity, fingerprint over the old components. */
function legacy(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    ...withoutIdentity(step({ fingerprint: 'legacy-fp', ...overrides })),
    legacyIdentity: 1,
  };
}

function withoutIdentity(record: StepRecord): StepRecord {
  const copy = { ...record };
  delete copy.identity;
  return copy;
}

const settledError = { message: 'x', kind: 'unknown', attempts: 1 } as const;

function request(harness: string): RequestSummary {
  return { harness } as RequestSummary;
}

const source = step({ output: 'from the source run' });

const fresh = (resume: boolean): ReplayDecision => ({
  migrateLegacy: false,
  outcome: { kind: 'fresh', resume },
});
const replayed: ReplayDecision = { migrateLegacy: false, outcome: { kind: 'replay' } };
const redefine: ReplayDecision = { migrateLegacy: false, outcome: { kind: 'redefine' } };
const refused = (refusal: ReplayRefusal, migrateLegacy = false): ReplayDecision => ({
  migrateLegacy,
  outcome: { kind: 'refuse', refusal },
});
const migrated = (decision: ReplayDecision): ReplayDecision => ({
  ...decision,
  migrateLegacy: true,
});

interface Row {
  name: string;
  input: Partial<Omit<ReplayInput, 'forkCandidate' | 'legacyFingerprint'>>;
  /** What the fork lookup thunk returns when called. */
  fork?: StepRecord;
  /** What the legacy fingerprint thunk returns; defaults to the legacy record's fingerprint. */
  legacyFingerprint?: string;
  expected: ReplayDecision;
  /** Expected fork lookups; defaults to 0. */
  forkCalls?: number;
  /** Expected legacy fingerprint computations; defaults to 0. */
  legacyCalls?: number;
}

const rows: Row[] = [
  // Original format-one identities.
  {
    name: 'legacy: a terminal local step migrates and replays',
    input: { prior: legacy() },
    expected: migrated(replayed),
    legacyCalls: 1,
  },
  {
    name: 'legacy: a failed step migrates and resumes',
    input: { prior: legacy({ status: 'failed' }) },
    expected: migrated(fresh(true)),
    legacyCalls: 1,
  },
  {
    name: 'legacy: a running step migrates and resumes',
    input: { prior: legacy({ status: 'running' }) },
    expected: migrated(fresh(true)),
    legacyCalls: 1,
  },
  ...(['agent', 'claude', 'codex'] as const).map((kind): Row => ({
    name: `legacy: a completed ${kind} step is refused before its fingerprint is computed`,
    input: { kind, prior: legacy({ kind: kind === 'agent' ? 'claude' : kind }) },
    expected: refused({ reason: 'legacy-agent-unpinned' }),
  })),
  {
    name: 'legacy: a settled-failed agent step is refused too',
    input: { kind: 'codex', prior: legacy({ kind: 'codex', status: 'settled-failed' }) },
    expected: refused({ reason: 'legacy-agent-unpinned' }),
  },
  {
    name: 'legacy: an unfinished agent step takes its old kind from request.harness and migrates',
    input: {
      kind: 'agent',
      request: request('claude'),
      prior: legacy({ kind: 'claude', status: 'failed' }),
    },
    expected: migrated(fresh(true)),
    legacyCalls: 1,
  },
  {
    name: 'legacy: an agent step whose old kind names another harness is refused',
    input: {
      kind: 'agent',
      request: request('codex'),
      prior: legacy({ kind: 'claude', status: 'failed' }),
    },
    expected: refused({ reason: 'legacy-identity-changed' }),
    legacyCalls: 1,
  },
  {
    name: 'legacy: a changed kind is refused',
    input: { prior: legacy({ kind: 'exec' }) },
    expected: refused({ reason: 'legacy-identity-changed' }),
    legacyCalls: 1,
  },
  {
    name: 'legacy: a changed old fingerprint is refused',
    input: { prior: legacy() },
    legacyFingerprint: 'other-fp',
    expected: refused({ reason: 'legacy-identity-changed' }),
    legacyCalls: 1,
  },
  {
    name: "legacy: onError 'return' is refused even when everything else matches",
    input: { prior: legacy(), onError: 'return' },
    expected: refused({ reason: 'legacy-identity-changed' }),
    legacyCalls: 1,
  },
  {
    name: 'legacy: a migrated step under rehearsal still migrates before the Git refusal',
    input: {
      kind: 'worktree',
      prior: legacy({ kind: 'worktree', status: 'failed' }),
      rehearsal: true,
    },
    expected: refused({ reason: 'rehearsal-git' }, true),
    legacyCalls: 1,
  },
  {
    name: 'legacy: a migrated unfinished step under strict divergence is refused after migrating',
    input: { prior: legacy({ status: 'failed' }), strictHealedDivergence: true },
    expected: refused({ reason: 'strict-healed-divergence' }, true),
    legacyCalls: 1,
  },

  // Questions and waits.
  {
    name: 'an unfinished question cannot be redefined',
    input: { kind: 'ask', prior: step({ kind: 'ask', status: 'waiting' }), fingerprint: 'fp2' },
    expected: refused({ reason: 'question-or-wait-redefined', priorKind: 'ask' }),
  },
  {
    name: 'an unfinished wait cannot be redefined',
    input: { kind: 'wait', prior: step({ kind: 'wait', status: 'waiting' }), fingerprint: 'fp2' },
    expected: refused({ reason: 'question-or-wait-redefined', priorKind: 'wait' }),
  },
  {
    name: 'a completed question cannot become another effect (checked before terminal identity)',
    input: { kind: 'step', prior: step({ kind: 'ask' }) },
    expected: refused({ reason: 'question-or-wait-redefined', priorKind: 'ask' }),
  },
  {
    name: 'a waiting question with the same identity resumes',
    input: { kind: 'ask', prior: step({ kind: 'ask', status: 'waiting' }) },
    expected: fresh(true),
  },

  // Terminal identities are immutable.
  {
    name: 'a completed step lists changed components in first-seen order',
    input: {
      prior: step({ identity: { kind: 'k', input: 'i0', schema: 's', callback: 'c' } }),
      identity: { kind: 'k', onError: 'o', input: 'i1', schema: 's' },
      fingerprint: 'fp2',
    },
    expected: refused({
      reason: 'terminal-redefined',
      changed: ['input', 'callback', 'onError'],
      status: 'completed',
    }),
  },
  {
    name: 'a settled-failed step names its status',
    input: {
      prior: step({ status: 'settled-failed', identity: { ...identity, input: 'i0' } }),
      fingerprint: 'fp2',
    },
    expected: refused({
      reason: 'terminal-redefined',
      changed: ['input'],
      status: 'settled-failed',
    }),
  },
  {
    name: 'a fingerprint change with identical components lists nothing',
    input: { prior: step({ fingerprint: 'fp-old' }) },
    expected: refused({ reason: 'terminal-redefined', changed: [], status: 'completed' }),
  },
  {
    name: 'a kind change with identical components lists nothing',
    input: { prior: step({ kind: 'exec' }) },
    expected: refused({ reason: 'terminal-redefined', changed: [], status: 'completed' }),
  },
  {
    name: 'a terminal step without recorded identity lists every requested component',
    input: { prior: withoutIdentity(step({ fingerprint: 'fp-old' })) },
    expected: refused({
      reason: 'terminal-redefined',
      changed: ['kind', 'onError', 'input', 'schema'],
      status: 'completed',
    }),
  },

  // Terminal replay.
  { name: 'a completed step replays', input: { prior: step() }, expected: replayed },
  {
    name: 'a settled-failed step replays',
    input: { prior: step({ status: 'settled-failed' }) },
    expected: replayed,
  },
  {
    name: 'a terminal worktree step replays under rehearsal (replay precedes the Git refusal)',
    input: { kind: 'worktree', prior: step({ kind: 'worktree' }), rehearsal: true, isolated: true },
    expected: replayed,
  },
  {
    name: 'a terminal step in a fork replays without a fork lookup',
    input: { prior: step(), forkedFrom: true },
    fork: source,
    expected: replayed,
  },

  // Dry-run refuses Git effects before fork reuse.
  {
    name: 'rehearsal refuses an isolated effect without a fork lookup',
    input: { kind: 'agent', rehearsal: true, isolated: true, forkedFrom: true },
    fork: source,
    expected: refused({ reason: 'rehearsal-git' }),
  },
  {
    name: 'rehearsal refuses a worktree effect',
    input: { kind: 'worktree', rehearsal: true },
    expected: refused({ reason: 'rehearsal-git' }),
  },
  {
    name: 'rehearsal refuses a merge effect',
    input: { kind: 'merge', rehearsal: true },
    expected: refused({ reason: 'rehearsal-git' }),
  },
  {
    name: 'rehearsal runs a non-Git effect',
    input: { kind: 'agent', rehearsal: true },
    expected: fresh(false),
  },
  {
    name: 'isolation without rehearsal runs',
    input: { kind: 'agent', isolated: true },
    expected: fresh(false),
  },

  // Fork reuse: only absent steps in forked runs, looked up once.
  {
    name: 'fork reuse hit',
    input: { forkedFrom: true },
    fork: source,
    expected: { migrateLegacy: false, outcome: { kind: 'reuse-fork', candidate: source } },
    forkCalls: 1,
  },
  {
    name: 'fork reuse miss runs fresh',
    input: { forkedFrom: true },
    expected: fresh(false),
    forkCalls: 1,
  },
  {
    name: 'a worktree effect whose lookup rejects every source step runs fresh',
    input: { kind: 'worktree', forkedFrom: true },
    expected: fresh(false),
    forkCalls: 1,
  },
  {
    name: 'an unfinished prior in a fork resumes without a fork lookup',
    input: { prior: step({ status: 'failed' }), forkedFrom: true },
    fork: source,
    expected: fresh(true),
  },
  {
    name: 'a run that is not a fork never looks up',
    input: {},
    fork: source,
    expected: fresh(false),
  },

  // Strict healed divergence stops before the next live effect.
  {
    name: 'strict divergence is refused after a fork miss',
    input: { forkedFrom: true, strictHealedDivergence: true },
    expected: refused({ reason: 'strict-healed-divergence' }),
    forkCalls: 1,
  },
  {
    name: 'a fork hit wins over strict divergence',
    input: { forkedFrom: true, strictHealedDivergence: true },
    fork: source,
    expected: { migrateLegacy: false, outcome: { kind: 'reuse-fork', candidate: source } },
    forkCalls: 1,
  },
  {
    name: 'terminal replay wins over strict divergence',
    input: { prior: step(), strictHealedDivergence: true },
    expected: replayed,
  },
  {
    name: 'strict divergence refuses a fresh effect',
    input: { strictHealedDivergence: true },
    expected: refused({ reason: 'strict-healed-divergence' }),
  },
  {
    name: 'strict divergence refuses a redefinition',
    input: { prior: step({ status: 'failed' }), fingerprint: 'fp2', strictHealedDivergence: true },
    expected: refused({ reason: 'strict-healed-divergence' }),
  },

  // Redefinition and fresh runs.
  {
    name: 'an unfinished step with a changed fingerprint is redefined',
    input: { prior: step({ status: 'running' }), fingerprint: 'fp2' },
    expected: redefine,
  },
  {
    name: 'a failed step with a changed kind is redefined',
    input: { kind: 'exec', prior: step({ status: 'failed' }) },
    expected: redefine,
  },
  {
    name: 'a cancelled step with a changed fingerprint is redefined',
    input: { prior: step({ status: 'cancelled' }), fingerprint: 'fp2' },
    expected: redefine,
  },
  {
    name: 'an unfinished step with the same identity resumes',
    input: { prior: step({ status: 'failed' }) },
    expected: fresh(true),
  },
  { name: 'an absent step runs fresh', input: {}, expected: fresh(false) },
];

describe('decideReplay', () => {
  it.each(rows)('$name', (row) => {
    const forkCandidate = vi.fn(() => row.fork);
    const legacyFingerprint = vi.fn(() => row.legacyFingerprint ?? 'legacy-fp');
    const input: ReplayInput = { ...defaults, ...row.input, forkCandidate, legacyFingerprint };
    const before = structuredClone(input.prior);
    expect(decideReplay(input)).toEqual(row.expected);
    expect(forkCandidate).toHaveBeenCalledTimes(row.forkCalls ?? 0);
    expect(legacyFingerprint).toHaveBeenCalledTimes(row.legacyCalls ?? 0);
    // The runner alone applies migrations and redefinitions.
    expect(input.prior).toEqual(before);
  });

  it('computes the legacy fingerprint before comparing, so its failure surfaces first', () => {
    const input: ReplayInput = {
      ...defaults,
      kind: 'agent',
      request: request('codex'),
      prior: legacy({ kind: 'claude', status: 'failed' }),
      forkCandidate: () => undefined,
      legacyFingerprint: () => {
        throw new Error('Transforms cannot be represented in JSON Schema');
      },
    };
    expect(() => decideReplay(input)).toThrow('Transforms cannot be represented in JSON Schema');
  });

  it('decides the same after the runner applies a legacy migration', () => {
    const prior = legacy({ status: 'failed' });
    const input: ReplayInput = {
      ...defaults,
      prior,
      forkCandidate: () => undefined,
      legacyFingerprint: () => 'legacy-fp',
    };
    const first = decideReplay(input);
    Object.assign(prior, { fingerprint: 'fp', identity, seq: 1 });
    delete prior.legacyIdentity;
    const second = decideReplay(input);
    expect(first).toEqual(migrated(fresh(true)));
    expect(second).toEqual(fresh(true));
  });
});

describe('legacyKind', () => {
  it('uses the request harness for an agent call', () => {
    expect(legacyKind('agent', request('codex'))).toBe('codex');
  });

  it('keeps agent without a request', () => {
    expect(legacyKind('agent', null)).toBe('agent');
    expect(legacyKind('agent', undefined)).toBe('agent');
  });

  it('keeps any other kind', () => {
    expect(legacyKind('step', request('codex'))).toBe('step');
    expect(legacyKind('claude', request('codex'))).toBe('claude');
  });
});

describe('forkReuseValid', () => {
  it('never reuses a worktree step and never parses its output', () => {
    const outputParses = vi.fn(() => true);
    expect(forkReuseValid('worktree', 'return', step({ kind: 'worktree' }), outputParses)).toBe(
      false,
    );
    const settled = step({
      kind: 'worktree',
      status: 'settled-failed',
      settledError,
    });
    expect(forkReuseValid('worktree', 'return', settled, outputParses)).toBe(false);
    expect(outputParses).not.toHaveBeenCalled();
  });

  it("reuses a settled failure only under onError 'return' with its settled error", () => {
    const settled = step({ status: 'settled-failed', settledError });
    const outputParses = vi.fn(() => true);
    expect(forkReuseValid('step', 'return', settled, outputParses)).toBe(true);
    expect(forkReuseValid('step', 'throw', settled, outputParses)).toBe(false);
    expect(forkReuseValid('step', undefined, settled, outputParses)).toBe(false);
    expect(forkReuseValid('step', 'return', step({ status: 'settled-failed' }), outputParses)).toBe(
      false,
    );
    expect(outputParses).not.toHaveBeenCalled();
  });

  it('reuses a completed step only when its output still parses', () => {
    const completed = step({ output: { answer: 42 } });
    const accepts = vi.fn(() => true);
    expect(forkReuseValid('step', 'throw', completed, accepts)).toBe(true);
    expect(accepts).toHaveBeenCalledWith({ answer: 42 });
    expect(forkReuseValid('step', 'throw', completed, () => false)).toBe(false);
  });
});

describe('replayRefusalMessage', () => {
  // Literals copied from runner.ts before the extraction; they must stay byte-identical.
  const cases: [Exclude<ReplayRefusal, { reason: 'strict-healed-divergence' }>, string][] = [
    [
      { reason: 'legacy-agent-unpinned' },
      'Step a/b: original format-one agent has no pinned isolation mode; start a new run or invalidate it in a fork.',
    ],
    [
      { reason: 'legacy-identity-changed' },
      'Step a/b: original format-one identity changed; restore its inputs/options/schema/retry before migrating or start a new run.',
    ],
    [
      { reason: 'question-or-wait-redefined', priorKind: 'ask' },
      'Step a/b: a question cannot be redefined as another effect; use a new ID.',
    ],
    [
      { reason: 'question-or-wait-redefined', priorKind: 'wait' },
      'Step a/b: a wait cannot be redefined as another effect; use a new ID.',
    ],
    [
      { reason: 'terminal-redefined', changed: ['input', 'schema'], status: 'completed' },
      'Step a/b: input, schema changed on a completed step; --accept-code-change cannot reuse it. Fork a new run with --fork-from RUN --reuse matching --invalidate a/b.',
    ],
    [
      { reason: 'terminal-redefined', changed: ['input'], status: 'settled-failed' },
      'Step a/b: input changed on a settled-failed step; --accept-code-change cannot reuse it. Fork a new run with --fork-from RUN --reuse matching --invalidate a/b.',
    ],
    [
      { reason: 'terminal-redefined', changed: [], status: 'completed' },
      'Step a/b: identity changed on a completed step; --accept-code-change cannot reuse it. Fork a new run with --fork-from RUN --reuse matching --invalidate a/b.',
    ],
    [
      { reason: 'rehearsal-git' },
      'Dry-run does not simulate Git worktree effects. Use a fixture harness in a temporary repository to rehearse isolation without paid calls.',
    ],
  ];

  it.each(cases)('%j', (refusal, message) => {
    expect(replayRefusalMessage('a/b', refusal)).toBe(message);
  });
});
