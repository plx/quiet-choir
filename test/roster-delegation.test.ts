// Child delegation ceilings on roster entries (ADR 0063 sections 4-5, #705/#709): the counterparts
// of child-profiles.test.ts:23/68/91/151/218, children.test.ts:265/561/1815/1874 and the delegation
// half of harness-registry.test.ts:232, with an entry name in place of the profile name. Rooted
// call-site directories were removed in #707, so no addDirRoots case has a roster counterpart; the
// literal addDirs subset tests below cover entries. defineRoster deep-freezes its entries, so a case
// that changes a definition between runs builds it from a factory. A roster call takes only the
// per-call and both-sides keys (ADR 0063 section 1), so the per-call maxTurns of children.test.ts:266
// becomes a per-call timeoutMs, and the per-call denial override of :562 is refused before inference
// as a key a call cannot set.
import { describe, expect, vi } from 'vitest';
import {
  defineHarness,
  defineRoster,
  defineWorkflow,
  z,
  type Harness,
  type HarnessAdapter,
} from '../src/index.js';
import { describeWorkflow } from '../src/workflow/runtime/definition.js';
import type { WorkflowDeclaration } from '../src/workflow/runtime/child-model.js';
import { delegateCapabilities } from '../src/workflow/runtime/child-profiles.js';
import { profileGrantDigest, resolveCapabilities } from '../src/workflow/runtime/profiles.js';
import type { ClaudeOptions, ExecutionPolicy } from '../src/workflow/runtime/model.js';
import { it } from './setup/state-dir.js';

const base = { version: '1', input: z.null(), output: z.null() } as const;

/** A declaration with the given roster, for the delegation unit cases. */
function declaration(
  name: string,
  roster: NonNullable<WorkflowDeclaration['roster']>,
  extra: Partial<WorkflowDeclaration> = {},
): WorkflowDeclaration {
  return {
    name,
    version: '1',
    input: z.null(),
    output: z.null(),
    run: () => Promise.resolve(null),
    roster,
    ...extra,
  };
}

