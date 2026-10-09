import { resolveStateDir } from '../workflow/runtime/paths.js';
import { Errors } from '@oclif/core';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BaseCommand } from './base-command.js';
import {
  requestedEventsStdout,
  requestedJson,
  workflowErrorDocument,
  workflowExitCodes,
  WorkflowCommandError,
} from './workflow-errors.js';
import { summarizeRunResult } from '../workflow/loader/run-result.js';
import { windowSuspensionMessage } from '../workflow/runtime/rate-limit.js';
import { formatNextCommands } from './presentation.js';
import { workflowFailure, type WorkflowFailure } from '../workflow/loader/failure.js';
import { isValidRunId, runIdMessage, type CliErrorCode } from '../workflow/runtime/run-errors.js';
import type { JsonValue } from '../workflow/runtime/model.js';
import { analyzeTypecheckEntrypoint } from '../workflow/typecheck/plan.js';
import type { TypecheckPlan } from '../workflow/typecheck/model.js';
import { tolerateClosedTerminal, executionSignals, writeAllSync } from './signals.js';
import { ProcessSupervisor } from '../processes/supervisor.js';
import { readRunSync, readRun, type RunRecord } from '../workflow/runtime/store.js';
import { commandLauncher as detectedCommandLauncher } from './launcher.js';
import type { CommandLauncher } from '../workflow/runtime/commands.js';
import type { WorkflowExecutorOptions } from '../workflow/loader/executor.js';

/** Workflow presentation boundary, including failures that occur before argument parsing. @internal */
export abstract class WorkflowCommand extends BaseCommand {
  protected failureContext: { runId: string | null; stateDir: string | null } = {
    runId: null,
    stateDir: null,
  };
  protected readonly processSupervisor = new ProcessSupervisor();
  protected signal: AbortSignal = new AbortController().signal;
  /** Program words for emitted commands, detected by `launchCli`; undefined in-process. */
  protected readonly commandLauncher: CommandLauncher | undefined = detectedCommandLauncher();
  #signals: ReturnType<typeof executionSignals> | undefined;
  #stdoutWrite: typeof process.stdout.write | undefined;

