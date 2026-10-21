import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { promptSetDescriptor } from '../prompts/prompt.js';
import type { WorkflowDeclaration } from '../runtime/child-model.js';
import { checkedDefinition } from '../runtime/definition.js';
import type { AnyPromptSet } from '../runtime/model.js';
import type { PackageOptions, WorkflowPackage } from './model.js';

// ADR 0065 section 1. `definePackage` validates its arguments without touching the disk; the
// loader (loader/import.ts) checks the declared root against the manifest's real directory, selects
// a workflow and runs the prompt checks of the package's own sets.

/**
 * Registry key of the package brand. A workflow imported through tsx carries its own copy of
 * quiet-choir (ADR 0028), so the loader reads the brand, never `instanceof`. @internal
 */
export const PACKAGE_BRAND: unique symbol = Symbol.for('quiet-choir.package');

/** The pattern a package name matches (ADR 0065 section 1). @internal */
export const PACKAGE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

const optionKeys: ReadonlySet<string> = new Set([
  'root',
  'name',
  'version',
  'description',
  'whenToUse',
  'workflows',
  'entry',
  'prompts',
]);

function packageError(message: string): never {
  throw new TypeError(`definePackage: ${message}`);
}

function fileRoot(root: string | URL): string {
  try {
    return resolve(fileURLToPath(root));
  } catch (error) {
    return packageError(
      `root ${JSON.stringify(String(root))} is not a valid file: URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function rootPath(root: unknown): string {
  if (root instanceof URL) {
    if (root.protocol !== 'file:')
      return packageError(`root must be a file: URL, not ${root.protocol}`);
    return fileRoot(root);
  }
  if (typeof root !== 'string' || root === '')
    return packageError(
      'root must be an absolute path or a file: URL, such as import.meta.dirname',
    );
  if (root.startsWith('file:')) return fileRoot(root);
  if (!isAbsolute(root))
    return packageError(
      `root ${JSON.stringify(root)} must be absolute, such as import.meta.dirname; a relative root would resolve against the current directory`,
    );
  return resolve(root);
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '')
    return packageError(`${field} must be a nonempty string when given`);
  return value;
}

function checkedWorkflows(value: unknown): readonly WorkflowDeclaration[] {
  if (!Array.isArray(value) || value.length === 0)
    return packageError('workflows must be a nonempty array of defineWorkflow definitions');
  const names = new Set<string>();
  return Object.freeze(
    (value as readonly unknown[]).map((workflow, index) => {
      if (workflow === undefined)
        return packageError(
          `workflows[${String(index)}] is undefined. A workflow module that imports package.ts forms an import cycle that leaves its definition unset while the manifest evaluates; import workflows from package.ts, never package.ts from a workflow.`,
        );
      let definition: WorkflowDeclaration;
      try {
        definition = checkedDefinition(workflow);
      } catch (error) {
        return packageError(
          `workflows[${String(index)}] is not a valid defineWorkflow definition: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (names.has(definition.name))
        return packageError(
          `workflows declares the workflow name ${JSON.stringify(definition.name)} twice; workflow names in a package must be unique`,
        );
      names.add(definition.name);
      return definition;
    }),
  );
}

function checkedPrompts(value: unknown): readonly AnyPromptSet[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value))
    return packageError('prompts must be an array of definePrompts(...) sets');
  (value as readonly unknown[]).forEach((set, index) => {
    if (promptSetDescriptor(set) === undefined)
      packageError(`prompts[${String(index)}] is not a definePrompts(...) set`);
  });
  return Object.freeze([...(value as readonly AnyPromptSet[])]);
}

/** `<root>/resources/<relativePath>`, refusing a path that is empty, absolute or escapes. */
function resourcePath(root: string, relativePath: unknown): string {
  if (typeof relativePath !== 'string' || relativePath === '')
    throw new TypeError('resource() needs a nonempty path relative to the resources/ directory.');
  if (isAbsolute(relativePath) || posix.isAbsolute(relativePath) || win32.isAbsolute(relativePath))
    throw new TypeError(
      `resource(${JSON.stringify(relativePath)}) must be relative to the resources/ directory, not absolute.`,
    );
  const base = join(root, 'resources');
  const path = resolve(base, relativePath);
  const inside = relative(base, path);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new TypeError(
      `resource(${JSON.stringify(relativePath)}) must name a file inside ${base}.`,
    );
  return path;
}

