// One racing lock owner for test/lock-race.test.ts: acquire and release the same run's locks until
// `cycles` acquisitions succeed. Contention (`run.locked`) is retried after a short jittered delay;
// anything else, including a lock refused for incomplete ownership metadata, fails the child.
import { setTimeout as delay } from 'node:timers/promises';
import { lockRun } from '../src/workflow/runtime/lock.ts';
import { setStorageSyncForTesting } from '../src/workflow/runtime/storage-io.ts';

const [stateDir, runId, cycles] = process.argv.slice(2);
// Like the in-process suite: fsync only slows the race and a crash is not simulated here.
setStorageSyncForTesting(false);
let acquired = 0;
let refused = 0;
while (acquired < Number(cycles)) {
  let release;
  try {
    // probeOwner: false skips a `ps` spawn per acquire on macOS; liveness still uses the PID.
    release = await lockRun(stateDir, runId, { probeOwner: false });
  } catch (error) {
    if (error?.code === 'run.locked' && !/incomplete ownership/u.test(error.message)) {
      refused++;
      await delay(Math.random() * 3);
      continue;
    }
    throw error;
  }
  acquired++;
  await delay(Math.random() * 2);
  await release();
}
process.send?.({ acquired, refused });
