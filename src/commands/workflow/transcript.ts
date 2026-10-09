import { Args, Flags, type Interfaces } from '@oclif/core';
import { writeAllSync } from '../../cli/signals.js';
import { WorkflowCommand } from '../../cli/workflow-command.js';
import { requestedJson } from '../../cli/workflow-errors.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';

interface WorkflowTranscriptArgs {
  readonly runId: string;
  readonly stepId: string;
}
interface WorkflowTranscriptFlags {
  readonly 'state-dir': string | undefined;
  readonly attempt: number | undefined;
  readonly stream: string;
  readonly json: boolean | undefined;
}

export default class WorkflowTranscript extends WorkflowCommand {
  /** Whether transcript bytes reached stdout, where a failure document would corrupt them. */
  #stdoutWritten = false;
  public static override readonly args: Interfaces.ArgInput<WorkflowTranscriptArgs> = {
    runId: Args.string({ description: 'Persisted run identifier', required: true }),
    stepId: Args.string({
      description: 'Full step ID of an agent step, as workflow inspect shows it',
      required: true,
    }),
  };
  public static override readonly flags: Interfaces.FlagInput<WorkflowTranscriptFlags> = {
    'state-dir': Flags.directory({
      description:
        'Runs container; defaults to environment, legacy run discovery, then project XDG state',
    }),
    attempt: Flags.integer({
      description: 'Attempt number to decode (default: the latest recorded attempt)',
      min: 1,
    }),
    stream: Flags.string({
      description: 'Native stream to print: stdout (the stream-json/JSONL protocol) or stderr',
      options: ['stdout', 'stderr'],
      default: 'stdout',
    }),
    json: Flags.boolean({
      description:
        'Report a failure, or a forced interruption, as a workflow.error JSON document on stdout, unless transcript bytes were already written (then a message on stderr); the transcript itself is always the raw native bytes',
      default: false,
    }),
  };
  public static override readonly summary =
    "Print an agent attempt's decoded private transcript without importing workflow code";
  public static override readonly description =
    'Decodes the base64 transcript entries of one agent attempt and writes the native bytes of the selected stream to stdout unchanged: Claude stream-json or Codex JSONL on stdout, which jq can read. A transcript cut at maxTranscriptBytes, or of an attempt still recorded as running, prints a warning on stderr.';

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowTranscript);
    const stateDir = this.runContext(args.runId, flags['state-dir']);
    // A reader that went away (such as `| head`) stops the decode instead of reading on for nobody.
    const closed = new AbortController();
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      commandLauncher: this.commandLauncher,
      signal: AbortSignal.any([this.signal, closed.signal]),
      onTranscriptChunk: async (chunk) => {
        if (closed.signal.aborted) return;
        try {
          // Set before the write: a forced exit during it may already have bytes on stdout.
          if (chunk.length > 0) this.#stdoutWritten = true;
          await this.writeStdout(chunk);
        } catch (error) {
          closed.abort(error);
        }
      },
    });
    const result = await executor.execute({
      kind: 'workflow.transcript',
      runId: args.runId,
      stateDir,
      stepId: args.stepId,
      ...(flags.attempt === undefined ? {} : { attempt: flags.attempt }),
      stream: flags.stream === 'stderr' ? 'stderr' : 'stdout',
    });
    // A reader that went away is a success. Exit through ExitError so the launcher drains and exits
    // instead of waiting on oclif's flush() for a stdout that will never drain.
    if (closed.signal.aborted && !this.signal.aborted) this.exit(0);
    if (!result.ok) {
      if (this.#stdoutWritten) this.failAfterStdout(result);
      this.failResult(result);
    }
    if (result.kind !== 'workflow.transcript.result') return;
    if (result.truncated)
      this.logToStderr(
        `Warning: the transcript of attempt ${String(result.attempt)} of ${result.stepId} was cut at its maxTranscriptBytes cap; the output ends early.`,
      );
    if (result.inProgress)
      this.logToStderr(
        `Warning: attempt ${String(result.attempt)} of ${result.stepId} is still running or was interrupted; the output may end early.`,
      );
  }

  /** A forced exit after transcript bytes reached stdout reports on stderr, not as a document there. */
  protected override forceInterrupted(): void {
    if (!this.#stdoutWritten) {
      super.forceInterrupted();
      return;
    }
    if (requestedJson(this.argv))
      writeAllSync(2, 'Workflow interrupted; forced process cleanup.\n');
  }

  /** Error documents carry the bounded summary, never the whole record. */
  protected override compactRunDocuments(): boolean {
    return true;
  }
}
