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

/** One argv unit: a known flag with its tokens, or any other token. */
interface ArgvItem {
  /** Canonical flag name, or null for a positional or unknown token. */
  readonly name: string | null;
  /** The unit's tokens as given: the flag and, in the separate form, its value. */
  readonly tokens: readonly string[];
  /** The flag's value (separate or `=` form), if any. */
  readonly value: string | undefined;
}

/**
 * Split argv into units up to a literal `--`, using the flag table to tell value-taking flags from
 * booleans, so a value that looks like a flag stays a value. `rest` is `--` and everything after.
 */
function scanArgv(
  argv: readonly string[],
  flags: ArgvFlagTable,
): { readonly items: readonly ArgvItem[]; readonly rest: readonly string[] } {
  const long = new Map<string, readonly [string, ArgvFlagDefinition]>();
  const short = new Map<string, readonly [string, ArgvFlagDefinition]>();
  for (const [name, definition] of Object.entries(flags)) {
    long.set(name, [name, definition]);
    for (const alias of definition.aliases ?? []) long.set(alias, [name, definition]);
    if (definition.char !== undefined) short.set(definition.char, [name, definition]);
    for (const alias of definition.charAliases ?? []) short.set(alias, [name, definition]);
  }
  const items: ArgvItem[] = [];
  let index = 0;
  for (; index < argv.length; index++) {
    const token = argv[index] ?? '';
    if (token === '--') break;
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const found = long.get(token.slice(2, equals === -1 ? undefined : equals));
      if (!found) {
        items.push({ name: null, tokens: [token], value: undefined });
        continue;
      }
      const [name, definition] = found;
      const separate = definition.type === 'option' && equals === -1;
      const next = argv[index + 1];
      const value = separate ? next : equals === -1 ? undefined : token.slice(equals + 1);
      if (separate && next !== undefined) {
        items.push({ name, tokens: [token, next], value });
        index++;
      } else items.push({ name, tokens: [token], value });
      continue;
    }
    if (token.length === 2 && token.startsWith('-')) {
      const found = short.get(token.slice(1));
      const next = argv[index + 1];
      if (found?.[1].type === 'option' && next !== undefined) {
        items.push({ name: found[0], tokens: [token, next], value: next });
        index++;
        continue;
      }
    }
    items.push({ name: null, tokens: [token], value: undefined });
  }
  return { items, rest: argv.slice(index) };
}

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
  const { items, rest } = scanArgv(argv, flags);
  const args: string[] = [];
  let stdinInputIndex: number | null = null;
  let runId = false;
  let stateDir = false;
  for (const { name, tokens, value } of items) {
    if (name !== null && startOnly.has(name)) continue;
    if (name === 'run-id') runId = true;
    if (name === 'state-dir') stateDir = true;
    if (name === 'input' && value === '-' && tokens[0]?.startsWith('--') === true) {
      args.push('--input', '-');
      stdinInputIndex = args.length - 1;
      continue;
    }
    args.push(...tokens);
  }
  return {
    args: [
      ...args,
      ...(runId ? [] : ['--run-id', options.runId]),
      ...(stateDir ? [] : ['--state-dir', options.stateDir]),
      '--json',
      ...rest,
    ],
    stdinInputIndex,
  };
}

/**
 * The foreground `workflow execute` arguments equivalent to a `workflow start` argv: every token as
 * given, `--json` and tokens after a literal `--` included, without start's own `--start-timeout`
 * and its value. Nothing is appended. A refused rehearsal flag points here (ADR 0056). Pure.
 * @internal
 */
export function foregroundExecuteArgs(
  argv: readonly string[],
  flags: ArgvFlagTable,
): readonly string[] {
  const { items, rest } = scanArgv(argv, flags);
  return [
    ...items.flatMap(({ name, tokens }) => (name === 'start-timeout' ? [] : tokens)),
    ...rest,
  ];
}
