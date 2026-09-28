import { Errors, flush, handle, run, settings } from '@oclif/core';
import { workflowFailure, type WorkflowFailure } from '../workflow/loader/failure.js';
import { requestedJson, workflowErrorDocument, workflowExitCodes } from './workflow-errors.js';

/** Reject topic-level flags before oclif turns them into successful topic help. @internal */
export function workflowArgvFailure(argv: readonly string[]): WorkflowFailure | null {
  const first = argv[0];
  const isWorkflow = first === 'workflow' || first?.startsWith('workflow:');
  if (!isWorkflow) return null;
  const separator = argv.indexOf('--');
  const rest = argv.slice(1, separator === -1 ? undefined : separator);
  if (first === 'workflow' && rest[0]?.startsWith('-') && rest[0] !== '--help' && rest[0] !== '-h')
    return workflowFailure(
      'usage.flag',
      'Put flags after the command name, for example: quiet-choir workflow inspect ID --json.',
    );
  if (requestedJson(argv) && rest.some((arg) => arg === '--help' || arg === '-h'))
    return workflowFailure('usage.flag', 'Use --help without --json to show command help.');
  return null;
}

/** Shared compiled/development launcher; command adapters handle their own parse failures. @internal */
export async function launchCli(options: { dir: string; development?: boolean }): Promise<void> {
  const argv = process.argv.slice(2);
  const failure = workflowArgvFailure(argv);
  if (failure) {
    if (requestedJson(argv)) console.log(JSON.stringify(workflowErrorDocument(failure)));
    else console.error(failure.message);
    process.exitCode = workflowExitCodes[failure.code];
    return;
  }
  if (options.development) {
    process.env['NODE_ENV'] = 'development';
    settings.debug = true;
  }
  try {
    await run(argv, options.dir);
    await flush();
  } catch (cause) {
    // Command failures have already emitted their document and deliberately throw ExitError.
    // Dispatch failures (such as an unknown workflow command) never reach a command's catch.
    if (
      requestedJson(argv) &&
      (argv[0] === 'workflow' || argv[0]?.startsWith('workflow:')) &&
      !(cause instanceof Errors.ExitError)
    ) {
      const failure = workflowFailure(
        'usage.flag',
        cause instanceof Error ? cause.message : String(cause),
      );
      console.log(JSON.stringify(workflowErrorDocument(failure)));
      process.exitCode = workflowExitCodes[failure.code];
    } else await handle(cause instanceof Error ? cause : new Error(String(cause)));
  }
}
