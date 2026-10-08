import { describe, expect, it, vi } from 'vitest';

import type { RequestSummary } from '../src/workflow/runtime/observability-model.js';
import type { MapComponents, StepRecord } from '../src/workflow/runtime/record.js';
import {
  decideReplay,
  decideSettledMapReplay,
  forkPrefixBlockers,
  forkReuseValid,
  healedDependents,
  legacyKind,
  replayRefusalMessage,
  settledMapRefusalMessage,
  type ForkPrefixFacts,
  type ForkSourceLaunch,
  type ForkTargetStep,
  type HealedStep,
  type MapItemScope,
  type PriorLaunch,
  type ReplayDecision,
  type ReplayInput,
  type ReplayRefusal,
  type SettledMapInput,
  type SettledMapReplay,
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
  rehearsalSynthesized: false,
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
    name: 'rehearsal runs a synthesized fresh isolated agent call',
    input: { kind: 'agent', rehearsal: true, isolated: true, rehearsalSynthesized: true },
    expected: fresh(false),
  },
  {
    name: 'rehearsal resumes an unfinished synthesized isolated agent call',
    input: {
      kind: 'agent',
      prior: step({ kind: 'agent', status: 'failed' }),
      rehearsal: true,
      isolated: true,
      rehearsalSynthesized: true,
    },
    expected: fresh(true),
  },
  {
    name: 'rehearsal runs a synthesized merge of unchanged changes',
    input: { kind: 'merge', rehearsal: true, rehearsalSynthesized: true },
    expected: fresh(false),
  },
  {
    name: 'a synthesized rehearsal effect in a fork still looks up fork reuse',
    input: {
      kind: 'agent',
      rehearsal: true,
      isolated: true,
      rehearsalSynthesized: true,
      forkedFrom: true,
    },
    fork: source,
    expected: { migrateLegacy: false, outcome: { kind: 'reuse-fork', candidate: source } },
    forkCalls: 1,
  },
  {
    name: 'rehearsal refuses an unsynthesized isolated exec or step',
    input: { kind: 'exec', rehearsal: true, isolated: true, rehearsalSynthesized: false },
    expected: refused({ reason: 'rehearsal-git' }),
  },
  {
    name: 'rehearsal refuses an unsynthesized merge',
    input: { kind: 'merge', rehearsal: true, rehearsalSynthesized: false },
    expected: refused({ reason: 'rehearsal-git' }),
  },
  {
    name: 'rehearsal refuses an unsynthesized worktree effect',
    input: { kind: 'worktree', rehearsal: true, rehearsalSynthesized: false },
    expected: refused({ reason: 'rehearsal-git' }),
  },
  {
    name: 'the accepted-replay probe runs a synthesized worktree effect',
    input: { kind: 'worktree', rehearsal: true, rehearsalSynthesized: true },
    expected: fresh(false),
  },
  {
    name: 'the accepted-replay probe resumes an unfinished synthesized worktree effect',
    input: {
      kind: 'worktree',
      prior: step({ kind: 'worktree', status: 'failed' }),
      rehearsal: true,
      rehearsalSynthesized: true,
    },
    expected: fresh(true),
  },
  {
    name: 'the accepted-replay probe runs a synthesized handle-isolated exec',
    input: { kind: 'exec', rehearsal: true, isolated: true, rehearsalSynthesized: true },
    expected: fresh(false),
  },
  {
    name: 'synthesis without rehearsal changes nothing',
    input: { kind: 'merge', rehearsalSynthesized: true },
    expected: fresh(false),
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

  it.each(['exec', 'read-file', 'write-file'] as const)(
    "reuses a settled %s failure only under onError 'return', like a settled step",
    (kind) => {
      const execError = { ...settledError, kind: 'process', code: 1, signal: null } as const;
      const settled = step({ kind, status: 'settled-failed', settledError: execError });
      const outputParses = vi.fn(() => true);
      expect(forkReuseValid(kind, 'return', settled, outputParses)).toBe(true);
      expect(forkReuseValid(kind, 'throw', settled, outputParses)).toBe(false);
      expect(forkReuseValid(kind, undefined, settled, outputParses)).toBe(false);
      expect(outputParses).not.toHaveBeenCalled();
    },
  );

  it('reuses a completed step only when its output still parses', () => {
    const completed = step({ output: { answer: 42 } });
    const accepts = vi.fn(() => true);
    expect(forkReuseValid('step', 'throw', completed, accepts)).toBe(true);
    expect(accepts).toHaveBeenCalledWith({ answer: 42 });
    expect(forkReuseValid('step', 'throw', completed, () => false)).toBe(false);
  });
});

