import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readFile, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExecutionPlan, ExecutionResult, Executor } from '../../application/execution.js';
import type { ProcessSupervisor } from '../../processes/supervisor.js';
import { signalProcess } from '../../processes/identity.js';
import { workflowArgv, type CommandLauncher } from '../runtime/commands.js';
import type { JsonValue } from '../runtime/model.js';
import { legacyRunPath, prepareStateDirectory, runDirectory } from '../runtime/paths.js';
import { withRunGuard } from '../runtime/lock.js';
import { isCliErrorCode, RunRefusedError } from '../runtime/run-errors.js';
import { createStorageDirectory } from '../runtime/storage-io.js';
import { inspectRunOwnership, readRun, type RunRecord } from '../runtime/store.js';
import type { DurabilityDiagnostic, TypecheckDiagnostic } from '../typecheck/model.js';
import { workflowFailure, type StartLaunchEvidence, type WorkflowFailure } from './failure.js';
import { failureNextCommands, type NextCommand } from './next-commands.js';
import { decideStart, type StartChildDocument } from './start-readiness.js';

/**
 * Launch `workflow execute` detached and return once its runner owns the run's record. Plain data:
 * the CLI builds the runner's argv and resolves the run ID and state directory first.
 */
export interface StartWorkflowPlan extends ExecutionPlan {
  readonly kind: 'workflow.start';
  /** The run ID the runner was given; the record must not exist yet. */
  readonly runId: string;
  /** Absolute runs container the runner was given. */
  readonly stateDir: string;
  /** The runner's working directory, which is also the run's. */
  readonly cwd: string;
  /** The runner's full argv, program words first, ending with `--json` (before any `--`). */
  readonly argv: readonly string[];
  /**
   * Input read from this process's stdin. It is written to `launch/<n>.input.json` and
   * `argv[argvIndex]` (the value of `--input`) is replaced with `@<that file>`, because the runner's
   * stdin is `/dev/null`.
   */
  readonly stdinInput?: { readonly value: JsonValue; readonly argvIndex: number };
  /** How long to wait for an owned record before stopping the runner. */
  readonly timeoutMs: number;
  /** SIGTERM grace for the runner's own cleanup; start waits this plus 2 s before SIGKILL. */
  readonly killGraceMs: number;
}

/** A started run: its runner owns (or already finished) the record, and keeps running detached. */
export interface StartWorkflowResult extends ExecutionResult {
  readonly kind: 'workflow.start.result';
  readonly ok: true;
  readonly exitCode: 0;
  readonly runId: string;
  readonly stateDir: string;
  /** The detached runner's PID, which owns the run lock while it executes. */
  readonly pid: number;
  /** Saved status when start returned: `running`, or a final status if the runner already ended. */
  readonly status: RunRecord['status'];
  /** Absolute path of the runner's stderr log. */
  readonly log: string;
  /** Absolute path of the runner's stdout, which receives its final JSON document. */
  readonly result: string;
  /** Launcher-correct follow-ups: a summary inspect and a watch. */
  readonly next: readonly NextCommand[];
}

/** What the executor reads about the run on each poll. @internal */
export interface StartRunObservation {
  /** Saved status, or null when the record cannot be read (yet). */
  readonly status: RunRecord['status'] | null;
  /** PID of the local run-lock owner, or null when unlocked, unreadable or remote. */
  readonly ownerPid: number | null;
}

/** Ports of {@link StartWorkflowExecutor}; tests inject the observer and the poll interval. */
export interface StartWorkflowExecutorOptions {
  /** Aborting stops the runner (SIGTERM, grace, SIGKILL) and reports `workflow.interrupted`. */
  readonly signal?: AbortSignal;
  /** Program words for emitted `next` commands. */
  readonly commandLauncher?: CommandLauncher | undefined;
  /** Tracks the runner until it is started, so a second signal's force kill reaches it. */
  readonly processSupervisor?: ProcessSupervisor;
  /** Poll interval in milliseconds; default 50. */
  readonly pollIntervalMs?: number;
  /** Read the run's status and lock owner; defaults to {@link observeStartedRun}. */
  readonly observeRun?: (stateDir: string, runId: string) => Promise<StartRunObservation>;
  /** Time after the kill grace for the runner to save its interrupted record; default 2000 ms. */
  readonly saveMarginMs?: number;
}

/** Extra time after the kill grace for the runner to save its interrupted record. */
const saveMarginMs = 2_000;

