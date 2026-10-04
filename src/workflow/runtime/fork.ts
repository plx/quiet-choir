import { RunRefusedError } from './run-errors.js';
import { readRequiredRun } from './read-required-run.js';
import { z } from 'zod';

import { oldFormatMessage } from './engine.js';
import { digest, jsonValue } from './json.js';
import { matchesStepGlob, policyOverrideSchema } from './policy.js';
import { forkPrefixBlockers, type MapItemScope } from './replay-decision.js';
import type { ForkOptions, ForkProvenance } from './replay-model.js';
import {
  isTerminalStep,
  readRun,
  recordSchemaDrift,
  refuseRecordSchemaDrift,
  type RunRecord,
  type StepRecord,
} from './store.js';

/** Validate fork settings before acquiring a writer or running effects. @internal */
export function validateFork(value: unknown): ForkOptions {
  const result = z
    .strictObject({
      runId: z.string().min(1),
      stateDir: z.string().optional(),
      reuse: z.enum(['prefix', 'matching']).optional(),
      invalidate: z.array(z.string()).optional(),
    })
    .parse(jsonValue(value));
  for (const match of result.invalidate ?? []) policyOverrideSchema.parse({ match });
  return result as ForkOptions;
}

/** Load a source for a new fork without taking its writer lock. @internal */
export async function loadFork(runId: string, stateDir: string, name: string): Promise<RunRecord> {
  const source = await readRequiredRun({ runId, stateDir });
  if (![6, 7].includes(source.formatVersion))
    throw new RunRefusedError('run.incompatible', runId, oldFormatMessage(source.formatVersion), {
      formatVersion: source.formatVersion,
    });
  // A fork copies reused steps from a source this build would read only in part.
  refuseRecordSchemaDrift(source);
  if (source.workflow.name !== name)
    throw new RunRefusedError(
      'run.incompatible',
      runId,
      `Fork source workflow name ${source.workflow.name} does not match ${name}.`,
      { name, savedName: source.workflow.name },
    );
  return source;
}

/** Recover the original reuse snapshot, closing future reuse if it has changed. @internal */
export async function pinnedFork(provenance: ForkProvenance): Promise<RunRecord | undefined> {
  if (provenance.reuseClosed) return undefined;
  try {
    const source = await readRun(provenance);
    // The digest covers the record as read, which omits fields this build does not know, so a
    // source that gained such a field (or a newer revision) after the pin still matches it.
    if (recordSchemaDrift(source))
      provenance.warning =
        'Fork source was rewritten by a newer quiet-choir or has fields this build does not know; remaining effects will execute live.';
    else if (
      digest(source) === provenance.sourceDigest ||
      priorHarnessDigest(source) === provenance.sourceDigest
    )
      return source;
    else
      provenance.warning =
        'Fork source changed since this run began; remaining effects will execute live.';
  } catch {
    provenance.warning = 'Fork source is unavailable; remaining effects will execute live.';
  }
  provenance.reuseClosed = true;
  return undefined;
}

/** Where a fork reuse request sits in the target run. @internal */
export interface ForkRequest {
  /** The target's settlement counter when the body requested the effect. */
  readonly launchStamp: number;
  /** The named-map items enclosing the request, outermost first. */
  readonly mapItems: readonly MapItemScope[];
  /** The target run's steps; read only. */
  readonly target: Readonly<Record<string, StepRecord>>;
}

/**
 * Select a reusable source step. `matching` reuses any terminal source step with the same ID and
 * identity. `prefix` (the default) also requires `forkPrefixBlockers` to find nothing: every
 * source step that had settled before this step's source launch is already reused, and no live
 * target step settled before this request, ignoring sibling named-map items. A miss closes nothing,
 * because later decisions read the reused copies already in the target; the caller must insert a
 * reused copy synchronously, before an await lets another launch decide. @internal
 */
export function reuseCandidate(
  provenance: ForkProvenance,
  source: RunRecord | undefined,
  id: string,
  kind: StepRecord['kind'],
  fingerprint: string,
  valid: (step: StepRecord) => boolean,
  request: ForkRequest,
): StepRecord | undefined {
  if (provenance.reuseClosed || source === undefined || !Object.hasOwn(source.steps, id))
    return undefined;
  const step = source.steps[id];
  if (
    step === undefined ||
    !isTerminalStep(step) ||
    step.kind !== kind ||
    step.fingerprint !== fingerprint ||
    provenance.invalidate.some((glob) => matchesStepGlob(glob, id)) ||
    !valid(step)
  )
    return undefined;
  if (provenance.reuse === 'prefix') {
    const blockers = forkPrefixBlockers({
      id,
      launchStamp: request.launchStamp,
      mapItems: request.mapItems,
      sourceRunId: provenance.runId,
      source: source.steps,
      target: request.target,
    });
    if (blockers.length > 0) return undefined;
    provenance.cursor++;
  }
  return step;
}

/** Reconstruct only the preceding harness field representation for an existing fork's source pin. */
function priorHarnessDigest(source: RunRecord): string {
  const prior = structuredClone(source);
  const summary = (request: StepRecord['request']): void => {
    if (
      !request ||
      request.revision !== undefined ||
      !['claude', 'codex'].includes(request.harness)
    )
      return;
    Object.assign(request, { provider: request.harness });
    Reflect.deleteProperty(request, 'harness');
  };
  for (const step of Object.values(prior.steps)) {
    if (
      step.kind === 'agent' &&
      step.revision === 1 &&
      (step.harness === 'claude' || step.harness === 'codex') &&
      step.request?.revision === undefined
    ) {
      step.kind = step.harness;
      delete step.harness;
      delete step.revision;
    }
    summary(step.request);
    for (const attempt of step.attemptHistory ?? []) summary(attempt.request);
  }
  return digest(prior);
}
