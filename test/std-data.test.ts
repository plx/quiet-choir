// quiet-choir/std data helpers: pure functions for settled results, voting, deduplication,
// ranking, map keys, checks, hashing and dependency waves. None of them takes a context.
import { describe, expect, it } from 'vitest';
import { stepId, type JsonValue, type Settled } from '../src/index.js';
import * as data from '../src/std/data.js';
import { digest as runtimeDigest } from '../src/workflow/runtime/json.js';

describe('settled results', () => {
  const results: Settled<number, string>[] = [
    { ok: true, value: 1 },
    { ok: false, error: 'x' },
    { ok: true, value: 3 },
    { ok: false, error: 'y' },
  ];

  it('splits values and errors in result order', () => {
    expect(data.oks(results)).toEqual([1, 3]);
    expect(data.failures(results)).toEqual(['x', 'y']);
    expect(data.oks([])).toEqual([]);
  });

  it('keeps array values whole', () => {
    expect(data.oks<number[], never>([{ ok: true, value: [1, 2] }])).toEqual([[1, 2]]);
  });
});

describe('voting', () => {
  it('computes a strict majority', () => {
    expect([1, 2, 3, 4, 5, 6].map(data.majority)).toEqual([1, 2, 2, 3, 3, 4]);
    expect(() => data.majority(0)).toThrow(
      new TypeError('seats must be an integer of at least 1; got 0.'),
    );
    expect(() => data.majority(2.5)).toThrow(TypeError);
  });

  it('resolves thresholds and rejects rules outside 1..seats', () => {
    expect(data.threshold('majority', 3)).toBe(2);
    expect(data.threshold('unanimous', 3)).toBe(3);
    expect(data.threshold({ atLeast: 1 }, 3)).toBe(1);
    expect(data.threshold({ atLeast: 3 }, 3)).toBe(3);
    expect(() => data.threshold({ atLeast: 4 }, 3)).toThrow(
      `Invalid vote rule {"atLeast":4}: expected 'majority', 'unanimous' or { atLeast: n } with n an integer from 1 to 3.`,
    );
    expect(() => data.threshold({ atLeast: 0 }, 3)).toThrow(TypeError);
    expect(() => data.threshold({ atLeast: 1.5 }, 3)).toThrow(TypeError);
    expect(() => data.threshold('most' as data.Rule, 3)).toThrow(/Invalid vote rule "most"/u);
    // Untyped callers get the rule message, not a property-access crash.
    expect(() => data.threshold(null as unknown as data.Rule, 3)).toThrow(
      new TypeError(
        `Invalid vote rule null: expected 'majority', 'unanimous' or { atLeast: n } with n an integer from 1 to 3.`,
      ),
    );
    expect(() => data.threshold(undefined as unknown as data.Rule, 3)).toThrow(
      /^Invalid vote rule undefined:/u,
    );
    expect(() => data.threshold({ atLeast: '2' } as unknown as data.Rule, 3)).toThrow(TypeError);
    expect(() => data.threshold('majority', 0)).toThrow(TypeError);
  });

  it('confirms, refutes or leaves undecided, never counting a missing seat', () => {
    expect(data.tally({ upheld: 2, against: 1, seats: 3 })).toEqual({
      outcome: 'confirmed',
      upheld: 2,
      against: 1,
      missing: 0,
      seats: 3,
    });
    expect(data.tally({ upheld: 1, against: 2, seats: 3 }).outcome).toBe('refuted');
    // One failed seat could still make two upholding votes: undecided.
    expect(data.tally({ upheld: 1, against: 1, seats: 3 })).toMatchObject({
      outcome: 'undecided',
      missing: 1,
    });
    // Two failed seats out of three: one vote is not a majority, nor is a refutation proven.
    expect(data.tally({ upheld: 0, against: 1, seats: 3 }).outcome).toBe('undecided');
    expect(data.tally({ upheld: 0, against: 0, seats: 3 }).outcome).toBe('undecided');
    expect(data.tally({ upheld: 2, against: 0, seats: 3 }).outcome).toBe('confirmed');
  });

  it('applies unanimous and atLeast rules', () => {
    expect(data.tally({ upheld: 2, against: 0, seats: 3 }, 'unanimous').outcome).toBe('undecided');
    expect(data.tally({ upheld: 2, against: 1, seats: 3 }, 'unanimous').outcome).toBe('refuted');
    expect(data.tally({ upheld: 3, against: 0, seats: 3 }, 'unanimous').outcome).toBe('confirmed');
    expect(data.tally({ upheld: 1, against: 2, seats: 3 }, { atLeast: 1 }).outcome).toBe(
      'confirmed',
    );
  });

  it('rejects impossible counts', () => {
    expect(() => data.tally({ upheld: 2, against: 2, seats: 3 })).toThrow(
      'upheld (2) plus against (2) exceeds seats (3).',
    );
    expect(() => data.tally({ upheld: -1, against: 0, seats: 3 })).toThrow(
      'upheld must be a nonnegative integer; got -1.',
    );
    expect(() => data.tally({ upheld: 0, against: 0, seats: 0 })).toThrow(TypeError);
  });
});

