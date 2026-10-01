// Holds a repository's worktree administration lock in a separate process for
// test/worktree-admin-lock.test.ts and test/worktrees.test.ts. Reports `{ held }` once it owns the
// lock. With a hold time in milliseconds it then reports `{ released }`, the wall-clock time just
// before it starts releasing (the lock is held at least until then), releases and exits; with
// `forever` it keeps the lock until it is killed.
import { setTimeout as delay } from 'node:timers/promises';
import { acquireWorktreeAdminLock } from '../src/workflow/runtime/worktree-admin-lock.ts';
import { setStorageSyncForTesting } from '../src/workflow/runtime/storage-io.ts';

const [commonGitDir, hold] = process.argv.slice(2);
// Like the in-process suite: fsync only slows the test and a crash is not simulated by a flush.
setStorageSyncForTesting(false);
const release = await acquireWorktreeAdminLock(commonGitDir, {
  signal: new AbortController().signal,
  probeOwner: false,
});
process.send?.({ held: Date.now() });
if (hold === 'forever') setInterval(() => undefined, 60_000);
else {
  await delay(Number(hold));
  const released = Date.now();
  await release();
  process.send?.({ released }, () => process.exit(0));
}
