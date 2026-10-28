// Pure rules: the evidence and usage caps, coverage of the code-found files, the approved plan text
// and digest, the files the upgrade may change, a writer's receipt checked against them, the
// disjoint cluster assignment with upstream's three-fixer cap, and the command verdicts.
import { createHash } from 'node:crypto';
import type { MapStepError, Settled, WorktreeChange } from 'quiet-choir';
import type { Check, Cluster, ClusterOutcome, Impact, Plan } from '../contracts.js';

/** Upstream's stabilize round runs at most three fixers, on the first clusters. */
export const FIXERS_PER_ROUND = 3;
/** The most manifest lines the analysts read; the rest are counted, never silently dropped. */
const EVIDENCE_LINES = 60;

/** The evidence lines the analysts read and how many were left out. */
export const capEvidence = (lines: string[]) => ({
  evidence: lines.slice(0, EVIDENCE_LINES),
  evidenceOmitted: Math.max(0, lines.length - EVIDENCE_LINES),
});

/** The code-found files, manifests aside: the first `max` for the analyst, the rest unmapped. */
export function usageFiles(hits: string[], manifests: string[], max: number) {
  const files = hits.filter((file) => !manifests.includes(file));
  return { mapped: files.slice(0, max), unmapped: files.slice(max) };
}

/** The analyst's usage sites, and the listed files it neither mapped nor excused. */
export function classify(mapped: string[], impact: Impact) {
  const sites = [...new Set(impact.usageSites.map((site) => site.file))];
  const excused = new Set(impact.unrelated.map((entry) => entry.file));
  return {
    sites,
    unclassified: mapped.filter((file) => !sites.includes(file) && !excused.has(file)),
  };
}

/** The plan as the human approves it and the writers receive it, with stable key order. */
export const planText = (upgrade: { package: string; from: string; to: string }, plan: Plan) =>
  JSON.stringify(
    {
      package: upgrade.package,
      from: upgrade.from,
      to: upgrade.to,
      riskLevel: plan.riskLevel,
      steps: plan.steps,
      files: plan.files,
      riskNotes: plan.riskNotes,
      testFocus: plan.testFocus,
    },
    null,
    2,
  );

/** The SHA-256 of the approved plan text. */
export const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A bounded preview for the approval question; the subject carries the whole plan. */
export const preview = (text: string): string =>
  Buffer.from(text).subarray(0, 15_000).toString('utf8');

/** Every file the upgrade may change: the plan's files and the operator's manifests. */
export const allowedFiles = (plan: Plan, manifests: string[]) =>
  [...new Set([...manifests, ...plan.files])].sort();

/**
 * A writer's receipt checked against the files it may change: it may add, modify or delete them,
 * never rename one. Returns the change (null when the tree is unchanged) or why it is refused.
 */
export function owned(
  change: WorktreeChange | undefined,
  allowed: string[],
): { change: WorktreeChange | null } | { refused: string } {
  if (!change) throw new Error('Writer did not produce an isolated receipt');
  const outside = change.files.filter(
    (file) => file.status === 'renamed' || !allowed.includes(file.path),
  );
  if (outside.length)
    return {
      refused: `changed files outside its approved set: ${outside.map((file) => `${file.path} (${file.status})`).join(', ')}`,
    };
  return { change: change.commit ? change : null };
}

/** The changed files of an integrated tree that the plan does not allow. */
export const outsidePlan = (files: { path: string; status: string }[], allowed: string[]) =>
  files
    .filter((file) => !allowed.includes(file.path))
    .map((file) => `${file.path} (${file.status})`);

/**
 * Give each cluster the allowed files it names that no earlier cluster claimed, so fixers work on
 * disjoint files and their changes cannot conflict. The first clusters with files get a fixer;
 * a cluster left without a file is unowned, and one past the cap is deferred.
 */
export function assign(clusters: Cluster[], allowed: string[]) {
  const claimed = new Set<string>();
  const fixing: Cluster[] = [];
  const skipped: ClusterOutcome[] = [];
  for (const cluster of clusters) {
    const files = [...new Set(cluster.files)].filter(
      (file) => allowed.includes(file) && !claimed.has(file),
    );
    if (!files.length)
      skipped.push({
        ...cluster,
        fix: 'unowned',
        summary: 'Its files are outside the plan or claimed by an earlier cluster',
      });
    else if (fixing.length >= FIXERS_PER_ROUND)
      skipped.push({ ...cluster, fix: 'deferred', summary: 'Over the three-fixer cap' });
    else {
      for (const file of files) claimed.add(file);
      fixing.push({ description: cluster.description, files });
    }
  }
  return { fixing, skipped };
}

/** A fixer's outcome as its mapper returns it, with the change to integrate. */
export type Fix = Pick<ClusterOutcome, 'fix' | 'summary'> & { change: WorktreeChange | null };

/** Join each settled fixer to its cluster; a failed call leaves its cluster unfixed. */
export const settleFixes = (
  clusters: Cluster[],
  results: Settled<Fix, MapStepError>[],
): (ClusterOutcome & { change: WorktreeChange | null })[] =>
  clusters.map((cluster, index) => {
    const result = results[index];
    return result?.ok
      ? { ...cluster, ...result.value }
      : {
          ...cluster,
          fix: 'failed',
          summary: `Fixer failed: ${result?.error.message ?? 'no outcome'}`,
          change: null,
        };
  });

/** A cluster's outcome for the output, without its change. */
export const reported = ({ description, files, fix, summary }: ClusterOutcome): ClusterOutcome => ({
  description,
  files,
  fix,
  summary,
});

/** A command passed: it exited 0 with complete output. */
export const green = (check: Check) =>
  check.failure === null && check.code === 0 && !check.truncated;

/** A failing command's outcome in words. */
export function outcomeOf(check: Check): string {
  const exit = check.signal
    ? `signal ${check.signal}`
    : check.code === null
      ? null
      : `exit ${String(check.code)}`;
  if (check.failure !== null) return exit ? `${check.failure}, ${exit}` : check.failure;
  return check.truncated ? `${exit ?? 'exit'} with truncated output` : (exit ?? 'no exit code');
}

/** The commands a round left failing, as the output's remaining list. */
export const failing = (round: { install: Check | null; checks: Check[] }) =>
  [...(round.install ? [round.install] : []), ...round.checks]
    .filter((check) => !green(check))
    .map((check) => `${check.argv.join(' ')}: ${outcomeOf(check)}`);
