import { z } from 'zod';

import { jsonValue } from '../workflow/runtime/json.js';
import type { JsonValue } from '../workflow/runtime/model.js';

type Schema = Record<string, JsonValue>;

/** One observed incompatibility with Codex's structured-output schema contract. */
export interface SchemaIssue {
  /** JSON path to the incompatible schema or property. */
  readonly path: string;
  /** Stable identifier for the violated rule. */
  readonly rule: string;
  /** Actionable change to the Zod schema or call options. */
  readonly fix: string;
}

function object(value: JsonValue | undefined): Schema | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function schemaJson(schema: z.ZodType | JsonValue): JsonValue {
  return schema instanceof z.ZodType
    ? jsonValue(JSON.parse(JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' }))))
    : jsonValue(schema);
}

function propertyPath(path: string, key: string): string {
  return /^[a-zA-Z_$][\w$]*$/u.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function resolveRef(root: JsonValue, ref: string, seen = new Set<string>()): Schema {
  if (seen.has(ref)) throw new Error(`Cyclic schema reference without a concrete schema: ${ref}`);
  seen.add(ref);
  let target: JsonValue | undefined = root;
  if (!ref.startsWith('#')) throw new Error(`Unsupported external schema reference: ${ref}`);
  for (const key of ref.slice(1).split('/').filter(Boolean)) {
    const decoded = key.replace(/~1/gu, '/').replace(/~0/gu, '~');
    const data = object(target);
    target = Array.isArray(target)
      ? target[Number(decoded)]
      : data && Object.hasOwn(data, decoded)
        ? data[decoded]
        : undefined;
  }
  const resolved = object(target);
  if (!resolved) throw new Error(`Unresolved schema reference: ${ref}`);
  if (typeof resolved['$ref'] === 'string') return resolveRef(root, resolved['$ref'], seen);
  return resolved;
}

/** Find schema shapes observed to be rejected by Codex, without invoking a harness. */
export function checkCodexSchema(schema: z.ZodType | JsonValue): SchemaIssue[] {
  const root = schemaJson(schema);
  const issues: SchemaIssue[] = [];
  const active = new Set<Schema>();
  const add = (path: string, rule: string, fix: string): void => {
    issues.push({ path, rule, fix });
  };
  const visit = (value: JsonValue, path: string, isRoot = false): void => {
    const node = object(value);
    if (!node) return;
    if (active.has(node)) return;
    active.add(node);
    if (typeof node['$ref'] === 'string') {
      visit(resolveRef(root, node['$ref']), path, isRoot);
      active.delete(node);
      return;
    }
    if (isRoot && node['type'] !== 'object')
      add(
        path,
        'object-root',
        'Wrap the root in z.object({ value: ... }), or use structuredOutput: "compat".',
      );
    if (node['propertyNames'] !== undefined)
      add(path, 'record', 'Use a fixed z.object shape, or structuredOutput: "compat" for records.');
    if (node['oneOf'] !== undefined)
      add(
        path,
        'oneOf',
        'Use z.union instead of z.discriminatedUnion, or structuredOutput: "compat".',
      );
    if (Array.isArray(node['items']) || node['prefixItems'] !== undefined)
      add(
        path,
        'tuple',
        'Replace z.tuple with a named z.object shape or a homogeneous z.array; compat cannot encode tuples.',
      );
    const properties = object(node['properties']);
    if (
      node['type'] === 'object' &&
      node['propertyNames'] === undefined &&
      node['additionalProperties'] !== false
    ) {
      add(
        path,
        'open-object',
        'Use z.object instead of z.looseObject/catchall, or structuredOutput: "compat" to close the wire object.',
      );
    }
    if (properties) {
      const required = Array.isArray(node['required']) ? node['required'] : [];
      for (const [key, child] of Object.entries(properties)) {
        const childPath = propertyPath(path, key);
        if (!required.includes(key))
          add(
            childPath,
            'optional',
            'Make this property required and .nullable(), or use structuredOutput: "compat".',
          );
        visit(child, childPath);
      }
    }
    for (const key of ['anyOf', 'oneOf', 'allOf', 'items', 'prefixItems']) {
      const child = node[key];
      if (Array.isArray(child))
        child.forEach((entry, index) => {
          visit(entry, `${path}.${key}[${String(index)}]`);
        });
      else if (child !== undefined) visit(child, `${path}.${key}`);
    }
    for (const key of ['additionalProperties', '$defs', 'definitions']) {
      const child = object(node[key]);
      if (!child) continue;
      if (key === 'additionalProperties') visit(child, `${path}.${key}`);
      else
        for (const [name, entry] of Object.entries(child))
          visit(entry, propertyPath(`${path}.${key}`, name));
    }
    active.delete(node);
  };
  visit(root, '$', true);
  return issues;
}

interface Plan {
  wire: Schema;
  decode: (value: JsonValue) => JsonValue;
}

/** Internal wire encoding; workflow results are still validated by the original Zod schema. */
export interface CodexSchemaPlan {
  readonly schema: JsonValue;
  readonly decode: (text: string) => string;
}

function reject(issues: readonly SchemaIssue[]): void {
  if (issues.length)
    throw new Error(
      `Codex strict mode rejects this output schema:\n${issues.map((issue) => `  ${issue.path} (${issue.rule}): ${issue.fix}`).join('\n')}`,
    );
}

/** Prepare a checked wire schema and its inverse compatibility transform. @internal */
export function prepareCodexSchema(schema: JsonValue, mode: 'strict' | 'compat'): CodexSchemaPlan {
  if (mode === 'strict') {
    reject(checkCodexSchema(schema));
    return { schema, decode: (text) => text };
  }
  reject(checkCodexSchema(schema).filter((issue) => issue.rule === 'tuple'));
  const definitions: Schema = {};
  const references = new Map<Schema, string>();
  const plans = new Map<Schema, Plan>();
  const validators = new Map<Schema, z.ZodType>();
  function accepts(wire: Schema, value: JsonValue): boolean {
    let validator = validators.get(wire);
    if (!validator) {
      validator = z.fromJSONSchema(
        { ...wire, definitions },
        {
          defaultTarget: 'draft-7',
        },
      );
      validators.set(wire, validator);
    }
    return validator.safeParse(value).success;
  }
  function compile(value: JsonValue): Plan {
    const node = object(value);
    if (!node) return { wire: {}, decode: (value) => value };
    const cached = plans.get(node);
    if (cached) return cached;
    const plan: Plan = { wire: {}, decode: (value) => value };
    plans.set(node, plan);
    if (typeof node['$ref'] === 'string') {
      const target = resolveRef(schema, node['$ref']);
      let id = references.get(target);
      if (!id) {
        id = `schema${String(references.size)}`;
        references.set(target, id);
        definitions[id] = compile(target).wire;
      }
      plan.wire['$ref'] = `#/definitions/${id}`;
      plan.decode = (value) => compile(target).decode(value);
      return plan;
    }
    Object.assign(plan.wire, node);
    delete plan.wire['$defs'];
    delete plan.wire['definitions'];
    delete plan.wire['$schema'];
    const alternatives = node['oneOf'] ?? node['anyOf'];
    if (Array.isArray(alternatives)) {
      const branches = alternatives.map(compile);
      delete plan.wire['oneOf'];
      plan.wire['anyOf'] = branches.map((branch) => branch.wire);
      plan.decode = (value) => {
        const branch = branches.find((branch) => accepts(branch.wire, value));
        if (!branch) throw new Error('Codex output did not match any wire schema branch.');
        return branch.decode(value);
      };
    } else if (node['type'] === 'object') {
      const names = object(node['propertyNames']);
      const extra = object(node['additionalProperties']);
      if (names && extra && !Array.isArray(names['enum'])) {
        const item = compile(extra);
        for (const key of Object.keys(plan.wire)) Reflect.deleteProperty(plan.wire, key);
        for (const key of ['title', 'description', '$comment']) {
          if (node[key] !== undefined) plan.wire[key] = node[key];
        }
        Object.assign(plan.wire, {
          type: 'array',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, value: item.wire },
            required: ['key', 'value'],
            additionalProperties: false,
          },
        });
        plan.decode = (value) => {
          if (!Array.isArray(value))
            throw new Error('Codex record output must be an array of key/value entries.');
          const entries = value.map((entry) => {
            const pair = object(entry);
            if (!pair || typeof pair['key'] !== 'string' || pair['value'] === undefined)
              throw new Error('Codex record entry requires key and value.');
            return [pair['key'], item.decode(pair['value'])] as const;
          });
          if (new Set(entries.map(([key]) => key)).size !== entries.length)
            throw new Error('Codex record output contains duplicate keys.');
          return Object.fromEntries(entries);
        };
      } else {
        const properties =
          names && extra && Array.isArray(names['enum'])
            ? Object.fromEntries(
                names['enum'].map((key) => {
                  if (typeof key !== 'string') throw new Error('Record keys must be strings.');
                  return [key, extra];
                }),
              )
            : (object(node['properties']) ?? {});
        const required = names
          ? Object.keys(properties)
          : Array.isArray(node['required'])
            ? node['required']
            : [];
        const children = Object.entries(properties).map(([key, child]) => ({
          key,
          plan: compile(child),
          optional: !required.includes(key),
        }));
        plan.wire['properties'] = Object.fromEntries(
          children.map((child) => [
            child.key,
            child.optional ? { anyOf: [child.plan.wire, { type: 'null' }] } : child.plan.wire,
          ]),
        );
        plan.wire['required'] = Object.keys(properties);
        plan.wire['additionalProperties'] = false;
        delete plan.wire['propertyNames'];
        plan.decode = (value) => {
          const data = object(value);
          if (!data) throw new Error('Codex object output must be an object.');
          const output = { ...data };
          for (const child of children) {
            const entry = data[child.key];
            if (entry === undefined) continue;
            if (entry === null && child.optional && !accepts(child.plan.wire, null))
              Reflect.deleteProperty(output, child.key);
            else
              Object.defineProperty(output, child.key, {
                value: child.plan.decode(entry),
                enumerable: true,
                writable: true,
                configurable: true,
              });
          }
          return output;
        };
      }
    } else if (node['type'] === 'array' && node['items'] !== undefined) {
      const item = compile(node['items']);
      plan.wire['items'] = item.wire;
      plan.decode = (value) => {
        if (!Array.isArray(value)) throw new Error('Codex array output must be an array.');
        return value.map(item.decode);
      };
    }
    return plan;
  }
  const root = compile(schema);
  const wrapped = root.wire['type'] !== 'object';
  const wire: Schema = wrapped
    ? {
        type: 'object',
        properties: { value: root.wire },
        required: ['value'],
        additionalProperties: false,
      }
    : { ...root.wire };
  if (Object.keys(definitions).length > 0) wire['definitions'] = definitions;
  reject(checkCodexSchema(wire));
  return {
    schema: wire,
    decode(text) {
      const value = jsonValue(JSON.parse(text));
      const data = wrapped ? object(value)?.['value'] : value;
      if (data === undefined) throw new Error('Codex wrapped output is missing value.');
      return JSON.stringify(root.decode(data));
    },
  };
}
