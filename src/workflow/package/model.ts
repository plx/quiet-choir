import type { WorkflowDeclaration } from '../runtime/child-model.js';
import type { AnyPromptSet } from '../runtime/model.js';

// ADR 0065 section 1. The package manifest types. This module is pure: the loader imports the
// manifest and reads its value by brand, and no core module imports it.

/**
 * The fields a `package.ts` manifest passes to {@link definePackage} (ADR 0065 section 1).
 */
export interface PackageOptions {
  /**
   * The package directory: `import.meta.dirname` in an ESM manifest (`__dirname` in a CommonJS
   * one), or a `file:` URL of it. It must be absolute, and the loader refuses a manifest whose root
   * is not the directory it was imported from.
   */
  readonly root: string | URL;
  /** Package name: a lowercase letter, then up to 63 lowercase letters, digits or hyphens. */
  readonly name: string;
  /** Explicit package version, a nonempty string like a workflow's `version`. */
  readonly version: string;
  /** Human purpose of the package, outside replay identity. */
  readonly description?: string;
  /** Guidance for choosing this package, outside replay identity. */
  readonly whenToUse?: string;
  /**
   * The package's workflows: imported `defineWorkflow` definitions with unique names. Each one must
   * be the default export of a TypeScript module under the package root.
   */
  readonly workflows: readonly WorkflowDeclaration[];
  /** The workflow `workflow execute <dir>` runs without `--workflow`; one of `workflows`. */
  readonly entry?: WorkflowDeclaration;
  /**
   * Prompt sets (`definePrompts` results) declared once for the package. The loader runs their
   * load-time checks (ADR 0064 section 3) and fingerprints their roots, as for a workflow's own
   * `prompts`.
   */
  readonly prompts?: readonly AnyPromptSet[];
}

/**
 * A validated, frozen package manifest: the default export of a `*.quiet-choir` directory's
 * `package.ts` (ADR 0065 section 1). The loader recognizes it by a registry-symbol brand, so a
 * manifest built by a project's own copy of quiet-choir is read like one built by the CLI's.
 */
export interface WorkflowPackage {
  /** The absolute package directory. */
  readonly root: string;
  /** Package name. */
  readonly name: string;
  /** Package version. */
  readonly version: string;
  /** Human purpose, or null. */
  readonly description: string | null;
  /** Selection guidance, or null. */
  readonly whenToUse: string | null;
  /** The declared workflows, in declaration order (a frozen copy). */
  readonly workflows: readonly WorkflowDeclaration[];
  /** The entry workflow, or null when the package declares none. */
  readonly entry: WorkflowDeclaration | null;
  /** The package-level prompt sets (a frozen copy, empty when none were declared). */
  readonly prompts: readonly AnyPromptSet[];
  /**
   * The absolute path of a file under `<root>/resources/`. The path is resolved lexically, without
   * touching the disk, so it works while modules initialize.
   *
   * @param relativePath - A nonempty relative path that stays inside `resources/`.
   * @returns `<root>/resources/<relativePath>`, normalized.
   * @throws TypeError - When the path is empty, absolute, or leaves `resources/`.
   */
  resource(relativePath: string): string;
}
