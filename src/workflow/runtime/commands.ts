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
 * fixture, and `--wait-mode block`. The defaults (`cli`, `suspend`) and launches without a policy
 * add nothing. `--harness-config` is never emitted, because its values are not recorded. @internal
 */
export function launchPolicyFlags(launch: WorkflowLaunch | undefined): string[] {
  const policy = launch?.policy;
  if (!policy) return [];
  return [
    ...harnessSpecifiers(policy.harness).flatMap((specifier) => ['--harness', specifier]),
    ...(policy.waitMode === 'block' ? ['--wait-mode', 'block'] : []),
  ];
}
