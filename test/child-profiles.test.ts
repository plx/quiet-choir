import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { z } from '../src/index.js';
import type { WorkflowDeclaration } from '../src/workflow/runtime/child-model.js';
import { delegateCapabilities } from '../src/workflow/runtime/child-profiles.js';
import { profileGrantDigest, resolveCapabilities } from '../src/workflow/runtime/profiles.js';
import type { AgentProfile, ResolvedProfile } from '../src/workflow/runtime/profiles-model.js';
import type { ClaudeOptions, ExecutionPolicy } from '../src/workflow/runtime/model.js';

function declaration(
  name: string,
  profiles: Readonly<Record<string, AgentProfile>>,
): WorkflowDeclaration {
  return {
    name,
    version: '1',
    input: z.null(),
    output: z.null(),
    run: () => Promise.resolve(null),
    profiles,
  };
}

it('clamps a delegated profile to the root ceiling before a grandchild can inherit a laxer one', () => {
  // Root caps the shared "worker" role well below what an intermediate child declares.
  const root = resolveCapabilities({
    profiles: { worker: { extends: 'edit', maxTurns: 3, maxBudgetUsd: 3, timeoutMs: 3_000 } },
  });
  const rootCeiling = root.profiles['worker'];
  if (!rootCeiling) throw new Error('root ceiling missing');
  const grants = ['worker'];
  const pins = { worker: profileGrantDigest(rootCeiling) };

  // The middle child declares a much larger limit for the same role name.
  const middle = delegateCapabilities(
    declaration('middle', {
      worker: { extends: 'edit', maxTurns: 99, maxBudgetUsd: 99, timeoutMs: 99_000 },
    }),
    root,
    grants,
    pins,
    [],
    {},
  );
  // The delegated manifest handed to descendants must already carry the clamped ceiling, not
  // the child's own laxer declaration.
  expect(middle.manifest.profiles['worker']).toMatchObject({
    maxTurns: 3,
    maxBudgetUsd: 3,
    timeoutMs: 3_000,
  });

  // A grandchild that asks for the child's laxer limit must still be capped at the root's ceiling.
  const grandchild = delegateCapabilities(
    declaration('grandchild', { worker: { extends: 'edit' } }),
    middle.manifest,
    middle.grants,
    middle.pins,
    middle.overrides,
    {},
  );
  expect(
    grandchild.limits('worker', { maxTurns: 99, maxBudgetUsd: 99, timeoutMs: 99_000 }),
  ).toEqual({ maxTurns: 3, maxBudgetUsd: 3, timeoutMs: 3_000 });
});

it('clamps a delegated idle deadline to the parent ceiling', () => {
  const root = resolveCapabilities({
    profiles: { worker: { extends: 'readonly', idleTimeoutMs: 1_000 } },
  });
  const ceiling = root.profiles['worker'];
  if (!ceiling) throw new Error('root ceiling missing');
  const child = delegateCapabilities(
    declaration('child', { worker: { extends: 'readonly', idleTimeoutMs: 99_000 } }),
    root,
    ['worker'],
    { worker: profileGrantDigest(ceiling) },
    [],
    {},
  );
  expect(child.manifest.profiles['worker']?.idleTimeoutMs).toBe(1_000);
  expect(child.limits('worker', { idleTimeoutMs: 99_000 }).idleTimeoutMs).toBe(1_000);
  expect(child.limits('worker', { idleTimeoutMs: 500 }).idleTimeoutMs).toBe(500);
  // An unset child deadline inherits the parent ceiling rather than running without one.
  const unset: ExecutionPolicy = {};
  expect(child.limits('worker', unset).idleTimeoutMs).toBe(1_000);
});

