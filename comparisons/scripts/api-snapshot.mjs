import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The only keys a batch's `apiSnapshot` may carry. The revision is derived at site build. */
export const API_SNAPSHOT_KEYS = ['description', 'file', 'package', 'sha256'];

/** Command that recomputes the hash after an intentional change to the API file. */
export const REFRESH_HINT = 'shasum -a 256 src/workflow/runtime/model.ts';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** SHA-256 (hex) of a file's bytes. */
export function hashFile(path) {
  return sha256(readFileSync(path));
}

/**
 * Validate `apiSnapshot` in every registered batch against the checkout.
 * Needs no git history. Returns a list of problem strings; empty means valid.
 */
export function checkApiSnapshots(repoRoot) {
  const problems = [];
  const batchRoot = join(repoRoot, 'comparisons', 'batches');
  const ids = JSON.parse(readFileSync(join(batchRoot, 'index.json'), 'utf8'));
  for (const id of ids) {
    const snapshot = JSON.parse(
      readFileSync(join(batchRoot, id, 'batch.json'), 'utf8'),
    ).apiSnapshot;
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      problems.push(`${id}: apiSnapshot is missing or not an object`);
      continue;
    }
    if ('revision' in snapshot)
      problems.push(`${id}: apiSnapshot.revision is derived at site build; remove it`);
    for (const key of Object.keys(snapshot))
      if (key !== 'revision' && !API_SNAPSHOT_KEYS.includes(key))
        problems.push(`${id}: apiSnapshot.${key} is not allowed`);
    for (const key of API_SNAPSHOT_KEYS)
      if (typeof snapshot[key] !== 'string' || snapshot[key] === '')
        problems.push(`${id}: apiSnapshot.${key} must be a non-empty string`);
    if (typeof snapshot.file !== 'string' || snapshot.file === '') continue;
    const path = join(repoRoot, snapshot.file);
    if (!existsSync(path)) {
      problems.push(`${id}: apiSnapshot.file ${snapshot.file} does not exist`);
      continue;
    }
    const actual = hashFile(path);
    if (snapshot.sha256 !== actual)
      problems.push(
        `${id}: apiSnapshot.sha256 is ${snapshot.sha256} but ${snapshot.file} hashes to ${actual}`,
      );
  }
  return problems;
}

const git = (repoRoot, args) =>
  execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });

/**
 * The newest commit reachable from HEAD whose version of `file` hashes to `expected`, or null.
 * Squash merges orphan a PR's own commits, so only HEAD's ancestry is searched. Git failures
 * (not a repository, shallow clone, unborn HEAD) return null.
 */
export function deriveApiRevision({ repoRoot, file, sha256: expected }) {
  try {
    const revisions = git(repoRoot, ['rev-list', 'HEAD', '--', file])
      .toString('utf8')
      .split('\n')
      .filter(Boolean);
    for (const revision of revisions) {
      try {
        if (sha256(git(repoRoot, ['show', `${revision}:${file}`])) === expected) return revision;
      } catch {
        // The file was deleted in this commit; keep walking.
      }
    }
  } catch {
    return null;
  }
  return null;
}
