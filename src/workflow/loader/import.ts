import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, extname, relative, sep } from 'node:path';
import ts from 'typescript';
import { register as registerEsm } from 'tsx/esm/api';
import { register as registerCommonJs } from 'tsx/cjs/api';
import { checkedDefinition } from '../runtime/definition.js';
import type { WorkflowDefinition } from '../runtime/model.js';
import type { WorkflowDeclaration } from '../runtime/child-model.js';
import { packageOf } from '../package/index.js';
import type { WorkflowPackage } from '../package/model.js';
import {
  TYPESCRIPT_DECLARATION_EXTENSIONS,
  TYPESCRIPT_SOURCE_EXTENSIONS,
  type TypecheckPlan,
} from '../typecheck/model.js';

/** Distinguish invalid exports from failures while importing trusted code. @internal */
export class WorkflowDefinitionError extends Error {
  public constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'WorkflowDefinitionError';
  }
}

/**
 * A package without a workflow to run (`package_workflow_required`: no `entry` and no
 * `--workflow`) or with an unknown `--workflow` (`package_workflow_unknown`); the executor reports
 * it as `usage.entrypoint` with the declared names. @internal
 */
export class PackageSelectionError extends Error {
  public readonly reason: 'package_workflow_required' | 'package_workflow_unknown';
  public readonly workflows: readonly string[];

  public constructor(
    message: string,
    reason: 'package_workflow_required' | 'package_workflow_unknown',
    workflows: readonly string[],
  ) {
    super(message);
    this.name = 'PackageSelectionError';
    this.reason = reason;
    this.workflows = workflows;
  }
}

/**
 * One tsx loader in a fresh namespace for the entrypoint's module format: `require` for CommonJS,
 * `import` (with a CommonJS registration in the same namespace, as `tsImport` does) otherwise. ESM
 * loads through it share one module cache, so a module the entrypoint already evaluated is
 * returned, not run again. CommonJS modules a required entrypoint reaches are cached by file
 * outside the namespace, so a later `require` in it may evaluate a module again; `exporters`
 * instead finds the cached modules whose default export is a given value. Every load, ESM or
 * CommonJS, first drops the cached CommonJS modules under the entrypoint's directory (outside
 * `node_modules`), so it re-evaluates the package's or workflow's own modules rather than reusing
 * ones an earlier load in this process evaluated before an edit; an ESM manifest can import
 * `.cts` workflows that live in that cache. `dispose` unregisters the CommonJS loader; the ESM hooks
 * stay registered, as with `tsImport`, because trusted code may still import lazily.
 */
