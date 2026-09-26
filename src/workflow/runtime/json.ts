import { createHash } from 'node:crypto';

import type { JsonValue } from './model.js';

/** Assert lossless JSON persistence, rejecting undefined, special numbers, instances, and cycles. */
export function jsonValue(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  function visit(item: unknown, path: string): JsonValue {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return item;
    if (typeof item !== 'object' || ancestors.has(item)) {
      throw new Error(
        `Checkpoint values must be lossless JSON (no undefined, cycles, or special numbers): ${typeof item === 'object' ? 'cycle' : typeof item === 'number' ? (Object.is(item, -0) ? '-0' : String(item)) : typeof item} at ${path}.`,
      );
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (
          Object.getPrototypeOf(item) !== Array.prototype ||
          Object.keys(item).length !== item.length ||
          Reflect.ownKeys(item).length !== item.length + 1
        )
          throw new Error(
            `Sparse, augmented, or subclassed arrays cannot be checkpointed at ${path}.`,
          );
        const result: JsonValue[] = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (descriptor === undefined || !('value' in descriptor))
            throw new Error(
              `Checkpoint arrays cannot contain getters at ${path}[${String(index)}].`,
            );
          result.push(visit(descriptor.value, `${path}[${String(index)}]`));
        }
        return result;
      }
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      ) {
        throw new Error(
          `Checkpoint values must be plain JSON objects, not class instances, at ${path}.`,
        );
      }
      if (Reflect.ownKeys(item).length !== Object.keys(item).length) {
        throw new Error(
          `Checkpoint objects cannot contain symbols or non-enumerable properties at ${path}.`,
        );
      }
      const result: Record<string, JsonValue> = {};
      for (const key of Object.keys(item).sort()) {
        const childPath = /^[a-zA-Z_$][\w$]*$/u.test(key)
          ? `${path}.${key}`
          : `${path}[${JSON.stringify(key)}]`;
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (descriptor === undefined || !('value' in descriptor))
          throw new Error(`Checkpoint objects cannot contain getters at ${childPath}.`);
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
