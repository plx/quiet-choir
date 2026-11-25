// quiet-choir/std lenses: the lens constructor's key and charter checks, and the frozen catalogs the
// std patterns default to. Lens keys are used unchanged in step IDs and map keys, and charters are
// prompt text, so the catalogs' keys are pinned here and every charter is checked for shape.
import { describe, expect, it } from 'vitest';
import { checkCodexSchema, stepId } from '../src/index.js';
import * as lenses from '../src/std/lenses.js';
import { rubric } from '../src/std/types.js';

describe('std.lenses.lens', () => {
  it('makes a frozen lens from a clean key and a charter', () => {
    const made = lenses.lens('migrations', 'Schema and data migrations.');
    expect(made).toEqual({ key: 'migrations', charter: 'Schema and data migrations.' });
    expect(Object.isFrozen(made)).toBe(true);
    for (const key of [
      'a',
      'A1',
      'error-handling',
      'v1.2',
      'scope:x',
      'snake_case',
      'x'.repeat(64),
    ])
      expect(lenses.lens(key, 'Charter.').key).toBe(key);
  });

  it.each([
    [''],
    ['-leading'],
    ['.leading'],
    ['has space'],
    ['has/slash'],
    ['ünïcode'],
    ['x'.repeat(65)],
  ])('refuses the key %j, which stepId would rewrite', (key) => {
    expect(() => lenses.lens(key, 'Charter.')).toThrow(TypeError);
    expect(() => lenses.lens(key, 'Charter.')).toThrow(/must be a clean step-ID segment/u);
  });

  it('refuses a non-string key and an empty charter', () => {
    expect(() => {
      Reflect.apply(lenses.lens, undefined, [3, 'Charter.']);
    }).toThrow(TypeError);
    expect(() => lenses.lens('migrations', '')).toThrow(
      /^Lens migrations needs a nonempty charter\.$/u,
    );
    expect(() => lenses.lens('key', '  \n')).toThrow(TypeError);
    expect(() => {
      Reflect.apply(lenses.lens, undefined, ['key', null]);
    }).toThrow(TypeError);
  });
});

/** Every catalog and its keys, in order. */
const catalogs = {
  bugs: [
    'error-handling',
    'boundaries',
    'concurrency',
    'resource-lifecycle',
    'state-machines',
    'contracts',
    'time-and-ordering',
    'input-validation',
  ],
  review: ['correctness', 'security', 'performance', 'maintainability', 'tests'],
  security: [
    'injection',
    'access-control',
    'secrets',
    'data-exposure',
    'untrusted-input',
    'supply-chain',
    'cryptography',
  ],
  design: ['ship-simplest', 'evolvability', 'data-first', 'operability-first'],
  research: [
    'official-docs',
    'source-code',
    'issues-and-discussions',
    'independent-analysis',
    'alternatives',
  ],
  release: ['tests', 'compatibility', 'security', 'performance', 'docs', 'operability'],
  writing: ['accuracy', 'completeness', 'clarity', 'structure'],
} as const;

describe('std.lenses catalogs', () => {
  it('exports exactly the documented catalogs, the lens constructor and the design rubric', () => {
    expect(Object.keys(lenses).sort()).toEqual(
      [...Object.keys(catalogs), 'designRubric', 'lens'].sort(),
    );
  });

  it.each(Object.entries(catalogs))('%s has its documented keys in order', (name, keys) => {
    const catalog = lenses[name as keyof typeof catalogs];
    expect(catalog.map((item) => item.key)).toEqual(keys);
  });

  it.each(Object.entries(catalogs))(
    '%s holds frozen lenses with clean keys and charters',
    (name) => {
      const catalog = lenses[name as keyof typeof catalogs];
      expect(Object.isFrozen(catalog)).toBe(true);
      expect(new Set(catalog.map((item) => item.key)).size).toBe(catalog.length);
      for (const item of catalog) {
        expect(Object.isFrozen(item)).toBe(true);
        expect(Object.keys(item).sort()).toEqual(['charter', 'key']);
        expect(stepId(item.key)).toBe(item.key);
        expect(item.charter, item.key).toMatch(/^[A-Z][^\n]*\.$/u);
        expect(item.charter, item.key).not.toMatch(/ {2}/u);
        expect(item.charter.length, item.key).toBeLessThanOrEqual(240);
      }
    },
  );

  it('writes the design philosophies as a proposer stance', () => {
    for (const item of lenses.design) expect(item.charter, item.key).toMatch(/^You /u);
  });
});

describe('std.lenses.designRubric', () => {
  it('describes four frozen criteria', () => {
    expect(Object.keys(lenses.designRubric)).toEqual([
      'fitness',
      'simplicity',
      'evolvability',
      'operability',
    ]);
    expect(Object.isFrozen(lenses.designRubric)).toBe(true);
    for (const [key, text] of Object.entries(lenses.designRubric))
      expect(text, key).toMatch(/^How [^\n]*\.$/u);
  });

  it('builds a scorecard schema Codex accepts', () => {
    const schema = rubric(lenses.designRubric);
    expect(checkCodexSchema(schema)).toEqual([]);
    expect(
      schema.parse({
        scores: { fitness: 8, simplicity: 6, evolvability: 7, operability: 5 },
        rationale: 'Meets the brief.',
      }).scores.fitness,
    ).toBe(8);
  });
});
