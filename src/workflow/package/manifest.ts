import type { PromptSetCheck } from '../prompts/check.js';
import { promptSetDescriptor, type PromptSetDescriptor } from '../prompts/prompt.js';
import type { WorkflowDeclaration, WorkflowDescription } from '../runtime/child-model.js';
import type { JsonValue } from '../runtime/model.js';
import type { AccessClass, ResolvedProfile } from '../runtime/profiles-model.js';
import { packageFilesDigest, type HashedPackageFile } from './files.js';
import type { WorkflowPackage } from './model.js';

// ADR 0065 section 5: the `package` section of `workflow validate --json` for a package. This
// module is pure: the executor imports the manifest, describes every declared workflow, checks the
// package's prompt sets and walks the files, and this builds the plain-data section from them.

/** The package fields `list-defs` shows beside each of a package's workflows. @internal */
export interface PackageListing {
  /** The package directory. */
  readonly root: string;
  /** Package name. */
  readonly name: string;
  /** Package version. */
  readonly version: string;
  /** Human purpose, or null. */
  readonly description: string | null;
  /** Selection guidance, or null. */
  readonly whenToUse: string | null;
}

/** One roster entry of a workflow, as the package section summarizes it. @internal */
export interface PackageRosterEntry {
  /** Entry name. */
  readonly name: string;
  /** The harness the entry is pinned to. */
  readonly harness: string;
  /** The pinned harness's inferred access. */
  readonly access: AccessClass;
  /** The model the entry sets for its harness, or null. */
  readonly model: string | null;
  /** The entry's description, or null. */
  readonly description: string | null;
}

/** One declared workflow in the package section. @internal */
export interface PackageWorkflowSummary {
  /** Workflow name. */
  readonly name: string;
  /** Workflow version. */
  readonly version: string;
  /** Human purpose, or null. */
  readonly description: string | null;
  /** Selection guidance, or null. */
  readonly whenToUse: string | null;
  /** Real path of the module that default-exports the workflow. */
  readonly entrypoint: string;
  /** Published input JSON Schema. */
  readonly inputSchema: JsonValue;
  /** The workflow's roster entries (manifest profiles pinned to a harness), in key order. */
  readonly roster: readonly PackageRosterEntry[];
}

/** One prompt set of the package's prompt inventory. @internal */
export interface PackagePromptSet {
  /** Absolute template root. */
  readonly root: string;
  /** The set's prompts, in declaration order. */
  readonly entries: readonly {
    /** Prompt name. */
    readonly name: string;
    /** Template file, relative to the root. */
    readonly file: string;
    /** The entry's description, else its front matter description, else null. */
    readonly description: string | null;
    /** The keys of the entry's params schema, sorted. */
    readonly params: readonly string[];
    /** Top-level variables the template reads, sorted. */
    readonly variables: readonly string[];
  }[];
}

/** The `package` section of `workflow validate --json` for a package (ADR 0065 section 5). @internal */
export interface PackageManifestSection extends PackageListing {
  /** The entry workflow's name, or null. */
  readonly entry: string | null;
  /** Every declared workflow, in declaration order. */
  readonly workflows: readonly PackageWorkflowSummary[];
  /**
   * The package's prompt sets and every set in each workflow's static tree, one per root in
   * first-seen order (package sets first).
   */
  readonly prompts: readonly PackagePromptSet[];
  /**
   * The walked files under the root (not `node_modules/` or `.git/`): their count, total bytes and
   * a digest over root-relative paths and contents, independent of where the package sits.
   */
  readonly files: { readonly count: number; readonly bytes: number; readonly sha256: string };
}

/** The listing summary of a package. @internal */
export function packageListing(pkg: WorkflowPackage): PackageListing {
  return {
    root: pkg.root,
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    whenToUse: pkg.whenToUse,
  };
}

function modelOf(profile: ResolvedProfile, harness: string): string | null {
  const options: unknown =
    harness === 'claude'
      ? profile.claude
      : harness === 'codex'
        ? profile.codex
        : profile.harnesses?.[harness];
  const model: unknown =
    typeof options === 'object' && options !== null ? Reflect.get(options, 'model') : undefined;
  return typeof model === 'string' ? model : null;
}