describe('deduplication', () => {
  const items = [
    { id: 'a', n: 1 },
    { id: 'b', n: 2 },
    { id: 'a', n: 3 },
    { id: 'c', n: 4 },
    { id: 'b', n: 5 },
  ];

  it('keeps the first occurrence in place, or merges duplicates into it', () => {
    expect(data.dedupeBy(items, (item) => item.id)).toEqual([
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
      { id: 'c', n: 4 },
    ]);
    const merged = data.dedupeBy(
      items,
      (item) => item.id,
      (kept, duplicate) => ({ id: kept.id, n: kept.n + duplicate.n }),
    );
    expect(merged).toEqual([
      { id: 'a', n: 4 },
      { id: 'b', n: 7 },
      { id: 'c', n: 4 },
    ]);
  });

  it('keeps only unseen items across rounds and records their keys', () => {
    const seen = new Set<string>(['x']);
    expect(data.fresh(['a', 'x', 'a', 'b'], seen, (item) => item)).toEqual(['a', 'b']);
    expect([...seen]).toEqual(['x', 'a', 'b']);
    expect(data.fresh(['b', 'c'], seen, (item) => item)).toEqual(['c']);
  });

  it('counts how many lists report each key, most corroborated first and stable', () => {
    const lists = [['a', 'b', 'b'], ['c', 'b'], ['a', 'b'], ['d']];
    expect(data.corroborate(lists, (item) => item)).toEqual([
      { key: 'b', item: 'b', count: 3 },
      { key: 'a', item: 'a', count: 2 },
      { key: 'c', item: 'c', count: 1 },
      { key: 'd', item: 'd', count: 1 },
    ]);
    const first = data.corroborate(
      [[{ k: 'x', from: 1 }], [{ k: 'x', from: 2 }]],
      (item) => item.k,
    );
    expect(first).toEqual([{ key: 'x', item: { k: 'x', from: 1 }, count: 2 }]);
  });
});

describe('ordering and selection', () => {
  it('chunks', () => {
    expect(data.chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(data.chunk([], 3)).toEqual([]);
    expect(() => data.chunk([1], 0)).toThrow('size must be an integer of at least 1; got 0.');
  });

  it('rotates a pool window per round', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'];
    expect(data.rotate(pool, 0, 3)).toEqual(['a', 'b', 'c']);
    expect(data.rotate(pool, 1, 3)).toEqual(['d', 'e', 'a']);
    expect(data.rotate(pool, 2, 3)).toEqual(['b', 'c', 'd']);
    expect(data.rotate(pool, 0, 9)).toEqual(pool);
    expect(data.rotate(pool, 3, 9)).toEqual(['c', 'd', 'e', 'a', 'b']);
    expect(data.rotate([], 4, 2)).toEqual([]);
    expect(data.rotate(pool, 4, 0)).toEqual([]);
    for (let round = 0; round < 20; round++) {
      const expected = [0, 1, 2].map((i) => pool[(round * 3 + i) % pool.length]);
      expect(data.rotate(pool, round, 3)).toEqual(expected);
    }
    expect(data.rotate(pool, Number.MAX_SAFE_INTEGER, 3)).toHaveLength(3);
    expect(() => data.rotate(pool, -1, 3)).toThrow(TypeError);
  });

  it('ranks stably by an order, with unknown values last', () => {
    const items = [
      { s: 'low', i: 0 },
      { s: 'critical', i: 1 },
      { s: 'odd', i: 2 },
      { s: 'high', i: 3 },
      { s: 'low', i: 4 },
      { s: 'critical', i: 5 },
      { s: 'medium', i: 6 },
    ];
    const order = ['critical', 'high', 'medium', 'low'] as const;
    const ranked = data.rankBy(items, (item) => item.s as (typeof order)[number], order);
    expect(ranked.map((item) => item.i)).toEqual([1, 5, 3, 6, 0, 4, 2]);
    const severities = items.map((item) => ({ severity: item.s, i: item.i }));
    expect(data.bySeverity(severities).map((item) => item.i)).toEqual([1, 5, 3, 6, 0, 4, 2]);
    expect(items[0]).toEqual({ s: 'low', i: 0 });
  });

  it('caps a stably sorted list and reports the deferred rest', () => {
    const items = [3, 1, 2, 5, 4];
    expect(data.rankCap(items, { cap: 2 })).toEqual({ chosen: [3, 1], deferred: [2, 5, 4] });
    expect(data.rankCap(items, { cap: 2, by: (a, b) => b - a })).toEqual({
      chosen: [5, 4],
      deferred: [3, 2, 1],
    });
    expect(data.rankCap(items, { cap: 0 })).toEqual({ chosen: [], deferred: items });
    expect(data.rankCap(items, { cap: 9 })).toEqual({ chosen: items, deferred: [] });
    expect(items).toEqual([3, 1, 2, 5, 4]);
    expect(() => data.rankCap(items, { cap: -1 })).toThrow(TypeError);
  });
});

