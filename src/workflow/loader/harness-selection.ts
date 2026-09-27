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
  specifier: string,
  configSource: string | undefined,
  cwd: string,
  killGraceMs?: number,
): Promise<HarnessSelection> {
  const raw: unknown =
    configSource === undefined
      ? {}
      : JSON.parse(
          configSource.startsWith('@')
            ? await readFile(resolve(cwd, configSource.slice(1)), 'utf8')
            : configSource,
        );
  const config = configSchema.parse(raw) as CliHarnessOptions;
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
  if (specifier === 'cli') return { kind: 'cli', config: resolved };
  if (specifier.startsWith('fixture:') && specifier.slice(8).length > 0)
    return {
      kind: 'fixture',
      config: resolved,
      fixtures: parseHarnessFixtures(
        JSON.parse(await readFile(resolve(cwd, specifier.slice(8)), 'utf8')),
      ),
    };
  if (specifier.startsWith('module:'))
    throw new Error('module: harness loading is deferred to #64; use cli or fixture:<file>.');
  throw new Error('--harness must be cli or fixture:<file>.');
}
