// The unfinished-identity rule for child frames (#240), checked over hand-built records so states
// that are awkward to reach end to end, such as superseded frames, compacted descendants and
// corrupt parent cycles, are covered directly.
import { describe, expect, it } from 'vitest';
import type { ChildRecord } from '../src/index.js';
import { frameRedefinition } from '../src/workflow/runtime/child-identity.js';
import { validateRecordChange, type RunRecord } from '../src/workflow/runtime/record.js';

const at = '2026-01-01T00:00:00.000Z';
const frame = (overrides: Partial<ChildRecord> = {}): ChildRecord => ({
  declared: true,
  label: 'kid',
  workflow: { name: 'kid', version: '1' },
  parent: null,
  depth: 1,
  inputDigest: 'input',
  schemaDigest: 'schema',
  status: 'failed',
  startedAt: at,
  finishedAt: at,
  error: 'kid broke',
  ...overrides,
});
const step = (status: string, frameId?: string | null) => ({
  status,
  ...(frameId === undefined ? {} : { frame: frameId }),
});
const record = (parts: {
  children?: Record<string, ChildRecord>;
  steps?: Record<string, unknown>;
  maps?: Record<string, unknown>;
}): RunRecord => ({ steps: {}, ...parts }) as unknown as RunRecord;
const settledOutcome = (children: string[] = []) => ({
  outcome: { ok: true as const, value: null },
  steps: [],
  maps: [],
  children,
});
const mapItem = (status: 'running' | 'completed', children: string[] = []) => ({
  status,
  outcome: null,
  steps: [],
  maps: [],
  children,
});

