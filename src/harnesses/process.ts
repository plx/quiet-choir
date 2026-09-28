import { spawn } from 'node:child_process';
import { addAbortListener } from 'node:events';
import { groupState, processIdentity, signalProcess } from '../processes/identity.js';
import type { HarnessInvocation, HarnessProcess } from '../workflow/runtime/model.js';

/** Resource limits and command details for a single headless invocation. */
export interface ProcessRequest {
  /** Executable path or command on PATH. */
  readonly binary: string;
  /** Overlay on the inherited process environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Arguments passed directly to the executable without a shell. */
  readonly args: readonly string[];
  /** Working directory for the executable. */
  readonly cwd: string;
  /** Prompt sent to stdin after durable process registration. */
  readonly input: string;
  /** Leader wall-clock deadline in milliseconds. */
  readonly timeoutMs: number;
  /** Combined stdout/stderr size limit in bytes. */
  readonly maxOutputBytes: number;
  /** Grace period between SIGTERM and SIGKILL. */
  readonly killGraceMs: number;
  /** Maximum pipe drain after leader exit; defaults to 2000ms. */
  readonly drainMs?: number;
  /** Force settlement this long after SIGKILL; defaults to 500ms. */
  readonly backstopMs?: number;
  /** Signal for cancelling the invocation. */
  readonly signal: AbortSignal;
  /** Runtime ownership port; standalone diagnostics may omit durable tracking. */
  readonly trackProcess?: HarnessInvocation['trackProcess'];
}

/** Captured output and termination status for a bounded process. */
export interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly warnings: readonly string[];
}

