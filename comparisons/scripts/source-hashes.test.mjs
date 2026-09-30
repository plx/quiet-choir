import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { checkSourceHashes } from './source-hashes.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const write = (root, path, contents) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
};
const batchPath = (id, path) => `comparisons/batches/${id}/${path}`;

/**
 * A temporary repository root with two valid batches. `mutate(root)` then derives a variant.
 * The originals contain non-UTF-8 bytes, so a hash over a decoded string would not match.
 */
const fixture = (mutate = () => {}) => {
  const root = mkdtempSync(join(tmpdir(), 'choir-source-hashes-'));
  roots.push(root);
  const ids = ['02-second', '01-first'];
  write(root, 'comparisons/batches/index.json', JSON.stringify(ids));
  for (const id of ids) {
    const files = {
      'alpha.js': Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0xff, 0xfe, 0x0a]),
      'beta.js': Buffer.from(`// ${id} beta\n`),
    };
    const license = Buffer.from(`MIT License for ${id}\n`);
    const hashes = { LICENSE: sha256(license) };
    for (const [name, bytes] of Object.entries(files)) {
      write(root, batchPath(id, `originals/${name}`), bytes);
      hashes[name] = sha256(bytes);
    }
    write(root, batchPath(id, 'LICENSE'), license);
    write(root, batchPath(id, 'source-hashes.json'), JSON.stringify(hashes, null, 2));
  }
  mutate(root);
  return root;
};
const hashesOf = (id) => batchPath(id, 'source-hashes.json');
const rewriteHashes = (root, id, edit) => {
  const hashes = JSON.parse(readFileSync(join(root, hashesOf(id)), 'utf8'));
  edit(hashes);
  write(root, hashesOf(id), JSON.stringify(hashes, null, 2));
};

describe('checkSourceHashes', () => {
  it('accepts an untouched fixture', () => {
    assert.deepEqual(checkSourceHashes(fixture()), []);
  });

  it('reports an edited original with the recorded and actual hashes', () => {
    const root = fixture((r) =>
      write(r, batchPath('01-first', 'originals/beta.js'), '// edited\n'),
    );
    const problems = checkSourceHashes(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^01-first: originals\/beta\.js hashes to [0-9a-f]{64} but/);
    assert.ok(problems[0].includes(sha256('// edited\n')));
    assert.ok(problems[0].includes(sha256('// 01-first beta\n')));
  });

  it('reports a byte change that decodes to the same text', () => {
    const root = fixture((r) =>
      write(r, batchPath('01-first', 'originals/alpha.js'), Buffer.from([0x63, 0xff, 0xff, 0x0a])),
    );
    assert.match(checkSourceHashes(root).join('\n'), /originals\/alpha\.js hashes to/);
  });

  it('reports an edited LICENSE', () => {
    const root = fixture((r) => write(r, batchPath('01-first', 'LICENSE'), 'Proprietary\n'));
    const problems = checkSourceHashes(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^01-first: LICENSE hashes to [0-9a-f]{64} but/);
  });

  it('reports an original with no entry', () => {
    const root = fixture((r) => write(r, batchPath('01-first', 'originals/gamma.js'), '// new\n'));
    assert.deepEqual(checkSourceHashes(root), [
      '01-first: originals/gamma.js has no entry in source-hashes.json',
    ]);
  });

  it('reports an entry with no file', () => {
    const root = fixture((r) =>
      rewriteHashes(r, '01-first', (hashes) => {
        hashes['gone.js'] = sha256('x');
      }),
    );
    assert.deepEqual(checkSourceHashes(root), [
      '01-first: source-hashes.json records gone.js but originals/gone.js does not exist',
    ]);
  });

  it('reports a missing LICENSE entry', () => {
    const root = fixture((r) =>
      rewriteHashes(r, '01-first', (hashes) => {
        delete hashes.LICENSE;
      }),
    );
    assert.deepEqual(checkSourceHashes(root), [
      '01-first: LICENSE has no entry in source-hashes.json',
    ]);
  });

  it('reports a missing LICENSE file', () => {
    const root = fixture((r) => rmSync(join(r, batchPath('01-first', 'LICENSE'))));
    assert.deepEqual(checkSourceHashes(root), ['01-first: LICENSE does not exist']);
  });

  it('reports a value that is not a lowercase hex SHA-256', () => {
    for (const bad of ['xyz', sha256('a').toUpperCase(), 42, null]) {
      const root = fixture((r) =>
        rewriteHashes(r, '01-first', (hashes) => {
          hashes['alpha.js'] = bad;
        }),
      );
      const problems = checkSourceHashes(root);
      assert.deepEqual(problems, [
        '01-first: source-hashes.json alpha.js is not a 64-character lowercase hex SHA-256',
      ]);
    }
  });

  it('reports a key that is neither LICENSE nor a .js file', () => {
    const root = fixture((r) =>
      rewriteHashes(r, '01-first', (hashes) => {
        hashes['notes.md'] = sha256('x');
      }),
    );
    assert.deepEqual(checkSourceHashes(root), [
      '01-first: source-hashes.json key notes.md is neither LICENSE nor a .js file',
    ]);
  });

  it('ignores non-.js files in originals/', () => {
    const root = fixture((r) => {
      write(r, batchPath('01-first', 'originals/.DS_Store'), 'junk');
      write(r, batchPath('01-first', 'originals/README.md'), 'junk');
    });
    assert.deepEqual(checkSourceHashes(root), []);
  });

  it('reports a problem in the second registered batch', () => {
    const root = fixture((r) => write(r, batchPath('02-second', 'originals/alpha.js'), '// x\n'));
    const problems = checkSourceHashes(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^02-second: originals\/alpha\.js hashes to/);
  });

  it('reports unreadable metadata instead of throwing', () => {
    const noHashes = fixture((r) => rmSync(join(r, hashesOf('01-first'))));
    assert.match(checkSourceHashes(noHashes)[0], /^01-first: source-hashes\.json cannot be read/);
    const badJson = fixture((r) => write(r, hashesOf('01-first'), '{'));
    assert.match(checkSourceHashes(badJson)[0], /^01-first: source-hashes\.json cannot be read/);
    const notObject = fixture((r) => write(r, hashesOf('01-first'), '[]'));
    assert.match(
      checkSourceHashes(notObject)[0],
      /^01-first: source-hashes\.json is not an object/,
    );
    const noOriginals = fixture((r) =>
      rmSync(join(r, batchPath('01-first', 'originals')), { recursive: true }),
    );
    assert.match(checkSourceHashes(noOriginals)[0], /^01-first: originals\/ cannot be read/);
    const noIndex = fixture((r) => rmSync(join(r, 'comparisons/batches/index.json')));
    assert.match(
      checkSourceHashes(noIndex)[0],
      /^comparisons\/batches\/index\.json cannot be read/,
    );
  });

  it('accepts the real repository: originals and LICENSE are unchanged', () => {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    assert.deepEqual(checkSourceHashes(repoRoot), []);
  });
});
