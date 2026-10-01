import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

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

const require = createRequire(import.meta.url);
/** The resolved version of a dependency, read once at module load. */
const dependencyVersion = (name: string): string =>
  z.object({ version: z.string() }).parse(require(`${name}/package.json`)).version;
const zodVersion = dependencyVersion('zod');
const tsxVersion = dependencyVersion('tsx');

/**
 * Informational toolchain versions for `record.engine`, excluded from workflow and step identity.
 * These are quiet-choir's own resolved dependencies: the zod that encodes schema identity and the
 * tsx that loads workflow source. Not part of {@link engineInfo}, which is digest-compared. @internal
 */
export function recordedEngine(): { quietChoir: string; node: string; zod: string; tsx: string } {
  return {
    quietChoir: engineInfo.version,
    node: process.version,
    zod: zodVersion,
    tsx: tsxVersion,
  };
}

/** Explain a checkpoint that predates the current durable-outcome contract. @internal */
export function oldFormatMessage(version: number): string {
  if (version === 1)
    return 'Checkpoint format version 1 must be migrated by resuming it before it can be used as a fork source.';
  return `Checkpoint format version ${String(version)} cannot resume or fork with the current durable-outcome contract (storage format 7, replay contract ${String(engineInfo.formatVersion)}). Inspect it with workflow inspect; use the original runtime to resume it or start a new run ID. No checkpoint was changed.`;
}