describe('map keys', () => {
  it('passes clean unique labels through unchanged', () => {
    expect(data.uniqueKeys(['a', 'B-2', 'x.y:z'])).toEqual(['a', 'B-2', 'x.y:z']);
    expect(data.uniqueKeys([])).toEqual([]);
  });

  it('makes arbitrary and repeated labels unique, clean segments', () => {
    const labels = ['a', 'a', 'a.2', 'a', 'src/a.ts', 'src/a.ts', '', '_x', 'x'.repeat(80)];
    const keys = data.uniqueKeys(labels);
    expect(keys.slice(0, 4)).toEqual(['a', 'a.3', 'a.2', 'a.4']);
    expect(keys[4]).toBe(stepId('src/a.ts'));
    expect(keys[5]).toBe(`${stepId('src/a.ts')}.2`);
    expect(new Set(keys).size).toBe(labels.length);
    for (const key of keys) {
      expect(stepId(key)).toBe(key);
      expect(key.length).toBeLessThanOrEqual(64);
    }
  });

  it('keeps a suffixed long label within one segment', () => {
    const long = 'k'.repeat(64);
    const keys = data.uniqueKeys([long, long]);
    expect(keys[0]).toBe(long);
    expect(keys[1]).toBe(`${'k'.repeat(62)}.2`);
  });

  it('asserts uniqueness', () => {
    expect(() => {
      data.assertUnique(['a', 'b'], 'key');
    }).not.toThrow();
    expect(() => {
      data.assertUnique(['a', 'b', 'a', 'c', 'b', 'a'], 'task ID');
    }).toThrow('Duplicate task ID: "a", "b".');
  });
});

describe('ownership and coverage', () => {
  const label = (item: { name: string }): string => item.name;

  it('accepts disjoint ownership, including one owner of a directory and its files', () => {
    const items = [
      { name: 'a', files: ['src/a.ts', 'docs/'] },
      { name: 'b', files: ['src/b.ts', 'src/bb/'] },
      { name: 'c', files: ['src/c', 'src/c/x.ts'] },
    ];
    expect(() => {
      data.assertDisjoint(items, (item) => item.files, label);
    }).not.toThrow();
  });

  it('reports shared paths and nested ownership', () => {
    const items = [
      { name: 'a', files: ['src/a.ts', 'docs'] },
      { name: 'b', files: ['src/a.ts/'] },
      { name: 'c', files: ['docs/guide.md'] },
    ];
    expect(() => {
      data.assertDisjoint(items, (item) => item.files, label);
    }).toThrow(
      'Overlapping files: "src/a.ts" is claimed by a, b; "docs" (a) contains "docs/guide.md" (c).',
    );
  });

  it('treats the empty path as the repository root', () => {
    const items = [
      { name: 'all', files: [''] },
      { name: 'one', files: ['src/a.ts'] },
    ];
    expect(() => {
      data.assertDisjoint(items, (item) => item.files, label);
    }).toThrow('Overlapping files: "" (all) contains "src/a.ts" (one).');
    expect(() => {
      data.assertDisjoint(items.slice(0, 1), (item) => item.files, label);
    }).not.toThrow();
    expect(() => {
      data.assertDisjoint(
        [
          { name: 'x', files: ['/'] },
          { name: 'y', files: [''] },
        ],
        (item) => item.files,
        label,
      );
    }).toThrow('Overlapping files: "" is claimed by x, y.');
  });

  it('computes coverage in expected order', () => {
    expect(data.coverage(['a', 'b', 'c', 'a'], new Set(['c', 'a', 'z']))).toEqual({
      covered: ['a', 'c'],
      missing: ['b'],
    });
    expect(data.coverage([], ['a'])).toEqual({ covered: [], missing: [] });
  });
});

