// quiet-choir/std roster entries and tiers (#588). The text, read-only and edit entries are
// golden-tested against a literal table of the former text/readonly/edit preset values through the
// capability manifest, so drift from those values fails here. The rest of the roster side (shells,
// limits, personas, roles, rosters, bash rules) is in std-roster.test.ts, the lenses in
// std-lenses.test.ts. The type assertions are checked by `npm run typecheck`, in the
// style of test/roster-types.test.ts: a workflow body that never runs holds one `@ts-expect-error`
// per rejected entry.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  defineRoster,
  defineWorkflow,
  z,
  type Agent,
  type CapabilityManifest,
  type AnyRoster,
} from '../src/index.js';
import { capabilityManifest } from '../src/workflow/runtime/profiles.js';
import * as std from '../src/std/index.js';

const base = { version: '1', input: z.null(), output: z.null() } as const;

/** The resolved `Entry` of a workflow with `roster`. */
function entryRow(roster: AnyRoster): CapabilityManifest['defaults'] {
  const workflow = defineWorkflow({
    ...base,
    name: 'std-golden',
    roster,
    run: () => Promise.resolve(null),
  });
  const resolved = capabilityManifest(workflow).profiles['Entry'];
  if (resolved === undefined) throw new Error('missing manifest row');
  return resolved;
}

/** The text, readonly and edit preset values each std entry carries. */
const presetValues = {
  text: {
    tools: [],
    sandbox: 'read-only',
    maxTurns: 10,
    maxBudgetUsd: 0.5,
    timeoutMs: 300_000,
    claudeAccess: 'none',
    codexAccess: 'read',
  },
  readonly: {
    tools: ['Read', 'Grep', 'Glob'],
    sandbox: 'read-only',
    maxTurns: 25,
    maxBudgetUsd: 2,
    timeoutMs: 900_000,
    claudeAccess: 'read',
    codexAccess: 'read',
  },
  edit: {
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
    sandbox: 'workspace-write',
    maxTurns: 40,
    maxBudgetUsd: 5,
    timeoutMs: 1_800_000,
    claudeAccess: 'write',
    codexAccess: 'write',
  },
} as const;

const presets = [
  ['Text', 'text'],
  ['ReadOnly', 'readonly'],
  ['Edit', 'edit'],
] as const;

describe('std.claude', () => {
  it.each(presets)('%s carries the %s preset tools and limits', (name, preset) => {
    const expected = presetValues[preset];
    const entry = entryRow(defineRoster({ Entry: { ...std.claude[name] } }));
    expect(entry.harness).toBe('claude');
    expect(entry.claude.tools).toEqual(expected.tools);
    expect(entry.maxTurns).toBe(expected.maxTurns);
    expect(entry.maxBudgetUsd).toBe(expected.maxBudgetUsd);
    expect(entry.timeoutMs).toBe(expected.timeoutMs);
    expect(entry.access).toBe(expected.claudeAccess);
  });
});

describe('std.codex', () => {
  it.each(presets)('%s carries the %s preset sandbox and time limit', (name, preset) => {
    const expected = presetValues[preset];
    const entry = entryRow(defineRoster({ Entry: { ...std.codex[name] } }));
    expect(entry.harness).toBe('codex');
    expect(entry.codex.sandbox).toBe(expected.sandbox);
    expect(entry.timeoutMs).toBe(expected.timeoutMs);
    expect(entry.access).toBe(expected.codexAccess);
    expect(Object.keys(std.codex[name])).not.toContain('maxTurns');
    expect(Object.keys(std.codex[name])).not.toContain('maxBudgetUsd');
  });
});

