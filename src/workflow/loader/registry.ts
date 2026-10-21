import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
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
import type { PackageSelection, ValidatedWorkflow, WorkflowCommandResult } from './model.js';
import { packageFiles } from '../package/files.js';
import { analyzePackagePath } from '../package/plan.js';
import { workflowLaunch } from './source.js';
import { promptRootFiles, promptRoots } from '../prompts/check.js';

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
    prompts: z.array(
      z.object({
        root: z.string(),
        entries: z.array(
          z.object({
            name: z.string(),
            file: z.string(),
            description: z.string().nullable(),
            variables: z.array(z.string()),
            warnings: z.array(z.string()),
          }),
        ),
      }),
    ),
    children: z.array(metadata),
    recursive: z.boolean(),
    entrypoint: z.string().nullable(),
  }),
) as z.ZodType<WorkflowDescription>;
const validation = z.object({
  kind: z.literal('workflow.validate.result'),
  ok: z.literal(true),
  entrypoint: z.string(),
  package: z
    .object({
      root: z.string(),
      name: z.string(),
      version: z.string(),
      description: z.string().nullable(),
      whenToUse: z.string().nullable(),
    })
    .exactOptional(),
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
// keyed on the version string alone are revalidated and rewritten. Version 6 (#581): results gain
// the checked `prompts` section and entries list every file under each prompt root as a source, so
// a template edit invalidates them; version 5 entries have neither and are revalidated. Version 7
// (#581): prompt-root files move to `promptSources`, fingerprinted by real path as well as bytes, so
// a file symlink retargeted to identical contents elsewhere revalidates; version 6 entries hashed
// bytes alone and are revalidated. Version 8 (#585): an entry is a loose definition file or a whole
// `*.quiet-choir` package, holding `results` (one per declared workflow, with the package summary)
// and `packageFiles`, the walked files of the package (null for a loose file); a package entry is
// served only while the walk lists exactly those files, and its sources include every one of them.
// Version 7 entries hold a single `result` and are revalidated.
const cache = z.object({
  version: z.literal(8),
  engine: z.string(),
  plan: z.json(),
  sources: z.record(z.string(), z.string()),
  promptSources: z.record(z.string(), z.string()),
  packageFiles: z.array(z.string()).nullable(),
  results: z.array(validation),
});
const definitionFile = /\.workflow\.(?:ts|mts|cts)$/u;
/** A package directory name: a nonempty stem, so the bare `.quiet-choir` state directory never matches. */
const packageDirectory = /^.+\.quiet-choir$/iu;
const ignored = new Set(['node_modules', '.git', '.quiet-choir', '.context', 'dist', 'coverage']);

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A prompt-root file's fingerprint: its real path and its bytes. A render reads a template through
 * its links and the loader refuses one that resolves outside the root, so a link retargeted to an
 * identical file elsewhere (even outside the root) must revalidate.
 */
async function promptSourceHash(file: string): Promise<string> {
  const real = await realpath(file);
  return createHash('sha256')
    .update(real)
    .update('\0')
    .update(await readFile(real))
    .digest('hex');
}

/** Whether every recorded fingerprint still matches; a missing or unreadable file never does. */
async function sourcesMatch(
  recorded: Readonly<Record<string, string>>,
  fingerprint: (path: string) => Promise<string>,
): Promise<boolean> {
  return (
    await Promise.all(
      Object.entries(recorded).map(
        async ([path, expected]) => (await fingerprint(path)) === expected,
      ),
    )
  ).every(Boolean);
}

/** What {@link discoverDefinitions} finds: loose definition files and package directories. @internal */
export interface DiscoveredDefinitions {
  /** Real paths of `*.workflow.ts`, `.mts` and `.cts` files outside packages, sorted. */
  readonly files: readonly string[];
  /** Real paths of `<stem>.quiet-choir` package directories, sorted. */
  readonly packages: readonly string[];
}

/**
 * Deterministic discovery of `*.workflow.ts`, `.mts` and `.cts` files (never `.d.ts` or `.tsx`)
 * and of `<stem>.quiet-choir` package directories (ADR 0065 section 3), including a given directory
 * that is itself one. A package is one artifact, so its contents are not scanned for loose files,
 * and a root inside a discovered package lists none of its files as loose definitions; symlink
 * directories are not followed and overlapping roots deduplicate. @internal
 */
export async function discoverDefinitions(
  directories: readonly string[],
): Promise<DiscoveredDefinitions> {
  const files = new Set<string>();
  const packages = new Set<string>();
  const seen = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    const canonical = await realpath(directory);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    if (packageDirectory.test(basename(canonical))) {
      packages.add(canonical);
      return;
    }
    for (const entry of await readdir(canonical, { withFileTypes: true })) {
      if (entry.isDirectory() && !ignored.has(entry.name)) await visit(join(canonical, entry.name));
      else if (entry.isFile() && definitionFile.test(entry.name))
        files.add(join(canonical, entry.name));
    }
  };
  for (const directory of directories) await visit(resolve(directory));
  // A root inside a package another root discovered reaches the package's own files; they belong
  // to the package, whichever order the roots come in.
  const loose = [...files].filter(
    (file) => ![...packages].some((pkg) => file === pkg || file.startsWith(pkg + sep)),
  );
  return { files: loose.sort(), packages: [...packages].sort() };
}

/** The loose definition files {@link discoverDefinitions} finds. @internal */
export async function definitionFiles(directories: readonly string[]): Promise<string[]> {
  return [...(await discoverDefinitions(directories)).files];
}

/**
 * The name `list-defs` lists and by-name dispatch matches: `<package>/<workflow>` for a package's
 * workflow, the workflow name for a loose definition. @internal
 */
export function listingName(definition: ValidatedWorkflow): string {
  return definition.package === undefined
    ? definition.workflow.name
    : `${definition.package.name}/${definition.workflow.name}`;
}

/**
 * Select a listed definition by name (ADR 0065 section 3): an exact listing name wins, so a loose
 * `main` stays runnable beside `demo/main`; otherwise a bare name matches the package workflows of
 * that name and must match exactly one. @internal
 * @throws Error - `Unknown workflow name` when nothing matches, or an ambiguity error naming every
 *   qualified match.
 */
export function selectDefinition(
  definitions: readonly ValidatedWorkflow[],
  name: string,
): ValidatedWorkflow {
  const exact = definitions.find((definition) => listingName(definition) === name);
  if (exact !== undefined) return exact;
  const bare = definitions.filter(
    (definition) => definition.package !== undefined && definition.workflow.name === name,
  );
  const [only, ...others] = bare;
  if (only === undefined)
    throw new Error(
      `Unknown workflow name ${name}: no listed definition or package workflow has that name (the argument was treated as a registered name); search directories with workflow list-defs or supply --registry-dir DIR.`,
    );
  if (others.length > 0)
    throw new Error(
      `Workflow name ${name} is ambiguous: ${bare.map(listingName).join(', ')}; use <package>/<workflow>.`,
    );
  return only;
}

/**
 * Whether the files now under the prompt roots of every cached result are exactly those the entry
 * recorded, so a file added or removed (or a root that appeared) is a cache miss even when every
 * recorded file is unchanged. Both sides use {@link promptRootFiles}' path form.
 */
function promptFilesMatch(
  recorded: Readonly<Record<string, string>>,
  results: readonly ValidatedWorkflow[],
): boolean {
  const current = new Set(
    results.flatMap((result) => promptRoots(result.workflow).flatMap(promptRootFiles)),
  );
  const prior = Object.keys(recorded);
  return current.size === prior.length && prior.every((file) => current.has(file));
}

async function cacheSources(
  plan: TypecheckPlan,
  result: ValidatedWorkflow,
): Promise<{ sources: Record<string, string>; promptSources: Record<string, string> }> {
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
  // Templates are read at validation, not compiled, so every file under a declared prompt root
  // is a source too (ADR 0064 section 4 makes the same set an execution dependency).
  const promptSources: Record<string, string> = {};
  for (const root of promptRoots(result.workflow))
    for (const file of promptRootFiles(root)) promptSources[file] = await promptSourceHash(file);
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
  return { sources, promptSources };
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

/** Whether two path lists hold the same paths. */
function samePaths(recorded: readonly string[], current: readonly string[]): boolean {
  const set = new Set(current);
  return recorded.length === set.size && recorded.every((path) => set.has(path));
}

/**
 * Source-validated metadata cache; execution always imports and checks the selected workflow anew.
 * Loose definition files and `*.quiet-choir` packages are listed together, sorted by file path or
 * package root and, inside a package, in declaration order; listing names must be unique. @internal
 */
export async function listDefinitions(
  directories: readonly string[],
  /**
   * Validate one definition file, or (with `pkg`) every workflow of a package, which returns a
   * `workflow.list-defs.result`; execution passes durabilityLint 'warn', so findings only log.
   */
  validate: (plan: TypecheckPlan, pkg?: PackageSelection) => Promise<WorkflowCommandResult>,
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
  const discovered = await discoverDefinitions(directories);
  const entries = [
    ...discovered.files.map((path) => ({ kind: 'file' as const, path })),
    ...discovered.packages.map((path) => ({ kind: 'package' as const, path })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of entries) {
    let plan: TypecheckPlan;
    let selection: PackageSelection | undefined;
    let walked: string[] | null = null;
    if (entry.kind === 'file') {
      const analyzed = analyzeTypecheckEntrypoint(entry.path, process.cwd());
      if (!analyzed.ok) throw new Error(analyzed.error.message);
      plan = analyzed.plan;
    } else {
      const analyzed = analyzePackagePath(entry.path, process.cwd());
      if (!analyzed.ok) throw new Error(analyzed.error.message);
      plan = analyzed.typecheck;
      selection = { ...analyzed.package, workflow: null };
      walked = (await packageFiles(entry.path)).map((file) => file.path);
    }
    const path = join(
      root,
      `${digest({ entrypoint: plan.entrypoint, configuration: plan.configuration })}.json`,
    );
    let results: ValidatedWorkflow[] | undefined;
    if (!refresh && engine !== undefined) {
      try {
        const prior = cache.parse(JSON.parse(await readFile(path, 'utf8')));
        if (
          prior.engine === engine &&
          digest(prior.plan) === digest(plan) &&
          prior.results.length > 0 &&
          (walked === null
            ? prior.packageFiles === null &&
              prior.results.length === 1 &&
              prior.results.every((result) => result.entrypoint === entry.path)
            : prior.packageFiles !== null && samePaths(prior.packageFiles, walked)) &&
          Object.keys(prior.sources).length > 0 &&
          (await sourcesMatch(prior.sources, async (path) => hash(await readFile(path)))) &&
          promptFilesMatch(prior.promptSources, prior.results) &&
          (await sourcesMatch(prior.promptSources, promptSourceHash))
        )
          results = prior.results;
      } catch {
        /* A missing, stale, unreadable or malformed cache never bypasses validation. */
      }
    }
    if (!results) {
      const checked = await validate(plan, selection);
      if (!checked.ok) return checked;
      if (selection === undefined) {
        if (checked.kind !== 'workflow.validate.result')
          throw new Error('Definition registry expected a validation result.');
        // Drop the (empty) lint diagnostics, so a fresh entry equals one read from the cache.
        results = [
          {
            kind: checked.kind,
            ok: checked.ok,
            entrypoint: checked.entrypoint,
            workflow: checked.workflow,
          },
        ];
      } else {
        if (checked.kind !== 'workflow.list-defs.result')
          throw new Error('Definition registry expected a package listing.');
        results = [...checked.definitions];
      }
      if (engine !== undefined)
        try {
          const sources: Record<string, string> = {};
          const promptSources: Record<string, string> = {};
          for (const result of results) {
            const fingerprints = await cacheSources(plan, result);
            Object.assign(sources, fingerprints.sources);
            Object.assign(promptSources, fingerprints.promptSources);
          }
          await mkdir(root, { recursive: true, mode: 0o700 });
          const temporary = `${path}.${randomUUID()}.tmp`;
          await writeFile(
            temporary,
            JSON.stringify({
              version: 8,
              engine,
              plan,
              sources,
              promptSources,
              packageFiles: walked,
              results,
            }),
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
    for (const result of results) {
      const name = listingName(result);
      const previous = names.get(name);
      if (previous)
        throw new Error(
          `Duplicate workflow name ${name}: ${previous} and ${result.entrypoint}. Choose directories with unique definition names.`,
        );
      names.set(name, result.entrypoint);
      definitions.push(result);
    }
  }
  return { kind: 'workflow.list-defs.result', ok: true, definitions };
}