/** The default observer: `readRun`, then the local lock owner's PID from `inspectRunOwnership`. @internal */
export async function observeStartedRun(
  stateDir: string,
  runId: string,
): Promise<StartRunObservation> {
  let run: RunRecord;
  try {
    run = await readRun({ stateDir, runId });
  } catch {
    return { status: null, ownerPid: null };
  }
  const ownership = await inspectRunOwnership({ stateDir, runId }).catch(() => null);
  const owner = ownership?.owner;
  return {
    status: run.status,
    ownerPid: owner && owner.state !== 'remote' ? owner.pid : null,
  };
}

/** A launch's evidence files, created exclusively; the caller closes the two handles. @internal */
export interface LaunchFiles {
  readonly log: string;
  readonly result: string;
  readonly input: string | null;
  readonly handles: readonly [FileHandle, FileHandle];
}

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/**
 * Create `<n>.log`, `<n>.result.json` and, for stdin input, `<n>.input.json` exclusively (0600) for
 * the smallest free `n`, so an earlier launch's evidence is never overwritten.
 */
async function allocateLaunchFiles(
  directory: string,
  input: JsonValue | undefined,
): Promise<LaunchFiles> {
  for (let n = 1; ; n++) {
    const log = join(directory, `${String(n)}.log`);
    const result = join(directory, `${String(n)}.result.json`);
    const inputPath = input === undefined ? null : join(directory, `${String(n)}.input.json`);
    let logHandle: FileHandle;
    try {
      logHandle = await open(log, 'wx', 0o600);
    } catch (error) {
      if (errno(error, 'EEXIST')) continue;
      throw error;
    }
    let resultHandle: FileHandle | undefined;
    try {
      resultHandle = await open(result, 'wx', 0o600);
      if (inputPath !== null) {
        await using inputHandle = await open(inputPath, 'wx', 0o600);
        await inputHandle.writeFile(`${JSON.stringify(input)}\n`);
      }
      return { log, result, input: inputPath, handles: [resultHandle, logHandle] };
    } catch (error) {
      await resultHandle?.close();
      await logHandle.close();
      if (errno(error, 'EEXIST')) continue;
      throw error;
    }
  }
}

function runExists(stateDir: string, runId: string): boolean {
  return (
    existsSync(join(runDirectory(stateDir, runId), 'run.json')) ||
    existsSync(legacyRunPath(stateDir, runId))
  );
}

function existsFailure(stateDir: string, runId: string): WorkflowFailure {
  return workflowFailure(
    'run.exists',
    `Run ${runId} already exists; use resume or choose a new run ID.`,
    { runId, stateDir, details: { stateDir } },
  );
}

/**
 * Check that the run does not exist and allocate its launch files, under the run's legacy guard.
 * `workflow rm` holds that guard until the run is gone, and an unmigrated flat run's `<runId>/`
 * (holding only the primary lock) outlives its `<runId>.json` there, so without the guard this
 * check could pass mid-removal and rm's rename would carry the new `launch/` into its tombstone.
 * The guard is released before the runner is spawned, since the runner takes it itself. A held
 * guard fails with `run.locked`. @internal
 */
