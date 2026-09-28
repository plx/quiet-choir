import type { HarnessConfigurations, HarnessAdapters } from '../runtime/harness-registry.js';
import type { Harness } from '../runtime/model.js';
import {
  ClaudeAdapter,
  CodexAdapter,
  type BuiltinAdapterOptions,
} from '../../harnesses/builtins/adapters.js';
import { FixtureHarness } from '../../harnesses/fixture.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CliHarness, type CliHarnessOptions } from '../../harnesses/cli.js';
import { parseHarnessFixtures, type HarnessFixtures } from '../../harnesses/fixture.js';

/** Serializable harness selection; fixtures are validated before workflow import. @internal */
export interface HarnessSelection {
  readonly kind: 'cli' | 'fixture';
  readonly config: CliHarnessOptions;
  readonly fixtures?: HarnessFixtures;
  readonly configurations?: HarnessConfigurations;
  readonly named?: Readonly<Record<string, HarnessFixtures>>;
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

/** Read explicit config/fixture files; no search, module import, or binary discovery. @internal */
export async function readHarnessSelection(
  specifier: string | readonly string[],
  configSource: string | undefined,
  cwd: string,
  killGraceMs?: number,
): Promise<HarnessSelection> {
  const specifiers = typeof specifier === 'string' ? [specifier] : specifier;
  const isNamed = (value: string) => !value.startsWith('fixture:') && value.includes('=');
  const global = specifiers.filter((value) => !isNamed(value));
  if (global.length > 1) throw new Error('Choose one global harness: cli or fixture:<file>.');
  const globalSpecifier = global[0] ?? 'cli';
  const named: Record<string, HarnessFixtures> = {};
  for (const value of specifiers.filter(isNamed)) {
    const match = /^([a-z][a-z0-9-]{0,31})=fixture:(.+)$/u.exec(value);
    if (!match?.[1] || !match[2])
      throw new Error(
        'Named --harness must be name=fixture:<JSON file>; adapter packages belong in workflow harnesses.',
      );
    if (Object.hasOwn(named, match[1]))
      throw new Error(`Duplicate --harness selection ${match[1]}.`);
    Object.defineProperty(named, match[1], {
      value: parseHarnessFixtures(JSON.parse(await readFile(resolve(cwd, match[2]), 'utf8'))),
      enumerable: true,
    });
  }
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
  const additions = {
    ...(configurations === undefined ? {} : { configurations }),
    ...(Object.keys(named).length ? { named } : {}),
  };
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
  if (globalSpecifier === 'cli') return { kind: 'cli', config: resolved, ...additions };
  if (globalSpecifier.startsWith('fixture:') && globalSpecifier.slice(8).length > 0)
    return {
      kind: 'fixture',
      ...additions,
      config: resolved,
      fixtures: parseHarnessFixtures(
        JSON.parse(await readFile(resolve(cwd, globalSpecifier.slice(8)), 'utf8')),
      ),
    };
  if (globalSpecifier.startsWith('module:'))
    throw new Error(
      'Register adapter packages in defineWorkflow({ harnesses }), not through module: loading.',
    );
  throw new Error('--harness must be cli or fixture:<file>.');
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
