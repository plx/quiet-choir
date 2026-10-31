// Pure rules: one target per location, the ranker's selection joined to the survey, a net claim
// checked against the writer's receipt (exactly the declared files, all new), net collisions
// between targets, the approved digest, the bounded text an agent sees, and the summary line.
import { createHash } from 'node:crypto';
import type { MapStepError, Settled, WorktreeChange } from 'quiet-choir';
import type { Chosen, NetClaim, RefactorOutput, Target } from '../contracts.js';

/**
 * The first surveyed target per location, so the ranker's enum and the map items are unique;
 * `duplicates` counts the later ones dropped.
 */
export function uniqueTargets(surveyed: Target[]) {
  const byLocation = new Map<string, Target>();
  for (const target of surveyed)
    if (!byLocation.has(target.location)) byLocation.set(target.location, target);
  const targets = [...byLocation.values()];
  return { targets, duplicates: surveyed.length - targets.length };
}

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
): Omit<GreenNet, 'status' | 'rounds' | 'partial'> | { why: string } {
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

/**
 * A pinned net: the files it added (its test file first) and what it pins. `partial` counts the
 * previous net files its repair rounds were shown only in part.
 */
export interface GreenNet {
  readonly status: 'green';
  readonly netFile: string;
  readonly supportFiles: string[];
  readonly files: string[];
  readonly behaviorsPinned: string[];
  readonly rounds: number;
  readonly partial: number;
  readonly change: WorktreeChange & { commit: string };
}
export type NetOutcome =
  GreenNet | { readonly status: 'skipped'; readonly why: string; readonly partial: number };

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
  return {
    green,
    skipped,
    failedNets: results.filter((result) => !result.ok).length,
    truncatedRepairFiles: results.reduce(
      (sum, result) => sum + (result.ok ? result.value.partial : 0),
      0,
    ),
  };
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

/** The bytes of the plan the approval question's details show. */
const PREVIEW = 15_000;

/** A bounded preview for the approval question, which says when it is cut. */
export function preview(text: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= PREVIEW) return text;
  const shown = bytes.subarray(0, PREVIEW).toString('utf8');
  return `${shown}\n\n(Only the first ${String(PREVIEW)} bytes are shown; the question's subject holds the whole plan.)`;
}

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
  const { refactored, netOnly, skipped, deferred, netsCommit, commit, refusal } = output;
  const dropped = output.duplicateTargets
    ? ` ${String(output.duplicateTargets)} surveyed duplicates dropped.`
    : '';
  const tail = `${String(skipped.length)} could not be pinned; ${String(deferred.length)} deferred by the ranker.${dropped}`;
  // Nothing reached the checkout, so say where the green nets are and how to keep them.
  const keep = `The nets are in run-owned commit ${netsCommit ?? 'none'}; git merge it to keep them.`;
  const kept = commit
    ? `run-owned commit ${commit} (the nets and ${String(refactored.length)} kept refactors, every net and verify command green on it) was not published; git merge that commit to keep it.`
    : 'nothing was integrated.';
  const reason = refusal ? refusal.message.replace(/\.$/u, '') : '';
  switch (output.status) {
    case 'dirty-checkout':
      return `An apply run publishes onto a clean checkout, and this one has uncommitted changes (${reason}), so nothing was surveyed; commit or stash them and start a new run.`;
    case 'no-targets':
      return `No measurable refactoring targets were chosen; ${String(deferred.length)} deferred.${dropped}`;
    case 'no-nets':
      return `No target got a green characterization net, so nothing was refactored. ${tail}`;
    case 'baseline-red':
      return `A net or verify command already fails on run-owned nets commit ${netsCommit ?? 'none'}, before any refactor, so nothing was refactored or published; fix the baseline (or the nets, if they interfere) and run again. ${tail}`;
    case 'report':
      return `${String(netOnly.length)} targets pinned by green nets and planned; apply was false, so the checkout is untouched and a run with apply pins them again. ${keep} ${tail}`;
    case 'declined':
      return `The refactoring plan for ${String(netOnly.length)} pinned targets was declined; nothing was published. ${keep} ${tail}`;
    case 'verification-failed':
      return `The final verification failed on run-owned integration ${commit ?? 'none'} (${String(refactored.length)} refactors kept), so nothing was published. ${keep} ${tail}`;
    case 'checkout-moved':
      return `The checkout moved during the run${refusal ? ` and ${refusal.step} conflicted with it (${reason})` : ''}, so nothing was published; ${kept} ${tail}`;
    case 'merge-refused':
      return `The ${refusal?.step ?? 'merge'} merge refused (${reason}) although the checkout had not moved, so nothing was published; ${kept} ${tail}`;
    default:
      return `${String(refactored.length)} refactored behind green nets, ${String(netOnly.length)} kept only their nets; the nets were published and left in place. ${tail}`;
  }
}
