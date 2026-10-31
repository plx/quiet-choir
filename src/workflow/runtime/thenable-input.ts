import { z } from 'zod';

/**
 * The path to the first Promise or other thenable among an input's own enumerable values, however
 * deep, or undefined when there is none. An input is typed unknown, so an unawaited Promise
 * typechecks, and an object schema reads one as an object with no fields. The search only refuses:
 * a value it cannot read (a throwing getter, a revoked Proxy) ends it with undefined, leaving the
 * verdict to the schema. @internal
 */
export function thenablePath(value: unknown): (string | number)[] | undefined {
  const seen = new Set<object>();
  const path: (string | number)[] = [];
  const visit = (current: unknown): boolean => {
    if (typeof current === 'function') return isThenable(current);
    if (typeof current !== 'object' || current === null || seen.has(current)) return false;
    if (isThenable(current)) return true;
    seen.add(current);
    // Binary data holds no values to search; Object.keys skips an array's holes.
    if (ArrayBuffer.isView(current)) return false;
    const array = Array.isArray(current);
    for (const key of Object.keys(current)) {
      path.push(array ? Number(key) : key);
      if (visit((current as Record<string, unknown>)[key])) return true;
      path.pop();
    }
    return false;
  };
  try {
    return visit(value) ? path : undefined;
  } catch {
    return undefined;
  }
}

const isThenable = (value: object): boolean =>
  typeof (value as { readonly then?: unknown }).then === 'function';

/** The validation error of an input with a thenable at `path`, as a schema failure reports. @internal */
export function thenableInputError(path: (string | number)[]): z.ZodError {
  return new z.ZodError([
    {
      code: 'custom',
      path,
      message: 'Workflow input holds a Promise or other thenable; await it and pass the value.',
      input: undefined,
    },
  ]);
}