function namespacedLoader(plan: TypecheckPlan): {
  readonly load: (path: string) => Promise<unknown>;
  readonly exporters?: (value: unknown) => string[];
  readonly dispose?: () => void;
} {
  const format = ts.getImpliedNodeFormatForFile(plan.entrypoint, undefined, ts.sys, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const namespace = randomUUID();
  if (format === ts.ModuleKind.CommonJS) {
    const registered = registerCommonJs({ namespace });
    return {
      load: (path) => {
        evictCommonJsModules(dirname(realpathSync(plan.entrypoint)));
        return Promise.resolve(registered.require(path, import.meta.url) as unknown);
      },
      exporters: (value) =>
        Object.values(createRequire(import.meta.url).cache).flatMap((module) =>
          module === undefined || defaultExport(module.exports) !== value
            ? []
            : [withoutNamespace(module.filename)],
        ),
      dispose: registered.unregister,
    };
  }
  registerCommonJs({ namespace });
  const registered = registerEsm({
    namespace,
    ...(plan.configuration.kind === 'tsconfig' ? { tsconfig: plan.configuration.path } : {}),
  });
  return {
    load: (path) => {
      evictCommonJsModules(dirname(realpathSync(plan.entrypoint)));
      return registered.import(path, import.meta.url) as Promise<unknown>;
    },
  };
}

/** A CommonJS cache key without the `?namespace=<id>` query tsx adds to a namespaced module. */
function withoutNamespace(filename: string): string {
  const query = filename.indexOf('?', filename.lastIndexOf(sep) + 1);
  return query === -1 ? filename : filename.slice(0, query);
}

/**
 * Drop from `require`'s cache every module whose real path lies under `directory` and outside a
 * `node_modules` directory there, so the next `require` evaluates the current source. It runs
 * synchronously, right before the synchronous `require` that loads the entrypoint.
 */
function evictCommonJsModules(directory: string): void {
  const cache = createRequire(import.meta.url).cache;
  for (const key of Object.keys(cache)) {
    const file = withoutNamespace(key);
    let real: string;
    try {
      real = realpathSync(file);
    } catch {
      real = file;
    }
    if (isInside(directory, real) && !relative(directory, real).split(sep).includes('node_modules'))
      Reflect.deleteProperty(cache, key);
  }
}

function defaultExport(module: unknown): unknown {
  return module !== null && typeof module === 'object' ? Reflect.get(module, 'default') : undefined;
}

/**
 * Whether a loaded module default-exports `selected`. A CommonJS module imported through an ESM
 * manifest arrives by default interop, so its `exports.default` is one level further down.
 */
function exportsWorkflow(module: unknown, selected: unknown): boolean {
  const value = defaultExport(module);
  return (
    value === selected ||
    (value !== null && typeof value === 'object' && defaultExport(value) === selected)
  );
}

/** Import already type-checked, trusted workflow code, preserving the CommonJS loader until disposed. @internal */
export async function importWorkflow(
  plan: TypecheckPlan,
): Promise<{ definition: WorkflowDefinition<unknown, unknown>; dispose?: () => void }> {
  const loader = namespacedLoader(plan);
  try {
    const definition = defaultExport(await loader.load(plan.entrypoint));
    try {
      if (packageOf(definition) !== undefined)
        throw new Error(
          `${plan.entrypoint} is a package manifest; pass its .quiet-choir directory instead.`,
        );
      if (definition === null || typeof definition !== 'object')
        throw new Error(
          'Workflow must default-export a defineWorkflow({ name, version, input, output, run }) definition.',
        );
      return {
        definition: checkedDefinition(definition) as unknown as WorkflowDefinition<
          unknown,
          unknown
        >,
        ...(loader.dispose === undefined ? {} : { dispose: loader.dispose }),
      };
    } catch (cause) {
      throw new WorkflowDefinitionError(cause);
    }
  } catch (cause) {
    loader.dispose?.();
    throw cause;
  }
}

/** A package imported by {@link importPackage}. @internal */
export interface ImportedPackage {
  readonly package: WorkflowPackage;
  /** The selected workflow, or null when the import selected none (`select: false`). */
  readonly selected: {
    readonly definition: WorkflowDefinition<unknown, unknown>;
    /** Real path of the TypeScript module that default-exports `definition`. */
    readonly modulePath: string;
  } | null;
  /**
   * Real module paths by workflow name: the selected workflow's alone, or every declared
   * workflow's under `every`, in declaration order.
   */
  readonly modules: ReadonlyMap<string, string>;
  readonly dispose?: () => void;
}

/** What {@link importPackage} selects and resolves. @internal */
export interface PackageImportOptions {
  /** The workflow to select; null selects the package's `entry`. */
  readonly workflow: string | null;
  /**
   * Whether to select a workflow (default true). The registry passes false: it lists every
   * workflow, so a package without `entry` needs no selection.
   */
  readonly select?: boolean;
  /** Resolve the module of every declared workflow, not only the selected one (validate). */
  readonly every?: boolean;
}

function isInside(root: string, path: string): boolean {
  const inside = relative(root, path);
  return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`);
}

function isTypeScriptModule(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    TYPESCRIPT_SOURCE_EXTENSIONS.some((extension) => extension === extname(lower)) &&
    !TYPESCRIPT_DECLARATION_EXTENSIONS.some((extension) => lower.endsWith(extension))
  );
}

/**
 * Import a type-checked package manifest (ADR 0065 section 2): read its `definePackage` value by
 * brand, refuse a declared root that is not the manifest's own directory (compared by real path),
 * select the requested workflow (else `entry`), and find the module under the root that
 * default-exports that same definition object. Candidates are the compiler's TypeScript sources
 * under the root (`sourceFiles`), `workflows/` first, imported through the manifest's loader, so a
 * module the manifest already evaluated is not run again. With `every`, the module of every
 * declared workflow is resolved the same way (the first candidate that default-exports each one),
 * loading candidates only until every definition is matched; a workflow without one fails as
 * `load.definition` even when another one is selected. @internal
 */
export async function importPackage(
  plan: TypecheckPlan,
  sourceFiles: readonly string[],
  options: PackageImportOptions,
): Promise<ImportedPackage> {
  const loader = namespacedLoader(plan);
  try {
    const value = defaultExport(await loader.load(plan.entrypoint));
    const manifestDirectory = await realpath(dirname(plan.entrypoint));
    const manifest = await realpath(plan.entrypoint);
    let pkg: WorkflowPackage;
    try {
      const found = packageOf(value);
      if (found === undefined)
        throw new Error(
          `Package manifest ${plan.entrypoint} must default-export definePackage({ root, name, version, workflows }).`,
        );
      pkg = found;
      const declared = await realpath(pkg.root).catch(() => pkg.root);
      if (declared !== manifestDirectory)
        throw new Error(
          `Package ${pkg.name} declares root ${pkg.root}, but its manifest is in ${manifestDirectory}; pass root: import.meta.dirname.`,
        );
    } catch (cause) {
      throw new WorkflowDefinitionError(cause);
    }
    const names = pkg.workflows.map((workflow) => workflow.name);
    let selected: WorkflowDeclaration | undefined;
    if (options.select !== false) {
      const name = options.workflow ?? pkg.entry?.name ?? null;
      if (name === null)
        throw new PackageSelectionError(
          `Package ${pkg.name} declares no entry; choose a workflow with --workflow: ${names.join(', ')}.`,
          'package_workflow_required',
          names,
        );
      selected = pkg.workflows.find((workflow) => workflow.name === name);
      if (selected === undefined)
        throw new PackageSelectionError(
          `Package ${pkg.name} declares no workflow ${name}; its workflows are ${names.join(', ')}.`,
          'package_workflow_unknown',
          names,
        );
    }
    const wanted: readonly WorkflowDeclaration[] =
      options.every === true ? pkg.workflows : selected === undefined ? [] : [selected];
    const candidates = (
      await Promise.all(
        sourceFiles.map(async (file) => (isTypeScriptModule(file) ? await realpath(file) : null)),
      )
    )
      .filter(
        (file): file is string =>
          file !== null && file !== manifest && isInside(manifestDirectory, file),
      )
      .map((file) => ({
        file,
        rank: relative(manifestDirectory, file).startsWith(`workflows${sep}`) ? 0 : 1,
      }))
      .sort((a, b) => a.rank - b.rank || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
      .map((candidate) => candidate.file);
    const found = new Map<WorkflowDeclaration, string>();
    if (loader.exporters) {
      for (const workflow of wanted) {
        const exporting = new Set(
          await Promise.all(
            loader.exporters(workflow).map((file) => realpath(file).catch(() => file)),
          ),
        );
        const modulePath = candidates.find((candidate) => exporting.has(candidate));
        if (modulePath !== undefined) found.set(workflow, modulePath);
      }
    } else
      for (const candidate of [...new Set(candidates)]) {
        if (found.size === wanted.length) break;
        const module = await loader.load(candidate);
        for (const workflow of wanted)
          if (!found.has(workflow) && exportsWorkflow(module, workflow))
            found.set(workflow, candidate);
      }
    const modules = new Map<string, string>();
    for (const workflow of wanted) {
      const modulePath = found.get(workflow);
      if (modulePath === undefined)
        throw new WorkflowDefinitionError(
          `Package ${pkg.name}: no TypeScript module under ${manifestDirectory} default-exports workflow ${workflow.name}. Each workflow must be the default export of its own .ts, .mts or .cts module in the package, because the run records that module as its entrypoint.`,
        );
      modules.set(workflow.name, modulePath);
    }
    const selectedPath = selected === undefined ? undefined : modules.get(selected.name);
    return {
      package: pkg,
      selected:
        selected === undefined || selectedPath === undefined
          ? null
          : {
              definition: selected as unknown as WorkflowDefinition<unknown, unknown>,
              modulePath: selectedPath,
            },
      modules,
      ...(loader.dispose === undefined ? {} : { dispose: loader.dispose }),
    };
  } catch (cause) {
    loader.dispose?.();
    throw cause;
  }
}
