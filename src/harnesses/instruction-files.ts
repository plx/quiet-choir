import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { InstructionSource } from '../harness-kit.js';

/*
 * Shared file inspection for the native instruction detectors (Codex and Claude). Detection records
 * paths and digests only, never contents, and turns read problems into warnings: only an abort of
 * the caller's signal rejects.
 */

/** Skill files listed individually per detection, across all its skill roots, before the remainder is only counted. @internal */
export const maxSkills = 64;

/**
 * Directory levels below a skill root that are searched for SKILL.md files. Measured against
 * codex-cli 0.160.0 (contract case codex-restricted-skill-layout): a skill directory six levels
 * below the root loads, one seven levels below does not. @internal
 */
export const maxSkillDepth = 6;

/** Directories read per skill root before the listing stops with a warning. */
const maxSkillDirectories = 2000;

/**
 * The home directory a child with this environment resolves. An unset or empty HOME resolves to the
 * OS account home, not to the parent process's own (possibly overridden) HOME. @internal
 */
export function userHomeOf(env: Readonly<Record<string, string | undefined>>): string {
  const home = env['HOME'];
  return home === undefined || home === '' ? accountHome() : home;
}

/** The account's home directory from the OS user database, independent of the HOME variable. */
function accountHome(): string {
  try {
    const { homedir: account } = userInfo();
    if (account !== '') return account;
  } catch {
    // userInfo throws when the user database has no entry for the uid.
  }
  return homedir();
}

/** Whether a filesystem error means the path does not exist. @internal */
export const absent = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');

/** The type of `path`, following symbolic links; only unexpected errors reject. @internal */
export async function kindOf(path: string): Promise<'file' | 'directory' | 'absent' | 'other'> {
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
 * White_Space, found in the same streaming pass without buffering the file. @internal
 */
export async function inspect(
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

/** Sorted by UTF-16 code units, independent of locale. */
const byName = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Skill files listed and counted so far by one detection, shared by all of its skill roots. @internal */
export class SkillBudget {
  /** Skill files recorded as sources. */
  public listed = 0;
  /** Skill files found beyond {@link maxSkills}, counted but not listed. */
  public omitted = 0;
}

/** Collects sources and read warnings for one detection pass. @internal */
export class Collector {
  /** Sources in discovery order. */
  public readonly sources: InstructionSource[] = [];
  /** Read problems, one message each. */
  public readonly warnings: string[] = [];
  readonly #label: string;
  readonly #signal: AbortSignal | undefined;
  /** `label` names the harness in warnings, such as `Codex`. */
  public constructor(label: string, signal: AbortSignal | undefined) {
    this.#label = label;
    this.#signal = signal;
  }

  /** Record a read problem for `path`; rethrows when the signal aborted. */
  public fail(path: string, error: unknown): void {
    this.#signal?.throwIfAborted();
    this.warnings.push(
      `Could not inspect ${this.#label} instruction file ${path}: ${(error instanceof Error
        ? error.message
        : String(error)
      ).slice(0, 300)}`,
    );
  }

  /** Record one file if present; returns whether it counts as found (a read problem does). */
  public async add(
    scope: InstructionSource['scope'],
    kind: InstructionSource['kind'],
    path: string,
    ifBlank: 'record' | 'skip' = 'record',
  ): Promise<boolean> {
    const signal = this.#signal;
    signal?.throwIfAborted();
    try {
      if ((await kindOf(path)) !== 'file') return false;
      const { sha256, hasContent } = await inspect(path, signal);
      if (!hasContent && ifBlank === 'skip') return false;
      this.sources.push({ scope, kind, path, sha256 });
      return true;
    } catch (error) {
      signal?.throwIfAborted();
      if (absent(error)) return false;
      this.fail(path, error);
      return true;
    }
  }

  /**
   * Record the SKILL.md files under one skill root as `kind: 'skill'`: every directory from the root
   * down to {@link maxSkillDepth} levels below it, in sorted order, skipping names that start with a
   * dot. A directory holding SKILL.md is still searched, because Codex loads skills nested inside
   * another skill's directory. Files beyond the budget are counted, not listed.
   */
  public async skills(
    scope: InstructionSource['scope'],
    root: string,
    budget: SkillBudget,
  ): Promise<void> {
    const signal = this.#signal;
    // An object, so the flags read after the recursive walk are not narrowed to their initial values.
    const walk = { visited: 0, truncated: false };
    const visit = async (directory: string, depth: number): Promise<void> => {
      signal?.throwIfAborted();
      if (walk.visited >= maxSkillDirectories) {
        walk.truncated = true;
        return;
      }
      walk.visited += 1;
      let entries: Dirent[];
      try {
        entries = (await readdir(directory, { withFileTypes: true }))
          .filter((entry) => !entry.name.startsWith('.'))
          .sort((left, right) => byName(left.name, right.name));
      } catch (error) {
        signal?.throwIfAborted();
        // A missing root, or a link that does not lead to a directory, holds no skills.
        if (!absent(error)) this.fail(directory, error);
        return;
      }
      if (entries.some((entry) => entry.name === 'SKILL.md')) {
        const file = join(directory, 'SKILL.md');
        if (budget.listed < maxSkills) {
          if (await this.add(scope, 'skill', file)) budget.listed += 1;
        } else {
          try {
            if ((await kindOf(file)) === 'file') budget.omitted += 1;
          } catch (error) {
            if (!absent(error)) this.fail(file, error);
          }
        }
      }
      if (depth >= maxSkillDepth) return;
      // Symbolic links are followed, erring toward recording a skill.
      for (const entry of entries)
        if (entry.name !== 'SKILL.md' && (entry.isDirectory() || entry.isSymbolicLink()))
          await visit(join(directory, entry.name), depth + 1);
    };
    await visit(root, 0);
    if (walk.truncated)
      this.warnings.push(
        `Stopped listing ${this.#label} skills under ${root} after ${String(maxSkillDirectories)} directories; more skill files may load.`,
      );
  }
}