describe('healedDependents', () => {
  // The healed step H has seq 2 and failed at settlement stamp 5 unless a case says otherwise.
  const healed: HealedStep = { id: 'h', seq: 2, failureStamp: 5 };
  const cases: {
    name: string;
    healed?: HealedStep;
    prior: PriorLaunch[];
    expected: string[];
  }[] = [
    { name: 'no prior steps', prior: [], expected: [] },
    {
      name: 'never flags the healed step itself',
      prior: [{ id: 'h', seq: 2, launchStamp: 9 }],
      expected: [],
    },
    {
      name: 'same-tick sibling launched before the failure settled',
      prior: [{ id: 's', seq: 3, launchStamp: 4 }],
      expected: [],
    },
    {
      name: 'launch at the failure stamp observed the failure',
      prior: [{ id: 's', seq: 3, launchStamp: 5 }],
      expected: ['s'],
    },
    {
      name: 'later launch',
      prior: [{ id: 's', seq: 3, launchStamp: 8 }],
      expected: ['s'],
    },
    {
      name: 'stamps govern over seq: a lower-seq step relaunched after the failure',
      prior: [{ id: 'early', seq: 1, launchStamp: 6 }],
      expected: ['early'],
    },
    {
      name: 'healed step without a failure stamp falls back to seq',
      healed: { id: 'h', seq: 2 },
      prior: [
        { id: 'before', seq: 1, launchStamp: 9 },
        { id: 'after', seq: 3, launchStamp: 0 },
      ],
      expected: ['after'],
    },
    {
      name: 'sibling without a launch stamp falls back to seq for that pair only',
      prior: [
        { id: 'legacy-later', seq: 3 },
        { id: 'legacy-earlier', seq: 1 },
        { id: 'stamped-sibling', seq: 4, launchStamp: 4 },
        { id: 'stamped-dependent', seq: 5, launchStamp: 7 },
      ],
      expected: ['legacy-later', 'stamped-dependent'],
    },
    {
      name: 'no stamps at all keeps the launch-order rule',
      healed: { id: 'h', seq: 2 },
      prior: [
        { id: 'a', seq: 1 },
        { id: 'h', seq: 2 },
        { id: 'b', seq: 3 },
        { id: 'c', seq: 4 },
      ],
      expected: ['b', 'c'],
    },
  ];

  it.each(cases)('$name', (testCase) => {
    expect(healedDependents(testCase.healed ?? healed, testCase.prior)).toEqual(testCase.expected);
  });
});