  protected override async init(): Promise<void> {
    await super.init();
    tolerateClosedTerminal();
    this.#signals = executionSignals(
      this.processSupervisor,
      (message) => {
        this.logToStderr(message);
      },
      'Workflow',
      () => {
        this.forceInterrupted();
      },
    );
    this.signal = this.#signals.signal;
    // `--json` reserves stdout for the result document and `--events -` for event lines, so stray
    // writes (workflow console output, human result text) go to stderr instead.
    if (requestedJson(this.argv) || requestedEventsStdout(this.argv)) {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Stored and restored on the same stream, never invoked unbound.
      this.#stdoutWrite = process.stdout.write;
      process.stdout.write = process.stderr.write.bind(process.stderr);
    }
  }

  protected override finally(): Promise<void> {
    this.#signals?.dispose();
    if (this.#stdoutWrite) process.stdout.write = this.#stdoutWrite;
    return Promise.resolve();
  }

  protected override async catch(cause: unknown): Promise<never> {
    // A command's own exit() already chose its code and output.
    if (cause instanceof Errors.ExitError) throw cause;
    let failure =
      cause instanceof WorkflowCommandError
        ? {
            ...cause.failure,
            runId: cause.failure.runId ?? this.failureContext.runId,
            stateDir: cause.failure.stateDir ?? this.failureContext.stateDir,
          }
        : workflowFailure(
            'usage.flag',
            cause instanceof Error ? cause.message : String(cause),
            this.failureContext,
          );
    // A watch whose record never appeared reports no record, even one created after its deadline.
    if (
      !failure.run &&
      failure.code !== 'watch.record_not_created' &&
      failure.runId &&
      failure.stateDir &&
      isValidRunId(failure.runId)
    ) {
      const run = await readRun({ runId: failure.runId, stateDir: failure.stateDir }).catch(
        () => null,
      );
      failure = { ...failure, run };
    }
    // Storage failures keep exit 74 so automation repairs storage before resuming, and a saved
    // `failed` checkpoint keeps exit 1 because the signal did not cause that failure.
    if (
      this.signal.aborted &&
      failure.code !== 'workflow.storage' &&
      !(failure.code === 'workflow.failed' && failure.run?.status === 'failed')
    )
      failure = { ...failure, code: 'workflow.interrupted' };
    if (this.argv.includes('-v') || this.argv.includes('--verbose')) {
      if (failure.run?.errorStack) this.logToStderr(failure.run.errorStack);
    }
    const exit = workflowExitCodes[failure.code];
    const human = [failure.message, ...formatNextCommands(failure.next)].join('\n');
    // Checked before --json: stdout already carries other output, which a document would corrupt.
    if (cause instanceof WorkflowCommandError && cause.humanExitOnly) {
      this.logToStderr(human);
      this.exit(exit);
    }
    if (requestedJson(this.argv)) {
      this.logToStderr(failure.message);
      this.#render(
        workflowErrorDocument(failure, { compact: this.compactRunDocuments() }),
        failure.message,
      );
      this.exit(exit);
    }
    this.error(human, { code: failure.code, exit });
  }

  /**
   * Refuse `--events -` together with JSON output before any run work: both would claim stdout.
   * `requestedJson` also counts answer's `--json VALUE` alias. @internal
   */
  protected refuseEventsStdoutWithJson(): void {
    if (requestedEventsStdout(this.argv) && requestedJson(this.argv))
      this.fail(
        'usage.flag',
        '--events - writes events to stdout, which --json reserves for the result document; give --events a file path',
      );
  }

  /**
   * The executor plan and option for a parsed `--events` value: a path resolved against the launch
   * directory, or `-` with a writer on the real stdout saved by `init`. @internal
   */
  protected eventsOptions(events: string | undefined): {
    readonly plan: { readonly events?: string };
    readonly executor: Pick<WorkflowExecutorOptions, 'eventsStdout'>;
  } {
    if (events === undefined) return { plan: {}, executor: {} };
    if (events !== '-') return { plan: { events: resolve(events) }, executor: {} };
    const write = this.#stdoutWrite ?? process.stdout.write.bind(process.stdout);
    return {
      plan: { events: '-' },
      executor: {
        eventsStdout: (line, onError) => {
          write.call(process.stdout, line, 'utf8', (error?: Error | null) => {
            if (error) onError(error);
          });
        },
      },
    };
  }

  /**
   * Write raw bytes to the real stdout, the writer `init` saved when `--json` redirected
   * `process.stdout`, resolving once the stream has taken them so a large output keeps
   * backpressure. A write error, such as `EPIPE` from a reader that went away, rejects. @internal
   */
  protected writeStdout(chunk: Uint8Array): Promise<void> {
    const write = this.#stdoutWrite ?? process.stdout.write.bind(process.stdout);
    return new Promise((resolve, reject) => {
      write.call(process.stdout, chunk, undefined, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  /**
   * Whether failure and suspension documents carry a compact `summary` instead of the whole `run`.
   * The run commands turn this on unless `--full` was requested. @internal
   */
  protected compactRunDocuments(): boolean {
    return false;
  }

  /** The success document of a run command: the compact result, or the full record under `--full`. */
  protected runResult(run: RunRecord, stateDir: string): object {
    return this.compactRunDocuments()
      ? { kind: 'workflow.run.result', ok: true, exitCode: 0, ...summarizeRunResult(run, stateDir) }
      : { ...run, stateDir };
  }

  protected fail(code: CliErrorCode, message: string, details: JsonValue = null): never {
    return this.failResult(workflowFailure(code, message, { ...this.failureContext, details }));
  }

  /**
   * Fail with `failure`. With `humanExitOnly`, the message and next commands go to stderr even under
   * `--json`, for a command whose stdout already carries other output. @internal
   */
  protected failResult(failure: WorkflowFailure, humanExitOnly = false): never {
    throw new WorkflowCommandError(failure, humanExitOnly);
  }

  protected runContext(runId: string, stateDir?: string): string {
    this.failureContext = { runId, stateDir: null };
    this.validateRunId(runId);
    const resolved = resolveStateDir({ runId, ...(stateDir === undefined ? {} : { stateDir }) });
    this.failureContext = { runId, stateDir: resolved };
    if (
      stateDir === undefined &&
      process.env['QUIET_CHOIR_STATE_DIR'] === undefined &&
      resolved === resolve('.quiet-choir/runs')
    )
      this.logToStderr(
        `Warning: legacy state directory ${resolved}; new runs use project-specific XDG storage.`,
      );
    return resolved;
  }

  protected validateRunId(runId: string): void {
    if (!isValidRunId(runId)) this.fail('usage.run_id', runIdMessage);
  }

  protected async entrypoint(file: string): Promise<TypecheckPlan> {
    const found = await stat(file).catch(() => null);
    if (!found?.isFile())
      this.fail('usage.file_not_found', `No file found at ${file}`, { file: resolve(file) });
    const analysis = analyzeTypecheckEntrypoint(file, process.cwd());
    if (!analysis.ok)
      this.fail('usage.entrypoint', analysis.error.message, { reason: analysis.error.code });
    return analysis.plan;
  }

  /** Success output. A first signal replaces Node's default termination, so report it instead. */
  protected output(json: unknown, human: string): void {
    if (this.signal.aborted)
      throw new WorkflowCommandError(
        workflowFailure('workflow.interrupted', 'Workflow interrupted.', this.failureContext),
      );
    this.#render(json, human);
  }

  /** A saved completion stands even when a signal arrived after the runner's last cancellation check. */
  protected outputSavedCompletion(json: unknown, human: string): void {
    this.#render(json, human);
  }

  #render(json: unknown, human: string): void {
    if (!requestedJson(this.argv)) {
      this.log(human);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Restore the exact method after rendering.
    const redirected = process.stdout.write;
    try {
      if (this.#stdoutWrite) process.stdout.write = this.#stdoutWrite;
      this.log(JSON.stringify(json));
    } finally {
      process.stdout.write = redirected;
    }
  }

  protected suspended(
    run: RunRecord & { readonly pending?: unknown; readonly resumeCommand?: unknown },
    rehearsal?: unknown,
  ): void {
    // Like a saved completion, a saved suspension stands even when a signal arrived afterward.
    this.outputSavedCompletion(
      {
        kind: 'workflow.run.suspended',
        ok: true,
        exitCode: 75,
        runId: run.id,
        stateDir: rehearsal === undefined ? this.failureContext.stateDir : null,
        pending: run.pending ?? [],
        resumeCommand: run.resumeCommand ?? null,
        // When tick will resume the run on its own; null when only an answer or signal can.
        nextWakeAt: run.nextWakeAt ?? null,
        ...(rehearsal === undefined && this.compactRunDocuments()
          ? { summary: summarizeRunResult(run, this.failureContext.stateDir) }
          : { run }),
        ...(rehearsal === undefined ? {} : { rehearsal }),
      },
      rehearsal !== undefined
        ? `Rehearsal ${run.id} reached an external wait. Temporary state was removed; start a real run to request the decision.`
        : run.budgetStop?.metric === 'maxWindowUtilization'
          ? `${windowSuspensionMessage(run.budgetStop, run.nextWakeAt ?? null, run.id)} workflow tick resumes it once that time has passed.`
          : `Run ${run.id} suspended. Use workflow pending to review waits, workflow answer for signals, and workflow tick to resume when due.`,
    );
    // Oclif's exit() throws through catch(), which would misclassify suspension as a usage error.
    process.exitCode = 75;
  }

  protected forceInterrupted(): void {
    if (!requestedJson(this.argv)) return;
    const { runId, stateDir } = this.failureContext;
    let run: RunRecord | null = null;
    if (runId && stateDir && isValidRunId(runId)) {
      try {
        run = readRunSync({ stateDir, runId });
      } catch {
        /* Report the last readable checkpoint only. */
      }
    }
    const failure = workflowFailure(
      'workflow.interrupted',
      'Workflow interrupted; forced process cleanup.',
      { ...this.failureContext, run, details: { forced: true } },
    );
    // A second signal exits synchronously, so write the whole document, retrying a full pipe,
    // before process.exit. The outcome is ignored: a gone or stalled reader must not block exit 130.
    writeAllSync(
      1,
      `${JSON.stringify(workflowErrorDocument(failure, { compact: this.compactRunDocuments() }))}\n`,
    );
  }
}
