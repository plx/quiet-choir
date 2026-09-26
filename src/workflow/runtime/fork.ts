import { z } from 'zod';

import { engineInfo, oldFormatMessage } from './engine.js';
import { digest, jsonValue } from './json.js';
import { matchesStepGlob, policyOverrideSchema } from './policy.js';
import type { ForkOptions, ForkProvenance } from './replay-model.js';
import { readRun, type RunRecord, type StepRecord } from './store.js';

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
  const source = await readRun({ runId, stateDir });
  if (source.formatVersion !== engineInfo.formatVersion)
    throw new Error(oldFormatMessage(source.formatVersion));
  if (source.workflow.name !== name)
    throw new Error(`Fork source workflow name ${source.workflow.name} does not match ${name}.`);
  return source;
}

/** Recover the original reuse snapshot, closing future reuse if it has changed. @internal */
export async function pinnedFork(provenance: ForkProvenance): Promise<RunRecord | undefined> {
  if (provenance.reuseClosed) return undefined;
  try {
    const source = await readRun(provenance);
    if (digest(source) === provenance.sourceDigest) return source;
    provenance.warning =
      'Fork source changed since this run began; remaining effects will execute live.';
  } catch {
    provenance.warning = 'Fork source is unavailable; remaining effects will execute live.';
  }
  provenance.reuseClosed = true;
  return undefined;
}

/** Select reuse synchronously, so concurrent launches cannot pass an earlier prefix miss. @internal */
export function reuseCandidate(
  provenance: ForkProvenance,
  source: RunRecord | undefined,
  id: string,
  kind: StepRecord['kind'],
  fingerprint: string,
  valid: (step: StepRecord) => boolean,
): StepRecord | undefined {
  if (provenance.reuseClosed || source === undefined) return undefined;
  const ordered = Object.entries(source.steps).sort((a, b) => (a[1].seq ?? 0) - (b[1].seq ?? 0));
  const candidate =
    provenance.reuse === 'prefix'
      ? ordered[provenance.cursor]
      : Object.hasOwn(source.steps, id)
        ? ([id, source.steps[id]] as const)
        : undefined;
  const step = candidate?.[1];
  if (
    candidate?.[0] === id &&
    step?.status === 'completed' &&
    step.kind === kind &&
    step.fingerprint === fingerprint &&
    !provenance.invalidate.some((glob) => matchesStepGlob(glob, id)) &&
    valid(step)
  ) {
    if (provenance.reuse === 'prefix') provenance.cursor++;
    return step;
  }
  if (provenance.reuse === 'prefix') provenance.reuseClosed = true;
  return undefined;
}
