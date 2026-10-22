// quiet-choir/std roster entries and tiers (#588). The preset entries are golden-tested against the
// built-in preset table through the public capability manifest, so drift from that table fails here.
// The type assertions are checked by `npm run typecheck`, in the style of test/roster-types.test.ts:
// a workflow body that never runs holds one `@ts-expect-error` per rejected entry.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  capabilityManifest,
  defineRoster,
  defineWorkflow,
  z,
  type Agent,
  type CapabilityManifest,
  type AnyRoster,
} from '../src/index.js';
import * as std from '../src/std/index.js';

const base = { version: '1', input: z.null(), output: z.null() } as const;

/** The resolved built-in `preset` and the resolved `Entry` of a workflow with `roster`. */
function rows(
  roster: AnyRoster,
  preset: 'text' | 'readonly' | 'edit',
): { builtin: CapabilityManifest['defaults']; entry: CapabilityManifest['defaults'] } {
  const workflow = defineWorkflow({
    ...base,
    name: 'std-golden',
    roster,
    run: () => Promise.resolve(null),
  });
  const manifest = capabilityManifest(workflow);
  const builtin = manifest.profiles[preset];
  const resolved = manifest.profiles['Entry'];
  if (builtin === undefined || resolved === undefined) throw new Error('missing manifest row');
  return { builtin, entry: resolved };
}

const presets = [
  ['Text', 'text'],
  ['ReadOnly', 'readonly'],
  ['Edit', 'edit'],
] as const;

describe('std.claude', () => {
  it.each(presets)('%s carries the %s preset tools and limits', (name, preset) => {
    const { builtin, entry } = rows(defineRoster({ Entry: { ...std.claude[name] } }), preset);
    expect(entry.harness).toBe('claude');
    expect(entry.claude.tools).toEqual(builtin.claude.tools);
    expect(entry.maxTurns).toBe(builtin.maxTurns);
    expect(entry.maxBudgetUsd).toBe(builtin.maxBudgetUsd);
    expect(entry.timeoutMs).toBe(builtin.timeoutMs);
    expect(entry.access).toBe(builtin.claudeAccess);
  });
});

describe('std.codex', () => {
  it.each(presets)('%s carries the %s preset sandbox and time limit', (name, preset) => {
    const { builtin, entry } = rows(defineRoster({ Entry: { ...std.codex[name] } }), preset);
    expect(entry.harness).toBe('codex');
    expect(entry.codex.sandbox).toBe(builtin.codex.sandbox);
    expect(entry.timeoutMs).toBe(builtin.timeoutMs);
    expect(entry.access).toBe(builtin.codexAccess);
    expect(Object.keys(std.codex[name])).not.toContain('maxTurns');
    expect(Object.keys(std.codex[name])).not.toContain('maxBudgetUsd');
  });
});

describe('std.tiers', () => {
  it('has the seven native tiers, each pinned to Claude with a model and effort', () => {
    const expected = {
      Clerk: ['haiku', 'low'],
      Copyist: ['sonnet', 'low'],
      Scribe: ['sonnet', 'medium'],
      Mechanic: ['sonnet', 'high'],
      Planner: ['opus', 'high'],
      Skeptic: ['opus', 'medium'],
      Surgeon: ['opus', 'high'],
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
    const { entry } = rows(
      defineRoster({ Entry: { ...std.claude.Edit, ...std.tiers.Mechanic } }),
      'edit',
    );
    expect(entry.claude.model).toBe('sonnet');
    expect(entry.claude.effort).toBe('high');
    expect(entry.access).toBe('write');
  });
});

it('freezes every entry and tier, including tool lists', () => {
  const groups: readonly Readonly<Record<string, object>>[] = [std.claude, std.codex, std.tiers];
  for (const group of groups) {
    for (const entry of Object.values(group)) {
      expect(Object.isFrozen(entry)).toBe(true);
      for (const value of Object.values(entry) as unknown[]) {
        if (typeof value === 'object') expect(Object.isFrozen(value)).toBe(true);
      }
    }
  }
  expect(() => {
    (std.claude.ReadOnly.tools as unknown as string[]).push('Bash');
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
