import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { hashFile } from './api-snapshot.mjs';

/** The `source-hashes.json` key for the batch-root LICENSE file. */
export const LICENSE_KEY = 'LICENSE';

/** What to do about a failing upstream source check. */
export const SOURCE_HASH_HINT =
  'The upstream originals and LICENSE are immutable pinned snapshots: restore a changed file ' +
  'with `git checkout -- <path>`. Record hashes (`shasum -a 256 <file>`) in source-hashes.json ' +
  'only when adding a new batch.';

const HASH = /^[0-9a-f]{64}$/;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Check every registered batch's upstream `originals/*.js` files and batch-root `LICENSE`
 * against the SHA-256 hashes (of the raw bytes) in its `source-hashes.json`. Reports files
 * without an entry, entries whose hash differs, and stale entries without a file. Needs no git
 * history and never throws for bad input. Returns a list of problem strings; empty means valid.
 */
export function checkSourceHashes(repoRoot) {
  const problems = [];
  const batchRoot = join(repoRoot, 'comparisons', 'batches');
  let ids;
  try {
    ids = readJson(join(batchRoot, 'index.json'));
  } catch (error) {
    return [`comparisons/batches/index.json cannot be read: ${error.message}`];
  }
  if (!Array.isArray(ids)) return ['comparisons/batches/index.json is not an array'];
  for (const id of ids) {
    const dir = join(batchRoot, id);
    const report = (message) => problems.push(`${id}: ${message}`);

    let recorded;
    try {
      recorded = readJson(join(dir, 'source-hashes.json'));
    } catch (error) {
      report(`source-hashes.json cannot be read: ${error.message}`);
      continue;
    }
    if (recorded === null || typeof recorded !== 'object' || Array.isArray(recorded)) {
      report('source-hashes.json is not an object of file names to SHA-256 hashes');
      continue;
    }
    for (const [key, value] of Object.entries(recorded))
      if (typeof value !== 'string' || !HASH.test(value))
        report(`source-hashes.json ${key} is not a 64-character lowercase hex SHA-256`);

    let originals;
    try {
      originals = readdirSync(join(dir, 'originals')).filter((name) => name.endsWith('.js'));
    } catch (error) {
      report(`originals/ cannot be read: ${error.message}`);
      continue;
    }
    originals.sort();
    const check = (key, relative) => {
      const path = join(dir, relative);
      if (!existsSync(path) || !statSync(path).isFile()) {
        report(`${relative} does not exist`);
        return;
      }
      if (!(key in recorded)) {
        report(`${relative} has no entry in source-hashes.json`);
        return;
      }
      if (typeof recorded[key] !== 'string' || !HASH.test(recorded[key])) return;
      const actual = hashFile(path);
      if (actual !== recorded[key])
        report(`${relative} hashes to ${actual} but source-hashes.json records ${recorded[key]}`);
    };
    for (const name of originals) check(name, `originals/${name}`);
    check(LICENSE_KEY, LICENSE_KEY);

    for (const key of Object.keys(recorded).sort()) {
      if (key === LICENSE_KEY) continue;
      if (!key.endsWith('.js'))
        report(`source-hashes.json key ${key} is neither LICENSE nor a .js file`);
      else if (!originals.includes(key))
        report(`source-hashes.json records ${key} but originals/${key} does not exist`);
    }
  }
  return problems;
}