describe('healedDependents with a failure history', () => {
  // The ticket's scenario (#300): H launched at 0 and failed at 2 in run 1; run 2 started its
  // counter at 2, relaunched H at 2 (failed again at 4) and a sibling in the same tick.
  const repeated: HealedStep = {
    id: 'h',
    seq: 1,
    failureStamp: 2,
    failures: [
      { launchStamp: 0, failureStamp: 2 },
      { launchStamp: 2, failureStamp: 4 },
    ],
    launchStamp: 2,
  };
  const cases: {
    name: string;
    healed: HealedStep;
    prior: PriorLaunch[];
    expected: string[];
  }[] = [
    {
      name: 'a sibling relaunched in the same tick as the failing relaunch (stamp tie)',
      healed: repeated,
      prior: [
        { id: 'h', seq: 1, launchStamp: 2 },
        { id: 'followups', seq: 2, launchStamp: 2 },
      ],
      expected: [],
    },
    {
      name: 'a dependent of the first failure that replays across a later failure',
      healed: {
        id: 'h',
        seq: 1,
        failureStamp: 1,
        failures: [
          { launchStamp: 0, failureStamp: 1 },
          { launchStamp: 3, failureStamp: 5 },
        ],
        launchStamp: 3,
      },
      prior: [{ id: 'dependent', seq: 2, launchStamp: 2 }],
      expected: ['dependent'],
    },
    {
      name: 'a dependent launched after the latest failure',
      healed: repeated,
      prior: [
        { id: 'followups', seq: 2, launchStamp: 2 },
        { id: 'fallback', seq: 3, launchStamp: 4 },
        { id: 'later', seq: 4, launchStamp: 7 },
      ],
      expected: ['fallback', 'later'],
    },
    {
      name: 'a sibling launched while the latest failing launch was in flight',
      healed: repeated,
      prior: [{ id: 's', seq: 2, launchStamp: 3 }],
      expected: [],
    },
    {
      name: 'a relaunch cancelled without a failure entry hides the earlier failure',
      healed: {
        id: 'h',
        seq: 1,
        failureStamp: 1,
        failures: [{ launchStamp: 0, failureStamp: 1 }],
        launchStamp: 3,
      },
      prior: [
        { id: 'dependent', seq: 2, launchStamp: 1 },
        { id: 'sibling', seq: 3, launchStamp: 4 },
      ],
      expected: ['dependent'],
    },
    {
      name: 'a step launched before the first failing launch',
      healed: {
        id: 'h',
        seq: 2,
        failureStamp: 6,
        failures: [{ launchStamp: 5, failureStamp: 6 }],
        launchStamp: 5,
      },
      prior: [
        { id: 'early', seq: 1, launchStamp: 4 },
        { id: 'sibling', seq: 3, launchStamp: 5 },
        { id: 'dependent', seq: 4, launchStamp: 6 },
      ],
      expected: ['dependent'],
    },
    {
      name: 'a truncated history falls back to the watermark',
      healed: {
        ...repeated,
        failures: [{ launchStamp: 2, failureStamp: 4 }],
      },
      prior: [
        { id: 'before', seq: 2, launchStamp: 1 },
        { id: 'followups', seq: 3, launchStamp: 2 },
      ],
      expected: ['followups'],
    },
    {
      name: 'a legacy record with only failureStamp keeps the watermark',
      healed: { id: 'h', seq: 1, failureStamp: 2, launchStamp: 2 },
      prior: [
        { id: 'before', seq: 2, launchStamp: 1 },
        { id: 'followups', seq: 3, launchStamp: 2 },
      ],
      expected: ['followups'],
    },
    {
      name: 'an empty history keeps the watermark',
      healed: { ...repeated, failures: [] },
      prior: [{ id: 'followups', seq: 2, launchStamp: 2 }],
      expected: ['followups'],
    },
    {
      name: 'a sibling without a launch stamp still falls back to seq for that pair',
      healed: repeated,
      prior: [
        { id: 'legacy-earlier', seq: 0 },
        { id: 'legacy-later', seq: 2 },
        { id: 'followups', seq: 3, launchStamp: 2 },
      ],
      expected: ['legacy-later'],
    },
    {
      name: 'a history without a failure stamp falls back to seq',
      healed: { ...repeated, failureStamp: undefined },
      prior: [
        { id: 'before', seq: 0, launchStamp: 9 },
        { id: 'after', seq: 2, launchStamp: 0 },
      ],
      expected: ['after'],
    },
  ];

  it.each(cases)('$name', ({ healed, prior, expected }) => {
    expect(healedDependents(healed, prior)).toEqual(expected);
  });
});

