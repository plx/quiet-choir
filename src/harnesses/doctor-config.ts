import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';

/** Selected inherited Codex values only; authentication and unrelated configuration stay private. */
export interface InheritedCodexConfig {
  /** Files inspected, in precedence order. */
  readonly files: readonly string[];
  /** Selected native configuration profile, or null. */
  readonly profile: string | null;
  /** Model inherited from these files, or null when the CLI chooses. */
  readonly model: string | null;
  /** Effort inherited from these files, or null when the CLI chooses. */
  readonly effort: string | null;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
async function configFile(
  path: string,
  optional: boolean,
): Promise<Record<string, unknown> | undefined> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (optional && error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw new Error(`Cannot read Codex configuration ${path}.`, { cause: error });
  }
  try {
    return parse(source);
  } catch {
    throw new Error(`Invalid TOML in Codex configuration ${path}.`);
  }
}
/** Read the relevant fields using TOML syntax, including legacy tables and native profile files. */
export async function readInheritedCodexConfig(
  home: string,
  selected?: string,
): Promise<InheritedCodexConfig> {
  const files: string[] = [];
  const basePath = join(home, 'config.toml');
  const base = await configFile(basePath, true);
  if (base) files.push(basePath);
  const profile = selected ?? (typeof base?.['profile'] === 'string' ? base['profile'] : null);
  if (profile !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(profile))
    throw new Error('Invalid Codex configuration profile name.');
  let layer: Record<string, unknown> = {};
  if (profile !== null) {
    const path = join(home, `${profile}.config.toml`);
    const native = await configFile(path, true);
    const legacy = object(base?.['profiles']);
    if (native) {
      layer = native;
      files.push(path);
    } else if (Object.hasOwn(legacy, profile)) layer = object(legacy[profile]);
    else throw new Error(`Codex profile ${profile} has no profile file or legacy table.`);
  }
  const values = { ...base, ...layer };
  return {
    files,
    profile,
    model: typeof values['model'] === 'string' ? values['model'] : null,
    effort:
      typeof values['model_reasoning_effort'] === 'string'
        ? values['model_reasoning_effort']
        : null,
  };
}
