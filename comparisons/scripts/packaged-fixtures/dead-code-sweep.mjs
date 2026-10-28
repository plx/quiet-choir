// dead-code-sweep: legacy.mjs holds an export nothing imports. Two modalities find it, the skeptic
// clears it, a human approves the list, the remover deletes the file in its worktree, and the
// verification command (which fails while legacy.mjs exists) passes before publication.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, git, leaf, writeFiles } from './_support.mjs';

const legacy = {
  identifier: 'oldHelper',
  file: 'legacy.mjs',
  kind: 'function',
  evidence: 'Exported, imported nowhere',
};
const gone = "if(require('node:fs').existsSync('legacy.mjs'))process.exit(3)";

export async function setup(env) {
  await writeFiles(env.cwd, { 'legacy.mjs': 'export function oldHelper() {\n  return 1;\n}\n' });
  commitAll(env.cwd, 'add legacy helper');
}

export const input = () => ({
  scope: '.',
  apply: true,
  verifyCommands: [[process.execPath, '-e', gone]],
});

export async function reply(request, env, mode) {
  const id = request.call.stepId;
  if (/^sweeps\/\d+\/answer$/u.test(id)) {
    const modality = request.options.prompt.includes('exported-but-never-imported')
      ? 'exports'
      : request.options.prompt.includes('entry points')
        ? 'reachability'
        : 'staleness';
    return { candidates: modality === 'staleness' ? [] : [legacy] };
  }
  if (/^cross-check\/\d+\/alive$/u.test(id))
    return { alive: false, reasoning: 'No reference anywhere', referenceFound: null };
  if (leaf(id) === 'remove') {
    await rm(join(request.cwd, 'legacy.mjs'));
    return { summary: 'Deleted legacy.mjs' };
  }
  throw new Error(`Unhandled dead-code-sweep step ${id} (${mode})`);
}

export function fail(request, mode) {
  return mode === 'skeptic-fails' && /^cross-check\/\d+\/alive$/u.test(request.call.stepId);
}

export async function check({ result, env, calls, suspended }) {
  const { output } = result;
  assert.equal(output.status, 'applied');
  assert.equal(output.failedSweeps, 0);
  assert.deepEqual(
    output.confirmedDead.map((c) => [c.file, c.modalities]),
    [['legacy.mjs', 2]],
  );
  assert.equal(suspended, 1);
  assert.ok(output.verification.every((row) => row.code === 0));
  assert.equal(existsSync(join(env.cwd, 'legacy.mjs')), false);
  assert.equal(git(env.cwd, 'status', '--porcelain'), '');
  const remover = calls.find((call) => leaf(call.call.stepId) === 'remove');
  assert.notEqual(remover.cwd, env.cwd);
  assert.ok(
    calls.filter((call) => call !== remover).every((call) => !call.options.tools.includes('Write')),
  );
}

export const kill = {
  step: '^remove$',
  boundary: 'response',
  writeLocation: 'isolated-checkout',
};

export const modes = [
  {
    mode: 'report-only',
    input: () => ({ scope: '.' }),
    check({ result, env, calls }) {
      assert.equal(result.output.status, 'report');
      assert.equal(result.output.confirmedDead.length, 1);
      assert.equal(
        calls.some((call) => leaf(call.call.stepId) === 'remove'),
        false,
      );
      assert.equal(existsSync(join(env.cwd, 'legacy.mjs')), true);
    },
  },
  {
    mode: 'skeptic-fails',
    check({ result, env }) {
      assert.equal(result.output.status, 'nothing-dead');
      assert.deepEqual(
        result.output.kept.map((k) => [k.file, k.checked, k.why]),
        [['legacy.mjs', false, 'check failed; kept by default']],
      );
      assert.equal(existsSync(join(env.cwd, 'legacy.mjs')), true);
    },
  },
  {
    mode: 'red-verify',
    input: () => ({
      scope: '.',
      apply: true,
      verifyCommands: [[process.execPath, '-e', 'process.exit(3)']],
    }),
    check({ result, env }) {
      assert.equal(result.output.status, 'verification-failed');
      assert.equal(result.output.verification[0].code, 3);
      assert.equal(existsSync(join(env.cwd, 'legacy.mjs')), true);
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
    },
  },
];

/** A failed sweep or an unchecked candidate means the sweep did not look everywhere. */
export const degraded = (output) => output.failedSweeps > 0 || output.unchecked.length > 0;
