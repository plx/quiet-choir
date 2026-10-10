import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
import type { WorkflowDescription } from '../runtime/child-model.js';
import { capabilityManifestSchema } from '../runtime/profiles.js';
import { engineInfo, recordedEngine } from '../runtime/engine.js';
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
// Version 3: validate results saved by version 2 hold plaintext settings, MCP servers and prompts
// (#103); they are never served and are rewritten with the redacted manifest. Version 4: version 3
// results may hold plaintext registered harness options now listed in sensitiveOptions (#247).
// Version 5 (#345): entries are keyed on the engine code and toolchain digest; version 4 entries
// keyed on the version string alone are revalidated and rewritten.
const cache = z.object({
  version: z.literal(5),
  engine: z.string(),
  plan: z.json(),
  sources: z.record(z.string(), z.string()),
  result: validation,
});
const definitionFile = /\.workflow\.(?:ts|mts|cts)$/u;
const ignored = new Set(['node_modules', '.git', '.quiet-choir', '.context', 'dist', 'coverage']);

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Deterministic discovery of `*.workflow.ts`, `.mts` and `.cts` files (never `.d.ts` or `.tsx`); symlink directories are not followed and overlapping roots deduplicate. @internal */
export async function definitionFiles(directories: readonly string[]): Promise<string[]> {
  const files = new Set<string>();
  const seen = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    const canonical = await realpath(directory);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    for (const entry of await readdir(canonical, { withFileTypes: true })) {
      if (entry.isDirectory() && !ignored.has(entry.name)) await visit(join(canonical, entry.name));
      else if (entry.isFile() && definitionFile.test(entry.name))
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

const engineExtensions = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json']);

/**
 * Digest of the engine's own code: every regular `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs` and
 * `.json` file (declaration files included) under `root`, keyed by relative path (`digest` sorts keys). Source maps
 * and symlinks are skipped. @internal
 */
export async function engineCodeDigest(root: string): Promise<string> {
  const files: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && engineExtensions.has(extname(entry.name)))
        files[relative(root, path).split('\\').join('/')] = hash(await readFile(path));
    }
  };
  await visit(root);
  return digest(files);
}

let engineKeyMemo: Promise<string> | undefined;

/**
 * The cache key for what validates a definition: the engine version, Node major, a digest of the
 * running engine modules (`src/` under tsx or vitest, `dist/` in a build) and the TypeScript, zod
 * and tsx versions. Validation rules live in that code, so any change revalidates every entry.
 * Computed once per process; `undefined` when it cannot be computed, so the cache is bypassed. The
 * walked root follows this file's location (two directories up).
 */
async function engineKey(): Promise<string | undefined> {
  try {
    engineKeyMemo ??= engineCodeDigest(fileURLToPath(new URL('../../', import.meta.url))).then(
      (code) => {
        const { zod, tsx } = recordedEngine();
        return digest({
          quietChoir: engineInfo.version,
          node: process.versions.node.split('.')[0] ?? 'unknown',
          code,
          typescript: ts.version,
          zod,
          tsx,
        });
      },
    );
    return await engineKeyMemo;
  } catch {
    engineKeyMemo = undefined;
    return undefined;
  }
}

/** Source-validated metadata cache; execution always imports and checks the selected workflow anew. @internal */
export async function listDefinitions(
  directories: readonly string[],
  /** Validate one definition; execution passes durabilityLint 'warn', so findings only log. */
  validate: (plan: TypecheckPlan) => Promise<WorkflowCommandResult>,
  options: {
    refresh?: boolean;
    /** Override the computed engine key, so a test can change the validation digest. */
    engine?: string;
  } = {},
): Promise<WorkflowCommandResult> {
  const refresh = options.refresh ?? false;
  // Without a key nothing is read or written: every definition validates.
  const engine = options.engine ?? (await engineKey());
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
    let result: ValidatedWorkflow | undefined;
    if (!refresh && engine !== undefined) {
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
      // Drop the (empty) lint diagnostics, so a fresh entry equals one read from the cache.
      result = {
        kind: checked.kind,
        ok: checked.ok,
        entrypoint: checked.entrypoint,
        workflow: checked.workflow,
      };
      if (engine !== undefined)
        try {
          const sources = await cacheSources(plan, result);
          await mkdir(root, { recursive: true, mode: 0o700 });
          const temporary = `${path}.${randomUUID()}.tmp`;
          await writeFile(
            temporary,
            JSON.stringify({ version: 5, engine, plan, sources, result }),
            {
              mode: 0o600,
              flag: 'wx',
            },
          );
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
