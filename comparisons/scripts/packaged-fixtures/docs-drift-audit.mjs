// docs-drift-audit: README.md tells readers to pass --yes, but cli.mjs (whose --help output an
// evidence command captures) accepts --force. The librarian ranks docs/config.md above README.md,
// the checker finds the README's flag drifted, the fixer patches it in its worktree, the
// verification command (which fails while README.md mentions --yes) passes, a human approves the
// exact patch, and code publishes it. CHANGELOG.md is never listed; docs/notes.txt, matched only
// by the limits mode's pathspecs, is over its size cap.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, enumOf, git, leaf, writeFiles } from './_support.mjs';

const readme =
  '# Fixture tool\n\n## Usage\n\nRun `node cli.mjs --yes` to skip prompts.\n\nSettings are described in docs/config.md.\n';
const fixedReadme = readme.replace('--yes', '--force');
const config = '# Configuration\n\nSettings live in `settings.json`.\n';
const help = 'Usage: node cli.mjs [--force] [--quiet]';
const helpCommand = [process.execPath, 'cli.mjs', '--help'];
const noYes =
  "if(require('node:fs').readFileSync('README.md','utf8').includes('--yes'))process.exit(4)";

export async function setup(env) {
  await writeFiles(env.cwd, {
    'cli.mjs': `if (process.argv.includes('--help')) console.log(${JSON.stringify(help)});\n`,
    'README.md': readme,
    'docs/config.md': config,
    'CHANGELOG.md': '# Changelog\n\n- 0.1: added --yes\n',
    'docs/notes.txt': 'Design notes\n'.repeat(200),
  });
  env.base = commitAll(env.cwd, 'add docs');
}

export const input = () => ({
  fix: true,
  evidenceCommands: [helpCommand],
  verifyCommands: [[process.execPath, '-e', noYes]],
});

const claims = {
  'README.md': [
    {
      claim: 'The CLI accepts --yes to skip prompts',
      kind: 'command',
      checkHint: 'Look for --yes in the argument handling of cli.mjs',
      quote: 'Run `node cli.mjs --yes` to skip prompts.',
    },
    {
      claim: 'docs/config.md describes the settings',
      kind: 'path',
      checkHint: 'Check that docs/config.md exists',
      quote: 'Settings are described in docs/config.md.',
    },
  ],
  'docs/config.md': [
    {
      claim: 'Settings live in settings.json',
      kind: 'config',
      checkHint: 'Find the code that loads settings',
      quote: 'Settings live in `settings.json`.',
    },
  ],
};
const invented = {
  claim: 'The tool installs from npm',
  kind: 'command',
  checkHint: 'Check package.json',
  quote: 'Install it with `npm install fixture-tool`.',
};
const results = {
  'README.md': [
    {
      status: 'drifted',
      reality: 'cli.mjs accepts --force and --quiet, not --yes (see the --help output)',
      suggestedText: 'Run `node cli.mjs --force` to skip prompts.',
    },
    { status: 'true', reality: 'docs/config.md exists', suggestedText: null },
  ],
  'docs/config.md': [
    {
      status: 'unverifiable',
      reality: 'No settings loader is in the repository; it ships with the deployed service',
      suggestedText: null,
    },
  ],
};

const docOf = (prompt, pattern) => pattern.exec(prompt)?.[1];

export async function reply(request, env, mode) {
  const id = request.call.stepId;
  const prompt = request.options.prompt;
  if (id === 'classify') {
    assert.deepEqual(enumOf(request.outputSchema, 'docs', 'items', 'path'), [
      'README.md',
      'docs/config.md',
    ]);
    assert.match(
      prompt,
      /- README\.md: # Fixture tool \/ ## Usage\n- docs\/config\.md: # Configuration\n/u,
    );
    const configDoc = { path: 'docs/config.md', audience: 'operators', priority: 'high' };
    const readmeDoc = { path: 'README.md', audience: 'end users', priority: 'medium' };
    return { docs: mode === 'limits' ? [configDoc] : [configDoc, readmeDoc] };
  }
  if (/^docs\/\d+\/extract$/u.test(id)) {
    const doc = docOf(prompt, /^Read (\S+) below/u);
    const found = claims[doc];
    assert.ok(found, `Unexpected doc ${doc}`);
    return { claims: mode === 'limits' ? [...found, invented] : found, more: false };
  }
  if (/^docs\/\d+\/check$/u.test(id)) {
    return { results: results[docOf(prompt, /^Verify these documentation claims from (\S+) /u)] };
  }
  if (/^docs\/\d+\/fix$/u.test(id)) {
    const path = join(request.cwd, 'README.md');
    let text = (await readFile(path, 'utf8')).replace('--yes', '--force');
    if (mode === 'declined')
      text = text.replace(
        'Settings are described in docs/config.md.',
        'See the configuration guide.',
      );
    await writeFile(path, text);
    if (mode === 'overreach') await writeFile(join(request.cwd, 'cli.mjs'), 'export {};\n');
    // Someone commits to the checkout while the run is in flight.
    if (mode === 'moved') {
      await writeFiles(env.cwd, { 'notes.txt': 'Unrelated work\n' });
      env.moved = commitAll(env.cwd, 'unrelated work');
    }
    return {
      edits: [`${mode === 'declined' ? 'DECLINE ' : ''}Usage: replaced --yes with --force`],
    };
  }
  throw new Error(`Unhandled docs-drift-audit step ${id} (${mode})`);
}