describe('unit delegation ceilings', () => {
  it('clamps a delegated entry to the root ceiling before a grandchild can inherit a laxer one (child-profiles.test.ts:26)', () => {
    // Root caps the shared Worker entry well below what an intermediate child declares.
    const root = resolveCapabilities({
      roster: defineRoster({
        Worker: {
          harness: 'claude',
          tools: ['Read', 'Edit'],
          maxTurns: 3,
          maxBudgetUsd: 3,
          timeoutMs: 3_000,
        },
      }),
    });
    const rootCeiling = root.profiles['Worker'];
    if (!rootCeiling) throw new Error('root ceiling missing');
    const grants = ['Worker'];
    const pins = { Worker: profileGrantDigest(rootCeiling) };

    // The middle child declares a much larger limit for the same entry name.
    const middle = delegateCapabilities(
      declaration(
        'middle',
        defineRoster({
          Worker: {
            harness: 'claude',
            tools: ['Read', 'Edit'],
            maxTurns: 99,
            maxBudgetUsd: 99,
            timeoutMs: 99_000,
          },
        }),
      ),
      root,
      grants,
      pins,
      [],
      {},
      true,
    );
    // The delegated manifest handed to descendants carries the clamped ceiling, not the child's own.
    expect(middle.manifest.profiles['Worker']).toMatchObject({
      maxTurns: 3,
      maxBudgetUsd: 3,
      timeoutMs: 3_000,
    });

    // A grandchild that asks for the child's laxer limit is still capped at the root's ceiling.
    const grandchild = delegateCapabilities(
      declaration(
        'grandchild',
        defineRoster({ Worker: { harness: 'claude', tools: ['Read', 'Edit'] } }),
      ),
      middle.manifest,
      middle.grants,
      middle.pins,
      middle.overrides,
      {},
      true,
    );
    expect(
      grandchild.limits('Worker', { maxTurns: 99, maxBudgetUsd: 99, timeoutMs: 99_000 }),
    ).toEqual({ maxTurns: 3, maxBudgetUsd: 3, timeoutMs: 3_000 });
  });

  it('clamps a delegated idle deadline to the parent ceiling (child-profiles.test.ts:71)', () => {
    const root = resolveCapabilities({
      roster: defineRoster({
        Worker: { harness: 'claude', tools: ['Read', 'Grep', 'Glob'], idleTimeoutMs: 1_000 },
      }),
    });
    const ceiling = root.profiles['Worker'];
    if (!ceiling) throw new Error('root ceiling missing');
    const child = delegateCapabilities(
      declaration(
        'child',
        defineRoster({
          Worker: { harness: 'claude', tools: ['Read', 'Grep', 'Glob'], idleTimeoutMs: 99_000 },
        }),
      ),
      root,
      ['Worker'],
      { Worker: profileGrantDigest(ceiling) },
      [],
      {},
      true,
    );
    expect(child.manifest.profiles['Worker']?.idleTimeoutMs).toBe(1_000);
    expect(child.limits('Worker', { idleTimeoutMs: 99_000 }).idleTimeoutMs).toBe(1_000);
    expect(child.limits('Worker', { idleTimeoutMs: 500 }).idleTimeoutMs).toBe(500);
    // An unset child deadline inherits the parent ceiling rather than running without one.
    const unset: ExecutionPolicy = {};
    expect(child.limits('Worker', unset).idleTimeoutMs).toBe(1_000);
  });

  it('keeps a failing parent denial policy for omitted child policies and refuses explicit warn (child-profiles.test.ts:94)', () => {
    const root = resolveCapabilities({
      defaults: { claude: { onPermissionDenied: 'fail' } },
      roster: defineRoster({
        Scout: {
          harness: 'claude',
          tools: ['Read', 'Grep', 'Glob'],
          onPermissionDenied: 'fail',
        },
      }),
    });
    const pins = Object.fromEntries(
      Object.entries(root.profiles).map(([name, role]) => [name, profileGrantDigest(role)]),
    );
    const scout = { harness: 'claude', tools: ['Read', 'Grep', 'Glob'] } as const;
    const inherited = delegateCapabilities(
      declaration('child', defineRoster({ Scout: scout })),
      root,
      [],
      pins,
      [],
      {},
      true,
    );
    // The entry's policy sits in its pinned Claude block.
    expect(inherited.manifest.profiles['Scout']?.claude.onPermissionDenied).toBe('fail');
    // A Claude-only failing policy passes to omitted built-ins at the Claude level.
    expect(inherited.manifest.profiles['text']?.claude.onPermissionDenied).toBe('fail');
    expect(() => {
      inherited.check('Scout', 'claude', {
        prompt: 'x',
        onPermissionDenied: 'warn',
      } as ClaudeOptions);
    }).toThrow('exceeds parent profile Scout: onPermissionDenied');
    expect(() => {
      inherited.check('Scout', 'claude', {
        prompt: 'x',
        onPermissionDenied: 'fail',
      } as ClaudeOptions);
    }).not.toThrow();
    expect(() => {
      inherited.check('text', 'claude', { prompt: 'x' });
    }).not.toThrow();

    expect(() =>
      delegateCapabilities(
        declaration('child', defineRoster({ Scout: { ...scout, onPermissionDenied: 'warn' } })),
        root,
        [],
        pins,
        [],
        {},
        true,
      ),
    ).toThrow('exceeds parent profile Scout: onPermissionDenied');
    expect(() =>
      delegateCapabilities(
        declaration('child', defineRoster({}), {
          defaults: { claude: { onPermissionDenied: 'warn' } },
        }),
        root,
        [],
        pins,
        [],
        {},
        true,
      ),
    ).toThrow('exceeds parent profile text: onPermissionDenied');
  });

  it('lets a delegated child entry inherit the parent entry Codex effort unless it sets its own (child-profiles.test.ts:154)', () => {
    const root = resolveCapabilities({
      roster: defineRoster({ Careful: { harness: 'codex', effort: 'minimal' } }),
    });
    const delegated = delegateCapabilities(
      declaration(
        'child',
        defineRoster({
          Author: { harness: 'codex' },
          Tuned: { harness: 'codex', effort: 'high' },
        }),
      ),
      root,
      [],
      {},
      [],
      { profiles: { Author: 'Careful', Tuned: 'Careful' } },
      true,
    );
    expect(delegated.manifest.profiles['Author']?.codex).toMatchObject({ effort: 'minimal' });
    expect(delegated.manifest.profiles['Tuned']?.codex).toMatchObject({ effort: 'high' });
  });

  it('keeps a child its own entries without requireGrants and checks ceilings only with it (child-profiles.test.ts:428)', () => {
    // A parent with a text-level Scout and an exec Runner that lacks Bash (toolAccess treats MCP
    // tools as exec), so a wider child entry exceeds it by tools.
    const root = resolveCapabilities({
      roster: defineRoster({
        Scout: { harness: 'claude' },
        Runner: { harness: 'claude', tools: ['Read', 'Edit', 'mcp__fixture__update'] },
      }),
    });
    const child = declaration(
      'child',
      defineRoster({
        Builder: { harness: 'claude', tools: ['Read', 'Edit', 'Bash'], maxTurns: 99 },
        Scout: { harness: 'claude', tools: ['Read', 'Grep', 'Glob'] },
      }),
    );
    const overrides = [{ profile: 'Scout', maxTurns: 2 }];
    const own = delegateCapabilities(child, root, [], {}, overrides, {}, false);
    // The child's own resolved manifest, uncompared and unclamped, with no grants or pins.
    expect(own.manifest).toEqual(resolveCapabilities(child, { requireGrants: false }));
    expect(own.manifest.profiles['Builder']).toMatchObject({ access: 'exec', maxTurns: 99 });
    expect(own.manifest.requiredGrants).toEqual([]);
    expect(own.grants).toEqual([]);
    expect(own.pins).toEqual({});
    // The parent's override rules pass through unchanged; operator limits still match by name.
    expect(own.overrides).toBe(overrides);
    expect(() => {
      own.check('Builder', 'claude', {
        prompt: 'x',
        tools: ['Bash'],
        env: { A: 'b' },
      } as ClaudeOptions);
    }).not.toThrow();
    const policy = { maxTurns: 99, timeoutMs: 99_000 };
    expect(own.limits('Builder', policy)).toBe(policy);
    // An options.profiles remap is accepted and ignored, even for an unknown child entry.
    const remapped = delegateCapabilities(
      child,
      root,
      [],
      {},
      [],
      { profiles: { missing: 'Scout', Builder: 'Scout' } },
      false,
    );
    expect(remapped.manifest).toEqual(own.manifest);

    // Under requireGrants, the same delegation is refused as before.
    expect(() =>
      delegateCapabilities(child, root, ['all'], {}, [], { profiles: { Builder: 'text' } }, true),
    ).toThrow('Child profile child.Builder exceeds parent profile text: tools.');
    expect(() =>
      delegateCapabilities(child, root, ['all'], {}, [], { profiles: { Builder: 'Runner' } }, true),
    ).toThrow('Child profile child.Builder exceeds parent profile Runner: tools.');
    // A parent roster entry is pinned, and the pin check runs before the subset check.
    expect(() =>
      delegateCapabilities(child, root, ['all'], {}, [], { profiles: { Builder: 'Scout' } }, true),
    ).toThrow('Child profile child.Builder exceeds parent profile Scout: access.');
    expect(() =>
      delegateCapabilities(child, root, [], {}, [], { profiles: { missing: 'Scout' } }, true),
    ).toThrow('Unknown child profile mapping: missing.');
    const orphan = declaration(
      'child',
      defineRoster({ Orphan: { harness: 'claude', tools: ['Read'] } }),
    );
    expect(() => delegateCapabilities(orphan, root, [], {}, [], {}, true)).toThrow(
      'Child child profile Orphan has no parent grant Orphan',
    );
    expect(() => delegateCapabilities(orphan, root, [], {}, [], {}, false)).not.toThrow();
  });
});

