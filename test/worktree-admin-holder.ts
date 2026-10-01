import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** A separate process holding a repository's worktree administration lock. */
export interface AdminLockHolder {
  readonly child: ChildProcess;
  /** Wall-clock time the child owned the lock. */
  readonly held: Promise<number>;
  /** Wall-clock time just before the child started releasing (it held the lock until then). */
  readonly released: Promise<number>;
  readonly exited: Promise<{ code: number | null; signal: string | null; stderr: string }>;
}

/** Fork test/worktree-admin-holder-child.mjs; `hold` is milliseconds or `forever` (until killed). */
export function holdAdminLock(commonGitDir: string, hold: number | 'forever'): AdminLockHolder {
  const child = fork(
    fileURLToPath(new URL('./worktree-admin-holder-child.mjs', import.meta.url)),
    [commonGitDir, String(hold)],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<{ code: number | null; signal: string | null; stderr: string }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        resolve({ code, signal, stderr });
      });
    },
  );
  const report = (key: 'held' | 'released'): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      child.on('message', (message) => {
        if (typeof message === 'object' && key in message)
          resolve(Number((message as Record<string, unknown>)[key]));
      });
      void exited.then(({ code, signal, stderr: output }) => {
        reject(
          new Error(
            `Lock holder exited (${String(code ?? signal)}) before reporting ${key}: ${output}`,
          ),
        );
      });
    });
  const held = report('held'),
    released = report('released');
  // A killed holder never releases; only the reports a test awaits may fail it.
  for (const promise of [held, released]) promise.catch(() => undefined);
  return { child, held, released, exited };
}
