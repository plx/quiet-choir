import { expect, it } from 'vitest';
import { z } from '../src/index.js';
import type { WorkflowDeclaration } from '../src/workflow/runtime/child-model.js';
import { delegateCapabilities } from '../src/workflow/runtime/child-profiles.js';
import { profileGrantDigest, resolveCapabilities } from '../src/workflow/runtime/profiles.js';
import type { AgentProfile } from '../src/workflow/runtime/profiles-model.js';

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
