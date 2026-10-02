import { describe, expect, it } from 'vitest';

import {
  chooseRecoveryHint,
  type RecoveryCause,
  type RecoveryHintInput,
} from '../src/workflow/runtime/recovery-hint.js';

// ADR 0006 recovery advice as a pure table: no state directory, store or workflow run.
const defaults: RecoveryHintInput = {
  cause: { kind: 'effect' },
  rehearsal: false,
  recordedWork: true,
  allTerminal: false,
  sourceChanged: false,
  runId: 'run-1',
};
const causes: readonly RecoveryCause[] = [
  { kind: 'grant', profile: 'fixer', access: 'write' },
  { kind: 'divergence' },
  { kind: 'configuration' },
  { kind: 'authoring' },
  { kind: 'effect' },
  { kind: 'cancelled' },
];
const hint = (input: Partial<RecoveryHintInput>): string | undefined =>
  chooseRecoveryHint({ ...defaults, ...input });

const refinalize =
  'All recorded work has terminal outcomes, including settled map items. Fix the workflow tail, output or configuration and use --resume --accept-code-change to re-finalize; unchanged identities reuse their results.';
const fixThenResume =
  'Fix the workflow or its configuration, then resume; add --accept-code-change if the fix edits workflow code or schemas. Completed steps are reused.';
const plainResume =
  'Resume with --resume once the cause is fixed or has passed; completed steps are reused and the failed step runs again.';
const cancelledResume = 'Resume with --resume to continue; completed steps are reused.';
const grant =
  'Grant the access, then resume: --resume --grant fixer (or --grant write, or --grant all); completed steps are reused.';
const nondeterminism =
  'The workflow source is unchanged, so the body likely computed a value outside a durable effect (time, randomness, environment or file contents) that changed a step identity or the replay path. Compute such values with ctx.now or inside ctx.step so replay reuses them, then fork a new run with --fork-from run-1; --resume --strict-replay stops at the first divergence before live work.';
const changedPath =
  'Replay left the recorded path after the accepted source change. Restore the replay path, or fork a new run with --fork-from run-1; --resume --strict-replay stops at the first divergence before live work.';

describe('chooseRecoveryHint', () => {
  it.each(
    causes.flatMap((cause) =>
      [true, false].flatMap((allTerminal) =>
        [true, false].map((sourceChanged) => ({ cause, allTerminal, sourceChanged })),
      ),
    ),
  )('gives no hint under rehearsal or without recorded work: %j', (facts) => {
    expect(hint({ ...facts, rehearsal: true })).toBeUndefined();
    expect(hint({ ...facts, recordedWork: false })).toBeUndefined();
    expect(hint({ ...facts, rehearsal: true, recordedWork: false })).toBeUndefined();
  });

  // [cause, allTerminal, sourceChanged, expected hint]
  const table: readonly (readonly [RecoveryCause['kind'], boolean, boolean, string])[] = [
    ['grant', false, false, grant],
    ['grant', true, false, grant],
    ['grant', true, true, grant],
    ['divergence', false, false, nondeterminism],
    ['divergence', true, false, nondeterminism],
    ['divergence', false, true, changedPath],
    ['divergence', true, true, changedPath],
    ['configuration', true, false, refinalize],
    ['configuration', true, true, refinalize],
    ['configuration', false, false, fixThenResume],
    ['configuration', false, true, fixThenResume],
    ['authoring', true, false, refinalize],
    ['authoring', true, true, refinalize],
    ['authoring', false, false, fixThenResume],
    ['authoring', false, true, fixThenResume],
    ['effect', false, false, plainResume],
    ['effect', true, false, plainResume],
    ['effect', false, true, plainResume],
    ['cancelled', false, false, cancelledResume],
    ['cancelled', true, true, cancelledResume],
  ];
  it.each(table)(
    '%s, allTerminal %s, sourceChanged %s',
    (kind, allTerminal, sourceChanged, text) => {
      const cause = causes.find((candidate) => candidate.kind === kind);
      if (!cause) throw new Error(kind);
      const chosen = hint({ cause, allTerminal, sourceChanged });
      expect(chosen).toBe(text);
      // Only a configuration or authoring failure suggests accepting a code change.
      expect(chosen?.includes('--accept-code-change')).toBe(
        kind === 'configuration' || kind === 'authoring',
      );
    },
  );

  it('keeps the re-finalize phrases that scripts and docs match on', () => {
    const chosen = hint({ cause: { kind: 'authoring' }, allTerminal: true });
    expect(chosen).toContain('All recorded work has terminal outcomes');
    expect(chosen).toContain('re-finalize');
    expect(chosen).toContain('--resume --accept-code-change');
  });

  it('names grants, not code acceptance, for a grant failure', () => {
    const chosen = hint({ cause: { kind: 'grant', profile: 'edit', access: 'exec' } });
    expect(chosen).toContain('--resume --grant edit');
    expect(chosen).toContain('--grant exec');
    expect(chosen).not.toContain('accept-code-change');
  });

  it('blames a body-computed value for a divergence with unchanged source', () => {
    const chosen = hint({ cause: { kind: 'divergence' }, runId: 'nightly' });
    for (const phrase of ['ctx.now', 'ctx.step', '--strict-replay', '--fork-from nightly'])
      expect(chosen).toContain(phrase);
    expect(chosen).not.toContain('accept-code-change');
    const changed = hint({ cause: { kind: 'divergence' }, sourceChanged: true });
    expect(changed).toContain('--strict-replay');
    expect(changed).not.toContain('accept-code-change');
  });
});