/**
 * Declare a workflow package: the default export of the `package.ts` manifest at the root of a
 * `<name>.quiet-choir` directory (ADR 0065 section 1). The manifest imports the package's workflow
 * definitions and lists them; `workflow execute <dir>.quiet-choir` runs `entry`, and
 * `--workflow <name>` selects another one. `validate`, `execute --dry-run` and `check-resume` take
 * the same forms, and a package run resumes by its run ID like any other.
 *
 * `definePackage` checks its arguments without touching the disk: `root` is absolute (pass
 * `import.meta.dirname`), `name` matches `/^[a-z][a-z0-9-]{0,63}$/`, `version` is a nonempty
 * string, `workflows` is a nonempty array of definitions with unique names, `entry` (when given)
 * is one of `workflows`, `prompts` (when given) holds only `definePrompts` sets, and no other key
 * is present. The loader then refuses a manifest whose `root` is not its own directory and runs
 * the prompt checks of `prompts`. See `docs/packages.md` for the layout and the CLI forms.
 *
 * Import workflows from the manifest, never the manifest from a workflow module: that cycle
 * leaves the definitions undefined while the manifest evaluates.
 *
 * @param options - The manifest fields.
 * @returns The frozen package, with `root` and `resource(relativePath)` usable at once.
 * @throws TypeError - When a field is invalid; the message names the field.
 */
export function definePackage(options: PackageOptions): WorkflowPackage {
  // Untyped callers (and JavaScript) can pass anything.
  const value: unknown = options;
  const prototype: unknown =
    typeof value === 'object' && value !== null
      ? (Object.getPrototypeOf(value) as unknown)
      : undefined;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  )
    return packageError('expects a plain object of package fields');
  for (const key of Reflect.ownKeys(options))
    if (typeof key !== 'string' || !optionKeys.has(key))
      packageError(
        `unknown key ${String(key)}; a package takes only ${[...optionKeys].join(', ')}`,
      );
  const root = rootPath(options.root);
  const name: unknown = options.name;
  if (typeof name !== 'string' || !PACKAGE_NAME_PATTERN.test(name))
    packageError(
      `name ${JSON.stringify(name)} must match /^[a-z][a-z0-9-]{0,63}$/: a lowercase letter, then up to 63 lowercase letters, digits or hyphens`,
    );
  const version: unknown = options.version;
  if (typeof version !== 'string' || version.trim() === '')
    packageError('version must be a nonempty string');
  const description = optionalText(options.description, 'description');
  const whenToUse = optionalText(options.whenToUse, 'whenToUse');
  const workflows = checkedWorkflows(options.workflows);
  const entry: unknown = options.entry;
  if (entry !== undefined && !workflows.includes(entry as WorkflowDeclaration))
    packageError(
      'entry must be one of the definitions in workflows (the same imported object), not a copy or a name',
    );
  const prompts = checkedPrompts(options.prompts);
  const result: WorkflowPackage = {
    root,
    name,
    version,
    description,
    whenToUse,
    workflows,
    entry: (entry as WorkflowDeclaration | undefined) ?? null,
    prompts,
    resource: (relativePath: string) => resourcePath(root, relativePath),
  };
  Object.defineProperty(result, PACKAGE_BRAND, { value: true });
  return Object.freeze(result);
}

/** The package a manifest's default export holds, from any quiet-choir copy, or undefined. @internal */
export function packageOf(value: unknown): WorkflowPackage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (Reflect.get(value, PACKAGE_BRAND) !== true) return undefined;
  const candidate = value as Partial<WorkflowPackage>;
  return typeof candidate.root === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.version === 'string' &&
    Array.isArray(candidate.workflows) &&
    Array.isArray(candidate.prompts)
    ? (value as WorkflowPackage)
    : undefined;
}

export type { PackageOptions, WorkflowPackage } from './model.js';
