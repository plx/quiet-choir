import { z } from 'zod';
import { ConfigurationError } from './configuration-error.js';
import { jsonValue } from './json.js';
import type { JsonValue } from './model.js';

type Node = Record<string, JsonValue>;
function object(value: JsonValue | undefined): Node | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function pointer(path: string, key: string | number): string {
  return `${path}/${String(key).replace(/~/gu, '~0').replace(/\//gu, '~1')}`;
}

/**
 * Deterministic JSON Schema samples. Unsupported or unsatisfied constraints require an explicit
 * fixture and reject as a {@link ConfigurationError}, so a synthesis gap is never settled or retried.
 */
export function synthesizeOutput(schema: JsonValue, stepId: string): JsonValue {
  const fail = (path: string, reason: string): never => {
    throw new ConfigurationError(
      `Step ${stepId} at JSON pointer ${JSON.stringify(path)}: ${reason}. Supply a fixture output for this step.`,
    );
  };
  const root = object(schema) ?? {};
  let remaining = 10_000;
  function visit(raw: JsonValue, path: string, depth: number): JsonValue {
    if (--remaining < 0 || depth > 32)
      return fail(path, 'schema synthesis exceeds its bounded size/depth');
    if (raw === false) return fail(path, 'schema permits no value');
    if (raw === true) return `dry-run:${stepId}${path}`;
    const node = object(raw);
    if (!node) return fail(path, 'expected a JSON Schema object');
    const accept = (value: JsonValue): JsonValue => {
      try {
        const validation: Node = {
          ...node,
          ...(root['definitions'] === undefined ? {} : { definitions: root['definitions'] }),
          ...(root['$defs'] === undefined ? {} : { $defs: root['$defs'] }),
        };
        const validator = z.fromJSONSchema(validation, { defaultTarget: 'draft-7' });
        const result = validator.safeParse(value);
        if (!result.success) {
          const issue = result.error.issues[0];
          const at =
            issue?.path.reduce<string>((at, key) => pointer(at, String(key)), path) ?? path;
          return fail(at, issue?.message ?? 'synthesized value violates schema constraints');
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(`Step ${stepId} at JSON pointer `))
          throw error;
        return fail(
          path,
          `cannot validate schema: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return value;
    };
    if (typeof node['$ref'] === 'string') {
      const ref = node['$ref'];
      if (ref !== '#' && !ref.startsWith('#/'))
        return fail(path, `unsupported external reference ${ref}`);
      let target: JsonValue | undefined = schema;
      for (const key of ref === '#' ? [] : ref.slice(2).split('/')) {
        const decoded = key.replace(/~1/gu, '/').replace(/~0/gu, '~');
        const data = object(target);
        target = Array.isArray(target)
          ? target[Number(decoded)]
          : data && Object.hasOwn(data, decoded)
            ? data[decoded]
            : undefined;
      }
      if (target === undefined) return fail(path, `unresolved reference ${ref}`);
      return accept(visit(target, path, depth + 1));
    }
    if (Object.hasOwn(node, 'const')) return accept(node['const'] as JsonValue);
    if (Array.isArray(node['enum'])) {
      const first = node['enum'][0];
      return first === undefined ? fail(path, 'empty enum') : accept(first);
    }
    const alternatives = node['anyOf'] ?? node['oneOf'];
    if (Array.isArray(alternatives)) {
      // Prefer a populated nullable branch; union order otherwise determines the rehearsed path.
      const populated = alternatives.filter((entry) => object(entry)?.['type'] !== 'null');
      const choices = populated.length ? populated : alternatives;
      let firstError: unknown;
      for (const choice of choices) {
        try {
          return accept(visit(choice, path, depth + 1));
        } catch (error) {
          firstError ??= error;
        }
      }
      throw firstError instanceof Error
        ? firstError
        : new ConfigurationError(`Step ${stepId}: empty union; supply a fixture.`);
    }
    if (Array.isArray(node['allOf'])) {
      const values = node['allOf'].map((entry) => visit(entry, path, depth + 1));
      const merged: JsonValue = values.every((entry) => object(entry) !== undefined)
        ? (Object.assign({}, ...values) as Node)
        : (values[0] ?? null);
      return accept(merged);
    }
    let type = node['type'];
    if (Array.isArray(type)) type = type.find((entry) => entry !== 'null') ?? 'null';
    if (type === 'null') return accept(null);
    if (type === 'boolean') return accept(false);
    if (type === 'number' || type === 'integer') {
      const minimum = typeof node['minimum'] === 'number' ? node['minimum'] : undefined;
      const exclusive =
        typeof node['exclusiveMinimum'] === 'number' ? node['exclusiveMinimum'] : undefined;
      const maximum = typeof node['maximum'] === 'number' ? node['maximum'] : undefined;
      const upper =
        typeof node['exclusiveMaximum'] === 'number' ? node['exclusiveMaximum'] : undefined;
      let value = minimum ?? exclusive ?? Math.min(0, maximum ?? upper ?? 0);
      if (exclusive !== undefined && value <= exclusive)
        value =
          exclusive +
          (type === 'integer'
            ? Math.floor(exclusive) + 1 - exclusive
            : Math.max(Number.MIN_VALUE, Math.abs(exclusive) * Number.EPSILON, Number.EPSILON));
      if (upper !== undefined && value >= upper && minimum === undefined && exclusive === undefined)
        value =
          upper -
          (type === 'integer'
            ? 1
            : Math.max(Number.MIN_VALUE, Math.abs(upper) * Number.EPSILON, Number.EPSILON));
      if (type === 'integer') value = Math.ceil(value);
      if (typeof node['multipleOf'] === 'number' && node['multipleOf'] > 0)
        value = Math.ceil(value / node['multipleOf']) * node['multipleOf'];
      if (!Number.isFinite(value)) return fail(path, 'no finite minimum can be synthesized');
      return accept(Object.is(value, -0) ? 0 : value);
    }
    if (type === 'array' || node['items'] !== undefined || node['prefixItems'] !== undefined) {
      const tuple = Array.isArray(node['items'])
        ? node['items']
        : Array.isArray(node['prefixItems'])
          ? node['prefixItems']
          : [];
      const length = Math.max(
        typeof node['minItems'] === 'number' ? node['minItems'] : tuple.length,
        1,
      );
      if (!Number.isSafeInteger(length) || length > 1000)
        return fail(path, 'array sample exceeds 1000 items');
      if (typeof node['maxItems'] === 'number' && length > node['maxItems'])
        return fail(path, 'one-item/minItems sample exceeds maxItems');
      return accept(
        Array.from({ length }, (_, index) =>
          visit(
            tuple[index] ??
              (Array.isArray(node['items'])
                ? (node['additionalItems'] ?? {})
                : (node['items'] ?? {})),
            pointer(path, index),
            depth + 1,
          ),
        ),
      );
    }
    if (
      type === 'object' ||
      node['properties'] !== undefined ||
      node['additionalProperties'] !== undefined
    ) {
      const properties = object(node['properties']) ?? {};
      const required = Array.isArray(node['required'])
        ? node['required'].filter((key): key is string => typeof key === 'string')
        : [];
      const keys = [...new Set([...required, ...Object.keys(properties)])];
      const result: Node = {};
      const put = (key: string, child: JsonValue): void => {
        Object.defineProperty(result, key, {
          value: visit(child, pointer(path, key), depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      };
      for (const key of keys) {
        if (
          !required.includes(key) &&
          typeof node['maxProperties'] === 'number' &&
          Object.keys(result).length >= node['maxProperties']
        )
          continue;
        put(key, properties[key] ?? node['additionalProperties'] ?? {});
      }
      const minimum = typeof node['minProperties'] === 'number' ? node['minProperties'] : 0;
      if (minimum > 1000) return fail(path, 'object sample exceeds 1000 properties');
      for (let index = 0; Object.keys(result).length < minimum; index++) {
        const key = `dry-run-key-${String(index)}`;
        if (!Object.hasOwn(result, key)) put(key, node['additionalProperties'] ?? {});
      }
      return accept(result);
    }
    if (type === 'string' || type === undefined) {
      let value = `dry-run:${stepId}${path}`;
      if (typeof node['maxLength'] === 'number') value = value.slice(0, node['maxLength']);
      if (typeof node['minLength'] === 'number') {
        if (node['minLength'] > 100_000)
          return fail(path, 'string sample exceeds 100000 characters');
        value = value.padEnd(node['minLength'], '.');
      }
      // Pattern/format validators report the exact output pointer rather than inventing business data.
      return accept(value);
    }
    return fail(path, `unsupported type ${JSON.stringify(type)}`);
  }
  return jsonValue(visit(schema, '', 0));
}
