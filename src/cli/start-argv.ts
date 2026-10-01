/** The parts of an oclif flag definition that decide how argv tokens are consumed. @internal */
export interface ArgvFlagDefinition {
  readonly type: 'boolean' | 'option';
  readonly char?: string;
  readonly aliases?: readonly string[];
  readonly charAliases?: readonly string[];
}

/** A command's flag table, keyed by canonical flag name. @internal */
export type ArgvFlagTable = Readonly<Record<string, ArgvFlagDefinition>>;

/** The `workflow execute` arguments a detached `workflow start` passes to its runner. @internal */
export interface StartChildArgv {
  /** Arguments after `workflow execute`. */
  readonly args: readonly string[];
  /**
   * Index in `args` of the `-` value of `--input -`, which the caller replaces with `@<file>`
   * because the runner's stdin is `/dev/null`; null when input does not come from stdin.
   */
  readonly stdinInputIndex: number | null;
}

/** Flags that belong to `workflow start` itself and never reach the runner. */
const startOnly = new Set(['json', 'start-timeout']);

/**
 * Translate the raw argv of `workflow start` into the runner's `workflow execute` arguments, keeping
 * every other token and its spelling (aliases, `--flag=value`, repeated flags, positionals) as
 * given. The flag table tells value-taking flags from booleans, so a value that looks like a flag
 * stays a value. Removes `--json` and `--start-timeout`; normalizes `--input -` and `--input=-` to
 * two tokens and reports the index of `-`; appends `--run-id` and `--state-dir` only when absent and
 * always `--json`, all before a literal `--`, after which tokens are kept verbatim. Pure. @internal
 */
export function buildStartChildArgv(
  argv: readonly string[],
  flags: ArgvFlagTable,
  options: { readonly runId: string; readonly stateDir: string },
): StartChildArgv {
  const long = new Map<string, readonly [string, ArgvFlagDefinition]>();
  const short = new Map<string, readonly [string, ArgvFlagDefinition]>();
  for (const [name, definition] of Object.entries(flags)) {
    long.set(name, [name, definition]);
    for (const alias of definition.aliases ?? []) long.set(alias, [name, definition]);
    if (definition.char !== undefined) short.set(definition.char, [name, definition]);
    for (const alias of definition.charAliases ?? []) short.set(alias, [name, definition]);
  }
  const args: string[] = [];
  let stdinInputIndex: number | null = null;
  let runId = false;
  let stateDir = false;
  let index = 0;
  for (; index < argv.length; index++) {
    const token = argv[index] ?? '';
    if (token === '--') break;
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const found = long.get(token.slice(2, equals === -1 ? undefined : equals));
      if (!found) {
        args.push(token);
        continue;
      }
      const [name, definition] = found;
      const separate = definition.type === 'option' && equals === -1;
      const next = argv[index + 1];
      const value = separate ? next : equals === -1 ? undefined : token.slice(equals + 1);
      const tokens = separate && next !== undefined ? [token, next] : [token];
      if (separate && next !== undefined) index++;
      if (startOnly.has(name)) continue;
      if (name === 'run-id') runId = true;
      if (name === 'state-dir') stateDir = true;
      if (name === 'input' && value === '-') {
        args.push('--input', '-');
        stdinInputIndex = args.length - 1;
        continue;
      }
      args.push(...tokens);
      continue;
    }
    if (token.length === 2 && token.startsWith('-') && token !== '--') {
      const found = short.get(token.slice(1));
      const next = argv[index + 1];
      if (found?.[1].type === 'option' && next !== undefined) {
        args.push(token, next);
        index++;
        continue;
      }
    }
    args.push(token);
  }
  return {
    args: [
      ...args,
      ...(runId ? [] : ['--run-id', options.runId]),
      ...(stateDir ? [] : ['--state-dir', options.stateDir]),
      '--json',
      ...argv.slice(index),
    ],
    stdinInputIndex,
  };
}
