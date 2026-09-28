import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
import type { WorkflowDescription } from '../runtime/child-model.js';
import { capabilityManifestSchema } from '../runtime/profiles.js';
import { engineInfo } from '../runtime/engine.js';
import { digest } from '../runtime/json.js';
import { analyzeTypecheckEntrypoint } from '../typecheck/plan.js';
import type { TypecheckPlan } from '../typecheck/model.js';
import type { ValidatedWorkflow, WorkflowCommandResult } from './model.js';
import { workflowLaunch } from './source.js';

const metadata: z.ZodType<WorkflowDescription> = z.lazy(() =>
  z.object({
    harnesses: z.array(
      z.object({
        name: z.string(),
        revision: z.number().int().positive(),
        options: z.json(),
        capabilities: z.object({
          structuredOutput: z.enum(['native', 'prompted', 'none']),
          effort: z.array(z.string()).optional(),
          sandbox: z.boolean().optional(),
          sessionResume: z.boolean().optional(),
        }),
        factory: z.boolean(),
        probe: z.boolean(),
      }),
    ),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().nullable(),
    whenToUse: z.string().nullable(),
    phases: z.array(z.object({ title: z.string().min(1), detail: z.string().optional() })),
    inputSchema: z.json(),
    outputSchema: z.json(),
    capabilities: capabilityManifestSchema,
    profiles: z.record(z.string(), capabilityManifestSchema.shape.defaults),
    children: z.array(metadata),
    recursive: z.boolean(),
    entrypoint: z.string().nullable(),
  }),
) as z.ZodType<WorkflowDescription>;
const validation = z.object({
  kind: z.literal('workflow.validate.result'),
  ok: z.literal(true),
  entrypoint: z.string(),
  workflow: metadata.and(
    z.object({
      fingerprint: z.string(),
      identity: z.object({
        code: z.string().nullable(),
        files: z.record(z.string(), z.string()),
        inputSchema: z.string(),
        outputSchema: z.string(),
        engine: z.object({ version: z.string(), formatVersion: z.number().int().positive() }),
      }),
    }),
  ),
});
const cache = z.object({
  version: z.literal(2),
  engine: z.string(),
  plan: z.json(),
  sources: z.record(z.string(), z.string()),
  result: validation,
});
const ignored = new Set(['node_modules', '.git', '.quiet-choir', '.context', 'dist', 'coverage']);

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Deterministic discovery; symlink directories are not followed and overlapping roots deduplicate. @internal */
export async function definitionFiles(directories: readonly string[]): Promise<string[]> {
  const files = new Set<string>();
  const seen = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    const canonical = await realpath(directory);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    for (const entry of await readdir(canonical, { withFileTypes: true })) {
      if (entry.isDirectory() && !ignored.has(entry.name)) await visit(join(canonical, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.workflow.ts'))
        files.add(join(canonical, entry.name));
    }
  };
  for (const directory of directories) await visit(resolve(directory));
  return [...files].sort();
}

async function cacheSources(
  plan: TypecheckPlan,
  result: ValidatedWorkflow,
): Promise<Record<string, string>> {
  const identity = result.workflow.identity;
  if (!identity?.code)
    throw new Error('Validated registry definitions require a source fingerprint.');
  const sources = {
    ...(await workflowLaunch(plan, { hash: identity.code, files: identity.files })).sources,
  };
  if (plan.configuration.kind === 'tsconfig') {
    const configPath = plan.configuration.path;
    const sourceFile = ts.readJsonConfigFile(configPath, (path) => ts.sys.readFile(path));
    ts.parseJsonSourceFileConfigFileContent(
      sourceFile,
      ts.sys,
      dirname(configPath),
      undefined,
      configPath,
    );
    for (const extended of sourceFile.extendedSourceFiles ?? [])
      sources[resolve(extended)] = hash(await readFile(extended));
  }
  const lockfiles = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];
  let directory = dirname(plan.entrypoint);
  for (;;) {
    let controllingRoot = false;
    for (const file of ['package.json', ...lockfiles]) {
      const path = join(directory, file);
      try {
        sources[path] = hash(await readFile(path));
        if (lockfiles.includes(file)) controllingRoot = true;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    // Keep climbing past a leaf package.json: a monorepo workspace root's lockfile, further up,
    // still controls dependency versions and must invalidate the cache when it changes.
    if (controllingRoot || dirname(directory) === directory) break;
    directory = dirname(directory);
  }
  return sources;
}

/** Source-validated metadata cache; execution always imports and checks the selected workflow anew. @internal */
export async function listDefinitions(
  directories: readonly string[],
  validate: (plan: TypecheckPlan) => Promise<WorkflowCommandResult>,
  refresh = false,
): Promise<WorkflowCommandResult> {
  const definitions: ValidatedWorkflow[] = [];
  const names = new Map<string, string>();
  const root = join(
    process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'),
    'quiet-choir',
    'definitions',
  );
  for (const entrypoint of await definitionFiles(directories)) {
    const analyzed = analyzeTypecheckEntrypoint(entrypoint, process.cwd());
    if (!analyzed.ok) throw new Error(analyzed.error.message);
    const plan = analyzed.plan;
    const path = join(root, `${digest({ entrypoint, configuration: plan.configuration })}.json`);
    const engine = `${engineInfo.version}:${process.versions.node.split('.')[0] ?? 'unknown'}`;
    let result: ValidatedWorkflow | undefined;
    if (!refresh) {
      try {
        const prior = cache.parse(JSON.parse(await readFile(path, 'utf8')));
        if (
          prior.engine === engine &&
          digest(prior.plan) === digest(plan) &&
          prior.result.entrypoint === entrypoint &&
          Object.keys(prior.sources).length > 0 &&
          (
            await Promise.all(
              Object.entries(prior.sources).map(
                async ([path, expected]) => hash(await readFile(path)) === expected,
              ),
            )
          ).every(Boolean)
        )
          result = prior.result;
      } catch {
        /* A missing, stale, unreadable or malformed cache never bypasses validation. */
      }
    }
    if (!result) {
      const checked = await validate(plan);
      if (!checked.ok) return checked;
      if (checked.kind !== 'workflow.validate.result')
        throw new Error('Definition registry expected a validation result.');
      result = checked;
      try {
        const sources = await cacheSources(plan, result);
        await mkdir(root, { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ version: 2, engine, plan, sources, result }), {
          mode: 0o600,
          flag: 'wx',
        });
        await rename(temporary, path);
      } catch {
        /* Cache availability does not change the validated discovery result. */
      }
    }
    const previous = names.get(result.workflow.name);
    if (previous)
      throw new Error(
        `Duplicate workflow name ${result.workflow.name}: ${previous} and ${entrypoint}. Choose directories with unique definition names.`,
      );
    names.set(result.workflow.name, entrypoint);
    definitions.push(result);
  }
  return { kind: 'workflow.list-defs.result', ok: true, definitions };
}
