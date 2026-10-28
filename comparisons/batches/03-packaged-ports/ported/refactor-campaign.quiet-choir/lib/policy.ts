// Pure rules: one target per location, the ranker's selection joined to the survey, a net claim
// checked against the writer's receipt (exactly the declared files, all new), net collisions
// between targets, the approved digest, the bounded text an agent sees, and the summary line.
import { createHash } from 'node:crypto';
import type { MapStepError, Settled, WorktreeChange } from 'quiet-choir';
import type { Chosen, NetClaim, RefactorOutput, Target } from '../contracts.js';

/** The first surveyed target per location, so the ranker's enum and the map items are unique. */
export const uniqueTargets = (targets: Target[]): Target[] => [
  ...new Map(targets.map((target) => [target.location, target])).values(),
];

/** The ranker's picks in its order, once each, with the survey's evidence; the rest are deferred. */
export function choose(
  targets: Target[],
  ranked: {
    location: string;
    refactoring: string;
    payoff: Chosen['payoff'];
    risk: Chosen['risk'];
  }[],
) {
  const byLocation = new Map(targets.map((target) => [target.location, target]));
  const chosen: Chosen[] = [];
  for (const pick of ranked) {
    const target = byLocation.get(pick.location);
    if (!target || chosen.some((done) => done.location === pick.location)) continue;
    chosen.push({ ...target, ...pick });
  }
  const deferred = targets.filter((target) => !chosen.some((c) => c.location === target.location));
  return { chosen, deferred };
}

/**
 * A pinned net's claim checked against the writer's receipt. Every round starts from a fresh
 * checkout of the base, so the receipt is exactly that round's files: the writer may only add
 * files, and those must be exactly the net file and the support files it declared. A file it
 * cannot account for would otherwise be published and protected without ever being run.
 */
export function acceptNet(
  net: NetClaim,
  change: WorktreeChange | undefined,
): Omit<GreenNet, 'status' | 'rounds'> | { why: string } {
  if (net.status === 'cannot-pin') return { why: `cannot pin: ${net.notes || 'no reason given'}` };
  if (net.netFile === null) return { why: 'pinned without a net file' };
  if (!net.behaviorsPinned.length) return { why: 'pinned net names no behavior' };
  if (!change?.commit) return { why: 'net writer left no change in its checkout' };
  const unexpected = change.files.filter((file) => file.status !== 'added');
  if (unexpected.length)
    return { why: `net writer changed existing files: ${JSON.stringify(unexpected)}` };
  const supportFiles = [...new Set(net.supportFiles)].filter((path) => path !== net.netFile);
  const files = [net.netFile, ...supportFiles];
  const added = change.files.map((file) => file.path);
  const undeclared = added.filter((path) => !files.includes(path));
  if (undeclared.length)
    return { why: `net writer added undeclared files: ${undeclared.join(', ')}` };
  const missing = files.filter((path) => !added.includes(path));
  if (missing.length) return { why: `declared net files were not added: ${missing.join(', ')}` };
  return {
    netFile: net.netFile,
    supportFiles,
    files,
    behaviorsPinned: net.behaviorsPinned,
    change: { ...change, commit: change.commit },
  };
}

/** A pinned net: the files it added (its test file first) and what it pins. */
export interface GreenNet {
  readonly status: 'green';
  readonly netFile: string;
  readonly supportFiles: string[];
  readonly files: string[];
  readonly behaviorsPinned: string[];
  readonly rounds: number;
  readonly change: WorktreeChange & { commit: string };
}
export type NetOutcome = GreenNet | { readonly status: 'skipped'; readonly why: string };

/**
 * Split the settled nets into green nets and skipped targets, in rank order. A failed writer is
 * skipped and counted; a net whose files collide with an earlier target's net is skipped too, so
 * the green nets integrate without conflicts.
 */