describe('hashing', () => {
  it('serializes canonically with sorted keys', () => {
    const a = { b: [1, { y: true, x: null }], a: 'é', c: { z: 1.5, 'k k': -0 } };
    const b = { c: { 'k k': 0, z: 1.5 }, a: 'é', b: [1, { x: null, y: true }] };
    expect(data.canonicalJson(a)).toBe(
      '{"a":"é","b":[1,{"x":null,"y":true}],"c":{"k k":0,"z":1.5}}',
    );
    expect(data.canonicalJson(a)).toBe(data.canonicalJson(b));
    expect(data.digest(a)).toBe(data.digest(b));
    expect(data.canonicalJson({ a: undefined, b: 1 } as unknown as JsonValue)).toBe('{"b":1}');
    expect(data.canonicalJson('x')).toBe('"x"');
  });

  it('sorts integer-like keys as strings', () => {
    expect(data.canonicalJson({ 9: 'a', 10: 'b', x: [] })).toBe('{"10":"b","9":"a","x":[]}');
  });

  it('matches the runtime digest for ordinary values', () => {
    const values: JsonValue[] = [
      null,
      0,
      'text',
      [1, 'two', [3]],
      { z: { b: 1, a: [true] }, a: 2 },
    ];
    for (const value of values) expect(data.digest(value)).toBe(runtimeDigest(value));
  });

  it('hashes UTF-8 text', () => {
    expect(data.sha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(data.sha256('é')).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects values that are not plain JSON', () => {
    const holey: unknown[] = [];
    holey[1] = 2;
    const cases: [unknown, string][] = [
      [Number.NaN, '$: NaN is not a finite number'],
      [{ a: [1, undefined] }, '$.a[1]: arrays cannot contain undefined'],
      [holey, '$[0]: arrays cannot have holes'],
      [{ d: new Date(0) }, '$.d: values must be plain objects, not class instances'],
      [{ f: () => 1 }, '$.f: function is not a JSON value'],
      [1n, '$: bigint is not a JSON value'],
    ];
    for (const [value, message] of cases) {
      expect(() => data.canonicalJson(value as JsonValue)).toThrow(
        new TypeError(`Value is not canonical JSON at ${message}.`),
      );
    }
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(() => data.digest(cycle as JsonValue)).toThrow('the value contains a cycle');
    const shared = { x: 1 };
    expect(data.canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

describe('finding keys', () => {
  it('normalizes titles', () => {
    expect(data.normalizeTitle('  Null deref: parse()!! ')).toBe('null deref parse');
    expect(data.normalizeTitle('null-deref   PARSE')).toBe('null deref parse');
    expect(data.normalizeTitle('Ｆｕｌｌ　width')).toBe('full width');
    expect(data.normalizeTitle('Café über')).toBe('café über');
    expect(data.normalizeTitle('---')).toBe('');
  });

  it('keys a finding by file and normalized title', () => {
    expect(data.findingKey({ file: 'src/a.ts', title: 'Off-by-one in loop' })).toBe(
      'src/a.ts::off by one in loop',
    );
    expect(data.findingKey({ file: 'src/a.ts', title: 'off by ONE in loop.' })).toBe(
      data.findingKey({ file: 'src/a.ts', title: 'Off-by-one in loop' }),
    );
  });
});

describe('topoWaves', () => {
  const task = (id: string, ...deps: string[]): { id: string; deps: string[] } => ({ id, deps });
  const plan = (tasks: { id: string; deps: string[] }[]): string[][] =>
    data
      .topoWaves(
        tasks,
        (item) => item.id,
        (item) => item.deps,
      )
      .map((wave) => wave.map((item) => item.id));

  it('groups items into dependency waves in input order', () => {
    expect(
      plan([task('d', 'b', 'c'), task('a'), task('b', 'a', 'a'), task('c', 'a'), task('e')]),
    ).toEqual([['a', 'e'], ['b', 'c'], ['d']]);
    expect(plan([])).toEqual([]);
  });

  it('reports every duplicate key and unknown dependency together', () => {
    expect(() => plan([task('a', 'x'), task('a'), task('b', 'y', 'a')])).toThrow(
      'Invalid dependencies: duplicate key "a"; "a" depends on unknown "x"; "b" depends on unknown "y".',
    );
  });

  it('reports a cycle', () => {
    expect(() => plan([task('a'), task('b', 'c'), task('c', 'd'), task('d', 'b')])).toThrow(
      'Invalid dependencies: cycle "b" -> "c" -> "d" -> "b".',
    );
    expect(() => plan([task('s', 's')])).toThrow('Invalid dependencies: cycle "s" -> "s".');
    // A node blocked behind a cycle is not itself part of it.
    expect(() => plan([task('x', 'y'), task('y', 'z'), task('z', 'y')])).toThrow(
      'Invalid dependencies: cycle "y" -> "z" -> "y".',
    );
  });
});
