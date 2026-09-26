import { spawn } from 'node:child_process';

/** Resource limits and command details for a single headless invocation. */
export interface ProcessRequest {
  /** Executable path or command on PATH. */
  readonly binary: string;
  /** Arguments passed directly to the executable without a shell. */
  readonly args: readonly string[];
  /** Working directory for the executable. */
  readonly cwd: string;
  /** Prompt sent to stdin. */
  readonly input: string;
  /** Wall-clock deadline in milliseconds. */
  readonly timeoutMs: number;
  /** Combined stdout/stderr size limit in bytes. */
  readonly maxOutputBytes: number;
  /** Grace period between SIGTERM and SIGKILL. */
  readonly killGraceMs: number;
  /** Signal for cancelling the invocation. */
  readonly signal: AbortSignal;
}

/** Captured output and termination status for a bounded process. */
export interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Capture every exit; reject only spawn, cancellation, deadline, and output-limit failures. */
export function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  request.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(request.binary, [...request.args], {
      cwd: request.cwd,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let settled = false;

    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        // Exiting between the close event and process-group cleanup is harmless.
      }
    };
    const stop = (error: Error): void => {
      if (failure !== undefined || settled) return;
      failure = error;
      kill('SIGTERM');
      escalation = setTimeout(() => {
        kill('SIGKILL');
      }, request.killGraceMs);
    };
    const abort = (): void => {
      stop(new Error(`${request.binary} invocation cancelled.`, { cause: request.signal.reason }));
    };
    const deadline = setTimeout(() => {
      stop(new Error(`${request.binary} exceeded its ${String(request.timeoutMs)}ms deadline.`));
    }, request.timeoutMs);
    const cleanup = (): void => {
      settled = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      request.signal.removeEventListener('abort', abort);
    };
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > request.maxOutputBytes) {
        stop(
          new Error(
            `${request.binary} exceeded its ${String(request.maxOutputBytes)}-byte output limit.`,
          ),
        );
      } else chunks.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      collect(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      collect(stderr, chunk);
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // Early process exit commonly closes stdin; the exit status is more useful.
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') stop(error);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        new Error(
          error.code === 'ENOENT'
            ? `Cannot start ${request.binary}. Install the harness CLI and check PATH and the working directory.`
            : `Cannot start ${request.binary}: ${error.message}`,
          { cause: error },
        ),
      );
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      cleanup();
      if (failure !== undefined) {
        // Also reap descendants if the group leader exited first.
        kill('SIGKILL');
        reject(failure);
      } else
        resolve({
          code,
          signal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
    });
    request.signal.addEventListener('abort', abort, { once: true });
    // Cancellation may have occurred while spawn was being set up.
    if (request.signal.aborted) abort();
    child.stdin.end(request.input);
  });
}
