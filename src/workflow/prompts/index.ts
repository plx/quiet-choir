import { isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { Prompt, PromptEntries, PromptEntry, PromptSet } from '../runtime/model.js';
import { createPromptEnvironment, engineFailure, type PromptEnvironment } from './engine.js';
import { PromptError, promptLabel } from './error.js';
import { templateNameProblem } from './paths.js';
import {
  createPrompt,
  PROMPT_NAME_PATTERN,
  PROMPT_SET,
  type PromptEntryDescriptor,
  type PromptSetDescriptor,
} from './prompt.js';

// ADR 0064 section 2: a TypeScript index over markdown templates. `definePrompts` validates its
// arguments without touching the disk; templates are read and parsed on the first render, and the
// load-time checks (check.ts) run when a workflow that lists the set is validated or launched.

const entryKeys: ReadonlySet<string> = new Set(['file', 'params', 'description']);

/**
 * The entry map `definePrompts` accepts: each value a {@link PromptEntry} with no other keys, so an
 * unknown key (a misspelled `description`, say) fails typecheck as well as at load.
 */
export type CheckedPromptEntries<E extends PromptEntries> = E & {
  readonly [K in keyof E]: Readonly<Record<Exclude<keyof E[K], keyof PromptEntry>, never>>;
};

function definitionError(message: string, prompt: string | null, file: string | null): never {
  throw new PromptError(`${promptLabel(prompt, file)}: ${message}`, {
    prompt,
    file,
    kind: 'InvalidDefinition',
    line: null,
  });
}

function fileRootPath(root: string | URL): string {
  try {
    return resolve(fileURLToPath(root));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return definitionError(
      `root ${JSON.stringify(String(root))} is not a valid file: URL: ${message}`,
      null,
      null,
    );
  }
}

function rootPath(root: unknown): string {
  if (root instanceof URL) {
    if (root.protocol !== 'file:')
      return definitionError(`root must be a file: URL, not ${root.protocol}`, null, null);
    return fileRootPath(root);
  }
  if (typeof root !== 'string')
    return definitionError('root must be an absolute path or a file: URL', null, null);
  if (root.startsWith('file:')) return fileRootPath(root);
  if (!isAbsolute(root))
    return definitionError(
      `root ${JSON.stringify(root)} must be absolute, such as import.meta.dirname + '/prompts'; a relative root would resolve against the current directory`,
      null,
      null,
    );
  return resolve(root);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkedEntry(name: string, value: unknown): PromptEntryDescriptor {
  if (!PROMPT_NAME_PATTERN.test(name))
    return definitionError(
      `prompt name ${JSON.stringify(name)} must be an identifier matching /^[A-Za-z][A-Za-z0-9_]*$/`,
      null,
      null,
    );
  if (!isRecord(value)) return definitionError('entry must be an object', name, null);
  for (const key of Reflect.ownKeys(value))
    if (typeof key !== 'string' || !entryKeys.has(key))
      return definitionError(
        `entry has unknown key ${String(key)}; an entry takes only file, params and description`,
        name,
        null,
      );
  const file = value['file'];
  if (typeof file !== 'string') return definitionError('file must be a string', name, null);
  const problem = templateNameProblem(file);
  if (problem !== null)
    return definitionError(`file ${JSON.stringify(file)} ${problem}`, name, file);
  const normalized = posix.normalize(file);
  if (!normalized.endsWith('.md'))
    return definitionError('file must be a markdown template ending in .md', name, file);
  const params = value['params'];
  if (!(params instanceof z.ZodObject))
    return definitionError(
      "params must be a zod 4 object schema (z.object({ ... }) from 'quiet-choir' or 'zod')",
      name,
      normalized,
    );
  const description = value['description'];
  if (description !== undefined && (typeof description !== 'string' || description.trim() === ''))
    return definitionError('description must be a nonempty string', name, normalized);
  return Object.freeze({
    file: normalized,
    params,
    ...(description === undefined ? {} : { description }),
  });
}

/** Turn a render failure into the fatal authoring error it is. */
function renderError(name: string, file: string, error: unknown): PromptError {
  if (error instanceof PromptError) return error;
  const failure = engineFailure(error);
  // Engine messages end with "(in <file>:<line>)"; loader failures name their file here.
  const located =
    failure.message.includes('(in ') ||
    (failure.file === null && failure.line === null) ||
    (failure.file === file && failure.line === null);
  const where = `${failure.file ?? file}${failure.line === null ? '' : `:${String(failure.line)}`}`;
  return new PromptError(
    `${promptLabel(name, file)}: ${failure.message}${located ? '' : ` (in ${where})`}`,
    { prompt: name, file: failure.file ?? file, kind: failure.kind, line: failure.line },
    { cause: error },
  );
}

/**
 * Declare markdown prompt templates and the Zod schemas of their parameters (ADR 0064). `root` is
 * the absolute template directory (`import.meta.dirname + '/prompts'`) or a `file:` URL; each entry
 * names a root-relative `.md` file, a `z.object` of parameters and an optional description. Names
 * are identifiers (`/^[A-Za-z][A-Za-z0-9_]*$/`), PascalCase by convention.
 *
 * The result is a frozen object with one function per entry. A call parses its parameters with the
 * entry's schema (unknown top-level keys rejected), renders the template with MiniJinja, and
 * returns a {@link Prompt}: pure and synchronous, so a roster module can render standing prompts
 * when it loads. Any parameter, template or engine error throws a {@link PromptError}, which a
 * workflow run treats as a fatal authoring error.
 *
 * `definePrompts` validates its arguments without reading any file. List the result in the
 * workflow's `prompts` so `workflow validate`, the execute preflight and `list-defs` check every
 * template before any paid call. See `docs/prompts.md` for the template subset and the checks.
 */
export function definePrompts<const E extends PromptEntries>(
  root: string | URL,
  entries: CheckedPromptEntries<E>,
): PromptSet<E> {
  const directory = rootPath(root);
  if (!isRecord(entries)) return definitionError('entries must be an object', null, null);
  if (Reflect.ownKeys(entries).length !== Object.keys(entries).length)
    return definitionError('entries cannot have symbol or non-enumerable keys', null, null);
  const checked: Record<string, PromptEntryDescriptor> = {};
  for (const name of Object.keys(entries)) checked[name] = checkedEntry(name, entries[name]);
  const descriptor: PromptSetDescriptor = Object.freeze({
    root: directory,
    entries: Object.freeze(checked),
  });
  let environment: PromptEnvironment | undefined;
  const set: Record<string, (params: unknown) => Prompt> = {};
  for (const [name, entry] of Object.entries(checked)) {
    const strict = entry.params.strict();
    const render = (params: unknown): Prompt => {
      let parsed: ReturnType<typeof strict.safeParse>;
      try {
        parsed = strict.safeParse(params);
      } catch (error) {
        // A schema Zod cannot run synchronously (an async refinement or transform) throws here.
        throw new PromptError(
          `${promptLabel(name, entry.file)}: invalid parameters: ${error instanceof Error ? error.message : String(error)}`,
          { prompt: name, file: entry.file, kind: 'InvalidParams', line: null },
          { cause: error },
        );
      }
      if (!parsed.success)
        throw new PromptError(
          `${promptLabel(name, entry.file)}: invalid parameters: ${parsed.error.issues
            .map((issue) => `${issue.path.map(String).join('.') || 'params'}: ${issue.message}`)
            .join('; ')}`,
          { prompt: name, file: entry.file, kind: 'InvalidParams', line: null },
          { cause: parsed.error },
        );
      const values = parsed.data as Readonly<Record<string, unknown>>;
      let text: string;
      try {
        environment ??= createPromptEnvironment(directory);
        text = environment.render(entry.file, values);
      } catch (error) {
        throw renderError(name, entry.file, error);
      }
      return createPrompt(text, name, values);
    };
    Object.defineProperty(render, 'name', { value: name });
    Object.defineProperty(set, name, { value: render, enumerable: true });
  }
  Object.defineProperty(set, PROMPT_SET, { value: descriptor });
  return Object.freeze(set) as unknown as PromptSet<E>;
}

export { PromptError } from './error.js';
export type { PromptErrorDetails } from './error.js';