export function fail(request, mode) {
  return mode === 'checker-fails' && request.call.stepId === 'docs/0/check';
}

/** The declined mode's fixer marks its edit, since answer() does not receive the mode. */
export const answer = (question) =>
  question.subject?.docs?.some((doc) => doc.edits.some((edit) => edit.startsWith('DECLINE ')))
    ? { approved: false }
    : undefined;

export const kill = {
  step: '^docs/\\d+/fix$',
  boundary: 'response',
  writeLocation: 'isolated-checkout',
};

const diffDigest = (cwd, from, to) =>
  createHash('sha256')
    .update(
      spawnSync('git', ['diff', '--no-color', '--no-ext-diff', from, to, '--'], {
        cwd,
        encoding: 'utf8',
      }).stdout,
    )
    .digest('hex');
/** The checkout is the base commit with its original docs, and nothing is left behind. */
function untouched(env) {
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.base);
  assert.equal(readFileSync(join(env.cwd, 'README.md'), 'utf8'), readme);
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
}
const statuses = (output) =>
  output.docs.map((doc) => [doc.path, ...doc.results.map((r) => r.status)]);
const fixCalls = (calls) => calls.filter((call) => leaf(call.call.stepId) === 'fix');

export function check({ result, env, calls, suspended }) {
  const { output } = result;
  assert.equal(output.status, 'complete');
  assert.equal(output.base, env.base);
  assert.equal(output.listed, 2);
  assert.deepEqual(
    output.docs.map((doc) => [doc.path, doc.priority, doc.audience]),
    [
      ['docs/config.md', 'high', 'operators'],
      ['README.md', 'medium', 'end users'],
    ],
  );
  assert.deepEqual(statuses(output), [
    ['docs/config.md', 'unverifiable'],
    ['README.md', 'drifted', 'true'],
  ]);
  assert.deepEqual(output.totals, { docs: 2, claims: 3, drifted: 1, unverifiable: 1, fixed: 1 });
  assert.deepEqual([output.skipped, output.failed, output.unclassified], [[], [], []]);
  assert.deepEqual(output.evidence, [
    { argv: helpCommand, code: 0, truncated: false, failure: null },
  ]);
  const fix = output.docs[1].fix;
  assert.match(fix.commit, /^[a-f0-9]{40}$/u);
  assert.deepEqual(
    { ...fix, commit: null },
    {
      status: 'changed',
      commit: null,
      edits: ['Usage: replaced --yes with --force'],
      resolved: 1,
      unresolved: [],
      collateral: [],
      unexpected: [],
      failure: null,
    },
  );
  // Published bytes are the approved bytes: the digest is of the patch from the base to HEAD.
  assert.equal(output.fix.status, 'applied');
  assert.equal(output.fix.commit, git(env.cwd, 'rev-parse', 'HEAD'));
  assert.equal(output.fix.digest, diffDigest(env.cwd, env.base, 'HEAD'));
  assert.deepEqual(
    output.fix.verification.map((row) => row.code),
    [0],
  );
  assert.equal(suspended, 1);
  assert.equal(readFileSync(join(env.cwd, 'README.md'), 'utf8'), fixedReadme);
  assert.equal(readFileSync(join(env.cwd, 'docs/config.md'), 'utf8'), config);
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
  // Only the fixer edits, in its own worktree; the librarian and the extractor have no tools.
  const [fixer, ...others] = fixCalls(calls);
  assert.equal(others.length, 0);
  assert.notEqual(fixer.cwd, env.cwd);
  assert.ok(
    fixer.options.prompt.includes('Suggested text: Run `node cli.mjs --force` to skip prompts.'),
  );
  assert.ok(fixer.options.prompt.includes('- "Settings are described in docs/config.md."'));
  for (const call of calls.filter((c) => c !== fixer))
    assert.ok(!(call.options.tools ?? []).includes('Write'), call.call.stepId);
  for (const call of calls.filter((c) => /^(?:classify|docs\/\d+\/extract)$/u.test(c.call.stepId)))
    assert.deepEqual(call.options.tools ?? [], [], call.call.stepId);
  assert.ok(calls.every((call) => !call.options.prompt.includes('CHANGELOG')));
  // Code ran the --help command once; every checker read its output.
  const checkers = calls.filter((call) => leaf(call.call.stepId) === 'check');
  assert.equal(checkers.length, 2);
  assert.ok(checkers.every((call) => call.options.prompt.includes(help)));
}

