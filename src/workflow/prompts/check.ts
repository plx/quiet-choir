import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createPromptEnvironment, engineFailure, type PromptEnvironment } from './engine.js';
import { promptLabel } from './error.js';
import { joinTemplateName, templateNameProblem } from './paths.js';
import type { PromptSetDescriptor } from './prompt.js';
import { scanTemplate } from './scan.js';

// ADR 0064 section 3: the static checks that `workflow validate`, the execute preflight,
// `list-defs` and `runWorkflow` run on every declared prompt set before any effect. Results are
// plain data; errors are aggregated so one validate run reports every problem.

/** The checked view of one prompt, published under `prompts` by `workflow validate`. @internal */
export interface PromptEntryCheck {
  /** Prompt name in its index. */
  readonly name: string;
  /** Root-relative template file. */
  readonly file: string;
  /** The entry's description, else the template's front matter description, else null. */
  readonly description: string | null;
  /** Top-level variables the template reads, sorted. */
  readonly variables: readonly string[];
  /** Non-fatal findings, such as an unused parameter. */
  readonly warnings: readonly string[];
}

/** The checked view of one prompt set. @internal */
export interface PromptSetCheck {
  /** Absolute template root. */
  readonly root: string;
  /** Entries in declaration order. */
  readonly entries: readonly PromptEntryCheck[];
}

/** The result of {@link checkPromptSets}. @internal */
export interface PromptChecks {
  /** One view per set, in order. */
  readonly sets: readonly PromptSetCheck[];
  /** Every error, each naming the prompt and file and, where known, the line. */
  readonly errors: readonly string[];
}

/** Names the scanner already refuses; dropped from undeclared sets so they are reported once. */
const refusedNames: ReadonlySet<string> = new Set(['randrange', 'lipsum']);

