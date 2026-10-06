import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { InstructionSource } from '../harness-kit.js';

/*
 * Discovery rules measured against codex-cli 0.157.1 (2026-10-05; the whitespace rules were also
 * seen on 0.160.0) with the zero-cost fake-API probe in test/harness-isolation-contract.mjs.
 * Restricted calls pass --ignore-user-config, which skips
 * config.toml, so only Codex's built-in defaults apply:
 *
 * - User level: CODEX_HOME/AGENTS.override.md if present, otherwise CODEX_HOME/AGENTS.md.
 * - User skills: CODEX_HOME/skills/<name>/SKILL.md descriptions. Dot-directories are skipped;
 *   Codex writes its own bundled skills to skills/.system.
 * - Project level: from the nearest ancestor of cwd holding a .git entry (file or directory) down
 *   to cwd, each directory contributes AGENTS.override.md if present, otherwise AGENTS.md. With no
 *   .git entry, only cwd is read.
 *
 * Blank means empty or whitespace-only, following Rust's str::trim (Unicode White_Space; a lone
 * U+FEFF is content). Measured by the contract cases codex-restricted-empty-override,
 * codex-restricted-whitespace-override, codex-restricted-whitespace-user-agents and
 * codex-restricted-whitespace-project-agents:
 *
 * - A blank user-level override counts as absent and falls back to AGENTS.md; a blank user-level
 *   AGENTS.md contributes nothing. Neither is recorded.
 * - A project-level override is selected by presence, so a blank one still replaces AGENTS.md in
 *   its directory. It is recorded because it explains why AGENTS.md was not loaded.
 * - A blank project-level AGENTS.md contributes nothing and is not recorded.
 *
 * BOM-only files and invalid UTF-8 were not probed; decoding is non-fatal, so they count as content,
 * which errs toward recording a source. Inherit-mode config keys (project_root_markers, project_doc_fallback_filenames, project_doc_max_bytes) can
 * change what Codex loads and are not modelled; this is a diagnostic, never part of step identity.
 */

/** Skills listed individually before the remainder is only counted. */
const maxSkills = 64;

/** Inputs for {@link detectCodexInstructionSources}. @internal */
export interface CodexInstructionOptions {
  /** Resolved Codex configuration directory. */
  readonly codexHome: string;
  /** Working directory of the Codex call; project files are searched from here. */
  readonly cwd: string;
  /** Cancellation; an abort rejects instead of becoming a warning. */
  readonly signal?: AbortSignal | undefined;
}

/** Instruction sources found for one call, as paths and digests only. @internal */
export interface CodexInstructionDetection {
  /** User sources first, then project sources from the Git root down to cwd. */
  readonly sources: readonly InstructionSource[];
  /** Skill files found beyond the listing cap, counted but not listed. */
  readonly omittedSkills: number;
  /** Read problems; detection never throws for them. */
  readonly warnings: readonly string[];
}

const failure = (path: string, error: unknown): string =>
  `Could not inspect Codex instruction file ${path}: ${(error instanceof Error
    ? error.message
    : String(error)
  ).slice(0, 300)}`;
const absent = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');

async function kindOf(path: string): Promise<'file' | 'directory' | 'absent' | 'other'> {
  try {
    const entry = await stat(path);
    return entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if (absent(error)) return 'absent';
    throw error;
  }
}

const nonWhitespace = /[^\p{White_Space}]/u;

/**
 * Digest of the raw bytes, plus whether the file holds any character that is not Unicode
 * White_Space, found in the same streaming pass without buffering the file.
 */
async function inspect(
  path: string,
  signal: AbortSignal | undefined,
): Promise<{ sha256: string; hasContent: boolean }> {
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let hasContent = false;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      if (!hasContent) hasContent = nonWhitespace.test(decoder.decode(chunk, { stream: true }));
      done();
    },
    final(done) {
      if (!hasContent) hasContent = nonWhitespace.test(decoder.decode());
      done();
    },
  });
  await pipeline(createReadStream(path), sink, ...(signal ? [{ signal }] : []));
  return { sha256: hash.digest('hex'), hasContent };
}

