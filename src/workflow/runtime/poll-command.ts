import { z } from 'zod';
import { prepareExec } from './exec.js';
import { commandSchema, stepExecOptionsSchema } from './exec-schema.js';
import { schemaJson } from './schema.js';
import type {
  CommandPollSource,
  PollContext,
  PollRequest,
  PollSource,
  WaitSources,
} from './wait-model.js';

/** Default upper bound for one poll observation when the poll sets no observeTimeoutMs. @internal */
export const defaultObserveTimeoutMs = 60_000;

/** Either form of poll source a wait accepts. @internal */
export type AnyPollSource = NonNullable<WaitSources['poll']>;

/** What one observation resolves to, before the wait checks its shape. @internal */
export type PollObservation = ReturnType<PollSource<unknown>['observe']>;

/** The command identity a command poll adds to its wait request. @internal */
export type PollCommandIdentity = NonNullable<PollRequest['command']>;

// A command poll's command options: no timeoutMs (observeTimeoutMs bounds a check) and no onError
// (the poll's onError applies). Strict, so a misspelled option fails when the wait opens.
const commandOptionsSchema = stepExecOptionsSchema.omit({ timeoutMs: true, onError: true });

/** Whether a poll source is the command form: it names a command. @internal */
export function isCommandPoll(poll: AnyPollSource): poll is CommandPollSource<unknown> {
  return (
    (poll as unknown) !== null &&
    typeof poll === 'object' &&
    (poll as { readonly command?: unknown }).command !== undefined
  );
}

/** Reject a malformed command poll when its wait opens, before any check runs. @internal */
export function validateCommandPoll(poll: CommandPollSource<unknown>): void {
  if ((poll as { readonly observe?: unknown }).observe !== undefined)
    throw new Error('Poll source takes an observe callback or a command, not both.');
  const command = commandSchema.safeParse(poll.command);
  if (!command.success)
    throw new Error(`Poll command is invalid: ${z.prettifyError(command.error)}`);
  if (!((poll.output as unknown) instanceof z.ZodType))
    throw new Error('Poll command output must be a Zod schema.');
  if (typeof poll.done !== 'function') throw new Error('Poll command requires a done callback.');
  const options = commandOptionsSchema.safeParse(poll.commandOptions ?? {});
  if (!options.success)
    throw new Error(`Poll commandOptions are invalid: ${z.prettifyError(options.error)}`);
  if (poll.live !== undefined && typeof poll.live !== 'boolean')
    throw new Error('Poll live must be a boolean.');
}

/**
 * Validate a command poll and prepare its command as `ctx.exec.json` would, relative to the run's
 * cwd, returning the identity its wait request records: the command summary (canonical cwd, env
 * and stdin digests, exit codes) and the output's JSON Schema. Policy (`maxOutputBytes`, `live`,
 * `observeTimeoutMs`, `onError`) stays out.
 * @internal
 */
export async function commandPollIdentity(
  poll: CommandPollSource<unknown>,
  cwd: string,
): Promise<PollCommandIdentity> {
  validateCommandPoll(poll);
  const { summary } = await prepareExec(poll.command, poll.commandOptions ?? {}, cwd, true);
  return { exec: summary, output: schemaJson(poll.output) };
}

/**
 * Run one observation of either poll form. A command poll runs its command through the
 * observation's `context.exec.json`, so the child is owned by the wait and stops with the
 * observation's signal; `observeTimeoutMs` (or its default) is also the command's own real-time
 * timeout. `done` then decides from the output and the frozen previous progress.
 * @internal
 */
export async function observePoll(
  poll: AnyPollSource,
  context: PollContext,
): Promise<Awaited<PollObservation>> {
  if (!isCommandPoll(poll)) return poll.observe(context);
  const output = await context.exec.json(poll.command, {
    ...poll.commandOptions,
    schema: poll.output,
    ...(poll.live === undefined ? {} : { live: poll.live }),
    timeoutMs: poll.observeTimeoutMs ?? defaultObserveTimeoutMs,
  });
  // Widened from NoInfer<...>, which await does not look through.
  const decided: Awaited<PollObservation> | PollObservation = poll.done(output, context.previous);
  return await decided;
}