describe('forkPrefixBlockers', () => {
  // The request is X; unless a case says otherwise X launched in the source at stamp 5 (seq 5)
  // and in the target at stamp 3, outside any named map.
  const reused = (stepId: string, runId = 'src'): ForkTargetStep => ({
    reusedFrom: { runId, stateDir: '/state', stepId, fingerprint: 'fp', at: 'now' },
    settleStamp: 1,
  });
  const scope = (map: string, keys: string[], key: string): MapItemScope => ({
    map,
    item: `${map}${key}/`,
    items: new Set(keys.map((k) => `${map}${k}/`)),
  });
  const review = (key: string): MapItemScope => scope('review/', ['0', '1', '2'], key);
  const cases: {
    name: string;
    id?: string;
    launchStamp?: number;
    mapItems?: MapItemScope[];
    source: Record<string, ForkSourceLaunch>;
    target?: Record<string, ForkTargetStep>;
    expected: string[];
  }[] = [
    { name: 'no causes', source: { x: { seq: 1, launchStamp: 0, settleStamp: 1 } }, expected: [] },
    {
      name: 'a cause reused from this source',
      source: { y: { seq: 1, launchStamp: 0, settleStamp: 1 }, x: { seq: 2, launchStamp: 5 } },
      target: { y: reused('y') },
      expected: [],
    },
    {
      name: 'a cause not reused',
      source: { y: { seq: 1, launchStamp: 0, settleStamp: 1 }, x: { seq: 2, launchStamp: 5 } },
      expected: ['y'],
    },
    {
      name: 'a cause reused from another run or under another ID still blocks',
      source: {
        y: { seq: 1, launchStamp: 0, settleStamp: 1 },
        z: { seq: 2, launchStamp: 0, settleStamp: 2 },
        x: { seq: 3, launchStamp: 5 },
      },
      target: { y: reused('y', 'other'), z: reused('y') },
      expected: ['y', 'z'],
    },
    {
      name: 'a cause settled exactly at the launch stamp blocks',
      source: { y: { seq: 1, launchStamp: 0, settleStamp: 5 }, x: { seq: 2, launchStamp: 5 } },
      expected: ['y'],
    },
    {
      name: 'a same-tick sibling that settled after the launch does not block',
      source: { y: { seq: 1, launchStamp: 5, settleStamp: 6 }, x: { seq: 2, launchStamp: 5 } },
      expected: [],
    },
    {
      name: 'an unsettled source step does not block',
      source: { y: { seq: 1, launchStamp: 0 }, x: { seq: 2, launchStamp: 5 } },
      expected: [],
    },
    {
      name: 'stamps govern over seq: a later-seq step that settled first blocks',
      source: { x: { seq: 1, launchStamp: 5 }, y: { seq: 2, launchStamp: 4, settleStamp: 5 } },
      expected: ['y'],
    },
    {
      name: 'stampless source falls back to seq order',
      source: { a: { seq: 1 }, x: { seq: 2 }, b: { seq: 3 } },
      expected: ['a'],
    },
    {
      name: 'a mixed pair falls back to seq for that pair only',
      source: {
        legacy: { seq: 1 },
        legacyLater: { seq: 9 },
        sibling: { seq: 3, launchStamp: 5, settleStamp: 6 },
        x: { seq: 2, launchStamp: 5 },
      },
      expected: ['legacy'],
    },
    {
      name: 'a requested step without a stamp falls back to seq for every pair',
      source: { y: { seq: 1, launchStamp: 9, settleStamp: 10 }, x: { seq: 2 } },
      expected: ['y'],
    },
    {
      name: 'a missing seq in the fallback counts as a cause',
      source: { y: {}, x: { seq: 2 } },
      expected: ['y'],
    },
    {
      name: 'sibling named-map items are independent',
      id: 'review/1/s1',
      mapItems: [review('1')],
      source: {
        'review/0/s3': { seq: 3, launchStamp: 2, settleStamp: 4 },
        'review/1/s1': { seq: 4, launchStamp: 5 },
      },
      target: { 'review/0/s3': { settleStamp: 2 } },
      expected: [],
    },
    {
      name: 'the same item is not independent',
      id: 'review/1/s2',
      mapItems: [review('1')],
      source: {
        'review/1/s1': { seq: 1, launchStamp: 0, settleStamp: 2 },
        'review/1/s2': { seq: 2, launchStamp: 5 },
      },
      target: { 'review/1/s1': { settleStamp: 1 } },
      expected: ['review/1/s1'],
    },
    {
      name: 'a step under the map prefix that is not an item still blocks',
      id: 'review/1/s1',
      mapItems: [review('1')],
      source: {
        'review/plan': { seq: 1, launchStamp: 0, settleStamp: 1 },
        'review/9/s1': { seq: 2, launchStamp: 0, settleStamp: 2 },
        'review/1/s1': { seq: 3, launchStamp: 5 },
      },
      expected: ['review/plan', 'review/9/s1'],
    },
    {
      name: 'a step before the map blocks its items',
      id: 'review/1/s1',
      mapItems: [review('1')],
      source: {
        plan: { seq: 1, launchStamp: 0, settleStamp: 1 },
        'review/1/s1': { seq: 2, launchStamp: 5 },
      },
      expected: ['plan'],
    },
    {
      name: 'nested maps: sibling items at either level are independent',
      id: 'outer/a/inner/x/s',
      mapItems: [scope('outer/', ['a', 'b'], 'a'), scope('outer/a/inner/', ['x', 'y'], 'x')],
      source: {
        'outer/b/inner/x/s': { seq: 1, launchStamp: 0, settleStamp: 1 },
        'outer/a/inner/y/s': { seq: 2, launchStamp: 0, settleStamp: 2 },
        'outer/a/pre': { seq: 3, launchStamp: 0, settleStamp: 3 },
        'outer/a/inner/x/s': { seq: 4, launchStamp: 5 },
      },
      expected: ['outer/a/pre'],
    },
    {
      name: 'keys containing a slash resolve to the longest matching sibling item',
      id: 'review/a/b/s',
      mapItems: [scope('review/', ['a', 'a/b'], 'a/b')],
      source: {
        'review/a/s': { seq: 1, launchStamp: 0, settleStamp: 1 },
        'review/a/b/s': { seq: 2, launchStamp: 5 },
      },
      expected: [],
    },
    {
      name: 'a root step after the map depends on every item',
      id: 'summary',
      source: {
        'review/0/s3': { seq: 1, launchStamp: 0, settleStamp: 1 },
        'review/1/s3': { seq: 2, launchStamp: 0, settleStamp: 2 },
        summary: { seq: 3, launchStamp: 5 },
      },
      target: { 'review/0/s3': reused('review/0/s3') },
      expected: ['review/1/s3'],
    },
    {
      name: 'target live work settled before the launch blocks',
      source: { x: { seq: 1, launchStamp: 0 } },
      target: { fresh: { settleStamp: 2 }, atLaunch: { settleStamp: 3 } },
      expected: ['fresh', 'atLaunch'],
    },
    {
      name: 'target live work settled after the launch, or still running, does not block',
      source: { x: { seq: 1, launchStamp: 0 } },
      target: { later: { settleStamp: 4 }, running: {} },
      expected: [],
    },
    {
      name: 'target reused steps never block as live work',
      source: { x: { seq: 1, launchStamp: 0 } },
      target: { y: reused('y') },
      expected: [],
    },
    {
      name: 'live work in a sibling named-map item does not block',
      id: 'review/2/s1',
      mapItems: [review('2')],
      source: { 'review/2/s1': { seq: 1, launchStamp: 0 } },
      target: { 'review/0/s3': { settleStamp: 1 } },
      expected: [],
    },
    {
      name: 'a step both unreused in the source and live in the target is reported once',
      source: { y: { seq: 1, launchStamp: 0, settleStamp: 1 }, x: { seq: 2, launchStamp: 5 } },
      target: { y: { settleStamp: 2 } },
      expected: ['y'],
    },
    {
      name: 'the requested ID is excluded on both sides',
      source: { x: { seq: 1, launchStamp: 0, settleStamp: 1 } },
      target: { x: { settleStamp: 1 } },
      expected: [],
    },
  ];

  it.each(cases)('$name', (testCase) => {
    const facts: ForkPrefixFacts = {
      id: testCase.id ?? 'x',
      launchStamp: testCase.launchStamp ?? 3,
      mapItems: testCase.mapItems ?? [],
      sourceRunId: 'src',
      source: testCase.source,
      target: testCase.target ?? {},
    };
    expect(forkPrefixBlockers(facts)).toEqual(testCase.expected);
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
      'Dry-run does not simulate this Git worktree effect: it synthesizes fresh isolated agent calls and merges of unchanged changes, but not ctx.worktree, effects isolated on a worktree handle, or merges of captured commits. Use a fixture harness in a temporary repository to rehearse these without paid calls.',
    ],
  ];

  it.each(cases)('%j', (refusal, message) => {
    expect(replayRefusalMessage('a/b', refusal)).toBe(message);
  });
});

