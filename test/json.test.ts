import { describe, expect, it } from 'vitest';

import { digest, jsonValue } from '../src/workflow/runtime/json.js';

describe('lossless checkpoint JSON', () => {
  it('copies data and canonicalizes nested object keys without changing arrays', () => {
    const shared = { z: 3, a: [true, null, 'text'] };
    const input = { second: shared, first: shared };
    const copy = jsonValue(input);

    expect(copy).toEqual(input);
    expect(copy).not.toBe(input);
    expect(JSON.stringify(copy)).toBe(
      '{"first":{"a":[true,null,"text"],"z":3},"second":{"a":[true,null,"text"],"z":3}}',
    );
    expect(digest(input)).toBe(digest({ first: shared, second: shared }));
    expect(digest([1, 2])).not.toBe(digest([2, 1]));
  });

  it('preserves own prototype-related keys without mutating object prototypes', () => {
    const input: unknown = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":1,"toString":2}',
    );
    const copy = jsonValue(input);

    expect(JSON.stringify(copy)).toBe(
      '{"__proto__":{"polluted":true},"constructor":1,"toString":2}',
    );
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(copy, '__proto__')).toBe(true);
    const empty: object = {};
    expect('polluted' in empty).toBe(false);
    expect(jsonValue(Object.create(null))).toEqual({});
  });

  it.each([undefined, NaN, Infinity, -Infinity, -0, 1n, Symbol('value'), () => 1])(
    'rejects values JSON would lose or alter: %s',
    (value) => {
      expect(() => jsonValue({ value })).toThrow(/lossless JSON/);
    },
  );

  it('rejects cycles while accepting repeated references', () => {
    const object: Record<string, unknown> = {};
    object['self'] = object;
    const array: unknown[] = [];
    array.push(array);

    expect(() => jsonValue(object)).toThrow(/cycles/);
    expect(() => jsonValue(array)).toThrow(/cycles/);
    expect(jsonValue([{ value: 1 }, { value: 1 }])).toEqual([{ value: 1 }, { value: 1 }]);
  });

  it.each([new Date(), new Map(), new Set(), /pattern/])('rejects class instances: %s', (value) => {
    expect(() => jsonValue(value)).toThrow(/plain JSON objects/);
  });

  it('rejects hidden properties and getters without invoking user code', () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        reads++;
        return 1;
      },
    });
    const hidden = Object.defineProperty({}, 'value', { value: 1 });
    const symbol = { [Symbol('hidden')]: 1 };

    expect(() => jsonValue(accessor)).toThrow(/getters/);
    expect(() => jsonValue(hidden)).toThrow(/non-enumerable/);
    expect(() => jsonValue(symbol)).toThrow(/symbols/);
    expect(reads).toBe(0);
  });

  it('rejects sparse, augmented, subclassed, and accessor arrays without dropping data', () => {
    let reads = 0;
    const sparse = new Array<unknown>(1);
    const augmented = Object.assign([1], { extra: true });
    const symbol = Object.assign([1], { [Symbol('extra')]: true });
    const hidden = Object.defineProperty([1], 'extra', { value: true });
    const getter = Object.defineProperty([1], '0', {
      enumerable: true,
      get() {
        reads++;
        return 1;
      },
    });
    class SpecialArray extends Array<number> {}

    for (const invalid of [sparse, augmented, symbol, hidden, new SpecialArray(1)]) {
      expect(() => jsonValue(invalid)).toThrow(/arrays cannot be checkpointed/);
    }
    expect(() => jsonValue(getter)).toThrow(/getters/);
    expect(reads).toBe(0);
  });
});
