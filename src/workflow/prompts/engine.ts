import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import type * as Minijinja from 'minijinja-js';

import { joinTemplateName, templateNameProblem } from './paths.js';

// ADR 0064 section 1: the one module that knows the template engine. Callers see a narrow
// interface (render, undeclared variables, source reads), so the engine can be replaced without
// touching them. Nothing here is exported from the package.

/**
 * Upper bound on the work one render or analysis may do. A render of a 2,000-item list stays far
 * below it, while a runaway nested loop fails in well under a second instead of hanging the loader.
 * It is a constant, not a setting: rendered text is step identity.
 */
const FUEL = 5_000_000;

let engine: typeof Minijinja | undefined;

/**
 * The engine module, loaded on first use. The package's Node entry initializes its WebAssembly
 * synchronously and has no top-level await, so `require` loads it and rendering stays a plain
 * function call; a static import would load about 900 KB of WebAssembly with every
 * `import 'quiet-choir'`.
 */
function minijinja(): typeof Minijinja {
  engine ??= createRequire(import.meta.url)('minijinja-js') as typeof Minijinja;
  return engine;
}

/** Whether the engine module has been loaded in this process. @internal */
export function engineLoaded(): boolean {
  return engine !== undefined;
}

/**
 * A problem with a template file found before the engine sees it: a refused path, an unreadable
 * file or invalid front matter. The prompt layer turns it into a `PromptError`. @internal
 */
export class TemplateFileError extends Error {
  /** `TemplateRefused` or `InvalidFrontMatter`. */
  public readonly kind: string;
  /** The root-relative template name. */
  public readonly file: string;
  /** The 1-based line, when known. */
  public readonly line: number | null;

  public constructor(kind: string, file: string, message: string, line: number | null = null) {
    super(message);
    this.name = 'TemplateFileError';
    this.kind = kind;
    this.file = file;
    this.line = line;
  }
}

/** A template file as the engine sees it. @internal */
export interface TemplateSource {
  /** The source with its front matter replaced by a Jinja comment spanning the same lines. */
  readonly text: string;
  /** The front matter's `description`, if any. */
  readonly description: string | undefined;
}

/** A failure from the engine or the loader, unwrapped to plain fields. @internal */
export interface EngineFailure {
  /** The engine error kind, or the {@link TemplateFileError} kind. */
  readonly kind: string;
  /** One-line explanation, without the engine's debug source listing. */
  readonly message: string;
  /** The root-relative template the failure is in, when known. */
  readonly file: string | null;
  /** The 1-based line, when known. */
  readonly line: number | null;
}

/** The engine operations a prompt set and the load-time checks need. @internal */
export interface PromptEnvironment {
  /** Render the root-relative template `name` with `context`. Throws engine errors as is. */
  render(name: string, context: Readonly<Record<string, unknown>>): string;
  /** The template's undeclared variables, as MiniJinja reports them; `nested` gives dotted paths. */
  undeclared(name: string, nested: boolean): string[];
  /** Whether the identifier `name` is an engine global (`range`, `dict`, `namespace`, ...). */
  isGlobal(name: string): boolean;
  /**
   * Read a template through the confined loader: null when it does not exist, a
   * {@link TemplateFileError} when its path is refused or its front matter is invalid.
   */
  read(name: string): TemplateSource | null;
  /**
   * Free the engine's WebAssembly memory now instead of at garbage collection. A later render or
   * analysis creates a fresh engine; the source cache is kept.
   */
  dispose(): void;
}

const plainDescription = /^[^\s"'[\]{}|>&*!%@`#,?:-].*$/u;
const nonString =
  /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|0x[\da-fA-F_]+|0o[0-7_]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/u;

/**
 * Parse reserved front matter (ADR 0064 section 2): a file whose first line is `---` must close it
 * with another `---` line, and in between hold only blank lines and at most one
 * `description: <value>` line, a plain scalar or a JSON double-quoted string. The block is
 * replaced by a `{# ... #}` comment over the same lines, so engine line numbers stay right and
 * nothing of it is rendered (`trimBlocks` removes the newline after the comment). @internal
 */
export function parseFrontMatter(file: string, source: string): TemplateSource {
  const lines = source.split('\n');
  if ((lines[0] ?? '').replace(/\r$/u, '') !== '---')
    return { text: source, description: undefined };
  const fail = (message: string, line: number): never => {
    throw new TemplateFileError('InvalidFrontMatter', file, `front matter ${message}`, line);
  };
  let description: string | undefined;
  for (let index = 1; index < lines.length; index++) {
    const line = (lines[index] ?? '').replace(/\r$/u, '');
    if (line === '---') {
      const rest = lines.slice(index + 1).join('\n');
      return { text: `{#${'\n'.repeat(index)}#}\n${rest}`, description };
    }
    if (line.trim() === '') continue;
    const match = /^description:(?:[ \t]+(.*))?$/u.exec(line);
    if (!match)
      return fail(
        `may hold only a description key, not ${JSON.stringify(line)}; anything else is reserved`,
        index + 1,
      );
    if (description !== undefined) return fail('repeats description', index + 1);
    const value = (match[1] ?? '').trim();
    if (value.startsWith('"')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return fail('description is not a valid double-quoted string', index + 1);
      }
      if (typeof parsed !== 'string' || parsed.trim() === '')
        return fail('description must be a nonempty string', index + 1);
      description = parsed;
    } else if (
      value === '' ||
      nonString.test(value) ||
      !plainDescription.test(value) ||
      / #|: /u.test(value)
    )
      return fail(
        'description must be a nonempty string: a plain scalar or a JSON double-quoted string',
        index + 1,
      );
    else description = value;
  }
  return fail('is not closed by a --- line', 1);
}