export function settleNets(chosen: Chosen[], results: Settled<NetOutcome, MapStepError>[]) {
  const green: (GreenNet & { target: Chosen })[] = [];
  const skipped: RefactorOutput['skipped'] = [];
  const claimed = new Map<string, string>();
  for (const [index, target] of chosen.entries()) {
    const result = results[index];
    const skip = (why: string, failed = false) =>
      skipped.push({ location: target.location, refactoring: target.refactoring, why, failed });
    if (!result?.ok) {
      skip(`net writer failed: ${result?.error.message ?? 'no outcome'}`, true);
      continue;
    }
    const outcome = result.value;
    if (outcome.status === 'skipped') {
      skip(outcome.why);
      continue;
    }
    const collision = outcome.files.find((file) => claimed.has(file));
    if (collision !== undefined) {
      skip(`net file ${collision} collides with the net of ${claimed.get(collision) ?? ''}`);
      continue;
    }
    for (const file of outcome.files) claimed.set(file, target.location);
    green.push({ ...outcome, target });
  }
  return { green, skipped, failedNets: results.filter((result) => !result.ok).length };
}

/** The plan entry a human approves and every refactorer receives. */
export const planned = (net: GreenNet & { target: Chosen }) => ({
  location: net.target.location,
  refactoring: net.target.refactoring,
  netFile: net.netFile,
  supportFiles: net.supportFiles,
  behaviorsPinned: net.behaviorsPinned,
});

/** The SHA-256 of the approved text (the goal and the plan), as the refactorers receive it. */
export const planDigest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A bounded preview for the approval question; the subject carries the whole plan. */
export const preview = (text: string): string =>
  Buffer.from(text).subarray(0, 15_000).toString('utf8');

/**
 * At most `max` bytes of a diff or file for an agent, with the shown byte count when truncated.
 * Trailing newlines are dropped, since the prompt closes the text's delimiter on the next line.
 */
export function bounded(text: string, max: number): { text: string; shownBytes: number | null } {
  const bytes = Buffer.from(text);
  const shown = bytes.length <= max ? text : bytes.subarray(0, max).toString('utf8');
  return { text: shown.replace(/\n+$/u, ''), shownBytes: bytes.length <= max ? null : max };
}

/** The touched paths that belong to a net (its test or support files), which no refactor may touch. */
export const netsTouched = (touched: string[], protectedFiles: string[]) =>
  touched.filter((path) => protectedFiles.includes(path));

/** The upstream's one-line summary, from the counts and commits the output already carries. */
export function summarize(output: Omit<RefactorOutput, 'summary'>): string {
  const { refactored, netOnly, skipped, deferred, netsCommit, commit } = output;
  const tail = `${String(skipped.length)} could not be pinned; ${String(deferred.length)} deferred by the ranker.`;
  // Nothing reached the checkout, so say where the green nets are and how to keep them.
  const keep = `The nets are in run-owned commit ${netsCommit ?? 'none'}; git merge it to keep them.`;
  switch (output.status) {
    case 'no-targets':
      return `No measurable refactoring targets were chosen; ${String(deferred.length)} deferred.`;
    case 'no-nets':
      return `No target got a green characterization net, so nothing was refactored. ${tail}`;
    case 'report':
      return `${String(netOnly.length)} targets pinned by green nets and planned; apply was false, so the checkout is untouched and a run with apply pins them again. ${keep} ${tail}`;
    case 'declined':
      return `The refactoring plan for ${String(netOnly.length)} pinned targets was declined; nothing was published. ${keep} ${tail}`;
    case 'verification-failed':
      return `The final verification failed on run-owned commit ${commit ?? 'none'} (${String(refactored.length)} refactors kept), so nothing was published. ${keep} ${tail}`;
    case 'checkout-moved':
      return `The checkout moved during the run, so the verified tree (run-owned commit ${commit ?? 'none'}, ${String(refactored.length)} refactors) was not published onto it. ${tail}`;
    default:
      return `${String(refactored.length)} refactored behind green nets, ${String(netOnly.length)} kept only their nets; the nets were published and left in place. ${tail}`;
  }
}
