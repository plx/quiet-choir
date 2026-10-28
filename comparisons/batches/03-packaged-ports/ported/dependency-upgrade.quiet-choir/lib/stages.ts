// The repair stage: one fixer per assigned cluster, in a fresh runtime-owned worktree of the
// round's integrated commit, its receipt checked against the files the cluster owns before the
// change can be integrated. Call it inside a map item, so the agent's step ID takes that prefix.
import type { Agent } from 'quiet-choir';
import { Fixed, type Cluster, type Failure, type Research } from '../contracts.js';
import { prompts } from '../prompts.js';
import { owned, type Fix } from './policy.js';

export async function fixCluster(
  fixer: Agent,
  options: {
    upgrade: { package: string; from: string; to: string };
    breaking: Research['breakingChanges'];
    cluster: Cluster;
    commit: string;
    failures: Failure[];
    digest: string;
    plan: string;
  },
): Promise<Fix> {
  const { upgrade, breaking, cluster, commit, failures, digest, plan } = options;
  const result = await fixer.object('fix', {
    worktree: { base: { commit } },
    schema: Fixed,
    prompt: prompts.Fix({ ...upgrade, breaking, cluster, failures, digest, plan }),
  });
  const verdict = owned(result.worktree, cluster.files);
  if ('refused' in verdict) return { fix: 'refused', summary: verdict.refused, change: null };
  return verdict.change
    ? { fix: 'applied', summary: result.output.summary, change: verdict.change }
    : { fix: 'unchanged', summary: result.output.summary, change: null };
}