/** Settle independently of inherited pipes, reaping the owned group on every exit path. */
export function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  request.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const child = spawn(request.binary, [...request.args], {
      cwd: request.cwd,
      ...(request.env === undefined ? {} : { env: { ...process.env, ...request.env } }),
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const warnings: string[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let settled = false;
    let exited = false;
    let pipesEnded = 0;
    let reaped = child.pid === undefined;
    let code: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let escalation: NodeJS.Timeout | undefined;
    let backstop: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    let cleaning = false;
    const descriptor: HarnessProcess | undefined =
      child.pid === undefined
        ? undefined
        : {
            pid: child.pid,
            pgid: process.platform === 'win32' ? null : child.pid,
            binary: request.binary,
            cwd: request.cwd,
            startedAt,
            osStartTime: processIdentity(child.pid)?.start ?? null,
          };
    let registration: ReturnType<HarnessInvocation['trackProcess']> | undefined;
    const warn = (message: string): void => {
      if (!warnings.includes(message)) warnings.push(message);
    };
    const kill = (sent: NodeJS.Signals): void => {
      if (!descriptor || reaped) return;
      try {
        const current = processIdentity(descriptor.pid);
        if (descriptor.osStartTime && current?.start && current.start !== descriptor.osStartTime) {
          reaped = true;
          return;
        }
        signalProcess(descriptor, sent);
      } catch (error) {
        warn(
          `Could not send ${sent} to ${request.binary}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const refresh = (): void => {
      // Once observed gone, this numeric group ID is no longer ours, even if reused while pipes drain.
      if (!reaped) reaped = !descriptor || groupState(descriptor) === 'dead';
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      clearTimeout(backstop);
      clearTimeout(drain);
      clearInterval(poll);
      subscription[Symbol.dispose]();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      void (async () => {
        try {
          const lease = await registration?.catch((error: unknown) => {
            failure ??= error instanceof Error ? error : new Error(String(error));
            return undefined;
          });
          if (lease && reaped) await lease.release();
          else if (lease)
            warn(
              'Process cleanup could not be confirmed; its ownership record was retained for inspect and recovery.',
            );
        } catch (error) {
          if (!failure)
            warn(
              `Process record cleanup: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        if (failure) {
          if (warnings.length) {
            Object.assign(failure, { processWarnings: warnings });
            failure.message += ` Cleanup: ${warnings.join(' ')}`;
          }
          reject(failure);
        } else
          resolve({
            code,
            signal,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            warnings,
          });
      })();
    };
    const maybeFinish = (): void => {
      if (exited && reaped && pipesEnded === 2) finish();
    };
    const beginCleanup = (): void => {
      if (cleaning || settled) return;
      cleaning = true;
      refresh();
      if (!reaped) {
        if (!failure) warn('Reaping leftover harness process group after leader exit.');
        kill('SIGTERM');
      }
      poll = setInterval(() => {
        refresh();
        maybeFinish();
      }, 40);
      escalation = setTimeout(() => {
        refresh();
        if (!reaped) {
          kill('SIGKILL');
          warn('Harness process cleanup escalated to SIGKILL.');
        }
        // A reaped, exited leader without a failure is already bounded by the drain timer; a
        // backstop here would truncate a short grace's valid output before that drain ends.
        if (exited && reaped && !failure) return;
        backstop = setTimeout(() => {
          refresh();
          if (pipesEnded !== 2)
            warn('Closed inherited output pipes at the process cleanup backstop.');
          if (!exited && !failure)
            failure = new Error('Harness leader did not exit after SIGKILL.');
          finish();
        }, request.backstopMs ?? 500);
      }, request.killGraceMs);
      maybeFinish();
    };
    const stop = (error: Error): void => {
      if (failure || settled) return;
      failure = error;
      beginCleanup();
    };
    const abort = (): void => {
      // A completed leader's valid result remains available while cleanup drains its pipes.
      if (exited) return;
      stop(
        Object.assign(
          new Error(`${request.binary} invocation cancelled.`, { cause: request.signal.reason }),
          { code: 'ABORT_ERR' },
        ),
      );
    };
    const deadline = setTimeout(() => {
      stop(
        Object.assign(
          new Error(`${request.binary} exceeded its ${String(request.timeoutMs)}ms deadline.`),
          { code: 'ETIMEDOUT' },
        ),
      );
    }, request.timeoutMs);
    const subscription = addAbortListener(request.signal, abort);
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > request.maxOutputBytes)
        stop(
          Object.assign(
            new Error(
              `${request.binary} exceeded its ${String(request.maxOutputBytes)}-byte output limit.`,
            ),
            { code: 'QUIET_CHOIR_OUTPUT_LIMIT' },
          ),
        );
      else chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      collect(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      collect(stderr, chunk);
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.once('end', () => {
        pipesEnded++;
        maybeFinish();
      });
      stream.on('error', (error: Error) => {
        stop(error);
      });
    }
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') stop(error);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      // `phase` marks every launch failure as a process failure, whatever its errno code.
      failure = Object.assign(
        new Error(
          error.code === 'ENOENT'
            ? `Cannot start ${request.binary}. Install the harness CLI and check PATH and the working directory.`
            : `Cannot start ${request.binary}: ${error.message}`,
          { cause: error },
        ),
        { code: error.code, phase: 'spawn' },
      );
      if (!descriptor) finish();
      else beginCleanup();
    });
    child.once('exit', (exitCode, exitSignal) => {
      if (settled) return;
      exited = true;
      code = exitCode;
      signal = exitSignal;
      clearTimeout(deadline);
      drain = setTimeout(() => {
        if (pipesEnded !== 2)
          warn(
            'Closed inherited output pipes after the leader drain deadline; output may be truncated.',
          );
        child.stdout.destroy();
        child.stderr.destroy();
        pipesEnded = 2;
        maybeFinish();
      }, request.drainMs ?? 2000);
      beginCleanup();
      refresh();
      maybeFinish();
    });
    if (descriptor && request.trackProcess) {
      // Calling this before yielding also installs the runner's synchronous second-signal ownership.
      try {
        registration = request.trackProcess(descriptor);
      } catch (error) {
        registration = Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    void Promise.resolve(registration).then(
      () => {
        if (!settled && !failure) child.stdin.end(request.input);
      },
      (error: unknown) => {
        // Registration may itself abort the run synchronously. Preserve its infrastructure
        // failure instead of the cancellation notification that raced the rejected promise.
        failure = error instanceof Error ? error : new Error(String(error));
        beginCleanup();
      },
    );
    if (request.signal.aborted) abort();
  });
}
