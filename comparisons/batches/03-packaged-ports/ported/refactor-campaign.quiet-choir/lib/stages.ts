// The two per-target stages as patterns over teams (ADR 0067): pin a net (write, run, repair from
// the red output) and refactor behind the nets (write, check ownership, run every net and verify
// command, review the diff). Agents propose; code runs every command and decides every verdict.
// Call each stage under a scope (a map item or ctx.scope), so the team's agents and the stage's
// commands share its prefix.
import {
  defineTeam,
  type AgentResult,
  type TeamOf,
  type WorkflowContext,
  type WorktreeChange,
} from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Net, Refactored, Review, type Check, type Chosen, type NetClaim } from '../contracts.js';
import { prompts } from '../prompts.js';
import { green, netArgv, passed, run, show, verify } from './checks.js';
import { acceptNet, bounded, netsTouched, type NetOutcome } from './policy.js';

/** The slot {@link pinNet} needs. */
export const NetTeam = defineTeam({
  writer: 'Writes or rewrites one characterization net in a fresh isolated checkout.',
});
export type NetTeam = TeamOf<typeof NetTeam>;

/** A red net handed to the next round: its files, as the next fresh checkout lacks them. */
interface RedNet {
  netFile: string;
  code: number | null;
  failure: string | null;
  output: string;
  files: { path: string; source: string; shownBytes: number | null }[];
}

/**
 * Pin `target` on `base` in up to `rounds` writes. Each write starts from a fresh checkout of
 * `base`, so its receipt holds only that round's files and a superseded file is never published;
 * code runs the net in a probe checkout of the writer's snapshot, so test artifacts stay out of
 * the change. A red run hands its output and the net's files to the next write. Step IDs per
 * round: `write/<r>`, `probe/<r>`, `check/<r>` and, when red, `source/<r>/<k>`.
 */
export async function pinNet(
  ctx: WorkflowContext,
  options: {
    team: NetTeam;
    target: Chosen;
    base: string;
    testCommand: Check['argv'];
    rounds: number;
  },
): Promise<NetOutcome> {
  const { team, target, testCommand } = options;
  let previous: RedNet | null = null;
  for (let round = 0; round < options.rounds; round++) {
    // Annotated: the loop's narrowing of `previous` otherwise makes the inference circular.
    const written: AgentResult<NetClaim> = await team.writer.object(ctx.id('write', round), {
      worktree: { base: { commit: options.base } },
      schema: Net,
      prompt: prompts.PinNet({ target, command: std.exec.json(testCommand), previous }),
    });
    const net = acceptNet(written.output, written.worktree);
    if ('why' in net) return { status: 'skipped', why: net.why };
    const { commit } = net.change;
    const probe = await ctx.worktree(ctx.id('probe', round), { base: { commit } });
    const result = await run(ctx, ctx.id('check', round), probe, netArgv(testCommand, net.netFile));
    if (green(result.check)) return { status: 'green', ...net, rounds: round + 1 };
    const files: RedNet['files'] = [];
    for (const [index, path] of net.files.entries()) {
      const text = bounded(await show(ctx, ctx.id('source', round, index), commit, path), 20_000);
      files.push({ path, source: text.text, shownBytes: text.shownBytes });
    }
    const { code, failure } = result.check;
    previous = { netFile: net.netFile, code, failure, output: result.output, files };
  }
  return {
    status: 'skipped',
    why: `net red on the current code after ${String(options.rounds)} rounds`,
  };
}

/** The slots {@link refactorTarget} needs. */
export const RefactorTeam = defineTeam({
  refactorer: 'Applies one approved refactoring in a fresh isolated checkout.',
  reviewer: 'Judges from the diff and the net whether the change is structural.',
});
export type RefactorTeam = TeamOf<typeof RefactorTeam>;

export type RefactorOutcome =
  | {
      readonly kept: true;
      readonly change: WorktreeChange & { commit: string };
      readonly files: string[];
      readonly review: string;
      readonly reviewedWhole: boolean;
    }
  | { readonly kept: false; readonly why: string; readonly failed: boolean };