/** The Codex home a child with this environment resolves; empty values count as unset. @internal */
export function codexHomeOf(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env['CODEX_HOME'];
  if (configured) return configured;
  const home = env['HOME'];
  return join(home === undefined || home === '' ? homedir() : home, '.codex');
}

/** Detect the instruction files Codex loads whatever the isolation mode. @internal */
export async function detectCodexInstructionSources(
  options: CodexInstructionOptions,
): Promise<CodexInstructionDetection> {
  const { signal } = options;
  const sources: InstructionSource[] = [];
  const warnings: string[] = [];
  let omittedSkills = 0;
  let listed = 0;
  const add = async (
    scope: InstructionSource['scope'],
    kind: InstructionSource['kind'],
    path: string,
    ifBlank: 'record' | 'skip' = 'record',
  ): Promise<boolean> => {
    signal?.throwIfAborted();
    try {
      if ((await kindOf(path)) !== 'file') return false;
      const { sha256, hasContent } = await inspect(path, signal);
      if (!hasContent && ifBlank === 'skip') return false;
      sources.push({ scope, kind, path, sha256 });
      return true;
    } catch (error) {
      signal?.throwIfAborted();
      if (absent(error)) return false;
      warnings.push(failure(path, error));
      return true;
    }
  };
  // The override replaces the plain file in the same directory.
  const agents = async (scope: InstructionSource['scope'], directory: string): Promise<void> => {
    // Measured: a blank (empty or whitespace-only) user-level override is treated as absent and
    // falls back to AGENTS.md; a project-level override is selected by presence, so a blank one
    // still replaces AGENTS.md and is recorded. A blank AGENTS.md is never recorded.
    if (
      await add(
        scope,
        'agents-override',
        join(directory, 'AGENTS.override.md'),
        scope === 'user' ? 'skip' : 'record',
      )
    )
      return;
    await add(scope, 'agents', join(directory, 'AGENTS.md'), 'skip');
  };

  const home = resolve(options.cwd, options.codexHome);
  await agents('user', home);

  const skills = join(home, 'skills');
  try {
    const names = (await readdir(skills))
      .filter((name) => !name.startsWith('.'))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const name of names) {
      const file = join(skills, name, 'SKILL.md');
      signal?.throwIfAborted();
      if (listed >= maxSkills) {
        try {
          if ((await kindOf(file)) === 'file') omittedSkills += 1;
        } catch (error) {
          signal?.throwIfAborted();
          if (!absent(error)) warnings.push(failure(file, error));
        }
        continue;
      }
      if (await add('user', 'skill', file)) listed += 1;
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (!absent(error)) warnings.push(failure(skills, error));
  }

  const cwd = resolve(options.cwd);
  const directories = [cwd];
  try {
    for (let current = cwd; ; current = dirname(current)) {
      signal?.throwIfAborted();
      if ((await kindOf(join(current, '.git'))) !== 'absent') {
        // Walk from the Git root down to cwd.
        directories.length = 0;
        for (let next = cwd; ; next = dirname(next)) {
          directories.unshift(next);
          if (next === current) break;
        }
        break;
      }
      if (dirname(current) === current) break;
    }
  } catch (error) {
    signal?.throwIfAborted();
    warnings.push(failure(join(cwd, '.git'), error));
  }
  for (const directory of directories) await agents('project', directory);

  return { sources, omittedSkills, warnings };
}

/** One run warning naming the user-level files Codex loads even in restricted mode. @internal */
export function codexInstructionWarning(detection: CodexInstructionDetection): string | undefined {
  const user = detection.sources.filter((source) => source.scope === 'user');
  const files = user.filter((source) => source.kind !== 'skill');
  const skills = user.filter((source) => source.kind === 'skill').length + detection.omittedSkills;
  if (!user.length) return undefined;
  const parts = files.map((source) => `${source.path} (sha256 ${source.sha256.slice(0, 12)})`);
  if (skills) parts.push(`${String(skills)} skill description file${skills === 1 ? '' : 's'}`);
  return `Codex loads user-level instructions in every isolation mode, including restricted: ${parts.join(', ')}. Results can depend on who runs this workflow. Set codex instructions: 'none' to run a call without them.`;
}
