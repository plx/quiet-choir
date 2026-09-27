import { createHash } from 'node:crypto';

import type { JsonValue } from './model.js';

/** Copy canonical JSON, omitting undefined object members and rejecting every other lossy value. */
export function jsonValue(
  value: unknown,
  boundary = 'Checkpoint value',
  options: { readonly canonical?: boolean } = {},
): JsonValue {
  const ancestors = new Set<object>();
  function invalid(path: string, reason: string): never {
    throw new Error(`${boundary} is not JSON at ${path}: ${reason}.`);
  }
  function visit(item: unknown, path: string): JsonValue {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return item;
    if (typeof item !== 'object' || ancestors.has(item)) {
      return invalid(
        path,
        typeof item === 'object'
          ? 'cycles cannot be checkpointed'
          : typeof item === 'number'
            ? `${Object.is(item, -0) ? '-0' : String(item)} is not a lossless JSON number`
            : `${typeof item} is not a lossless JSON value`,
      );
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype)
          return invalid(path, 'subclassed arrays cannot be checkpointed');
        const result: JsonValue[] = [];
        for (let index = 0; index < item.length; index++) {
          const childPath = `${path}[${String(index)}]`;
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (descriptor === undefined)
            return invalid(childPath, 'array hole. Use null (with .nullable()) or filter it out');
          if (!('value' in descriptor)) return invalid(childPath, 'arrays cannot contain getters');
          if (!descriptor.enumerable)
            return invalid(childPath, 'arrays cannot contain non-enumerable elements');
          if (descriptor.value === undefined)
            return invalid(
              childPath,
              'undefined array element. Use null (with .nullable()) or filter it out',
            );
          result.push(visit(descriptor.value, childPath));
        }
        if (Reflect.ownKeys(item).length !== item.length + 1)
          return invalid(path, 'augmented arrays cannot be checkpointed');
        return result;
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        return invalid(path, 'values must be plain JSON objects, not class instances');
      if (Reflect.ownKeys(item).length !== Object.keys(item).length)
        return invalid(path, 'objects cannot contain symbols or non-enumerable properties');
      const result: Record<string, JsonValue> = {};
      const keys = Object.keys(item);
      if (options.canonical !== false) keys.sort();
      for (const key of keys) {
        const childPath = /^[a-zA-Z_$][\w$]*$/u.test(key)
          ? `${path}.${key}`
          : `${path}[${JSON.stringify(key)}]`;
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (descriptor === undefined || !('value' in descriptor))
          return invalid(childPath, 'objects cannot contain getters');
        if (descriptor.value === undefined) continue;
        Object.defineProperty(result, key, {
          value: visit(descriptor.value, childPath),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    } finally {
      ancestors.delete(item);
    }
  }
  return visit(value, '$');
}

/** Hash canonical JSON for explicit step dependency checks. */
export function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(jsonValue(value)))
    .digest('hex');
}