describe('frameRedefinition', () => {
  it.each(['failed', 'cancelled', 'superseded'] as const)(
    'accepts a %s frame with no terminal work',
    (status) => {
      const run = record({
        children: { kid: frame({ status }) },
        steps: { 'kid/a': step('failed', 'kid'), 'kid/b': step('cancelled', 'kid') },
        maps: { 'kid/m': { items: [mapItem('running')] } },
      });
      expect(frameRedefinition(run, 'kid')).toEqual({ redefinable: true });
    },
  );

  it.each(['running', 'suspended', 'completed'] as const)('refuses a %s frame', (status) => {
    expect(frameRedefinition(record({ children: { kid: frame({ status }) } }), 'kid')).toEqual({
      redefinable: false,
      reason: 'status',
    });
  });

  it('refuses a settled frame and an unknown frame', () => {
    const settled = frame({ onError: 'return', settled: settledOutcome() });
    expect(frameRedefinition(record({ children: { kid: settled } }), 'kid')).toMatchObject({
      reason: 'status',
    });
    expect(frameRedefinition(record({ children: {} }), 'kid')).toMatchObject({
      reason: 'status',
    });
  });

  it('refuses a frame owned by a completed map item, directly or through an ancestor', () => {
    const children = {
      'items/0/outer': frame({ label: 'outer' }),
      'items/0/outer/kid': frame({ parent: 'items/0/outer', depth: 2 }),
    };
    const owned = record({
      children,
      maps: { items: { items: [mapItem('completed', ['items/0/outer'])] } },
    });
    expect(frameRedefinition(owned, 'items/0/outer/kid')).toEqual({
      redefinable: false,
      reason: 'owned',
      owner: 'settled map items item 0',
    });
    const running = record({
      children,
      maps: { items: { items: [mapItem('running', ['items/0/outer'])] } },
    });
    expect(frameRedefinition(running, 'items/0/outer/kid')).toEqual({ redefinable: true });
  });

  it('refuses a frame under a settled ancestor or listed by a settled frame', () => {
    const outer = frame({ label: 'outer', onError: 'return', settled: settledOutcome() });
    expect(
      frameRedefinition(
        record({ children: { outer, 'outer/kid': frame({ parent: 'outer', depth: 2 }) } }),
        'outer/kid',
      ),
    ).toEqual({ redefinable: false, reason: 'owned', owner: 'settled frame outer' });
    const lister = frame({ label: 'lister', onError: 'return', settled: settledOutcome(['kid']) });
    expect(frameRedefinition(record({ children: { lister, kid: frame() } }), 'kid')).toEqual({
      redefinable: false,
      reason: 'owned',
      owner: 'settled frame lister',
    });
  });

  it('finds terminal steps by frame attribution and, without it, by ID prefix', () => {
    const children = { kid: frame() };
    expect(
      frameRedefinition(
        record({ children, steps: { elsewhere: step('completed', 'kid') } }),
        'kid',
      ),
    ).toEqual({ redefinable: false, reason: 'terminal-work', terminal: ['elsewhere'] });
    expect(
      frameRedefinition(
        record({
          children,
          steps: { 'kid/done': step('settled-failed'), 'kidney/done': step('completed') },
        }),
        'kid',
      ),
    ).toEqual({ redefinable: false, reason: 'terminal-work', terminal: ['kid/done'] });
  });

  it('finds settled maps with a completed item and completed or settled descendant frames', () => {
    const run = record({
      children: {
        kid: frame(),
        'kid/done': frame({ parent: 'kid', depth: 2, status: 'completed' }),
        'kid/settled': frame({
          parent: 'kid',
          depth: 2,
          onError: 'return',
          settled: { ...settledOutcome(), outcome: { ok: true, value: null } },
        }),
        'kid/open': frame({ parent: 'kid', depth: 2 }),
      },
      maps: {
        'kid/m': { items: [mapItem('running'), mapItem('completed')] },
        'other/m': { items: [mapItem('completed')] },
      },
    });
    expect(frameRedefinition(run, 'kid')).toEqual({
      redefinable: false,
      reason: 'terminal-work',
      terminal: ['kid/m', 'kid/done', 'kid/settled'],
    });
    expect(frameRedefinition(run, 'kid/open')).toEqual({ redefinable: true });
  });

  it('finds a settled map outside the prefix by its recorded frame or, before it, its owned work', () => {
    const children = {
      kid: frame(),
      'kid/grand': frame({ parent: 'kid', depth: 2, label: 'grand' }),
      other: frame({ label: 'other' }),
    };
    const bound = (map: Record<string, unknown>) => record({ children, maps: { 'shared/m': map } });
    // Revision 8 records the frame that ran the map, so an effect-free mapper still counts.
    for (const owner of ['kid', 'kid/grand'])
      expect(
        frameRedefinition(bound({ frame: owner, items: [mapItem('completed')] }), 'kid'),
      ).toEqual({ redefinable: false, reason: 'terminal-work', terminal: ['shared/m'] });
    expect(
      frameRedefinition(bound({ frame: 'other', items: [mapItem('completed')] }), 'kid'),
    ).toEqual({ redefinable: true });
    expect(frameRedefinition(bound({ frame: 'kid', items: [mapItem('running')] }), 'kid')).toEqual({
      redefinable: true,
    });
    // A journal saved before the field counts through a completed item's steps or children.
    const legacy = (item: Record<string, unknown>, steps: Record<string, unknown> = {}) =>
      record({ children, steps, maps: { 'shared/m': { items: [item] } } });
    expect(
      frameRedefinition(
        legacy(
          { ...mapItem('completed'), steps: ['shared/m/0/x'] },
          {
            'shared/m/0/x': step('failed', 'kid/grand'),
          },
        ),
        'kid',
      ),
    ).toEqual({ redefinable: false, reason: 'terminal-work', terminal: ['shared/m'] });
    expect(frameRedefinition(legacy({ ...mapItem('completed'), steps: ['kid/x'] }), 'kid')).toEqual(
      { redefinable: false, reason: 'terminal-work', terminal: ['shared/m'] },
    );
    expect(frameRedefinition(legacy(mapItem('completed', ['kid/grand'])), 'kid')).toEqual({
      redefinable: false,
      reason: 'terminal-work',
      terminal: ['shared/m'],
    });
    expect(
      frameRedefinition(
        legacy(
          { ...mapItem('completed', ['other']), steps: ['shared/m/0/x'] },
          {
            'shared/m/0/x': step('failed', 'other'),
          },
        ),
        'kid',
      ),
    ).toEqual({ redefinable: true });
    expect(
      frameRedefinition(
        legacy(
          { ...mapItem('running'), steps: ['shared/m/0/x'] },
          {
            'shared/m/0/x': step('failed', 'kid'),
          },
        ),
        'kid',
      ),
    ).toEqual({ redefinable: true });
  });

  it('counts a completed settled map over no items as terminal work', () => {
    const children = { kid: frame(), other: frame({ label: 'other' }) };
    const maps = (map: Record<string, unknown>, id = 'shared/m') =>
      record({ children, maps: { [id]: { items: [], ...map } } });
    expect(frameRedefinition(maps({ frame: 'kid', status: 'completed' }), 'kid')).toEqual({
      redefinable: false,
      reason: 'terminal-work',
      terminal: ['shared/m'],
    });
    // A journal saved before `frame` existed is placed by its prefix alone.
    expect(frameRedefinition(maps({ status: 'completed' }, 'kid/m'), 'kid')).toEqual({
      redefinable: false,
      reason: 'terminal-work',
      terminal: ['kid/m'],
    });
    expect(frameRedefinition(maps({ status: 'completed' }), 'kid')).toEqual({ redefinable: true });
    expect(frameRedefinition(maps({ frame: 'other', status: 'completed' }), 'kid')).toEqual({
      redefinable: true,
    });
    expect(frameRedefinition(maps({ frame: 'kid', status: 'running' }), 'kid')).toEqual({
      redefinable: true,
    });
  });

  it('follows parent links to compacted child IDs and their effects', () => {
    const hash = `child:${'a'.repeat(64)}`;
    const deeper = `child:${'b'.repeat(64)}`;
    const children = {
      kid: frame(),
      [hash]: frame({ parent: 'kid', depth: 2, label: 'long' }),
      [deeper]: frame({ parent: hash, depth: 3, label: 'longer' }),
    };
    expect(frameRedefinition(record({ children }), 'kid')).toEqual({ redefinable: true });
    expect(
      frameRedefinition(record({ children, steps: { [`${deeper}/x`]: step('completed') } }), 'kid'),
    ).toEqual({ redefinable: false, reason: 'terminal-work', terminal: [`${deeper}/x`] });
    expect(
      frameRedefinition(
        record({ children, maps: { [`${hash}/m`]: { items: [mapItem('completed')] } } }),
        'kid',
      ),
    ).toEqual({ redefinable: false, reason: 'terminal-work', terminal: [`${hash}/m`] });
    expect(
      frameRedefinition(
        record({
          children: {
            ...children,
            [deeper]: frame({ parent: hash, depth: 3, label: 'longer', status: 'completed' }),
          },
        }),
        'kid',
      ),
    ).toEqual({ redefinable: false, reason: 'terminal-work', terminal: [deeper] });
  });

  it('terminates on a parent cycle', () => {
    const run = record({
      children: {
        a: frame({ parent: 'b', label: 'a' }),
        b: frame({ parent: 'a', label: 'b' }),
        c: frame({ parent: 'c', label: 'c' }),
      },
    });
    expect(frameRedefinition(run, 'a')).toEqual({ redefinable: true });
    expect(frameRedefinition(run, 'c')).toEqual({ redefinable: true });
  });
});

