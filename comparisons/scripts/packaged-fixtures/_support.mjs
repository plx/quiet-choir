// Shared support for Batch 03 fixture modules. It imports nothing from idiomatic-fixtures.mjs,
// which loads the fixture modules with top-level await, so a module that imported it back would
// deadlock.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const dated = {
  ...process.env,
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
};

/** Run git in `cwd` with fixed dates and return its trimmed stdout. */
export function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: dated });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Write repository-relative files under `cwd`, creating parent directories. */
export async function writeFiles(cwd, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
}

/** Stage everything and commit it as the fixture identity; returns the new HEAD. */
export function commitAll(cwd, message) {
  git(cwd, 'add', '-A');
  git(
    cwd,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    message,
  );
  return git(cwd, 'rev-parse', 'HEAD');
}

/** The schema-constrained values a reply may use: an enum's members, read from the JSON Schema. */
export const enumOf = (schema, ...path) => {
  let node = schema;
  for (const key of path) node = node?.properties?.[key] ?? node?.items ?? node?.[key];
  assert.ok(Array.isArray(node?.enum), `No enum at ${path.join('.')}`);
  return node.enum;
};

/** The leaf of a step ID, after the last scope or map segment. */
export const leaf = (stepId) => stepId.split('/').at(-1);
