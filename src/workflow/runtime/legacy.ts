import { digest } from './json.js';
import { schemaJson } from './schema.js';
import type { WorkflowDefinition } from './model.js';
import type { WorkflowCodeOptions } from './compatibility.js';
import type { RunRecord } from './record.js';

/** Original format-one aggregate; old records did not keep individual code/schema hashes. @internal */
export function legacyWorkflowFingerprint(
  definition: Pick<WorkflowDefinition<unknown, unknown>, 'input' | 'output'>,
  options: WorkflowCodeOptions,
): string {
  return digest({
    code: options.source?.hash ?? options.fingerprint ?? null,
    input: schemaJson(definition.input),
    output: schemaJson(definition.output),
  });
}

/** Fill absent bookkeeping without inventing historical attempt times or usage. @internal */
export function prepareLegacyReplay(record: RunRecord): void {
  record.executions = [];
  record.events = [];
  record.eventCounts = {};
  record.phase = null;
  record.errorStack = null;
  record.maps = {};
  record.rootCause = null;
  record.policy ??= [];
  record.allowModelOverride ??= false;
  let seq = 0;
  for (const step of Object.values(record.steps)) {
    step.seq = ++seq;
    step.legacyIdentity = 1;
    step.legacyAttempts = step.attempts;
    step.identity = {};
    step.attemptHistory = [];
    step.phase = null;
    step.startedAt = null;
    step.finishedAt = null;
    step.durationMs = null;
    step.request = null;
    step.errorStack = null;
  }
}