/** A fake harness whose requests are recorded; it answers `text` and optional extras. */
function fake(extra: { readonly permissionDenials?: number } = {}) {
  const invoke = vi
    .fn<Harness['invoke']>()
    .mockResolvedValue({ text: 'ok', sessionId: null, ...extra });
  return { invoke, harness: { invoke } };
}

describe('inline child delegation', () => {
  it('maps a child entry to a differently named parent entry, caps its limits and refuses direct or nested escalation (children.test.ts:266)', async ({
    stateDir,
    runs,
  }) => {
    const { invoke, harness } = fake();
    const writer = defineWorkflow({
      name: 'writer',
      ...base,
      roster: defineRoster({
        Author: { harness: 'claude', tools: ['Read', 'Edit'], maxTurns: 99 },
      }),
      async run(ctx) {
        // A roster call sets no maxTurns, so the entry's own 99 is what the parent clamps; its
        // per-call deadline is the call-site limit the parent clamps too.
        await ctx.roster.Author.text('write', { prompt: 'x', timeoutMs: 99_000 });
        return null;
      },
    });
    // The root passes the nested workflow no Editor role, so it cannot map Author onto one.
    const nested = defineWorkflow({
      name: 'nested',
      ...base,
      children: [writer],
      async run(ctx) {
        return ctx.workflow('writer', writer, null, { profiles: { Author: 'Editor' } });
      },
    });
    const root = defineWorkflow({
      name: 'parent',
      ...base,
      requireGrants: true,
      roster: defineRoster({
        Editor: {
          harness: 'claude',
          tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
          maxTurns: 3,
          timeoutMs: 3_000,
          model: 'parent-model',
        },
      }),
      async run(ctx) {
        await expect(ctx.workflow('missing', writer, null)).rejects.toThrow('no parent grant');
        await ctx.workflow('granted', writer, null, { profiles: { Author: 'Editor' } });
        await expect(ctx.workflow('nested', nested, null)).rejects.toThrow('no parent grant');
        return null;
      },
    });
    const run = await runs.run(root, {
      stateDir,
      runId: 'profiles',
      input: null,
      grants: ['Editor'],
      harness,
    });
    expect(run.status).toBe('completed');
    expect(invoke).toHaveBeenCalledTimes(1);
    const request = invoke.mock.calls[0]?.[0];
    expect(request?.harness).toBe('claude');
    expect(request?.options).toMatchObject({ maxTurns: 3 });
    expect(request?.options.model).toBe('parent-model');
    expect(invoke.mock.calls[0]?.[1].policy?.timeoutMs).toBe(3_000);
  });

  // A roster call cannot carry a denial policy (ADR 0063 section 1), so the original's weaker call
  // override is refused before inference as a key the call cannot set; the ceiling's call-time
  // refusal stays covered by the unit case above.
  it('keeps a failing parent denial policy in children and refuses a weaker entry or call (children.test.ts:562)', async ({
    stateDir,
    runs,
  }) => {
    const { invoke, harness } = fake({ permissionDenials: 1 });
    const scout = { harness: 'claude', tools: ['Read', 'Grep', 'Glob'] } as const;
    const inheriting = defineWorkflow({
      name: 'inheriting',
      ...base,
      output: z.string(),
      roster: defineRoster({ Scout: scout }),
      async run(ctx) {
        const result = await ctx.roster.Scout.text('look', { prompt: 'x', onError: 'return' });
        return result.ok ? 'accepted' : result.error.kind;
      },
    });
    const weakening = defineWorkflow({
      name: 'weakening',
      ...base,
      roster: defineRoster({ Scout: { ...scout, onPermissionDenied: 'warn' } }),
      async run(ctx) {
        await ctx.roster.Scout.text('look', { prompt: 'x' });
        return null;
      },
    });
    const weakeningCall = defineWorkflow({
      name: 'weakening-call',
      ...base,
      roster: defineRoster({ Scout: scout }),
      async run(ctx) {
        // @ts-expect-error -- the denial policy is bound, never set per call.
        await ctx.roster.Scout.text('look', { prompt: 'x', onPermissionDenied: 'warn' });
        return null;
      },
    });
    const root = defineWorkflow({
      name: 'parent',
      ...base,
      requireGrants: true,
      output: z.string(),
      roster: defineRoster({ Scout: { ...scout, onPermissionDenied: 'fail' } }),
      async run(ctx) {
        await expect(ctx.workflow('weakening', weakening, null)).rejects.toThrow(
          'exceeds parent profile Scout: onPermissionDenied',
        );
        await expect(ctx.workflow('weakening-call', weakeningCall, null)).rejects.toThrow(
          'A bound agent call cannot set onPermissionDenied',
        );
        return ctx.workflow('inheriting', inheriting, null);
      },
    });
    const run = await runs.run(root, { stateDir, runId: 'denials', input: null, harness });
    expect(run.output).toBe('permission');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(run.steps['weakening/look']).toBeUndefined();
    expect(run.steps['weakening-call/look']).toBeUndefined();
  });

  it('runs a child entry wider than its parent by default and refuses it under requireGrants (children.test.ts:1906)', async ({
    stateDir,
    runs,
  }) => {
    const tools: string[][] = [];
    const harness = {
      invoke: (request: { readonly options: object }) => {
        tools.push((request.options as { readonly tools?: string[] }).tools ?? []);
        return Promise.resolve({ text: 'ok', sessionId: null });
      },
    };
    const builder = defineWorkflow({
      name: 'builder',
      ...base,
      roster: defineRoster({ Runner: { harness: 'claude', tools: ['Read', 'Edit', 'Bash'] } }),
      async run(ctx) {
        await ctx.roster.Runner.text('build', { prompt: 'x' });
        // A raw call-site capability is not compared to the parent either.
        await ctx.claude.text('fetch', { prompt: 'y', tools: ['WebFetch'] });
        return null;
      },
    });
    const parent = (requireGrants: boolean) =>
      defineWorkflow({
        name: 'parent',
        ...base,
        requireGrants,
        children: [builder],
        async run(ctx) {
          // The remap names an unknown child entry; without requireGrants it is accepted and ignored.
          return ctx.workflow('builder', builder, null, { profiles: { missing: 'text' } });
        },
      });
    const run = await runs.run(parent(false), { stateDir, runId: 'open', input: null, harness });
    expect(run.status).toBe('completed');
    expect(tools).toEqual([['Read', 'Edit', 'Bash'], ['WebFetch']]);
    await expect(
      runs.run(parent(true), { stateDir, runId: 'opted', input: null, grants: ['all'], harness }),
    ).rejects.toThrow('Unknown child profile mapping: missing.');
    const mapped = defineWorkflow({
      name: 'parent',
      ...base,
      requireGrants: true,
      children: [builder],
      roster: defineRoster({
        Editor: { harness: 'claude', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] },
      }),
      async run(ctx) {
        return ctx.workflow('builder', builder, null, { profiles: { Runner: 'Editor' } });
      },
    });
    // Editor is pinned, so its pin check (Bash needs exec) refuses before the tools subset check.
    await expect(
      runs.run(mapped, { stateDir, runId: 'mapped', input: null, grants: ['all'], harness }),
    ).rejects.toThrow('Child profile builder.Runner exceeds parent profile Editor: access.');
    // The run-level flag turns the same layer on for a root that does not declare it.
    await expect(
      runs.run(
        { ...mapped, requireGrants: false },
        { stateDir, runId: 'flagged', input: null, grants: ['all'], requireGrants: true, harness },
      ),
    ).rejects.toThrow('Child profile builder.Runner exceeds parent profile Editor: access.');
    expect(tools).toHaveLength(2);
  });

  it('ignores a child definition requireGrants: the root decides for every child (children.test.ts:1965)', async ({
    stateDir,
    runs,
  }) => {
    const { invoke, harness } = fake();
    const child = defineWorkflow({
      name: 'child',
      ...base,
      requireGrants: true,
      roster: defineRoster({ Fixer: { harness: 'claude', tools: ['Read', 'Edit'] } }),
      async run(ctx) {
        await ctx.roster.Fixer.text('fix', { prompt: 'x' });
        return null;
      },
    });
    const root = defineWorkflow({
      name: 'parent',
      ...base,
      children: [child],
      run: (ctx) => ctx.workflow('child', child, null),
    });
    const run = await runs.run(root, { stateDir, runId: 'child-flag', input: null, harness });
    expect(run.status).toBe('completed');
    expect(invoke).toHaveBeenCalledTimes(1);
    // validate --json publishes child requiredGrants only when the root opts in.
    expect(describeWorkflow(root).children[0]?.capabilities.requiredGrants).toEqual([]);
    expect(
      describeWorkflow({ ...root, requireGrants: true }).children[0]?.capabilities.requiredGrants,
    ).toEqual(['Fixer']);
  });
});