/** The fixed environment of ADR 0064 section 1. */
function configuredEnvironment(
  load: (name: string) => string | null,
): InstanceType<typeof Minijinja.Environment> {
  const { Environment } = minijinja();
  const env = new Environment();
  env.undefinedBehavior = 'strict';
  // The binding has no autoEscape property; the callback decides for every template name.
  env.setAutoEscapeCallback(() => 'none');
  env.trimBlocks = true;
  env.lstripBlocks = true;
  env.keepTrailingNewline = false;
  env.fuel = FUEL;
  // The only nondeterministic built-ins. The date-time module is never loaded, and no filter,
  // global, function or Python compatibility is ever added.
  env.removeFilter('random');
  env.removeGlobal('randrange');
  env.removeGlobal('lipsum');
  env.setPathJoinCallback((target, parent) => joinTemplateName(target, parent));
  env.setLoader(load);
  return env;
}

/**
 * The confined, caching template reader over `root` (an absolute path). It lives in its own scope,
 * apart from the engine: the loader closure the engine keeps reaches only this reader, so it never
 * holds the engine alive and a dropped environment can still be finalized.
 */
function confinedReader(root: string): (name: string) => TemplateSource | null {
  const sources = new Map<string, TemplateSource | null>();
  let realRoot: string | undefined;
  return (name) => {
    if (sources.has(name)) return sources.get(name) ?? null;
    const problem = templateNameProblem(name);
    if (problem !== null)
      throw new TemplateFileError(
        'TemplateRefused',
        name,
        `template path ${JSON.stringify(name)} ${problem}`,
      );
    try {
      realRoot ??= realpathSync(root);
    } catch {
      throw new TemplateFileError(
        'TemplateNotFound',
        name,
        `prompt root ${root} does not exist or cannot be read`,
      );
    }
    let real: string;
    try {
      real = realpathSync(join(root, name));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        sources.set(name, null);
        return null;
      }
      throw error;
    }
    if (real !== realRoot && !real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep))
      throw new TemplateFileError(
        'TemplateRefused',
        name,
        `template ${JSON.stringify(name)} resolves outside the prompt root (to ${real})`,
      );
    if (!statSync(real).isFile())
      throw new TemplateFileError(
        'TemplateRefused',
        name,
        `template ${JSON.stringify(name)} is not a regular file`,
      );
    const source = parseFrontMatter(name, readFileSync(real, 'utf8'));
    sources.set(name, source);
    return source;
  };
}

/** The engine's loader over `read`, built outside any scope that holds the engine. */
function templateLoader(
  read: (name: string) => TemplateSource | null,
): (name: string) => string | null {
  return (name) => read(name)?.text ?? null;
}

/**
 * A confined environment over the template directory `root` (an absolute path). Template names are
 * root-relative POSIX paths; the loader refuses an absolute, backslashed, NUL-containing or escaping
 * name, and a file whose real path leaves the root's real path, so a symlink cannot escape. Files
 * are read synchronously once and cached, and the engine is created on the first render or
 * analysis. Call `dispose` when done with a short-lived environment. @internal
 */
export function createPromptEnvironment(root: string): PromptEnvironment {
  const read = confinedReader(root);
  const load = templateLoader(read);
  let env: InstanceType<typeof Minijinja.Environment> | undefined;
  const globals = new Map<string, boolean>();
  const engineEnv = (): InstanceType<typeof Minijinja.Environment> => {
    env ??= configuredEnvironment(load);
    return env;
  };
  return {
    render: (name, context) => engineEnv().renderTemplate(name, context),
    undeclared: (name, nested) => engineEnv().undeclaredVariablesInTemplate(name, nested),
    isGlobal: (name) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return false;
      let known = globals.get(name);
      if (known === undefined) {
        known = engineEnv().evalExpr(`${name} is defined`, {}) === true;
        globals.set(name, known);
      }
      return known;
    },
    read,
    dispose: () => {
      env?.free();
      env = undefined;
    },
  };
}

/** Render a one-off template string in the fixed environment, without a loader. @internal */
export function renderString(source: string, context: Readonly<Record<string, unknown>>): string {
  const env = configuredEnvironment(() => null);
  try {
    return env.renderStr(source, context);
  } finally {
    env.free();
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * Unwrap an engine or loader failure: a {@link TemplateFileError} thrown by the loader arrives as
 * the engine error's `cause`, and keeps its own kind and message. @internal
 */
export function engineFailure(error: unknown): EngineFailure {
  const cause = field(error, 'cause');
  const own = error instanceof TemplateFileError ? error : undefined;
  const loader = own ?? (cause instanceof TemplateFileError ? cause : undefined);
  if (loader)
    return { kind: loader.kind, message: loader.message, file: loader.file, line: loader.line };
  const kind = field(error, 'kind');
  const message = error instanceof Error ? error.message : String(error);
  const name = field(error, 'templateName');
  const line = field(error, 'line');
  return {
    kind: typeof kind === 'string' ? kind : 'Error',
    message: message.split('\n')[0] ?? message,
    file: typeof name === 'string' ? name : null,
    line: typeof line === 'number' ? line : null,
  };
}