/**
 * Refactor `target` on a checkout of `from`, which holds every net. Code refuses a change that
 * touches any net's files, runs every net and then every verify command on the result, and asks
 * the reviewer only when all pass; a failed call, a red command or a behavioral verdict discards
 * the change. Step IDs: `write`, `touched`, `tree`, `net/<k>`, `verify/<n>`, `diff`, `net-source`
 * and `review`.
 */
export async function refactorTarget(
  ctx: WorkflowContext,
  options: {
    team: RefactorTeam;
    target: Chosen;
    goal: string;
    from: string;
    net: { netFile: string; behaviorsPinned: string[] };
    /** Every net's test file, run after the refactor. */
    nets: string[];
    /** Every net's test and support files, which the refactorer may not touch. */
    protectedFiles: string[];
    testCommand: Check['argv'];
    verifyCommands: Check['argv'][];
    digest: string;
    approved: string;
  },
): Promise<RefactorOutcome> {
  const { team, target, goal, from, net, nets, protectedFiles } = options;
  const { netFile, behaviorsPinned: behaviors } = net;
  const written = await team.refactorer.object('write', {
    worktree: { base: { commit: from } },
    schema: Refactored,
    onError: 'return',
    prompt: prompts.Refactor({
      target,
      goal,
      netFile,
      behaviors,
      protectedFiles,
      digest: options.digest,
      approved: options.approved,
    }),
  });
  if (!written.ok)
    return { kept: false, why: `refactor call failed: ${written.error.message}`, failed: true };
  const { output, worktree } = written.value;
  if (output.status === 'declined')
    return { kept: false, why: `refactorer declined: ${output.summary}`, failed: false };
  if (!worktree?.commit) return { kept: false, why: 'refactorer made no change', failed: false };
  const change = { ...worktree, commit: worktree.commit };
  // A receipt names only a rename's destination, so code lists both sides itself.
  const touched = (
    await std.exec.git(ctx, 'touched', [
      'diff',
      '--no-renames',
      '--name-only',
      '-z',
      from,
      change.commit,
    ])
  )
    .split('\0')
    .filter(Boolean);
  const edited = netsTouched(touched, protectedFiles);
  if (edited.length)
    return { kept: false, why: `refactor touched a net: ${edited.join(', ')}`, failed: false };
  const tree = await ctx.worktree('tree', { base: { commit: change.commit } });
  for (const [index, file] of nets.entries()) {
    const result = await run(ctx, ctx.id('net', index), tree, netArgv(options.testCommand, file));
    if (!green(result.check))
      return {
        kept: false,
        why: `net ${file} went red after the refactor (exit ${String(result.check.code)}); discarded`,
        failed: false,
      };
  }
  // A refactor that keeps every net green but breaks the build or the wider suite is discarded on
  // its own, so it cannot sink the refactors kept before it at the final verification.
  const checks = await verify(ctx, tree, options.verifyCommands);
  if (!passed(checks)) {
    const red = checks.find((check) => !green(check));
    return {
      kept: false,
      why: `verify command ${JSON.stringify(red?.argv)} failed after the refactor (exit ${String(red?.code)}); discarded`,
      failed: false,
    };
  }
  const diff = bounded(
    await std.exec.git(ctx, 'diff', ['diff', '--unified=8', from, change.commit], {
      maxOutputBytes: 8 * 1024 * 1024,
    }),
    100_000,
  );
  const source = bounded(await show(ctx, 'net-source', from, netFile), 50_000);
  const review = await team.reviewer.value('review', {
    schema: Review,
    onError: 'return',
    prompt: prompts.Review({
      target,
      goal,
      netFile,
      behaviors,
      netSource: source.text,
      netShownBytes: source.shownBytes,
      diff: diff.text,
      shownBytes: diff.shownBytes,
    }),
  });
  if (!review.ok)
    return { kept: false, why: `review failed: ${review.error.message}`, failed: true };
  if (!review.value.structural)
    return { kept: false, why: `reviewer: ${review.value.reasoning}`, failed: false };
  return {
    kept: true,
    change,
    files: touched,
    review: review.value.reasoning,
    reviewedWhole: diff.shownBytes === null && source.shownBytes === null,
  };
}
