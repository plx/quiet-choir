import type { HarnessConfigurations, HarnessAdapters } from '../runtime/harness-registry.js';
import type { Harness } from '../runtime/model.js';
import type { LaunchPolicy } from '../runtime/question-model.js';
import { harnessSpecifiers } from '../runtime/commands.js';
import {
  ClaudeAdapter,
  CodexAdapter,
  type BuiltinAdapterOptions,
} from '../../harnesses/builtins/adapters.js';
import { FixtureHarness } from '../../harnesses/fixture.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CliHarness, type CliHarnessOptions } from '../../harnesses/cli.js';
import { digest } from '../runtime/json.js';
import { parseHarnessFixtures, type HarnessFixtures } from '../../harnesses/fixture.js';

/** One fixture file a selection read: absolute path and SHA-256 of its bytes. @internal */
export type FixtureSource = NonNullable<LaunchPolicy['harness']['fixtures']>[number];

/** Serializable harness selection; fixtures are validated before workflow import. @internal */
export interface HarnessSelection {
  readonly kind: 'cli' | 'fixture';
  readonly config: CliHarnessOptions;
  readonly fixtures?: HarnessFixtures;
  readonly configurations?: HarnessConfigurations;
  readonly named?: Readonly<Record<string, HarnessFixtures>>;
  /**
   * The fixture files read for `fixtures` (unnamed) and `named`, recorded as the run's launch
   * policy. Absent when an embedder built the selection from data rather than files.
   */
  readonly sources?: readonly FixtureSource[];
}
const configSchema = z
  .object({
    claudeBinary: z.string().min(1).optional(),
    codexBinary: z.string().min(1).optional(),
    maxOutputBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxRetainedBytes: z.number().int().positive().max(2_147_483_647).optional(),
    maxStreamBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    killGraceMs: z.number().int().positive().max(2_147_483_647).optional(),
    scrubEnv: z
      .union([z.literal(false), z.array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/u))])
      .optional(),
  })
  .strict();

/** The fixture part of a selection, read from `--harness` specifiers. */
type FixtureSelection = Pick<HarnessSelection, 'kind' | 'fixtures' | 'named' | 'sources'>;

