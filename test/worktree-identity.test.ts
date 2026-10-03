// worktree is the only public checkout selector (#340), but the pre-#340 spellings still run and
// must fingerprint exactly as before, so recorded checkpoints resume after a source migration.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveIsolation } from '../src/harness-kit.js';
import { isolationParts } from '../src/workflow/runtime/agent-isolation.js';
import { agentIdentity } from '../src/workflow/runtime/identity.js';
import { legacyAgentIdentity } from '../src/workflow/runtime/legacy-agent.js';
import { isolationIdentity } from '../src/workflow/runtime/worktree-identity.js';
import { resolveWorktree } from '../src/workflow/runtime/worktree-schema.js';

const commit = 'a'.repeat(40);
const handle = { id: 'h-1', path: '/cache/h-1', base: commit };
const head = { kind: 'worktree', base: 'HEAD' };
const both =
  'Choose worktree or a legacy worktree isolation value, not both; use worktree: true | { base } | handle.';

const identityDigest = (identity: Readonly<Record<string, string>>): string =>
  createHash('sha256')
    .update(
      JSON.stringify(Object.entries(identity).sort(([left], [right]) => (left < right ? -1 : 1))),
    )
    .digest('hex');

describe('isolationIdentity', () => {
  it.each([
    [true, head],
    [{}, head],
    ['worktree', head],
    [{ kind: 'worktree' }, head],
    [{ base: 'main' }, { kind: 'worktree', base: 'main' }],
    [
      { kind: 'worktree', base: 'main' },
      { kind: 'worktree', base: 'main' },
    ],
    [{ base: { commit } }, { kind: 'worktree', base: { commit } }],
    [
      { kind: 'worktree', base: { commit } },
      { kind: 'worktree', base: { commit } },
    ],
    [handle, { id: 'h-1', base: commit }],
  ])('maps %j to one identity without a checkout path', (selection, expected) => {
    expect(isolationIdentity(selection)).toEqual(expected);
    expect(JSON.stringify(isolationIdentity(selection))).toBe(JSON.stringify(expected));
  });

  it('rejects values that select no checkout', () => {
    for (const value of [false, 'restricted', { kind: 'other' }, { base: '' }, { id: 'h' }])
      expect(() => isolationIdentity(value)).toThrow();
  });

  it('resolves every accepted spelling to the canonical base or handle', () => {
    expect(resolveWorktree(true)).toEqual({});
    expect(resolveWorktree('worktree')).toEqual({});
    expect(resolveWorktree({ kind: 'worktree', base: 'main' })).toEqual({ base: 'main' });
    expect(resolveWorktree({ base: { commit } })).toEqual({ base: { commit } });
    expect(resolveWorktree(handle)).toEqual(handle);
  });
});

// Digests computed on origin/main (c338a4b) before #340, for the pinned request below.
const golden = {
  claude: {
    head: 'bec3e7f03ee7a6ec5593d9bef01e515af640721d3975c7bba36f5fde3bab3aea',
    main: 'b883d5689e6dc0a1bdb2c6479f0b9bd037e32704877008a03e00a012276ac06e',
    commit: '3e04775897e471ed57d9fe3bb90a1a1bdc0691b7fa89adf7ae99bab2d8fc3bdf',
    handle: 'd8c8300c1dd9fff870baa077a90be0d7c36b9914ffe9aa4a87966ceb92b28c36',
  },
  codex: {
    head: '209a61d91556650df81b754289568f37a1073323a8d0366377cd80b9915d5b48',
    main: '1dc60c5cde5e66ad6dc6ad6e726b7defc6984af1eb2bdfd14afff160bcdfe0b0',
    commit: '74d9c5faa461a19a3944bb15117bc9d5ce77d489de1a5361504e1d9a078d3533',
    handle: 'fd7114d7bb46dbcee43d5af3a8b68af24aee90596489f2b7330717aba0a7dddc',
  },
  registered: {
    head: 'bd84605e451b76f41ef6fb81ac1af286da130aed11d63e10f0f9d75b64114a09',
    main: '01a70b7c6c6551aa070114012a5ce27edf1ccad84303d296b4bc9527f1f3da34',
    handle: 'a91b8299b447cf6a07c514142ed05c324be4460be6fa3ee08b9ceca01f693bfe',
  },
} as const;