/** The roster entries of a description's manifest: the profiles pinned to a harness. @internal */
export function rosterSummary(description: WorkflowDescription): PackageRosterEntry[] {
  return Object.entries(description.capabilities.profiles).flatMap(([name, profile]) =>
    profile.harness === undefined
      ? []
      : [
          {
            name,
            harness: profile.harness,
            access: profile.access,
            model: modelOf(profile, profile.harness),
            description: profile.description ?? null,
          },
        ],
  );
}

/** One declared workflow with the description the loader computed for its module. @internal */
export interface DescribedPackageWorkflow {
  readonly definition: WorkflowDeclaration;
  readonly description: WorkflowDescription;
}

type PromptInventoryEntry = PackagePromptSet['entries'][number];

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Whether two inventory entries declare the same prompt: name, file, params and variables. */
function sameDeclaration(a: PromptInventoryEntry, b: PromptInventoryEntry): boolean {
  return (
    a.name === b.name &&
    a.file === b.file &&
    sameList(a.params, b.params) &&
    sameList(a.variables, b.variables)
  );
}

/**
 * Build the validate package section (ADR 0065 section 5) from the imported package, each declared
 * workflow's definition and description (in declaration order, `entrypoint` set to its module), the
 * checked package-level prompt sets (in the order of `pkg.prompts`) and the hashed walk. @internal
 */
export function packageManifestSection(
  pkg: WorkflowPackage,
  workflows: readonly DescribedPackageWorkflow[],
  packagePrompts: readonly PromptSetCheck[],
  files: readonly HashedPackageFile[],
): PackageManifestSection {
  const inventory = new Map<string, { readonly root: string; entries: PromptInventoryEntry[] }>();
  const add = (
    descriptor: PromptSetDescriptor | undefined,
    checked: PromptSetCheck | undefined,
  ) => {
    if (descriptor === undefined || checked === undefined) return;
    let set = inventory.get(checked.root);
    if (set === undefined) {
      set = { root: checked.root, entries: [] };
      inventory.set(checked.root, set);
    }
    for (const entry of checked.entries) {
      const params = descriptor.entries[entry.name]?.params;
      const listed = {
        name: entry.name,
        file: entry.file,
        description: entry.description,
        params: params === undefined ? [] : Object.keys(params.shape).sort(),
        variables: entry.variables,
      };
      // Two sets on one root can map a name to different files or params: list each declaration
      // once and keep the differing ones side by side.
      if (set.entries.some((known) => sameDeclaration(known, listed))) continue;
      set.entries.push(listed);
    }
  };
  pkg.prompts.forEach((set, index) => {
    add(promptSetDescriptor(set), packagePrompts[index]);
  });
  // A description lists each node's checked sets in the order of its definition's `prompts`, and
  // its children in the order of the definition's `children`, so the two trees walk together.
  const seen = new Set<WorkflowDeclaration>();
  const visit = (definition: WorkflowDeclaration, description: WorkflowDescription): void => {
    if (seen.has(definition)) return;
    seen.add(definition);
    (definition.prompts ?? []).forEach((set, index) => {
      add(promptSetDescriptor(set), description.prompts[index]);
    });
    if (description.recursive) return;
    (definition.children ?? []).forEach((child, index) => {
      const node = description.children[index];
      if (node !== undefined) visit(child, node);
    });
  };
  for (const workflow of workflows) visit(workflow.definition, workflow.description);
  return {
    ...packageListing(pkg),
    entry: pkg.entry?.name ?? null,
    workflows: workflows.map(({ description }) => ({
      name: description.name,
      version: description.version,
      description: description.description,
      whenToUse: description.whenToUse,
      entrypoint: description.entrypoint ?? '',
      inputSchema: description.inputSchema,
      roster: rosterSummary(description),
    })),
    prompts: [...inventory.values()].map((set) => ({ root: set.root, entries: set.entries })),
    files: packageFilesDigest(files),
  };
}