it('keeps a failing parent denial policy for omitted child policies and refuses explicit warn', () => {
  const root = resolveCapabilities({
    defaults: { claude: { onPermissionDenied: 'fail' } },
    profiles: { scout: { extends: 'readonly', onPermissionDenied: 'fail' } },
  });
  const pins = Object.fromEntries(
    Object.entries(root.profiles).map(([name, role]) => [name, profileGrantDigest(role)]),
  );
  const inherited = delegateCapabilities(
    declaration('child', { scout: { extends: 'readonly' } }),
    root,
    [],
    pins,
    [],
    {},
  );
  expect(inherited.manifest.profiles['scout']?.onPermissionDenied).toBe('fail');
  // A Claude-only failing policy passes to omitted built-ins at the Claude level.
  expect(inherited.manifest.profiles['text']?.claude.onPermissionDenied).toBe('fail');
  expect(() => {
    inherited.check('scout', 'claude', {
      prompt: 'x',
      onPermissionDenied: 'warn',
    } as ClaudeOptions);
  }).toThrow('exceeds parent profile scout: onPermissionDenied');
  expect(() => {
    inherited.check('scout', 'claude', {
      prompt: 'x',
      onPermissionDenied: 'fail',
    } as ClaudeOptions);
  }).not.toThrow();
  expect(() => {
    inherited.check('text', 'claude', { prompt: 'x' });
  }).not.toThrow();

  expect(() =>
    delegateCapabilities(
      declaration('child', { scout: { extends: 'readonly', onPermissionDenied: 'warn' } }),
      root,
      [],
      pins,
      [],
      {},
    ),
  ).toThrow('exceeds parent profile scout: onPermissionDenied');
  expect(() =>
    delegateCapabilities(
      { ...declaration('child', {}), defaults: { claude: { onPermissionDenied: 'warn' } } },
      root,
      [],
      pins,
      [],
      {},
    ),
  ).toThrow('exceeds parent profile text: onPermissionDenied');
});

it('lets a delegated child role inherit the parent role Codex effort unless it sets its own', () => {
  const root = resolveCapabilities({
    profiles: { careful: { extends: 'readonly', codex: { effort: 'minimal' } } },
  });
  const delegated = delegateCapabilities(
    declaration('child', {
      author: { extends: 'readonly' },
      tuned: { extends: 'readonly', codex: { effort: 'high' } },
    }),
    root,
    [],
    {},
    [],
    { profiles: { author: 'careful', tuned: 'careful' } },
  );
  expect(delegated.manifest.profiles['author']?.codex).toMatchObject({ effort: 'minimal' });
  expect(delegated.manifest.profiles['tuned']?.codex).toMatchObject({ effort: 'high' });
});

