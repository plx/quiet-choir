import type { HarnessInvocation } from '../src/workflow/runtime/model.js';

/** Adapter unit tests own no durable run; process cleanup is still enforced by runProcess. */
export function testInvocation(signal = new AbortController().signal): HarnessInvocation {
  return {
    signal,
    runId: 'adapter-test',
    stepId: 'call',
    attempt: 1,
    trackProcess: () => Promise.resolve({ release: () => Promise.resolve() }),
  };
}