describe('registered harness delegation', () => {
  it('refuses a child entry with no parent grant and delegates the parent entry model (harness-registry.test.ts:232)', async ({
    stateDir,
    runs,
  }) => {
    // The options schema carries model, so a roster entry for this harness can set it.
    const tool = defineHarness({
      name: 'tool',
      revision: 1,
      options: z.object({
        prompt: z.string(),
        tools: z.array(z.string()).optional(),
        model: z.string().optional(),
      }),
      capabilities: { structuredOutput: 'none' },
      capabilityKeys: ['tools'],
      access: (options) => (options.tools?.length ? 'exec' : 'none'),
    });
    const invoke = vi
      .fn<HarnessAdapter['invoke']>()
      .mockResolvedValue({ text: 'done', sessionId: null });
    const adapters = { tool: { invoke } };
    const child = defineWorkflow({
      name: 'child',
      version: '1',
      input: z.null(),
      output: z.string(),
      requireGrants: true,
      harnesses: [tool],
      roster: defineRoster(
        { Worker: { harness: 'tool', tools: ['shell'] } },
        { harnesses: [tool] },
      ),
      async run(ctx) {
        return (await ctx.roster.Worker.text('work', { prompt: 'x' })).output;
      },
    });
    const shared = {
      name: 'registry',
      version: '1',
      input: z.null(),
      output: z.string(),
      requireGrants: true,
      harnesses: [tool],
      children: [child],
    } as const;
    const bare = defineWorkflow({
      ...shared,
      async run(ctx) {
        return ctx.workflow('child', child, null);
      },
    });
    await expect(
      runs.run(bare, { stateDir, runId: 'ungranted', input: null, adapters, grants: ['exec'] }),
    ).rejects.toThrow('no parent grant Worker');
    expect(invoke).not.toHaveBeenCalled();
    const granted = defineWorkflow({
      ...shared,
      roster: defineRoster(
        { Worker: { harness: 'tool', tools: ['shell'], model: 'parent-model' } },
        { harnesses: [tool] },
      ),
      async run(ctx) {
        return ctx.workflow('child', child, null);
      },
    });
    const delegated = await runs.run(granted, {
      stateDir,
      runId: 'granted',
      input: null,
      adapters,
      grants: ['Worker'],
    });
    expect(delegated.output).toBe('done');
    expect(delegated.steps['child/work']?.request?.model).toBe('parent-model');
  });
});
