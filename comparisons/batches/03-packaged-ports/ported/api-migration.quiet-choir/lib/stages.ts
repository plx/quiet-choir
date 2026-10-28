// The two writer stages: migrate one approved group, and repair one failure cluster. Each writer
// gets a fresh runtime-owned worktree, and code checks its receipt against the files it may change
// before the change can be integrated. Call each under a scope (a map item), so the agent's step
// ID takes that prefix.
import type { Agent } from 'quiet-choir';
import { Repaired, Transformed, type Cluster, type Failure, type Planned } from '../contracts.js';
import { prompts } from '../prompts.js';
import { owned, type Outcome, type Repair } from './policy.js';

interface Migration {
  readonly from: string;
  readonly to: string;
  readonly notes: string | null;
  readonly digest: string;
  readonly plan: string;
}

/**
 * Migrate `group` in a checkout of `base` (step `migrate`). A blocked group, a refused receipt and
 * an unchanged tree integrate nothing, so their files keep the old API.
 */
export async function migrateGroup(
  migrator: Agent,
  options: Migration & { group: Planned; base: string },
): Promise<Outcome> {
  const { group, base, ...migration } = options;
  const result = await migrator.object('migrate', {
    worktree: { base: { commit: base } },
    schema: Transformed,
    prompt: prompts.Migrate({ ...migration, group }),
  });
  const { status, summary, blockers } = result.output;
  if (status === 'blocked') return { status, summary, blockers, change: null };
  const verdict = owned(result.worktree, group.files);
  if ('refused' in verdict)
    return { status: 'refused', summary: `Refused: ${verdict.refused}`, blockers, change: null };
  if (!verdict.change)
    return {
      status: 'unchanged',
      summary: `Reported ${status}, changed nothing`,
      blockers,
      change: null,
    };
  return { status, summary, blockers, change: verdict.change };
}

/**
 * Repair `cluster` in a checkout of the integrated `commit` (step `repair`), changing only the
 * approved files.
 */
export async function repairCluster(
  repairer: Agent,
  options: Migration & {
    cluster: Cluster;
    commit: string;
    allowed: string[];
    leftovers: string[];
    failures: Failure[];
  },
): Promise<Repair> {
  const { commit, ...rest } = options;
  const result = await repairer.object('repair', {
    worktree: { base: { commit } },
    schema: Repaired,
    prompt: prompts.Repair(rest),
  });
  const { summary } = result.output;
  const verdict = owned(result.worktree, options.allowed);
  if ('refused' in verdict) return { repair: 'refused', summary: verdict.refused, change: null };
  return verdict.change
    ? { repair: 'applied', summary, change: verdict.change }
    : { repair: 'unchanged', summary, change: null };
}