describe('decideSettledMapReplay', () => {
  const components: MapComponents = { items: 'i', mapper: 'm', version: 'v', cwd: 'c', keys: 'k' };
  const saved = (
    overrides: Partial<NonNullable<SettledMapInput['saved']>> = {},
  ): SettledMapInput['saved'] => ({
    fingerprint: 'old',
    components,
    committed: true,
    ...overrides,
  });
  const facts = (overrides: Partial<SettledMapInput>): SettledMapInput => ({
    saved: saved(),
    fingerprint: 'new',
    components,
    acceptCodeChange: false,
    ...overrides,
  });
  const cases: { name: string; input: SettledMapInput; outcome: SettledMapReplay }[] = [
    { name: 'no saved journal', input: facts({ saved: undefined }), outcome: { kind: 'reset' } },
    {
      name: 'same aggregate',
      input: facts({ fingerprint: 'old' }),
      outcome: { kind: 'reuse', backfill: false },
    },
    {
      name: 'same aggregate without saved components backfills',
      input: facts({ saved: saved({ components: undefined }), fingerprint: 'old' }),
      outcome: { kind: 'reuse', backfill: true },
    },
    {
      name: 'changed, nothing committed',
      input: facts({
        saved: saved({ committed: false }),
        components: { ...components, items: 'x' },
      }),
      outcome: { kind: 'reset' },
    },
    {
      name: 'changed legacy journal, nothing committed',
      input: facts({ saved: saved({ committed: false, components: undefined }) }),
      outcome: { kind: 'reset' },
    },
    {
      name: 'mapper only, accepted',
      input: facts({ components: { ...components, mapper: 'x' }, acceptCodeChange: true }),
      outcome: { kind: 'accept' },
    },
    {
      name: 'mapper only, not accepted',
      input: facts({ components: { ...components, mapper: 'x' } }),
      outcome: { kind: 'refuse', changed: ['mapper'] },
    },
    {
      name: 'items under acceptance',
      input: facts({ components: { ...components, items: 'x' }, acceptCodeChange: true }),
      outcome: { kind: 'refuse', changed: ['items'] },
    },
    {
      name: 'version and cwd under acceptance',
      input: facts({
        components: { ...components, version: 'x', cwd: 'x' },
        acceptCodeChange: true,
      }),
      outcome: { kind: 'refuse', changed: ['version', 'cwd'] },
    },
    {
      name: 'mapper and items under acceptance',
      input: facts({
        components: { ...components, mapper: 'x', items: 'x' },
        acceptCodeChange: true,
      }),
      outcome: { kind: 'refuse', changed: ['items', 'mapper'] },
    },
    {
      name: 'keys present on one side only',
      input: facts({
        components: { items: 'i', mapper: 'm', version: 'v', cwd: 'c' },
        acceptCodeChange: true,
      }),
      outcome: { kind: 'refuse', changed: ['keys'] },
    },
    {
      name: 'aggregate differs with equal components',
      input: facts({ acceptCodeChange: true }),
      outcome: { kind: 'refuse', changed: [] },
    },
    {
      name: 'legacy committed journal under acceptance',
      input: facts({ saved: saved({ components: undefined }), acceptCodeChange: true }),
      outcome: { kind: 'refuse-legacy' },
    },
  ];

  it.each(cases)('$name', ({ input, outcome }) => {
    expect(decideSettledMapReplay(input)).toEqual(outcome);
  });
});

