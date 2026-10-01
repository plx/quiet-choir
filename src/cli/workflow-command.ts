import { resolveStateDir } from '../workflow/runtime/paths.js';
import { stat } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaseCommand } from './base-command.js';
import {
  requestedJson,
  workflowErrorDocument,
  workflowExitCodes,
  WorkflowCommandError,
} from './workflow-errors.js';
import { summarizeRunResult } from '../workflow/loader/run-result.js';
import { workflowFailure, type WorkflowFailure } from '../workflow/loader/failure.js';
import { isValidRunId, runIdMessage, type CliErrorCode } from '../workflow/runtime/run-errors.js';
import type { JsonValue } from '../workflow/runtime/model.js';
import { analyzeTypecheckEntrypoint } from '../workflow/typecheck/plan.js';
import type { TypecheckPlan } from '../workflow/typecheck/model.js';
import { tolerateClosedTerminal, executionSignals } from './signals.js';
import { ProcessSupervisor } from '../processes/supervisor.js';
import { readRunSync, readRun, type RunRecord } from '../workflow/runtime/store.js';

/** Workflow presentation boundary, including failures that occur before argument parsing. @internal */
export abstract class WorkflowCommand extends BaseCommand {
  protected failureContext: { runId: string | null; stateDir: string | null } = {
    runId: null,
    stateDir: null,
  };
  protected readonly processSupervisor = new ProcessSupervisor();
  protected signal: AbortSignal = new AbortController().signal;
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
    if (requestedJson(this.argv)) {
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
    if (!failure.run && failure.runId && failure.stateDir && isValidRunId(failure.runId)) {
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
    if (requestedJson(this.argv)) {
      this.logToStderr(failure.message);
      this.#render(
        workflowErrorDocument(failure, { compact: this.compactRunDocuments() }),
        failure.message,
      );
      this.exit(exit);
    }
    if (cause instanceof WorkflowCommandError && cause.humanExitOnly) {
      this.logToStderr(failure.message);
      this.exit(exit);
    }
    this.error(failure.message, { code: failure.code, exit });
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
        ...(rehearsal === undefined && this.compactRunDocuments()
          ? { summary: summarizeRunResult(run, this.failureContext.stateDir) }
          : { run }),
        ...(rehearsal === undefined ? {} : { rehearsal }),
      },
      rehearsal === undefined
        ? `Run ${run.id} suspended. Use workflow pending to review waits, workflow answer for signals, and workflow tick to resume when due.`
        : `Rehearsal ${run.id} reached an external wait. Temporary state was removed; start a real run to request the decision.`,
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
    // A second signal exits synchronously: do not lose a buffered JSON document on process.exit.
    writeSync(
      1,
      `${JSON.stringify(workflowErrorDocument(failure, { compact: this.compactRunDocuments() }))}\n`,
    );
  }
}
