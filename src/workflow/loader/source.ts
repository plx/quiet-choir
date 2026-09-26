import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { digest } from '../runtime/json.js';
import type { SourceFingerprint } from '../runtime/replay-model.js';
import type { TypecheckPlan } from '../typecheck/model.js';

async function projectRoot(entrypoint: string, config: string | undefined): Promise<string> {
  if (config !== undefined) return dirname(await realpath(config));
  let directory = dirname(entrypoint);
  for (;;) {
    try {
      if ((await stat(join(directory, 'package.json'))).isFile()) return directory;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return dirname(entrypoint);
    directory = parent;
  }
}

/** Hash canonical project-relative source files, excluding quiet-choir's own src/dist implementation. @internal */
export async function fingerprintSources(
  plan: TypecheckPlan,
  sourceFiles: readonly string[],
): Promise<SourceFingerprint> {
  const entrypoint = await realpath(plan.entrypoint);
  const config = plan.configuration.kind === 'tsconfig' ? plan.configuration.path : undefined;
  const root = await projectRoot(entrypoint, config);
  const engineRoot = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
  const paths = [
    ...new Set(
      await Promise.all(
        [...sourceFiles, plan.entrypoint, ...(config === undefined ? [] : [config])].map((file) =>
          realpath(file),
        ),
      ),
    ),
  ].sort();
  const files: Record<string, string> = {};
  for (const file of paths) {
    const enginePath = relative(engineRoot, file).split(sep);
    if (file !== entrypoint && (enginePath[0] === 'src' || enginePath[0] === 'dist')) continue;
    if (file.split(sep).includes('node_modules') && file !== entrypoint) continue;
    const key = relative(root, file).split(sep).join('/');
    Object.defineProperty(files, key, {
      value: createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
      enumerable: true,
    });
  }
  return { hash: digest(files), files };
}
