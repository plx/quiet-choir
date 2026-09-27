import { stat } from 'node:fs/promises';
import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaseCommand } from './base-command.js';
import {
  requestedJson,
  workflowErrorDocument,
  workflowExitCodes,
  WorkflowCommandError,
} from './workflow-errors.js';
import { workflowFailure, type WorkflowFailure } from '../workflow/loader/failure.js';
import { isValidRunId, runIdMessage, type CliErrorCode } from '../workflow/runtime/run-errors.js';
import type { JsonValue } from '../workflow/runtime/model.js';
import { analyzeTypecheckEntrypoint } from '../workflow/typecheck/plan.js';
import type { TypecheckPlan } from '../workflow/typecheck/model.js';
import { tolerateClosedTerminal, executionSignals } from './signals.js';
import { ProcessSupervisor } from '../processes/supervisor.js';
import { parseRunRecord, readRun, type RunRecord } from '../workflow/runtime/store.js';

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
    if (this.signal.aborted) failure = { ...failure, code: 'workflow.interrupted' };
    const exit = workflowExitCodes[failure.code];
    if (requestedJson(this.argv)) {
      this.logToStderr(failure.message);
      this.output(workflowErrorDocument(failure), failure.message);
      this.exit(exit);
    }
    if (cause instanceof WorkflowCommandError && cause.humanExitOnly) {
      this.logToStderr(failure.message);
      this.exit(exit);
    }
    this.error(failure.message, { code: failure.code, exit });
  }

  protected fail(code: CliErrorCode, message: string, details: JsonValue = null): never {
    return this.failResult(workflowFailure(code, message, { ...this.failureContext, details }));
  }

  protected failResult(failure: WorkflowFailure, humanExitOnly = false): never {
    throw new WorkflowCommandError(failure, humanExitOnly);
  }

  protected runContext(runId: string, stateDir: string): void {
    this.failureContext = { runId, stateDir: resolve(stateDir) };
    this.validateRunId(runId);
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

  protected output(json: unknown, human: string): void {
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

  protected forceInterrupted(): void {
    if (!requestedJson(this.argv)) return;
    const { runId, stateDir } = this.failureContext;
    let run: RunRecord | null = null;
    if (runId && stateDir && isValidRunId(runId)) {
      try {
        run = parseRunRecord(readFileSync(resolve(stateDir, `${runId}.json`), 'utf8'), runId);
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
    writeSync(1, `${JSON.stringify(workflowErrorDocument(failure))}\n`);
  }
}