describe('settledMapRefusalMessage', () => {
  const cases: [Extract<SettledMapReplay, { kind: 'refuse' | 'refuse-legacy' }>, string][] = [
    [
      { kind: 'refuse', changed: ['mapper'] },
      'Settled map a/m changed after an item completed (changed: mapper). Resume with --accept-code-change to keep completed item outcomes and run unfinished items with the new mapper, or fork a new run. A thin mapper such as (item) => handle(ctx, item) keeps helper edits out of map identity.',
    ],
    [
      { kind: 'refuse', changed: ['items', 'keys'] },
      'Settled map a/m changed after an item completed (changed: items, keys); --accept-code-change accepts only a mapper change. Fork a new run.',
    ],
    [
      { kind: 'refuse', changed: ['items', 'mapper'] },
      'Settled map a/m changed after an item completed (changed: items, mapper); --accept-code-change accepts only a mapper change. Fork a new run.',
    ],
    [
      { kind: 'refuse', changed: [] },
      'Settled map a/m changed after an item completed (changed: identity); --accept-code-change accepts only a mapper change. Fork a new run.',
    ],
    [
      { kind: 'refuse-legacy' },
      'Settled map a/m changed after an item completed; its journal predates per-component fingerprints, so the changed component is unknown. Fork a new run.',
    ],
  ];

  it.each(cases)('%j', (refusal, message) => {
    expect(settledMapRefusalMessage('a/m', refusal)).toBe(message);
  });
});
