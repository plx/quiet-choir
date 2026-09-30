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

/**
 * Resolve once each stream has handed every earlier write to the OS. An empty write's callback runs
 * after all queued chunks, unlike oclif's `flush()`, which returns early when the queue is below the
 * high-water mark. Closed or failing streams resolve at once, so a broken pipe cannot hang or throw.
 * @internal
 */
export async function drainOutput(streams: readonly NodeJS.WritableStream[]): Promise<void> {
  for (const stream of streams) {
    const writable = stream as NodeJS.WritableStream & {
      readonly destroyed?: boolean;
      readonly writableEnded?: boolean;
    };
    if (writable.destroyed === true || writable.writableEnded === true) continue;
    await new Promise<void>((resolve) => {
      try {
        writable.write('', () => {
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }
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
    // Command failures have already emitted their document and throw ExitError. Drain it here:
    // oclif's handle() would call process.exit() before a piped stdout finishes writing, cutting
    // the document off at the pipe buffer. Still exit explicitly so a failure never hangs.
    if (cause instanceof Errors.ExitError) {
      const code = cause.oclif.exit;
      process.exitCode = code;
      await drainOutput([process.stdout, process.stderr]);
      process.exit(code);
      return;
    }
    // Dispatch failures (such as an unknown workflow command) never reach a command's catch.
    if (requestedJson(argv) && (argv[0] === 'workflow' || argv[0]?.startsWith('workflow:'))) {
      const failure = workflowFailure(
        'usage.flag',
        cause instanceof Error ? cause.message : String(cause),
      );
      console.log(JSON.stringify(workflowErrorDocument(failure)));
      process.exitCode = workflowExitCodes[failure.code];
    } else await handle(cause instanceof Error ? cause : new Error(String(cause)));
  }
}
