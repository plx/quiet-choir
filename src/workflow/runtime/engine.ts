import { readFileSync } from 'node:fs';

import { z } from 'zod';

import type { EngineInfo } from './replay-model.js';

/** Replay compatibility metadata; storage format revisions do not change effect identity. @internal */
export const engineInfo: EngineInfo = {
  version: z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')))
    .version,
  formatVersion: 6,
};

/** Explain a checkpoint that predates the current durable-outcome contract. @internal */
export function oldFormatMessage(version: number): string {
  if (version === 1)
    return 'Checkpoint format version 1 must be migrated by resuming it before it can be used as a fork source.';
  return `Checkpoint format version ${String(version)} cannot resume or fork with the current durable-outcome contract (storage format 7, replay contract ${String(engineInfo.formatVersion)}). Inspect it with workflow inspect; use the original runtime to resume it or start a new run ID. No checkpoint was changed.`;
}