export async function prepareStartLaunch(
  plan: Pick<StartWorkflowPlan, 'runId' | 'stateDir' | 'cwd' | 'stdinInput'>,
  signal?: AbortSignal,
  commandLauncher?: CommandLauncher,
): Promise<{ readonly ok: true; readonly files: LaunchFiles } | WorkflowFailure> {
  const { runId, stateDir } = plan;
  // Fast path outside the guard: a live run's writer holds the guard, and its ID is simply taken.
  if (runExists(stateDir, runId)) return existsFailure(stateDir, runId);
  let allocated: LaunchFiles | undefined;
  try {
    return await withRunGuard(
      stateDir,
      runId,
      async () => {
        if (runExists(stateDir, runId)) return existsFailure(stateDir, runId);
        try {
          await prepareStateDirectory(stateDir, plan.cwd);
          const launchDir = join(runDirectory(stateDir, runId), 'launch');
          await createStorageDirectory(launchDir);
          allocated = await allocateLaunchFiles(launchDir, plan.stdinInput?.value);
          return { ok: true as const, files: allocated };
        } catch (error) {
          return workflowFailure(
            'workflow.storage',
            `Could not create the launch files of run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
            { stateDir },
          );
        }
      },
      { cwd: plan.cwd, commandLauncher, ...(signal === undefined ? {} : { signal }) },
    );
  } catch (error) {
    // Only a failed guard release reaches here with files open; nothing will launch with them.
    if (allocated) await Promise.all(allocated.handles.map((handle) => handle.close()));
    if (error instanceof RunRefusedError)
      return workflowFailure(
        error.code,
        `Run ID ${runId} is locked or being removed; retry once it is free. ${error.message}`,
        { stateDir, details: error.details },
      );
    return workflowFailure(
      'workflow.storage',
      `Could not take or release the legacy guard of run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      { stateDir },
    );
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The last line of the result file that parses as a JSON object, or null. */
async function readDocument(path: string): Promise<Record<string, unknown> | null> {
  const text = await readFile(path, 'utf8').catch(() => '');
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  for (const line of lines.reverse()) {
    try {
      const value = record(JSON.parse(line));
      if (value && typeof value['ok'] === 'boolean') return value;
    } catch {
      /* Not a document line. */
    }
  }
  return null;
}

function childDocument(document: Record<string, unknown> | null): StartChildDocument | null {
  if (!document) return null;
  const code = record(document['error'])?.['code'];
  return { ok: document['ok'] === true, errorCode: typeof code === 'string' ? code : null };
}

/** Wait until `done` settles, `ms` pass or `signal` aborts, without leaving a timer behind. */
async function waitFor(done: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  const timer = new AbortController();
  const stop = (): void => {
    timer.abort();
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await Promise.race([
      done,
      delay(ms, undefined, { signal: timer.signal }).catch(() => undefined),
    ]);
  } finally {
    signal?.removeEventListener('abort', stop);
    timer.abort();
  }
}

interface ExitState {
  readonly code: number | null;
  readonly signal: string | null;
}

function describeExit(exit: ExitState | null): string {
  if (!exit) return 'is still running';
  return exit.signal === null
    ? `exited with code ${String(exit.code)}`
    : `was killed by ${exit.signal}`;
}

/** Runs `workflow execute` detached and reports when, and whether, it took ownership of its run. */
export class StartWorkflowExecutor implements Executor<
  StartWorkflowPlan,
  StartWorkflowResult | WorkflowFailure
> {
  readonly #options: StartWorkflowExecutorOptions;

  public constructor(options: StartWorkflowExecutorOptions = {}) {
    this.#options = options;
  }

  public async execute(plan: StartWorkflowPlan): Promise<StartWorkflowResult | WorkflowFailure> {
    const { runId, stateDir } = plan;
    const signal = this.#options.signal;
    const observe = this.#options.observeRun ?? observeStartedRun;
    const prepared = await prepareStartLaunch(plan, signal, this.#options.commandLauncher);
    if (!prepared.ok) return prepared;
    const { files } = prepared;
    const argv = [...plan.argv];
    if (plan.stdinInput && files.input !== null)
      argv[plan.stdinInput.argvIndex] = `@${files.input}`;
    const evidence = (pid: number | null, exit: ExitState | null): StartLaunchEvidence => ({
      runId,
      pid,
      log: files.log,
      result: files.result,
      exitCode: exit?.code ?? null,
      signal: exit?.signal ?? null,
    });
    if (signal?.aborted) {
      await Promise.all(files.handles.map((handle) => handle.close()));
      return workflowFailure('workflow.interrupted', 'Workflow start interrupted before launch.', {
        stateDir,
        launch: evidence(null, null),
      });
    }
    const state: { exit: ExitState | null; error: Error | null } = { exit: null, error: null };
    let child: ChildProcess | undefined;
    let exited: Promise<void> = Promise.resolve();
    try {
      // The runner gets its own session (setsid) and never this process's stdio: a host capturing
      // start's output must not wait for the runner.
      const spawned = spawn(argv[0] ?? '', argv.slice(1), {
        cwd: plan.cwd,
        env: process.env,
        detached: true,
        stdio: ['ignore', files.handles[0].fd, files.handles[1].fd],
      });
      child = spawned;
      // Listen before any await: a failed spawn reports its error on the next tick.
      exited = new Promise<void>((resolve) => {
        spawned.once('exit', (code, exitSignal) => {
          state.exit = { code, signal: exitSignal };
          resolve();
        });
        spawned.once('error', (error) => {
          state.error = error;
          if (spawned.pid === undefined) resolve();
        });
      });
    } catch (error) {
      state.error = error instanceof Error ? error : new Error(String(error));
    } finally {
      await Promise.all(files.handles.map((handle) => handle.close()));
    }
    const pid = child?.pid;
    if (child === undefined || pid === undefined) {
      await exited;
      return workflowFailure(
        'start.exited',
        `Could not launch the runner of run ${runId}: ${state.error?.message ?? 'no process was created'}.`,
        { stateDir, launch: evidence(null, null) },
      );
    }
    const runner = child;
    const group = { pid, pgid: process.platform === 'win32' ? null : pid };
    const untrack = this.#options.processSupervisor?.track({
      ...group,
      binary: basename(argv[0] ?? 'node'),
      cwd: plan.cwd,
      startedAt: new Date().toISOString(),
      osStartTime: null,
    });
    const running = (): boolean => state.exit === null;
    const stop = async (): Promise<void> => {
      if (running()) {
        signalProcess(group, 'SIGTERM');
        await waitFor(exited, plan.killGraceMs + (this.#options.saveMarginMs ?? saveMarginMs));
        if (running()) {
          signalProcess(group, 'SIGKILL');
          await exited;
        }
      }
      untrack?.();
    };
    const failure = async (
      code: WorkflowFailure['code'],
      message: string,
      observed: StartRunObservation,
      context: Partial<WorkflowFailure> = {},
    ): Promise<WorkflowFailure> => {
      const run =
        observed.status === null ? null : await readRun({ stateDir, runId }).catch(() => null);
      const owned = observed.status === null ? null : runId;
      return workflowFailure(code, message, {
        runId: owned,
        stateDir,
        run,
        next: failureNextCommands({
          code,
          details: null,
          run,
          runId: owned,
          stateDir,
          launcher: this.#options.commandLauncher,
          rehearsal: false,
        }),
        ...context,
        launch: evidence(pid, state.exit),
      });
    };
    const deadline = Date.now() + plan.timeoutMs;
    const poll = this.#options.pollIntervalMs ?? 50;
    for (;;) {
      if (signal?.aborted) {
        await stop();
        return failure(
          'workflow.interrupted',
          `Workflow start interrupted; stopped runner PID ${String(pid)} of run ${runId}. See ${files.log}.`,
          await observe(stateDir, runId),
        );
      }
      // Take the exit first: a record observed afterwards is final for an exited runner.
      const exit = state.exit;
      const observed = await observe(stateDir, runId);
      const document = exit === null ? null : await readDocument(files.result);
      const decision = decideStart({
        childPid: pid,
        exit,
        recordReadable: observed.status !== null,
        ownerPid: observed.ownerPid,
        document: childDocument(document),
        deadlinePassed: Date.now() >= deadline,
      });
      if (decision.type === 'started') {
        untrack?.();
        runner.unref();
        return {
          kind: 'workflow.start.result',
          ok: true,
          exitCode: 0,
          runId,
          stateDir,
          pid,
          status: observed.status ?? 'running',
          log: files.log,
          result: files.result,
          next: [
            {
              why: 'Read the run’s compact status; exit 0 means the record was read, not that it completed.',
              argv: workflowArgv(
                this.#options.commandLauncher,
                'inspect',
                runId,
                '--state-dir',
                stateDir,
                '--json',
                '--summary',
              ),
            },
            {
              why: 'Watch the run until it completes (0), fails (1), suspends (75) or is cancelled (130).',
              argv: workflowArgv(
                this.#options.commandLauncher,
                'inspect',
                runId,
                '--state-dir',
                stateDir,
                '--watch',
              ),
            },
          ],
        };
      }
      if (decision.type === 'failed') {
        if (decision.reason === 'timeout') {
          await stop();
          return failure(
            'start.timeout',
            `Run ${runId} had no record owned by its runner after ${String(plan.timeoutMs)} ms; stopped runner PID ${String(pid)}. See ${files.log}.`,
            await observe(stateDir, runId),
          );
        }
        untrack?.();
        const error = record(document?.['error']);
        if (decision.reason === 'document' && error && isCliErrorCode(error['code'])) {
          const diagnostics = document?.['diagnostics'];
          const next = document?.['next'];
          return failure(
            error['code'],
            typeof error['message'] === 'string' ? error['message'] : `Run ${runId} did not start.`,
            observed,
            {
              details: (error['details'] ?? null) as JsonValue,
              stepId: typeof error['stepId'] === 'string' ? error['stepId'] : null,
              diagnostics: Array.isArray(diagnostics)
                ? (diagnostics as (TypecheckDiagnostic | DurabilityDiagnostic)[])
                : [],
              next: Array.isArray(next) ? (next as NextCommand[]) : [],
            },
          );
        }
        return failure(
          'start.exited',
          `The runner of run ${runId} (PID ${String(pid)}) ${describeExit(state.exit)} without ${
            observed.status === null ? 'creating its record or ' : ''
          }writing a usable result document. See ${files.log}.`,
          observed,
        );
      }
      await waitFor(exited, poll, signal);
    }
  }
}
