import { expect, it } from 'vitest';
import { z } from '../src/index.js';
import type { WorkflowDeclaration } from '../src/workflow/runtime/child-model.js';
import { delegateCapabilities } from '../src/workflow/runtime/child-profiles.js';
import { profileGrantDigest, resolveCapabilities } from '../src/workflow/runtime/profiles.js';
import type { AgentProfile } from '../src/workflow/runtime/profiles-model.js';
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