async function readFixtureFile(
  path: string,
  sources: FixtureSource[],
  name: string | undefined,
  missing?: (error: unknown) => Error,
): Promise<HarnessFixtures> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw missing ? missing(error) : error;
  }
  sources.push({
    ...(name === undefined ? {} : { name }),
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  return parseHarnessFixtures(JSON.parse(bytes.toString('utf8')));
}

async function readFixtureSelection(
  specifiers: readonly string[],
  cwd: string,
  missing?: (error: unknown) => Error,
): Promise<FixtureSelection> {
  const isNamed = (value: string) => !value.startsWith('fixture:') && value.includes('=');
  const global = specifiers.filter((value) => !isNamed(value));
  if (global.length > 1) throw new Error('Choose one global harness: cli or fixture:<file>.');
  const globalSpecifier = global[0] ?? 'cli';
  const sources: FixtureSource[] = [];
  let fixtures: HarnessFixtures | undefined;
  if (globalSpecifier.startsWith('fixture:') && globalSpecifier.slice(8).length > 0)
    fixtures = await readFixtureFile(
      resolve(cwd, globalSpecifier.slice(8)),
      sources,
      undefined,
      missing,
    );
  else if (globalSpecifier.startsWith('module:'))
    throw new Error(
      'Register adapter packages in defineWorkflow({ harnesses }), not through module: loading.',
    );
  else if (globalSpecifier !== 'cli') throw new Error('--harness must be cli or fixture:<file>.');
  const named: Record<string, HarnessFixtures> = {};
  for (const value of specifiers.filter(isNamed)) {
    const match = /^([a-z][a-z0-9-]{0,31})=fixture:(.+)$/u.exec(value);
    if (!match?.[1] || !match[2])
      throw new Error(
        'Named --harness must be name=fixture:<JSON file>; adapter packages belong in workflow harnesses.',
      );
    if (Object.hasOwn(named, match[1]))
      throw new Error(`Duplicate --harness selection ${match[1]}.`);
    const path = resolve(cwd, match[2]);
    const file = await readFixtureFile(path, sources, match[1], missing);
    // Commands are not per-harness: exec rules and the commands mode belong to the global file.
    if (file.exec !== undefined || file.commands !== undefined)
      throw new Error(
        `Named fixture file ${path} for harness ${match[1]} has exec rules or a commands mode; commands are not per-harness, so put them in the global --harness fixture:FILE.`,
      );
    Object.defineProperty(named, match[1], { value: file, enumerable: true });
  }
  return {
    kind: fixtures === undefined ? 'cli' : 'fixture',
    ...(fixtures === undefined ? {} : { fixtures }),
    ...(Object.keys(named).length ? { named } : {}),
    ...(sources.length ? { sources } : {}),
  };
}

/** Read explicit config/fixture files; no search, module import, or binary discovery. @internal */
export async function readHarnessSelection(
  specifier: string | readonly string[],
  configSource: string | undefined,
  cwd: string,
  killGraceMs?: number,
): Promise<HarnessSelection> {
  const specifiers = typeof specifier === 'string' ? [specifier] : specifier;
  const raw: unknown =
    configSource === undefined
      ? {}
      : JSON.parse(
          configSource.startsWith('@')
            ? await readFile(resolve(cwd, configSource.slice(1)), 'utf8')
            : configSource,
        );
  const { harnesses: parsed, ...legacy } = configSchema
    .extend({
      harnesses: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u), z.json()).optional(),
    })
    .parse(raw);
  // Built-in binary paths follow the legacy fields: resolve against the command cwd now, because
  // agent processes may run in options.cwd or a runtime worktree. Package configs stay opaque.
  const configurations =
    parsed === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(parsed).map(([name, value]) => [
            name,
            (name === 'claude' || name === 'codex') &&
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value) &&
            typeof value['binary'] === 'string' &&
            value['binary'].includes('/')
              ? { ...value, binary: resolve(cwd, value['binary']) }
              : value,
          ]),
        );
  const config = legacy as CliHarnessOptions;
  const resolved = {
    ...config,
    ...(config.claudeBinary?.includes('/')
      ? { claudeBinary: resolve(cwd, config.claudeBinary) }
      : {}),
    ...(config.codexBinary?.includes('/') ? { codexBinary: resolve(cwd, config.codexBinary) } : {}),
    ...(killGraceMs === undefined ? {} : { killGraceMs }),
  };
  // Constructor validation is shared with embedding callers and remains process-free.
  new CliHarness(resolved);
  return {
    ...(await readFixtureSelection(specifiers, cwd)),
    config: resolved,
    ...(configurations === undefined ? {} : { configurations }),
  };
}

/**
 * The launch policy a selection records: its kind and fixture sources, and the wait mode. Undefined
 * when the selection holds fixtures it did not read from files (an embedder's data), because such
 * a policy could not be reproduced by a later resume. Configuration values are never included.
 * @internal
 */
export function launchPolicyOf(
  selection: HarnessSelection | undefined,
  waitMode: LaunchPolicy['waitMode'],
): LaunchPolicy | undefined {
  const sources = selection?.sources ?? [];
  const recorded = new Set(sources.map(({ name }) => name));
  if (selection?.fixtures !== undefined && !recorded.has(undefined)) return undefined;
  if (Object.keys(selection?.named ?? {}).some((name) => !recorded.has(name))) return undefined;
  return {
    harness: {
      kind: selection?.kind ?? 'cli',
      ...(sources.length
        ? {
            fixtures: sources.map(({ name, path, sha256 }) => ({
              ...(name === undefined ? {} : { name }),
              path,
              sha256,
            })),
          }
        : {}),
    },
    waitMode,
  };
}