describe('std.tiers', () => {
  it('has the seven native tiers and Judge, each pinned to Claude with a model and effort', () => {
    const expected = {
      Clerk: ['haiku', 'low'],
      Copyist: ['sonnet', 'low'],
      Scribe: ['sonnet', 'medium'],
      Mechanic: ['sonnet', 'high'],
      Planner: ['opus', 'high'],
      Skeptic: ['opus', 'medium'],
      Surgeon: ['opus', 'high'],
      Judge: ['opus', 'xhigh'],
    };
    expect(Object.keys(std.tiers).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, [model, effort]] of Object.entries(expected)) {
      const tier = std.tiers[name as keyof typeof expected];
      expect({ harness: tier.harness, model: tier.model, effort: tier.effort }).toEqual({
        harness: 'claude',
        model,
        effort,
      });
      expect(tier.description).not.toBe('');
    }
  });

  it('composes with a capability entry by spread into a valid roster entry', () => {
    const roster = defineRoster({
      Mechanic: { ...std.claude.Edit, ...std.tiers.Mechanic },
      Clerk: { ...std.tiers.Clerk },
    });
    expect(roster.Mechanic).toMatchObject({
      harness: 'claude',
      model: 'sonnet',
      effort: 'high',
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
      maxTurns: 40,
      description: std.tiers.Mechanic.description,
    });
    const entry = entryRow(defineRoster({ Entry: { ...std.claude.Edit, ...std.tiers.Mechanic } }));
    expect(entry.claude.model).toBe('sonnet');
    expect(entry.claude.effort).toBe('high');
    expect(entry.access).toBe('write');
  });
});

/** Expect `value` and every object or array inside it to be frozen. */
function expectDeepFrozen(value: unknown, path: string): void {
  if (typeof value !== 'object' || value === null) return;
  expect(Object.isFrozen(value), path).toBe(true);
  for (const [key, inner] of Object.entries(value)) expectDeepFrozen(inner, `${path}.${key}`);
}

it('freezes every data value of the roster and lens namespaces, nested lists too', () => {
  const groups = {
    claude: std.claude,
    codex: std.codex,
    tiers: std.tiers,
    limits: std.limits,
    personas: std.personas,
    roles: std.roles,
    rosters: std.rosters,
    bash: std.bash,
    lenses: std.lenses,
  };
  let checked = 0;
  for (const [name, group] of Object.entries(groups)) {
    for (const [key, value] of Object.entries(group as Readonly<Record<string, unknown>>)) {
      // Functions build fresh frozen values; std-roster.test.ts checks those. A Zod schema such
      // as std.lenses.LensSchema keeps internal caches; std-result-schemas.test.ts pins it.
      if (typeof value === 'function' || value instanceof z.ZodType) continue;
      expect(['object', 'string'], `std.${name}.${key}`).toContain(typeof value);
      expectDeepFrozen(value, `std.${name}.${key}`);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(70);
  expect(() => {
    (std.claude.ReadOnly.tools as unknown as string[]).push('Bash');
  }).toThrow(TypeError);
  expect(() => {
    (std.bash.gitRead as string[]).push('Bash(git push:*)');
  }).toThrow(TypeError);
  expect(() => {
    (std.roles.Skeptic as { model: string }).model = 'haiku';
  }).toThrow(TypeError);
});

it('types spread entries as agents and keeps the per-harness option typing', () => {
  const roster = defineRoster({
    Reviewer: { ...std.claude.ReadOnly, description: 'Reviews.' },
    Checker: { ...std.codex.ReadOnly, effort: 'high' },
    Mechanic: { ...std.claude.Edit, ...std.tiers.Mechanic },
  });
  defineWorkflow({
    ...base,
    name: 'std-types',
    roster,
    async run(ctx) {
      expectTypeOf(ctx.roster.Reviewer).toExtend<Agent>();
      expectTypeOf(ctx.roster.Checker).toExtend<Agent>();
      expectTypeOf(ctx.roster.Mechanic).toExtend<Agent>();
      // The body never runs: these rejected entries are typecheck assertions only.
      defineRoster({
        // @ts-expect-error -- a Codex entry has no Claude tools.
        Tools: { ...std.codex.ReadOnly, tools: ['Read'] },
      });
      defineRoster({
        // @ts-expect-error -- maxTurns is a Claude-only limit.
        Turns: { ...std.codex.ReadOnly, maxTurns: 3 },
      });
      await Promise.resolve();
      return null;
    },
  });
  expect(roster.Reviewer.description).toBe('Reviews.');
});