export const modes = [
  {
    mode: 'report-only',
    input: () => ({ evidenceCommands: [helpCommand] }),
    check({ result, env, calls }) {
      assert.equal(result.output.status, 'complete');
      assert.deepEqual(result.output.fix, {
        status: 'not-requested',
        digest: null,
        commit: null,
        verification: [],
      });
      assert.equal(result.output.totals.drifted, 1);
      assert.equal(result.output.totals.fixed, 0);
      assert.equal(fixCalls(calls).length, 0);
      untouched(env);
    },
  },
  {
    mode: 'declined',
    check({ result, env, suspended }) {
      const { output } = result;
      assert.equal(suspended, 1);
      assert.equal(output.fix.status, 'declined');
      assert.match(output.fix.digest, /^[a-f0-9]{64}$/u);
      assert.equal(output.fix.digest, diffDigest(env.cwd, env.base, output.fix.commit));
      assert.deepEqual(output.docs[1].fix.collateral, ['docs/config.md describes the settings']);
      assert.equal(output.totals.fixed, 0);
      // The proposal survives in the run-owned integration commit; the checkout does not change.
      assert.match(git(env.cwd, 'show', `${output.fix.commit}:README.md`), /--force/u);
      untouched(env);
    },
  },
  {
    mode: 'red-verify',
    input: () => ({ fix: true, verifyCommands: [[process.execPath, '-e', 'process.exit(3)']] }),
    check({ result, env, suspended }) {
      assert.equal(result.output.fix.status, 'verification-failed');
      assert.equal(result.output.fix.verification[0].code, 3);
      assert.equal(result.output.fix.digest, null);
      assert.equal(suspended, 0);
      untouched(env);
    },
  },
  {
    mode: 'overreach',
    check({ result, env }) {
      const { fix } = result.output.docs[1];
      assert.equal(fix.status, 'refused');
      assert.deepEqual(fix.unexpected, [{ path: 'cli.mjs', status: 'modified' }]);
      assert.equal(result.output.fix.status, 'no-change');
      untouched(env);
    },
  },
  {
    mode: 'moved',
    check({ result, env, suspended }) {
      const { output } = result;
      assert.equal(suspended, 1);
      assert.equal(output.fix.status, 'moved');
      assert.equal(output.fix.digest, diffDigest(env.cwd, env.base, output.fix.commit));
      assert.equal(output.totals.fixed, 0);
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.moved);
      assert.equal(readFileSync(join(env.cwd, 'README.md'), 'utf8'), readme);
      assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
    },
  },
  {
    mode: 'checker-fails',
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(
        output.failed.map((row) => [row.doc, row.step]),
        [['docs/config.md', 'docs/0/check']],
      );
      assert.deepEqual(statuses(output), [['README.md', 'drifted', 'true']]);
      assert.equal(output.fix.status, 'applied');
      assert.equal(readFileSync(join(env.cwd, 'README.md'), 'utf8'), fixedReadme);
    },
  },
  {
    mode: 'limits',
    input: () => ({
      paths: ['*.md', 'docs/*.txt'],
      maxDocs: 1,
      maxDocBytes: 1024,
      evidenceCommands: [helpCommand],
    }),
    check({ result, env, calls }) {
      const { output } = result;
      // The unclassified README ranks last, so the one-doc cap skips it.
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.unclassified, ['README.md']);
      assert.equal(output.listed, 3);
      assert.deepEqual(output.skipped, [
        { doc: 'docs/notes.txt', reason: 'too-large' },
        { doc: 'README.md', reason: 'max-docs' },
      ]);
      assert.deepEqual(output.docs[0].unanchored, ['The tool installs from npm']);
      assert.equal(output.docs[0].results.length, 1);
      assert.equal(degraded(output), true);
      assert.equal(calls.filter((call) => leaf(call.call.stepId) === 'check').length, 1);
      untouched(env);
    },
  },
  {
    mode: 'no-docs',
    input: () => ({ paths: ['*.nothing'], fix: true }),
    check({ result, calls }) {
      assert.equal(result.output.status, 'no-docs');
      assert.equal(result.output.listed, 0);
      assert.equal(calls.length, 0);
    },
  },
  {
    mode: 'dirty',
    options(opts, env) {
      writeFileSync(join(env.cwd, 'docs/config.md'), `${config}Uncommitted.\n`);
      return opts;
    },
    rejects: /Commit or stash tracked changes/u,
    check({ result, calls }) {
      assert.equal(result.status, 'failed');
      assert.equal(calls.length, 0);
    },
  },
];

/** A claim dropped for a quote that is not in its doc may be a real claim the audit never checked. */
export const degraded = (output) => output.docs.some((doc) => doc.unanchored.length > 0);