it('delegates Claude directories by containment in the parent roots (#171)', () => {
  const tree = mkdtempSync(join(tmpdir(), 'choir-child-roots-'));
  try {
    const root = join(tree, 'root');
    mkdirSync(join(root, 'sub'), { recursive: true });
    const parent = resolveCapabilities({
      profiles: { reader: { extends: 'readonly', claude: { addDirRoots: [root] } } },
    });
    const ceiling = parent.profiles['reader'];
    if (!ceiling) throw new Error('parent role missing');
    const pins = { reader: profileGrantDigest(ceiling) };
    const delegate = (roots: string[], withCwd = true) =>
      delegateCapabilities(
        declaration('child', { reader: { extends: 'readonly', claude: { addDirRoots: roots } } }),
        parent,
        ['reader'],
        pins,
        [],
        {},
        withCwd ? tree : undefined,
      );
    // Equal and nested roots (absolute, or relative to the run cwd) stay inside the parent's.
    for (const roots of [[root], [join(root, 'sub')], ['root/sub']])
      expect(() => delegate(roots)).not.toThrow();
    for (const roots of [[tree], [join(tree, 'other')], [root, join(tree, 'other')]])
      expect(() => delegate(roots)).toThrow(
        'Child profile child.reader exceeds parent profile reader: claude.addDirRoots.',
      );
    // Without the run cwd only a literally delegated root passes.
    expect(() => delegate([root], false)).not.toThrow();
    expect(() => delegate([join(root, 'sub')], false)).toThrow('claude.addDirRoots');
    // A child call's canonical directories are rechecked against the parent's roots.
    const child = delegate([join(root, 'sub')]);
    const inside = join(realpathSync.native(root), 'sub', 'pr-1');
    expect(() => {
      child.check('reader', 'claude', { prompt: 'x', addDirs: [inside] });
    }).not.toThrow();
    expect(() => {
      child.check('reader', 'claude', {
        prompt: 'x',
        addDirs: [join(tree, 'outside')],
      });
    }).toThrow('Child profile child.reader exceeds parent profile reader: claude.addDirs.');
    // Relative entries still need literal membership: their effect cwd is unknown here.
    expect(() => {
      child.check('reader', 'claude', { prompt: 'x', addDirs: ['root/sub'] });
    }).toThrow('claude.addDirs');
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

it('rechecks every ancestor role root when delegating to grandchildren (#391)', () => {
  const base = mkdtempSync(join(tmpdir(), 'choir-ancestor-roots-'));
  try {
    const allowed = join(base, 'allowed');
    const inner = join(allowed, 'inner');
    const outside = join(base, 'outside');
    const link = join(allowed, 'link');
    mkdirSync(inner, { recursive: true });
    mkdirSync(outside);
    symlinkSync(inner, link);
    const top = resolveCapabilities({
      profiles: { reader: { extends: 'readonly', claude: { addDirRoots: [allowed] } } },
    });
    const topReader = top.profiles['reader'];
    if (!topReader) throw new Error('top role missing');
    const middle = delegateCapabilities(
      declaration('middle', { reader: { extends: 'readonly', claude: { addDirRoots: [link] } } }),
      top,
      ['reader'],
      { reader: profileGrantDigest(topReader) },
      [],
      {},
      base,
    );
    // A root-level child carries only its parent's ceiling; its own checks see no ancestors.
    expect(middle.ancestry['reader']).toEqual([
      { profile: 'reader', addDirs: [], addDirRoots: [allowed] },
    ]);
    const delegateLeaf = (options: { profiles?: Record<string, string> } = {}, role = 'reader') =>
      delegateCapabilities(
        declaration('leaf', { [role]: { extends: 'readonly', claude: { addDirRoots: [link] } } }),
        middle.manifest,
        middle.grants,
        middle.pins,
        middle.overrides,
        options,
        base,
        middle.ancestry,
      );
    const leaf = delegateLeaf();
    expect(leaf.ancestry['reader']).toEqual([
      { profile: 'reader', addDirs: [], addDirRoots: [allowed] },
      { profile: 'reader', addDirs: [], addDirRoots: [link] },
    ]);
    const insideDir = join(realpathSync.native(inner), 'x');
    expect(() => {
      leaf.check('reader', 'claude', { prompt: 'x', addDirs: [insideDir] });
    }).not.toThrow();

    // Retarget the narrowed root outside the top-level root after the leaf's delegation.
    rmSync(link);
    symlinkSync(outside, link);
    const outsideDir = join(realpathSync.native(outside), 'x');
    expect(() => {
      leaf.check('reader', 'claude', { prompt: 'x', addDirs: [outsideDir] });
    }).toThrow(
      'Child profile leaf.reader exceeds ancestor profile reader: claude.addDirs. Delegate a sufficient parent role explicitly.',
    );
    // The leaf's own root is rechecked on calls that add no directory.
    expect(() => {
      leaf.check('reader', 'claude', { prompt: 'x' });
    }).toThrow('Child profile leaf.reader exceeds ancestor profile reader: claude.addDirRoots.');
    // A fresh delegation is refused, also through a mapped role name.
    expect(() => delegateLeaf()).toThrow(
      'Child profile leaf.reader exceeds ancestor profile reader: claude.addDirRoots.',
    );
    expect(() => delegateLeaf({ profiles: { scan: 'reader' } }, 'scan')).toThrow(
      'Child profile leaf.scan exceeds ancestor profile reader: claude.addDirRoots.',
    );
    // The middle's own calls were already refused against its immediate parent.
    expect(() => {
      middle.check('reader', 'claude', { prompt: 'x' });
    }).toThrow('Child profile middle.reader exceeds parent profile reader: claude.addDirRoots.');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it('keeps literal Claude directory delegation working through every ancestor (#391)', () => {
  const base = mkdtempSync(join(tmpdir(), 'choir-ancestor-literal-'));
  try {
    const allowed = join(base, 'allowed');
    mkdirSync(join(allowed, 'inner'), { recursive: true });
    const top = resolveCapabilities({
      profiles: {
        reader: { extends: 'readonly', claude: { addDirs: ['docs'], addDirRoots: [allowed] } },
      },
    });
    const topReader = top.profiles['reader'];
    if (!topReader) throw new Error('top role missing');
    const chain = (middleRoots: string[], leafRoots: string[], rootCwd?: string) => {
      const middle = delegateCapabilities(
        declaration('middle', {
          reader: { extends: 'readonly', claude: { addDirs: ['docs'], addDirRoots: middleRoots } },
        }),
        top,
        ['reader'],
        { reader: profileGrantDigest(topReader) },
        [],
        {},
        base,
      );
      return delegateCapabilities(
        declaration('leaf', {
          reader: { extends: 'readonly', claude: { addDirs: ['docs'], addDirRoots: leafRoots } },
        }),
        middle.manifest,
        middle.grants,
        middle.pins,
        middle.overrides,
        {},
        rootCwd,
        middle.ancestry,
      );
    };
    // A relative static directory listed literally at every level delegates with or without cwd.
    for (const rootCwd of [base, undefined]) {
      const leaf = chain([allowed], [allowed], rootCwd);
      expect(() => {
        leaf.check('reader', 'claude', { prompt: 'x', addDirs: ['docs'] });
      }).not.toThrow();
    }
    // Without the run cwd, only literal membership delegates, at the ancestor level too.
    const nested = join(allowed, 'inner');
    expect(() => chain([nested], [nested], base)).not.toThrow();
    expect(() => chain([nested], [nested])).toThrow(
      'Child profile leaf.reader exceeds ancestor profile reader: claude.addDirRoots.',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it('reads only own keys when a role is named like an Object.prototype member (#391)', () => {
  const base = mkdtempSync(join(tmpdir(), 'choir-ancestor-proto-'));
  try {
    const allowed = join(base, 'allowed');
    const outside = join(base, 'outside');
    const link = join(allowed, 'link');
    mkdirSync(join(allowed, 'inner'), { recursive: true });
    mkdirSync(outside);
    symlinkSync(join(allowed, 'inner'), link);
    const top = resolveCapabilities({
      profiles: { toString: { extends: 'readonly', claude: { addDirRoots: [allowed] } } },
    });
    const topRole = Reflect.get(top.profiles, 'toString') as ResolvedProfile | undefined;
    if (!topRole) throw new Error('top role missing');
    // The same role name is delegated without a mapping and with no inherited ancestry.
    const middle = delegateCapabilities(
      declaration('middle', {
        toString: { extends: 'readonly', claude: { addDirRoots: [link] } },
      }),
      top,
      ['toString'],
      { toString: profileGrantDigest(topRole) },
      [],
      {},
      base,
    );
    expect(Object.getPrototypeOf(middle.ancestry)).toBeNull();
    expect(Reflect.get(middle.ancestry, 'toString')).toEqual([
      { profile: 'toString', addDirs: [], addDirRoots: [allowed] },
    ]);
    // An unrelated role does not pick up a prototype member as its ancestry or parent name.
    expect(Object.hasOwn(middle.ancestry, 'valueOf')).toBe(false);
    // A grandchild role maps onto the prototype-named parent role through two levels.
    const delegateLeaf = () =>
      delegateCapabilities(
        declaration('leaf', {
          reader: { extends: 'readonly', claude: { addDirRoots: [link] } },
        }),
        middle.manifest,
        middle.grants,
        middle.pins,
        middle.overrides,
        { profiles: { reader: 'toString' } },
        base,
        middle.ancestry,
      );
    const leaf = delegateLeaf();
    expect(leaf.ancestry['reader']).toEqual([
      { profile: 'toString', addDirs: [], addDirRoots: [allowed] },
      { profile: 'toString', addDirs: [], addDirRoots: [link] },
    ]);
    // The ancestor ceiling under that name still refuses a retargeted root.
    rmSync(link);
    symlinkSync(outside, link);
    expect(() => delegateLeaf()).toThrow(
      'Child profile leaf.reader exceeds ancestor profile toString: claude.addDirRoots.',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
