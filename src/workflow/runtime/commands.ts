import { resolve } from 'node:path';
import type { JsonValue } from './model.js';
import type { WorkflowLaunch } from './question-model.js';

/**
 * The program words that start every emitted command, such as `resumeCommand` and
 * `answerCommand`: `['quiet-choir']` for an installed binary, or `[node, '/abs/bin/run.js']` for a
 * repository checkout. The CLI detects it from the invocation; an embedder may supply its own.
 */
export type CommandLauncher = readonly string[];

/** The launcher used when none is supplied: an installed `quiet-choir` binary on PATH. @internal */
export const defaultCommandLauncher: CommandLauncher = ['quiet-choir'];

/**
 * Build a `workflow` subcommand argument vector behind the launcher. An absent or empty launcher
 * falls back to {@link defaultCommandLauncher}. @internal
 */
export function workflowArgv(launcher: CommandLauncher | undefined, ...args: string[]): string[] {
  return [...(launcher?.length ? launcher : defaultCommandLauncher), 'workflow', ...args];
}

/** The `--harness` specifiers that reproduce a recorded harness policy, unnamed fixture first. @internal */
export function harnessSpecifiers(
  harness: NonNullable<WorkflowLaunch['policy']>['harness'],
): string[] {
  const fixtures = harness.fixtures ?? [];
  return [
    ...fixtures.flatMap(({ name, path }) => (name === undefined ? [`fixture:${path}`] : [])),
    ...fixtures.flatMap(({ name, path }) =>
      name === undefined ? [] : [`${name}=fixture:${path}`],
    ),
  ];
}

/**
 * The flags that repeat a run's recorded launch policy on an emitted resume command:
 * `--harness fixture:<abs>` for the global fixture, `--harness <name>=fixture:<abs>` for each named
 * fixture, `--wait-mode block`, and the recorded `--worktree-keep` and `--worktree-root`. The
 * defaults (`cli`, `suspend`) and launches without a policy add nothing. `--harness-config` is never
 * emitted, because its values are not recorded. @internal
 */
export function launchPolicyFlags(launch: WorkflowLaunch | undefined): string[] {
  const policy = launch?.policy;
  if (!policy) return [];
  return [
    ...harnessSpecifiers(policy.harness).flatMap((specifier) => ['--harness', specifier]),
    ...(policy.waitMode === 'block' ? ['--wait-mode', 'block'] : []),
    ...(policy.worktrees?.keep === undefined ? [] : ['--worktree-keep', policy.worktrees.keep]),
    ...(policy.worktrees?.root === undefined ? [] : ['--worktree-root', policy.worktrees.root]),
  ];
}

/**
 * One runnable follow-up: why it applies and the exact argument vector to run, built behind the
 * launcher of the invocation that produced it. `<ANSWER_JSON>`, `<NEW_RUN_ID>` and `<ENTRYPOINT>`
 * are placeholders to substitute first. @internal
 */
export interface NextCommand {
  readonly why: string;
  readonly argv: readonly string[];
}

const placeholder = /^<[A-Z][A-Z_]*>$/u;

/**
 * Quote an argument vector for a POSIX shell, leaving placeholders bare so they read as slots to
 * fill. Display only: run the argv itself whenever possible. @internal
 */
export function formatArgv(argv: readonly string[]): string {
  return argv
    .map((value) =>
      placeholder.test(value) || /^[\w./:@%+=,-]+$/u.test(value)
        ? value
        : `'${value.replaceAll("'", "'\\''")}'`,
    )
    .join(' ');
}

/**
 * The follow-up that clears an abandoned run lock: `workflow unlock <runId> --state-dir <abs>` behind
 * the launcher, with `--force-remote` only when the holder is on a foreign host. Refusal prose embeds
 * `formatArgv(entry.argv)` and `details.next` carries the entry, so the two cannot drift. @internal
 */
export function unlockNext(
  launcher: CommandLauncher | undefined,
  stateDir: string,
  runId: string,
  options: { readonly forceRemote?: boolean; readonly why: string },
): NextCommand {
  return {
    why: options.why,
    argv: workflowArgv(
      launcher,
      'unlock',
      runId,
      '--state-dir',
      resolve(stateDir),
      ...(options.forceRemote ? ['--force-remote'] : []),
    ),
  };
}

/**
 * The follow-up that clears a repository's abandoned worktree administration lock:
 * `workflow unlock --worktree-admin <abs common Git dir>` behind the launcher, with
 * `--force-remote` only when the holder is on a foreign host. @internal
 */
export function unlockWorktreeAdminNext(
  launcher: CommandLauncher | undefined,
  commonGitDir: string,
  options: { readonly forceRemote?: boolean; readonly why: string },
): NextCommand {
  return {
    why: options.why,
    argv: workflowArgv(
      launcher,
      'unlock',
      '--worktree-admin',
      resolve(commonGitDir),
      ...(options.forceRemote ? ['--force-remote'] : []),
    ),
  };
}

/** Plain-JSON copy of next-command entries, for a refusal's `details.next`. @internal */
export function nextDetail(entries: readonly NextCommand[]): JsonValue[] {
  return entries.map((entry) => ({ why: entry.why, argv: [...entry.argv] }));
}
