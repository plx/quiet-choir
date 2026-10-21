import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { digest } from '../runtime/json.js';

// ADR 0065 section 4: a package run fingerprints every regular file under its root. This module
// walks the directory and summarizes the result; the loader merges the hashes into the source
// fingerprint (loader/source.ts) and the validate package section publishes the digest.

/** Directory entries skipped at any depth of a package walk, files or directories alike. @internal */
export const PACKAGE_EXCLUDED_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git']);

/**
 * The total size of a package's walked files above which validate and execute log a warning
 * naming the largest files (10 MiB), because every resume hashes all of them. @internal
 */
export const PACKAGE_SIZE_WARNING_BYTES = 10 * 1024 * 1024;

/** One regular file under a package root. @internal */
export interface PackageFile {
  /** Absolute path: the real path of the root joined with `relative`. */
  readonly path: string;
  /** Root-relative path with `/` separators. */
  readonly relative: string;
  /** Size in bytes. */
  readonly bytes: number;
}

/** A {@link PackageFile} with the SHA-256 of the bytes that were read. @internal */
export interface HashedPackageFile extends PackageFile {
  /** Hex SHA-256 of the file's bytes. */
  readonly sha256: string;
}

/**
 * Every regular file under a package root, sorted by root-relative path. The walk starts at the
 * root's real path, skips every entry named `node_modules` or `.git` at any depth, and lists only
 * regular files: a file symlink is not listed and a directory symlink is not followed, as in the
 * registry's own walk. TypeScript a symlink reaches stays fingerprinted through the compiler's
 * closure, and templates through the prompt roots. @internal
 */
export async function packageFiles(root: string): Promise<readonly PackageFile[]> {
  const realRoot = await realpath(root);
  const files: PackageFile[] = [];
  const visit = async (directory: string, prefix: readonly string[]): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (PACKAGE_EXCLUDED_NAMES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, [...prefix, entry.name]);
      else if (entry.isFile())
        files.push({
          path,
          relative: [...prefix, entry.name].join('/'),
          bytes: (await stat(path)).size,
        });
    }
  };
  await visit(realRoot, []);
  return files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}

/** Files read at once while hashing a package; the rest wait their turn. @internal */
export const PACKAGE_HASH_CONCURRENCY = 16;

/**
 * Read and hash each walked file; `bytes` becomes the length that was read. At most
 * {@link PACKAGE_HASH_CONCURRENCY} files are open at once, so a large package neither holds all
 * its buffers nor exhausts file descriptors; the result keeps the input order. @internal
 */
export async function hashPackageFiles(
  files: readonly PackageFile[],
): Promise<readonly HashedPackageFile[]> {
  const hashed = new Array<HashedPackageFile>(files.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < files.length; index = next++) {
      const file = files[index];
      if (file === undefined) continue;
      const bytes = await readFile(file.path);
      hashed[index] = {
        ...file,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PACKAGE_HASH_CONCURRENCY, files.length) }, worker),
  );
  return hashed;
}

/**
 * The `files` summary of the validate package section: the file count, total bytes and the
 * {@link digest} of the root-relative path to SHA-256 map, so the digest does not depend on where
 * the package sits on disk. @internal
 */
export function packageFilesDigest(files: readonly HashedPackageFile[]): {
  readonly count: number;
  readonly bytes: number;
  readonly sha256: string;
} {
  return {
    count: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    sha256: digest(Object.fromEntries(files.map((file) => [file.relative, file.sha256]))),
  };
}

/** Binary units: B, KiB, MiB or GiB, one decimal above bytes. */
function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'GiB'}`;
}

/**
 * The warning for a package whose walked files total more than `threshold` bytes, naming the total
 * and the five largest files with their sizes, or null at or below it (ADR 0065 section 4).
 * @internal
 */
export function packageSizeWarning(
  name: string,
  files: readonly PackageFile[],
  threshold: number = PACKAGE_SIZE_WARNING_BYTES,
): string | null {
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total <= threshold) return null;
  const largest = [...files]
    .sort((a, b) => b.bytes - a.bytes || (a.relative < b.relative ? -1 : 1))
    .slice(0, 5)
    .map((file) => `${file.relative} (${size(file.bytes)})`);
  return `Package ${name} holds ${size(total)} in ${String(files.length)} files, above the ${size(threshold)} warning threshold; every resume hashes all of them. Largest: ${largest.join(', ')}.`;
}
