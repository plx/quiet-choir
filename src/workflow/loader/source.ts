import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { WorkflowLaunch } from '../runtime/question-model.js';
import { fileURLToPath } from 'node:url';

import { promptRootFiles } from '../prompts/check.js';
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

/**
 * Add every file under the declared prompt roots to a source fingerprint (ADR 0064 section 4), so a
 * template edit is a code change like a TypeScript edit. Each file that {@link promptRootFiles}
 * lists, whether or not a template references it, is keyed by the real path of its root joined
 * with its logical path inside the root, relative to the same project root as the TypeScript
 * sources and with `/` separators, and hashed as the SHA-256 of the bytes a render reads (links
 * followed). Only the root is resolved: an in-root file or directory symlink keeps its own path, so
 * retargeting it changes the hash under the path a render reads, and the key still resolves back to
 * those bytes from the project root. No path is excluded, not even one under `node_modules`. The
 * entries are merged into `files`, keys sorted, and `hash` recomputed over the merged map; with no
 * roots the fingerprint is returned unchanged, so a workflow without prompts keeps its identity.
 * @internal
 */
export async function withPromptSources(
  plan: TypecheckPlan,
  source: SourceFingerprint,
  roots: readonly string[],
): Promise<SourceFingerprint> {
  if (roots.length === 0) return source;
  const entrypoint = await realpath(plan.entrypoint);
  const config = plan.configuration.kind === 'tsconfig' ? plan.configuration.path : undefined;
  const project = await projectRoot(entrypoint, config);
  const merged = new Map(Object.entries(source.files));
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    for (const file of promptRootFiles(root)) {
      const key = relative(project, join(realRoot, relative(root, file)))
        .split(sep)
        .join('/');
      merged.set(
        key,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      );
    }
  }
  const files: Record<string, string> = {};
  for (const key of [...merged.keys()].sort())
    Object.defineProperty(files, key, { value: merged.get(key), enumerable: true });
  return { hash: digest(files), files };
}

/**
 * Persist launch paths separately from semantic identity so pending can check bytes without
 * imports. A package run (ADR 0065 section 2) passes `override`: `entrypoint` becomes the real path
 * of the selected workflow's module and `package` records the package's real root, name and
 * version, while the project root that keys `sources` still comes from the plan's entrypoint (the
 * manifest), so a launch and its resume agree. @internal
 */
export async function workflowLaunch(
  plan: TypecheckPlan,
  source: SourceFingerprint,
  override?: {
    readonly entrypoint: string;
    readonly package: { readonly root: string; readonly name: string; readonly version: string };
  },
): Promise<WorkflowLaunch> {
  const typecheckEntrypoint = await realpath(plan.entrypoint);
  const tsconfig =
    plan.configuration.kind === 'tsconfig' ? await realpath(plan.configuration.path) : null;
  const root = await projectRoot(typecheckEntrypoint, tsconfig ?? undefined);
  return {
    entrypoint: override === undefined ? typecheckEntrypoint : await realpath(override.entrypoint),
    tsconfig,
    sources: Object.fromEntries(
      Object.entries(source.files).map(([path, hash]) => [resolve(root, path), hash]),
    ),
    ...(override === undefined
      ? {}
      : {
          package: {
            root: await realpath(override.package.root),
            name: override.package.name,
            version: override.package.version,
          },
        }),
  };
}