describe('redefinition history record shape', () => {
  const history = {
    workflow: { name: 'kid', version: '1' },
    schemaDigest: 'schema',
    inputDigest: 'input',
    redefinedAt: at,
  };

  it('accepts a frame with redefinitions and rejects a malformed entry', () => {
    expect(() => {
      validateRecordChange('children', 'kid', frame({ redefinitions: [history] }));
    }).not.toThrow();
    expect(() => {
      validateRecordChange('children', 'kid', {
        ...frame(),
        redefinitions: [{ ...history, redefinedAt: 'yesterday' }],
      });
    }).toThrow();
    expect(() => {
      validateRecordChange('children', 'kid', {
        ...frame(),
        redefinitions: [{ ...history, workflow: { name: '', version: '1' } }],
      });
    }).toThrow();
  });
});

describe('settled map frame record shape', () => {
  it('accepts a map journal with or without its frame and rejects a non-string frame', () => {
    const journal = { fingerprint: 'f', status: 'completed', items: [mapItem('completed')] };
    expect(() => {
      validateRecordChange('maps', 'shared/m', { ...journal, frame: 'kid' });
    }).not.toThrow();
    expect(() => {
      validateRecordChange('maps', 'shared/m', journal);
    }).not.toThrow();
    expect(() => {
      validateRecordChange('maps', 'shared/m', { ...journal, frame: 1 });
    }).toThrow();
  });
});
