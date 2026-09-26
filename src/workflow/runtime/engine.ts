import { readFileSync } from 'node:fs';

import { z } from 'zod';

import type { EngineInfo } from './replay-model.js';

/** Current engine compatibility metadata. @internal */
export const engineInfo: EngineInfo = {
  version: z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')))
    .version,
  formatVersion: 3,
};

/** Explain a checkpoint that predates callback identity. @internal */
export function oldFormatMessage(version: number): string {
  return `Checkpoint format version ${String(version)} cannot resume or fork with callback-aware identity (current format 3). Inspect it with workflow inspect; use the original runtime to resume it or start a new run ID. No checkpoint was changed.`;
}
