// quiet-choir/std pattern-kit: the internal helpers the pattern modules share (defaults, option
// validation, ID-safe keyed records and settled-map options), exercised directly and through one
// real settled map so their typing composes with ctx.map.
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  defineWorkflow,
  runWorkflow,
  stepId,
  z,
  type MapStepError,
  type Settled,
} from '../src/index.js';
import * as kit from '../src/std/pattern-kit.js';
import { ScriptedHarness, makeRoot, promptOf, removeRoot, runOptions } from './std-harness.js';

let root: string;
beforeEach(async () => {
  root = await makeRoot();
});
afterEach(async () => {
  await removeRoot(root);
});

describe('option validation', () => {
  it('accepts counts and rejects everything else with the option name', () => {
    expect(kit.DEFAULT_CONCURRENCY).toBe(4);
    expect(kit.positiveInt('seats', 3)).toBe(3);
    expect(() => kit.positiveInt('seats', 0)).toThrow(
      new TypeError('seats must be a positive integer; got 0.'),
    );
    expect(() => kit.positiveInt('seats', Number.NaN)).toThrow('got NaN.');
    expect(() => kit.positiveInt('seats', '3' as unknown as number)).toThrow('got "3".');
    expect(kit.nonNegativeInt('cap', 0)).toBe(0);
    expect(() => kit.nonNegativeInt('cap', -1)).toThrow(
      new TypeError('cap must be a nonnegative integer; got -1.'),
    );
    const keys = kit.nonEmpty('keys', ['a', 'b']);
    expectTypeOf(keys).toEqualTypeOf<readonly [string, ...string[]]>();
    expect(z.enum(keys).options).toEqual(['a', 'b']);
    expect(() => kit.nonEmpty('lenses', [])).toThrow(new TypeError('lenses must not be empty.'));
    expect(kit.statusOf(0)).toBe('complete');
    expect(kit.statusOf(2)).toBe('degraded');
  });
});

describe('keyed', () => {
  it('pairs items with unique ID-safe keys and their labels', () => {
    expect(kit.keyed(['p', 'q'])).toEqual([
      { key: '0', label: '0', item: 'p', index: 0 },
      { key: '1', label: '1', item: 'q', index: 1 },
    ]);
    const records = kit.keyed(['a', 'a', 'src/x.ts'], (item) => item);
    expect(records.map((record) => record.key)).toEqual(['a', 'a.2', stepId('src/x.ts')]);
    expect(records.map((record) => record.label)).toEqual(['a', 'a', 'src/x.ts']);
  });
});

describe('settledMap', () => {
  it('builds settled options keyed by record key, with the default concurrency', () => {
    const options = kit.settledMap<{ key: string }>({ version: 'v1' });
    expect(options).toMatchObject({ concurrency: 4, onError: 'return', version: 'v1' });
    expect(options.key?.({ key: 'k' }, 0)).toBe('k');
    expect(() => kit.settledMap({ concurrency: 0 })).toThrow(
      'concurrency must be a positive integer; got 0.',
    );
  });

  it('drives a real settled map over keyed prompt records', async () => {
    const workflow = defineWorkflow({
      name: 'kit-map',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      async run(ctx) {
        const agent = ctx.claude.bind({});
        const records = kit
          .keyed(['alpha', 'beta', 'alpha'], (item) => item)
          .map(({ key, item }) => ({ key, prompt: `say ${item}` }));
        const results = await ctx.map(
          'lens',
          records,
          kit.settledMap({ concurrency: 2 }),
          (record) => agent.value('read', { prompt: record.prompt }),
        );
        expectTypeOf(results).toEqualTypeOf<Settled<string, MapStepError>[]>();
        return results;
      },
    });
    const harness = new ScriptedHarness((request) => `re:${promptOf(request)}`);
    const result = await runWorkflow(workflow, { ...runOptions(root), harness, input: null });
    expect([...harness.ids()].sort()).toEqual([
      'lens/alpha.2/read',
      'lens/alpha/read',
      'lens/beta/read',
    ]);
    expect(result.output).toEqual([
      { ok: true, value: 're:say alpha' },
      { ok: true, value: 're:say beta' },
      { ok: true, value: 're:say alpha' },
    ]);
  });
});
