import { setTimeout as delay } from 'node:timers/promises';
import type { WorkflowClock } from './wait-model.js';

/** Last millisecond of year 9999, the limit of the persisted four-digit ISO timestamps. @internal */
export const MAX_EPOCH_MS = 253_402_300_799_999;

/** System wall clock with cancellable timers; no background scheduler is created. @internal */
export const systemClock: WorkflowClock = {
  now: () => Date.now(),
  async sleep(milliseconds, signal) {
    signal.throwIfAborted();
    let remaining = milliseconds;
    while (remaining > 0) {
      const interval = Math.min(remaining, 2_147_483_647);
      await delay(interval, undefined, { signal });
      remaining -= interval;
    }
  },
};

/** Read and validate a clock before using its value in persisted wait state. @internal */
export function clockNow(clock: WorkflowClock): number {
  const value = clock.now();
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EPOCH_MS)
    throw new Error(
      'Workflow clock must return a nonnegative integer Unix epoch millisecond value through year 9999.',
    );
  return value;
}

/** Short waits stay in-process under the default suspension policy. @internal */
export const SHORT_WAIT_MS = 1_000;