/** Old spellings, then the new spelling they migrate to, for each golden selection. */
const spellings = {
  head: [{ isolation: 'worktree' }, { worktree: 'worktree' }, { worktree: { kind: 'worktree' } }],
  main: [
    { isolation: { kind: 'worktree', base: 'main' } },
    { worktree: { kind: 'worktree', base: 'main' } },
  ],
  commit: [{ isolation: { kind: 'worktree', base: { commit } } }],
  handle: [{ isolation: handle }],
} as const;
const migrated = {
  head: [{ worktree: true }, { worktree: {} }],
  main: [{ worktree: { base: 'main' } }],
  commit: [{ worktree: { base: { commit } } }],
  handle: [{ worktree: handle }],
} as const;

describe('legacyAgentIdentity', () => {
  const identity = (harness: 'claude' | 'codex', options: object) =>
    identityDigest(
      legacyAgentIdentity(
        {
          harness,
          cwd: '/pinned/cwd',
          outputSchema: null,
          options: { prompt: 'pinned prompt', ...options },
        },
        { type: 'object' },
      ),
    );

  it.each(['claude', 'codex'] as const)(
    'fingerprints old and new %s spellings identically, matching main',
    (harness) => {
      for (const key of Object.keys(spellings) as (keyof typeof spellings)[])
        for (const options of [...spellings[key], ...migrated[key]])
          expect(identity(harness, options), `${key} ${JSON.stringify(options)}`).toBe(
            golden[harness][key],
          );
    },
  );

  it('still refuses both a worktree and a legacy worktree isolation', () => {
    for (const isolation of ['worktree', handle, { kind: 'worktree' }])
      expect(() => identity('claude', { worktree: true, isolation })).toThrow(both);
  });
});

it('fingerprints old and new spellings identically on a registered harness, matching main', () => {
  // Registered options skip isolationParts; agentIdentity normalizes their worktree itself.
  const identity = (worktree: unknown) =>
    identityDigest(
      agentIdentity(
        {
          harness: 'fixture',
          revision: 2,
          cwd: '/pinned/cwd',
          outputSchema: null,
          options: { prompt: 'pinned prompt', worktree },
        } as never,
        { type: 'object' },
      ),
    );
  for (const worktree of [true, {}, 'worktree', { kind: 'worktree' }])
    expect(identity(worktree)).toBe(golden.registered.head);
  for (const worktree of [{ base: 'main' }, { kind: 'worktree', base: 'main' }])
    expect(identity(worktree)).toBe(golden.registered.main);
  expect(identity(handle)).toBe(golden.registered.handle);
});

describe('isolationParts and resolveIsolation', () => {
  it.each([
    [{ isolation: 'worktree' }, { worktree: true }],
    [{ isolation: { kind: 'worktree' } }, { worktree: {} }],
    [{ isolation: { kind: 'worktree', base: 'main' } }, { worktree: { base: 'main' } }],
    [{ isolation: handle }, { worktree: handle }],
    [{ worktree: 'worktree' }, { worktree: true }],
    [{ worktree: { kind: 'worktree', base: { commit } } }, { worktree: { base: { commit } } }],
    [
      { worktree: true, isolation: 'inherit' },
      { worktree: true, isolation: 'inherit' },
    ],
    [{ worktree: { base: 'main' } }, { worktree: { base: 'main' } }],
    [
      { worktree: handle, isolation: 'restricted' },
      { worktree: handle, isolation: 'restricted' },
    ],
    [{ isolation: 'inherit' }, { isolation: 'inherit' }],
  ])('normalizes %j to the public form', (options, expected) => {
    expect(isolationParts({ prompt: 'x', ...options })).toEqual({ prompt: 'x', ...expected });
    expect(resolveIsolation({ prompt: 'x', ...options } as never)).toEqual({
      prompt: 'x',
      isolation: 'restricted',
      ...expected,
    });
  });

  it('refuses a worktree together with a legacy worktree isolation', () => {
    for (const isolation of ['worktree', { kind: 'worktree', base: 'main' }, handle]) {
      expect(() => isolationParts({ worktree: true, isolation })).toThrow(both);
      expect(() => resolveIsolation({ worktree: handle, isolation } as never)).toThrow(both);
    }
  });

  it('leaves an invalid selection for option validation to report', () => {
    expect(isolationParts({ worktree: 'elsewhere' })).toEqual({ worktree: 'elsewhere' });
    expect(isolationParts({ isolation: 'bogus' })).toEqual({ worktree: 'bogus' });
  });
});