/** A zod 4 schema's definition, read structurally so a schema from any zod copy works. */
function def(schema: unknown): Readonly<Record<string, unknown>> | undefined {
  const internals: unknown =
    typeof schema === 'object' && schema !== null ? Reflect.get(schema, '_zod') : undefined;
  const value: unknown =
    typeof internals === 'object' && internals !== null ? Reflect.get(internals, 'def') : undefined;
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

const wrappers: ReadonlySet<string> = new Set(['optional', 'nullable', 'default', 'readonly']);

/**
 * The shape of a plain object schema after unwrapping optional, nullable, default and readonly,
 * or undefined for anything else, including an object with a catchall or passthrough, whose
 * unknown keys survive parsing.
 */
function plainShape(schema: unknown): Readonly<Record<string, unknown>> | undefined {
  let current = def(schema);
  while (current !== undefined && wrappers.has(String(current['type'])))
    current = def(current['innerType']);
  if (current?.['type'] !== 'object') return undefined;
  const catchall = def(current['catchall']);
  if (catchall !== undefined && catchall['type'] !== 'never') return undefined;
  const shape: unknown = current['shape'];
  return typeof shape === 'object' && shape !== null
    ? (shape as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * Check a dotted path (`issue.author.login`) against the parameter shape, best effort: the walk
 * stops at anything that is not a plain object schema. Returns the first missing segment's path.
 */
function missingPath(shape: Readonly<Record<string, unknown>>, path: string): string | null {
  const [first, ...segments] = path.split('.');
  if (first === undefined || !Object.hasOwn(shape, first)) return null;
  let schema: unknown = shape[first];
  let walked = first;
  for (const segment of segments) {
    const inner = plainShape(schema);
    if (inner === undefined) return null;
    if (!Object.hasOwn(inner, segment)) return `${walked}.${segment}`;
    schema = inner[segment];
    walked = `${walked}.${segment}`;
  }
  return null;
}

function checkEntry(
  environment: PromptEnvironment,
  root: string,
  name: string,
  entry: PromptSetDescriptor['entries'][string],
  errors: string[],
): PromptEntryCheck {
  const label = promptLabel(name, entry.file);
  const warnings: string[] = [];
  const error = (message: string): void => {
    errors.push(`${label}: ${message}`);
  };
  const at = (file: string, line: number | null): string =>
    line === null ? file : `${file}:${String(line)}`;
  const failed = new Set<string>();
  const read = (file: string): ReturnType<PromptEnvironment['read']> | undefined => {
    try {
      return environment.read(file);
    } catch (cause) {
      const failure = engineFailure(cause);
      failed.add(file);
      error(`${at(failure.file ?? file, failure.line)}: ${failure.message}`);
      return undefined;
    }
  };
  const entrySource = read(entry.file);
  if (entrySource === null) {
    error(`template file ${entry.file} does not exist under ${root}`);
    return {
      name,
      file: entry.file,
      description: entry.description ?? null,
      variables: [],
      warnings,
    };
  }

  // The include/extends/import closure, scanned once per template. Every template reached from the
  // entry reads its context: MiniJinja gives an imported macro the render's root context whatever
  // the import's context clause says, so `import` and `from` count like `include` and `extends`.
  const scanned = new Set<string>();
  const queue: string[] = [entry.file];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (scanned.has(current)) continue;
    const source = current === entry.file ? entrySource : read(current);
    if (source === undefined || source === null) {
      scanned.add(current);
      continue;
    }
    const scan = scanTemplate(source.text);
    for (const problem of scan.problems) error(`${at(current, problem.line)}: ${problem.message}`);
    scanned.add(current);
    for (const dependency of scan.dependencies) {
      const target = joinTemplateName(dependency.target, current);
      const problem = templateNameProblem(target);
      const where = at(current, dependency.line);
      if (problem !== null) {
        error(
          `${where}: ${dependency.keyword} target ${JSON.stringify(dependency.target)} ${problem}`,
        );
        continue;
      }
      if (!scanned.has(target)) {
        let exists: boolean;
        try {
          exists = environment.read(target) !== null;
        } catch {
          // Reported when the target itself is read below.
          exists = true;
        }
        if (!exists) {
          error(
            `${where}: ${dependency.keyword} target ${JSON.stringify(dependency.target)} (${target}) does not exist under the prompt root`,
          );
          scanned.add(target);
          failed.add(target);
          continue;
        }
      }
      queue.push(target);
    }
  }

  // Parse every template in the closure, and collect the variables they read.
  const undeclared = (file: string, nested: boolean): string[] | undefined => {
    if (failed.has(file)) return undefined;
    try {
      return environment
        .undeclared(file, nested)
        .filter((variable) => !refusedNames.has(variable.split('.')[0] ?? variable))
        .filter((variable) => !environment.isGlobal(variable.split('.')[0] ?? variable));
    } catch (cause) {
      const failure = engineFailure(cause);
      failed.add(file);
      error(
        failure.message.includes('(in ')
          ? failure.message
          : `${at(failure.file ?? file, failure.line)}: ${failure.message}`,
      );
      return undefined;
    }
  };
  const shape = entry.params.shape as Readonly<Record<string, unknown>>;
  const keys = Object.keys(shape);
  const variables = (undeclared(entry.file, false) ?? []).sort();
  const used = new Set(variables);
  for (const file of scanned) {
    if (file === entry.file) continue;
    for (const variable of undeclared(file, false) ?? []) used.add(variable);
  }
  for (const variable of variables)
    if (!Object.hasOwn(shape, variable))
      error(`reads variable ${variable}, which its params schema does not declare`);
  for (const path of undeclared(entry.file, true) ?? []) {
    const missing = path.includes('.') ? missingPath(shape, path) : null;
    if (missing !== null)
      error(
        `reads ${missing}, which its params schema does not declare (parsing drops unknown keys, so the render would fail)`,
      );
  }
  // An entry that failed to read or parse reads nothing, so it gets no unused-key warnings.
  for (const key of failed.has(entry.file) ? [] : keys)
    if (!used.has(key))
      warnings.push(`${label}: parameter ${key} is never read by the template or its includes`);
  return {
    name,
    file: entry.file,
    description: entry.description ?? entrySource?.description ?? null,
    variables,
    warnings,
  };
}

/**
 * Run the load-time checks of ADR 0064 section 3 on prompt set descriptors: each entry's file
 * exists and parses; every include, extends, import and from target in its closure is one string
 * literal without `ignore missing` that resolves inside the root and exists; no template names
 * `random`, `randrange` or `lipsum`; the entry's undeclared variables are schema keys, and dotted
 * paths match plain object schemas (best effort). A schema key that neither the entry nor its
 * include/extends/import closure reads is a warning. Fragments are parsed but not held to the schema,
 * since they may read the loop variables of the template that includes them. @internal
 */
export function checkPromptSets(descriptors: readonly PromptSetDescriptor[]): PromptChecks {
  const errors: string[] = [];
  const sets = descriptors.map((descriptor) => {
    const environment = createPromptEnvironment(descriptor.root);
    return {
      root: descriptor.root,
      entries: Object.entries(descriptor.entries).map(([name, entry]) =>
        checkEntry(environment, descriptor.root, name, entry, errors),
      ),
    };
  });
  return { sets, errors };
}

/**
 * Every regular file or file symlink under a prompt root, as sorted absolute paths: the superset of
 * what a render can read, since dependency targets are literal and confined. A file symlink is
 * listed at its own path, so hashing it reads its target and a retarget or a target edit changes
 * the hash. Directory symlinks are not followed, a dangling symlink is skipped (no render can read
 * it), and a missing root has no files. @internal
 */
export function promptRootFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (
        directory === root &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() || (entry.isSymbolicLink() && linksToFile(path))) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

/** Whether a symlink resolves to a regular file; a dangling or looping link does not. */
function linksToFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))
    )
      return false;
    throw error;
  }
}
