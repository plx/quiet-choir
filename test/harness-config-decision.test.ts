import { describe, expect, it } from 'vitest';

import {
  harnessConfigRefusal,
  type HarnessConfigCheck,
} from '../src/workflow/runtime/harness-config-decision.js';

// The harness configuration rule as a pure table, shared by runWorkflow and workflow tick.
const recorded = 'a'.repeat(64);
const supplied = 'b'.repeat(64);

function check(overrides: Partial<HarnessConfigCheck> = {}): HarnessConfigCheck {
  return {
    runId: 'run',
    previous: { kind: 'cli', previousKinds: [], configDigest: recorded },
    requestedKind: 'cli',
    requestedConfigDigest: supplied,
    allowHarnessConfigChange: false,
    ...overrides,
  };
}

describe('harnessConfigRefusal', () => {
  it.each<[string, Partial<HarnessConfigCheck>]>([
    ['no recorded harness', { previous: undefined }],
    ['no recorded digest', { previous: { kind: 'cli', previousKinds: [] } }],
    ['no supplied digest', { requestedConfigDigest: undefined }],
    ['a different kind', { requestedKind: 'fixture' }],
    [
      "the reserved kind 'none'",
      {
        previous: { kind: 'none', previousKinds: [], configDigest: recorded },
        requestedKind: 'none',
      },
    ],
    ['equal digests', { requestedConfigDigest: recorded }],
    ['an accepted change', { allowHarnessConfigChange: true }],
  ])('allows the resume with %s', (_name, overrides) => {
    expect(harnessConfigRefusal(check(overrides))).toBeUndefined();
  });

  it('refuses a changed configuration with both digest prefixes and the two remedies', () => {
    expect(harnessConfigRefusal(check({ runId: 'nightly' }))).toEqual({
      message:
        'Run nightly last executed with a different harness configuration (sha256 aaaaaaaaaaaa); this invocation supplies bbbbbbbbbbbb. Repeat the original --harness-config, or pass --allow-harness-config-change to accept the change.',
      details: { previousConfigDigest: recorded, requestedConfigDigest: supplied },
    });
  });

  it('applies to any kind other than none, not only the CLI', () => {
    expect(
      harnessConfigRefusal(
        check({
          previous: { kind: 'fixture', previousKinds: ['cli'], configDigest: recorded },
          requestedKind: 'fixture',
        }),
      ),
    ).toMatchObject({ details: { previousConfigDigest: recorded } });
  });
});
