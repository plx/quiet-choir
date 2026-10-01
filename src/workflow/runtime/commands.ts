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
