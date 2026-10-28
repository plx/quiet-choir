// The two writer stages: build one module, and fix one module's confirmed findings. Each writer
// gets a fresh runtime-owned worktree and settles a failed call as data; code checks its receipt
// against the module's areas before the change can be integrated. Call each under a scope (a map
// item or a ctx.within view), so the agent's step ID takes that prefix.
import type { Agent, WorktreeChange } from 'quiet-choir';
import {
  Implemented,
  Repaired,
  type Module,
  type ModuleRecord,
  type Ticket,
} from '../contracts.js';
import { prompts } from '../prompts.js';
import { owned } from './plan.js';

const brief = (message: string) => message.slice(0, 500);

/** A builder's outcome, with the change to integrate (null unless accepted with edits). */
export interface Built {
  readonly build: ModuleRecord['build'];
  readonly summary: string;
  readonly blockers: string[];
  readonly outside: string[];
  readonly files: string[];
  readonly commit: string | null;
  readonly change: WorktreeChange | null;
}

/**
 * Build `module` in a checkout of `base` (step `build`). A failed call, a blocked report and a
 * receipt outside the areas integrate nothing; a module that changed nothing is `unchanged`.
 */
export async function buildModule(
  builder: Agent,
  options: {
    module: Module;
    tickets: Ticket[];
    builtOn: string[];
    base: string;
    digest: string;
    plan: string;
  },
): Promise<Built> {
  const { base, ...params } = options;
  const result = await builder.object('build', {
    worktree: { base: { commit: base } },
    schema: Implemented,
    prompt: prompts.Build(params),
    onError: 'return',
  });
  const nothing = { outside: [], files: [], commit: null, change: null };
  if (!result.ok)
    return {
      ...nothing,
      build: 'failed',
      summary: `Build failed: ${brief(result.error.message)}`,
      blockers: [],
    };
  const { status, summary, blockers } = result.value.output;
  const { outside, change } = owned(result.value.worktree, options.module.fileAreas);
  const files = result.value.worktree?.files.map((file) => file.path) ?? [];
  const commit = result.value.worktree?.commit ?? null;
  if (status === 'blocked') return { ...nothing, build: status, summary, blockers, files, commit };
  if (outside.length)
    return { ...nothing, build: 'refused', summary, blockers, outside, files, commit };
  if (!change) return { ...nothing, build: 'unchanged', summary, blockers };
  return { build: status, summary, blockers, outside, files, commit, change };
}

/** A fixer's outcome, with the change to integrate after its module's (null unless repaired). */
export interface Fixed {
  readonly record: NonNullable<ModuleRecord['repair']>;
  readonly change: WorktreeChange | null;
}

/** Fix `findings` in a checkout of the module's snapshot `commit` (step `fix`). */
export async function repairModule(
  fixer: Agent,
  options: {
    module: Pick<Module, 'name' | 'fileAreas'>;
    commit: string;
    findings: Parameters<typeof prompts.Repair>[0]['findings'];
  },
): Promise<Fixed> {
  const result = await fixer.object('fix', {
    worktree: { base: { commit: options.commit } },
    schema: Repaired,
    prompt: prompts.Repair({ module: options.module, findings: options.findings }),
    onError: 'return',
  });
  const none = { unresolved: [], outside: [], commit: null };
  if (!result.ok)
    return {
      record: { ...none, status: 'failed', summary: `Fix failed: ${brief(result.error.message)}` },
      change: null,
    };
  const { summary, unresolved } = result.value.output;
  const { outside, change } = owned(result.value.worktree, options.module.fileAreas);
  if (outside.length)
    return { record: { ...none, status: 'refused', summary, unresolved, outside }, change: null };
  if (!change) return { record: { ...none, status: 'unchanged', summary, unresolved }, change };
  return {
    record: { status: 'repaired', summary, unresolved, outside, commit: change.commit },
    change,
  };
}
