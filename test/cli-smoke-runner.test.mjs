import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  addedEntries,
  discoverSmokes,
  realStateRoot,
  runSmokes,
  stateSnapshot,
} from '../scripts/run-cli-smokes.mjs';

const roots = [];
const temp = (label) => {
  const root = mkdtempSync(join(tmpdir(), `choir-runner-test-${label}-`));
  roots.push(root);
  return root;
};
after(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

/** Run the runner over fake smokes with a private "real" state root. */
async function run(files, options = {}) {
  const dir = temp('smokes');
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  const real = temp('real');
  const lines = [];
  const outcome = await runSmokes({
    dir,
    concurrency: 2,
    cwd: dir,
    env: { ...process.env, XDG_STATE_HOME: real },
    log: (line) => lines.push(line),
    ...options,
  });
  return { ...outcome, real, log: lines.join('\n') };
}

describe('discoverSmokes', () => {
  it('finds every *smoke.mjs, including cli-smoke.mjs, and nothing else', () => {
    const dir = temp('discover');
    for (const name of ['cli-smoke.mjs', 'x-cli-smoke.mjs', 'x.test.mjs', 'helper.mjs', 'smoke.ts'])
      writeFileSync(join(dir, name), '');
    assert.deepEqual(discoverSmokes(dir), ['cli-smoke.mjs', 'x-cli-smoke.mjs']);
  });

  it('matches the repository smokes, and never the runner test itself', () => {
    const names = discoverSmokes(new URL('.', import.meta.url).pathname);
    assert.ok(names.includes('cli-smoke.mjs'));
    assert.ok(names.includes('schema-values-cli-smoke.mjs'));
    assert.ok(!names.includes('cli-smoke-runner.test.mjs'));
  });
});

describe('addedEntries', () => {
  it('reports additions and ignores deletions', () => {
    assert.deepEqual(addedEntries(['a', 'b/runs/1'], ['a', 'b/runs/1', 'b/runs/2', 'c']), [
      'b/runs/2',
      'c',
    ]);
    assert.deepEqual(addedEntries(['a', 'b'], ['a']), []);
  });
});

describe('stateSnapshot', () => {
  it('lists projects and their runs, and tolerates a missing root', () => {
    const root = temp('snapshot');
    mkdirSync(join(root, 'p-1', 'runs', 'r1'), { recursive: true });
    mkdirSync(join(root, 'p-2'));
    writeFileSync(join(root, 'stray.txt'), '');
    assert.deepEqual(stateSnapshot(root), ['p-1', 'p-1/runs/r1', 'p-2', 'stray.txt']);
    assert.deepEqual(stateSnapshot(join(root, 'missing')), []);
  });

  it('derives the real root from XDG_STATE_HOME, as the runtime does', () => {
    assert.equal(realStateRoot({ XDG_STATE_HOME: '/x/state' }), '/x/state/quiet-choir');
  });
});

describe('runSmokes', () => {
  it('passes when every smoke passes and lists each with a summary', async () => {
    const { exitCode, log } = await run({
      'a-smoke.mjs': 'console.log("fine");',
      'b-smoke.mjs': 'process.exit(0);',
    });
    assert.equal(exitCode, 0, log);
    assert.match(log, /ok\s+a-smoke\.mjs/u);
    assert.match(log, /2 smokes passed/u);
  });

  it('fails on a failing smoke and prints its output tail and the kept state path', async () => {
    const { exitCode, log, results } = await run({
      'good-smoke.mjs': 'console.log("fine");',
      'bad-smoke.mjs': 'console.error("boom-marker"); process.exit(3);',
    });
    assert.equal(exitCode, 1);
    assert.match(log, /FAIL bad-smoke\.mjs/u);
    assert.match(log, /ok\s+good-smoke\.mjs/u);
    assert.match(log, /boom-marker/u);
    assert.match(log, /exit 3/u);
    const bad = results.find((result) => result.name === 'bad-smoke.mjs');
    assert.ok(bad?.xdg && existsSync(bad.xdg), 'a failing smoke keeps its state directory');
    rmSync(bad.xdg, { force: true, recursive: true });
  });

  it('applies substring filters and fails on a filter that matches nothing', async () => {
    const files = { 'a-smoke.mjs': '', 'b-smoke.mjs': 'process.exit(1);' };
    const only = await run(files, { filters: ['a-'] });
    assert.equal(only.exitCode, 0, only.log);
    assert.equal(only.results.length, 1);
    const none = await run(files, { filters: ['zzz'] });
    assert.equal(none.exitCode, 1);
  });

  it('isolates default state: a smoke writing under XDG_STATE_HOME never reaches the real root', async () => {
    const { exitCode, log, real } = await run({
      'writes-smoke.mjs': `
        import { mkdirSync } from 'node:fs';
        import { join } from 'node:path';
        mkdirSync(join(process.env.XDG_STATE_HOME, 'quiet-choir', 'proj-1', 'runs', 'r1'), { recursive: true });`,
    });
    assert.equal(exitCode, 0, log);
    assert.deepEqual(readdirSync(real), []);
  });

  it('strips QUIET_CHOIR_* variables from the smokes', async () => {
    const { exitCode, log } = await run(
      {
        'env-smoke.mjs': `
          const leaked = Object.keys(process.env).filter((k) => k.startsWith('QUIET_CHOIR_'));
          if (leaked.length) { console.error('leaked ' + leaked); process.exit(1); }`,
      },
      {
        env: {
          ...process.env,
          XDG_STATE_HOME: temp('real-env'),
          QUIET_CHOIR_STATE_DIR: '/nope',
          QUIET_CHOIR_HARNESS_CONFIG: '{}',
        },
      },
    );
    assert.equal(exitCode, 0, log);
  });

  it('fails when a smoke adds entries to the real state root', async () => {
    const real = temp('real-leak');
    const { exitCode, log } = await run(
      {
        'leak-smoke.mjs': `
          import { mkdirSync } from 'node:fs';
          import { join } from 'node:path';
          mkdirSync(join(${JSON.stringify(real)}, 'quiet-choir', 'proj-1', 'runs', 'leaked'), { recursive: true });`,
      },
      { env: { ...process.env, XDG_STATE_HOME: real } },
    );
    // The smoke's own XDG_STATE_HOME differs, but it wrote to the real root by absolute path.
    assert.equal(exitCode, 1);
    assert.match(log, /added entries to the real state root/u);
    assert.match(log, /proj-1\/runs\/leaked/u);
  });

  it('kills a smoke that exceeds its timeout and counts it as a failure', async () => {
    const { exitCode, log, results } = await run(
      { 'hang-smoke.mjs': 'setInterval(() => {}, 1000);' },
      { timeoutMs: 300 },
    );
    assert.equal(exitCode, 1);
    assert.match(log, /timed out/u);
    rmSync(results[0].xdg, { force: true, recursive: true });
  });
});