/**
 * Replace the kind and fixtures of an invocation's selection with a run's recorded ones, keeping the
 * invocation's configuration (`--harness-config` is never recorded). Each recorded file is read
 * again: a missing or unreadable one fails, naming the path and `--harness`; changed content is
 * used, with a warning naming the file and both digests, and the new digest is recorded. @internal
 */
export async function inheritHarnessSelection(
  selection: HarnessSelection | undefined,
  recorded: LaunchPolicy['harness'],
  warn: (message: string) => void,
): Promise<HarnessSelection> {
  const fixturePart = await readFixtureSelection(harnessSpecifiers(recorded), '/', (error) => {
    const path =
      error instanceof Error && 'path' in error && typeof error.path === 'string'
        ? error.path
        : 'a recorded fixture file';
    return new Error(
      `The run's recorded fixture ${path} cannot be read (${error instanceof Error && 'code' in error ? String(error.code) : String(error)}); pass --harness explicitly to choose the harness for this resume.`,
      { cause: error },
    );
  });
  for (const source of fixturePart.sources ?? []) {
    const before = recorded.fixtures?.find(({ name }) => name === source.name);
    if (before && before.sha256 !== source.sha256)
      warn(
        `Fixture ${source.path}${source.name === undefined ? '' : ` (${source.name})`} changed since the run last executed (sha256 ${before.sha256.slice(0, 12)}, now ${source.sha256.slice(0, 12)}); using the current content.`,
      );
  }
  // Only the configuration survives from the invocation; kind and every fixture part are recorded.
  return {
    config: selection?.config ?? {},
    ...(selection?.configurations === undefined
      ? {}
      : { configurations: selection.configurations }),
    ...fixturePart,
  };
}

/**
 * SHA-256 of the CLI harness configuration a selection applies, recorded as
 * `RunRecord.harness.configDigest` and compared on resume. It covers the legacy `CliHarnessOptions`
 * fields (binary paths as `readHarnessSelection` resolved them, output limits, `scrubEnv`) and the
 * `harnesses.<name>` configurations. It excludes `killGraceMs` (termination policy, not output),
 * the selection kind (recorded and checked separately), and fixtures. An absent selection digests
 * like the default `{ kind: 'cli', config: {} }`; key order never matters. Uses the same canonical
 * `digest()` as environment summaries and step identities. @internal
 */
export function harnessConfigDigest(selection?: HarnessSelection): string {
  // digest() omits undefined members, so this drops killGraceMs without a second canonical form.
  return digest({
    config: { ...selection?.config, killGraceMs: undefined },
    configurations: selection?.configurations ?? {},
  });
}

/** Construct only operator-selected adapters; declared custom factories stay lazy in the runtime. @internal */
export function selectedAdapters(
  selection: HarnessSelection | undefined,
  fallback?: Harness,
): HarnessAdapters {
  const result: Record<string, HarnessAdapters[string]> = {};
  const nativeConfig = (name: string) => {
    const raw = selection?.configurations?.[name];
    if (raw === undefined) return {};
    return configSchema
      .omit({ claudeBinary: true, codexBinary: true })
      .extend({ binary: z.string().min(1).optional() })
      .parse(raw) as BuiltinAdapterOptions;
  };
  if (!fallback && selection?.kind !== 'fixture') {
    const { claudeBinary, codexBinary, ...limits } = selection?.config ?? {};
    result['claude'] = new ClaudeAdapter({
      ...limits,
      ...(claudeBinary === undefined ? {} : { binary: claudeBinary }),
      ...nativeConfig('claude'),
    });
    result['codex'] = new CodexAdapter({
      ...limits,
      ...(codexBinary === undefined ? {} : { binary: codexBinary }),
      ...nativeConfig('codex'),
    });
  }
  for (const [name, fixtures] of Object.entries(selection?.named ?? {})) {
    const fixture = new FixtureHarness(fixtures);
    result[name] = {
      kind: fixture.kind,
      invoke: (request, signal, invocation) => {
        if (!invocation)
          throw new Error('Selected fixture adapter requires runtime invocation identity.');
        return fixture.invoke(request, { ...invocation, signal });
      },
    };
  }
  return result;
}
