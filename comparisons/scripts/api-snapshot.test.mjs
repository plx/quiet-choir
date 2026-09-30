import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { checkApiSnapshots, deriveApiRevision, hashFile } from './api-snapshot.mjs';

const FILE = 'src/workflow/runtime/model.ts';
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'choir-api-snapshot-'));
  roots.push(root);
  return root;
};
const git = (root, ...args) =>
  execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], {
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const write = (root, path, contents) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
};
const commit = (root, message) => {
  git(root, 'add', '-A');
  git(root, 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
};
const repo = () => {
  const root = temp();
  git(root, 'init', '-q', '-b', 'main');
  return root;
};

const fixture = (mutate = (snapshot) => snapshot) => {
  const root = temp();
  write(root, FILE, 'export const model = 1;\n');
  const good = {
    package: 'quiet-choir 0.0.0',
    file: FILE,
    sha256: hashFile(join(root, FILE)),
    description: 'fixture',
  };
  write(root, 'comparisons/batches/index.json', JSON.stringify(['b1']));
  write(root, 'comparisons/batches/b1/batch.json', JSON.stringify({ apiSnapshot: mutate(good) }));
  return { root, good };
};

describe('checkApiSnapshots', () => {
  it('passes when the keys are exact and sha256 matches the file', () => {
    assert.deepEqual(checkApiSnapshots(fixture().root), []);
  });

  it('reports a sha256 mismatch with both hashes and the batch id', () => {
    const { root, good } = fixture((s) => ({ ...s, sha256: 'a'.repeat(64) }));
    const problems = checkApiSnapshots(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^b1: /);
    assert.ok(problems[0].includes('a'.repeat(64)));
    assert.ok(problems[0].includes(hashFile(join(root, FILE))));
    assert.notEqual(good.sha256, 'a'.repeat(64));
  });

  it('reports a missing API file', () => {
    const { root } = fixture((s) => ({ ...s, file: 'src/missing.ts' }));
    const problems = checkApiSnapshots(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /src\/missing\.ts does not exist/);
  });

  it('reports a leftover revision key as derived-only', () => {
    const { root } = fixture((s) => ({ ...s, revision: 'abc123' }));
    const problems = checkApiSnapshots(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /revision is derived at site build; remove it/);
  });

  it('reports unknown and missing keys', () => {
    const { root } = fixture((s) => {
      const rest = { ...s, extra: 'x' };
      delete rest.description;
      return rest;
    });
    const problems = checkApiSnapshots(root).join('\n');
    assert.match(problems, /apiSnapshot\.extra is not allowed/);
    assert.match(problems, /apiSnapshot\.description must be a non-empty string/);
  });
});

describe('deriveApiRevision', () => {
  const sha = (contents) => {
    const root = temp();
    write(root, 'x', contents);
    return hashFile(join(root, 'x'));
  };

  it('returns the newest commit that set the file to the hash', () => {
    const root = repo();
    write(root, FILE, 'v1\n');
    const v1 = commit(root, 'v1');
    write(root, FILE, 'v2\n');
    const v2 = commit(root, 'v2');
    write(root, 'other.txt', 'unrelated\n');
    commit(root, 'unrelated');
    assert.equal(deriveApiRevision({ repoRoot: root, file: FILE, sha256: sha('v2\n') }), v2);
    assert.equal(deriveApiRevision({ repoRoot: root, file: FILE, sha256: sha('v1\n') }), v1);
    assert.equal(deriveApiRevision({ repoRoot: root, file: FILE, sha256: sha('v3\n') }), null);
  });

  it('names the squash commit on main, not the orphaned feature commit', () => {
    const root = repo();
    write(root, FILE, 'v1\n');
    commit(root, 'v1');
    git(root, 'checkout', '-q', '-b', 'feature');
    write(root, FILE, 'v2\n');
    const feature = commit(root, 'feature');
    git(root, 'checkout', '-q', 'main');
    git(root, 'merge', '--squash', 'feature');
    const squash = commit(root, 'squash');
    git(root, 'branch', '-D', 'feature');
    const derived = deriveApiRevision({ repoRoot: root, file: FILE, sha256: sha('v2\n') });
    assert.equal(derived, squash);
    assert.notEqual(derived, feature);
  });

  it('returns null for an uncommitted change', () => {
    const root = repo();
    write(root, FILE, 'v1\n');
    commit(root, 'v1');
    write(root, FILE, 'dirty\n');
    assert.equal(deriveApiRevision({ repoRoot: root, file: FILE, sha256: sha('dirty\n') }), null);
  });

  it('returns null without throwing outside a git repository', () => {
    const root = temp();
    write(root, FILE, 'v1\n');
    assert.equal(deriveApiRevision({ repoRoot: root, file: FILE, sha256: sha('v1\n') }), null);
  });
});
