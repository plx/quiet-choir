// docs-drift-audit: README.md tells readers to pass --yes, but cli.mjs (whose --help output an
// evidence command captures in a checkout of the base) accepts --force. The librarian ranks
// docs/config.md above README.md, the checker finds the README's flag drifted in its own snapshot,
// the fixer patches it in its worktree, the verification command (which fails while README.md
// mentions --yes) passes, a human approves the exact patch, and code publishes it. CHANGELOG.md is
// never listed; docs/notes.txt, matched only by the limits modes' pathspecs, is over its size cap.
// reply() asserts what each agent was told: the committed doc text, and the anchored claims in order.
// Every approval is checked to hold only the fixed docs, integrated onto the base.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, enumOf, git, leaf, writeFiles } from './_support.mjs';

const readme =
  '# Fixture tool\n\n## Usage\n\nRun `node cli.mjs --yes` to skip prompts.\n\nSettings are described in docs/config.md.\n';
const fixedReadme = readme.replace('--yes', '--force');
const config = '# Configuration\n\nSettings live in `settings.json`.\n';
const fixedConfig = config.replace('settings.json', 'config.json');
const help = 'Usage: node cli.mjs [--force] [--quiet]';
const cli = `if (process.argv.includes('--help')) console.log(${JSON.stringify(help)});\n`;
const helpCommand = [process.execPath, 'cli.mjs', '--help'];
/** An ignored build of the tool, present only in the source checkout. */
const builtCli = 'node_modules/fixture-tool/cli.mjs';
const noYes =
  "if(require('node:fs').readFileSync('README.md','utf8').includes('--yes'))process.exit(4)";
/** Appended by the large-patch mode's fixer: multibyte text, so a byte cut could split a character. */
const bulk = `\nNotes on the flags, kept for the fixture: ${'Ünïcödé flägs. '.repeat(4)}\n`.repeat(
  400,
);

export async function setup(env) {
  seen.question = null;
  seen.moveOnAnswer = null;
  await writeFiles(env.cwd, {
    'cli.mjs': cli,
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
const configDrift = {
  status: 'drifted',
  reality: 'The deployed service reads config.json (see its loader)',
  suggestedText: 'Settings live in `config.json`.',
};

const texts = { 'README.md': readme, 'docs/config.md': config };

/** What the extractor returns for `doc` in `mode`; report-only drops a quote's backticks. */
function extracted(doc, mode) {
  const found = claims[doc];
  assert.ok(found, `Unexpected doc ${doc}`);
  if (mode === 'limits') return { claims: [...found, invented], more: false };
  if (mode === 'paraphrase')
    return {
      claims: found.map((claim) => ({ ...claim, quote: `In short: ${claim.claim}` })),
      more: false,
    };
  if (mode === 'report-only' && doc === 'README.md') {
    const [flag, ...rest] = found;
    return { claims: [{ ...flag, quote: flag.quote.replaceAll('`', '') }, ...rest], more: false };
  }
  return { claims: found, more: mode === 'weak-evidence' };
}
/** The checker's claim list: the extracted claims whose quote is in the doc, numbered in order. */
const listing = (doc, mode) =>
  extracted(doc, mode)
    .claims.filter((claim) => claim !== invented)
    .map(
      (claim, index) =>
        `${String(index + 1)}. [${claim.kind}] ${claim.claim}\n   Doc text: "${claim.quote}"\n   Check hint: ${claim.checkHint}`,
    )
    .join('\n');

const docOf = (prompt, pattern) => pattern.exec(prompt)?.[1];
const configDoc = { path: 'docs/config.md', audience: 'operators', priority: 'high' };
const readmeDoc = { path: 'README.md', audience: 'end users', priority: 'medium' };

function classify(request, mode) {
  const { prompt } = request.options;
  if (mode === 'subdir') {
    // Listed from docs/, the paths stay root-relative and the outline still finds the headings.
    assert.deepEqual(enumOf(request.outputSchema, 'docs', 'items', 'path'), ['docs/config.md']);
    assert.match(prompt, /- docs\/config\.md: # Configuration\n/u);
    return { docs: [configDoc] };
  }
  if (mode === 'inventory-cap') {
    // Only the first supported doc in path order reaches the librarian.
    assert.deepEqual(enumOf(request.outputSchema, 'docs', 'items', 'path'), ['README.md']);
    assert.doesNotMatch(prompt, /- docs\//u);
    return { docs: [readmeDoc] };
  }
  assert.deepEqual(enumOf(request.outputSchema, 'docs', 'items', 'path'), [
    'README.md',
    'docs/config.md',
  ]);
  assert.match(
    prompt,
    /- README\.md: # Fixture tool \/ ## Usage\n- docs\/config\.md: # Configuration\n/u,
  );
  if (mode === 'limits') return { docs: [configDoc] };
  if (mode === 'weak-evidence') return { docs: [{ ...configDoc, priority: 'skip' }, readmeDoc] };
  return { docs: [configDoc, readmeDoc] };
}

async function fixDoc(request, env, mode) {
  // Every fixer starts at the root of its checkout, whatever directory the run started in.
  assert.ok(existsSync(join(request.cwd, 'cli.mjs')), request.cwd);
  const doc = docOf(request.options.prompt, /^Update (\S+) to match the code\./u);
  if (doc === 'docs/config.md') {
    await writeFile(join(request.cwd, doc), fixedConfig);
    // The mixed mode's config fixer also edits the code, so its change is refused.
    if (mode === 'mixed') await writeFile(join(request.cwd, 'cli.mjs'), 'export {};\n');
    return { edits: ['Configuration: settings.json is now config.json'] };
  }
  assert.equal(doc, 'README.md');
  const path = join(request.cwd, doc);
  let text = (await readFile(path, 'utf8')).replace('--yes', '--force');
  if (mode === 'declined')
    text = text.replace(
      'Settings are described in docs/config.md.',
      'See the configuration guide.',
    );
  if (mode === 'large-patch') text += bulk;
  if (mode === 'renamed') {
    rmSync(path);
    await writeFile(join(request.cwd, 'GUIDE.md'), text);
  } else await writeFile(path, text);
  if (mode === 'overreach') await writeFile(join(request.cwd, 'cli.mjs'), 'export {};\n');
  // Someone leaves a file in, or commits to, the checkout while the run is in flight.
  if (mode === 'dirtied') writeFileSync(join(env.cwd, 'scratch.txt'), 'local notes\n');
  if (mode === 'moved') {
    await writeFiles(env.cwd, { 'notes.txt': 'Unrelated work\n' });
    env.moved = commitAll(env.cwd, 'unrelated work');
  }
  return { edits: [`${mode === 'declined' ? 'DECLINE ' : ''}Usage: replaced --yes with --force`] };
}

export async function reply(request, env, mode) {
  const id = request.call.stepId;
  const prompt = request.options.prompt;
  if (id === 'classify') return classify(request, mode);
  if (/^docs\/\d+\/extract$/u.test(id)) {
    // The extractor gets the committed text of its doc, whole, inside the document block.
    const doc = docOf(prompt, /^Read (\S+) below/u);
    const text = texts[doc];
    assert.ok(prompt.includes(`<document path="${doc}">\n${text.trim()}\n</document>`), prompt);
    return extracted(doc, mode);
  }
  if (/^docs\/\d+\/check$/u.test(id)) {
    // The checker reads its own checkout of the base, entered at the repository root, and gets
    // the anchored claims in the order its results are paired by.
    assert.ok(existsSync(join(request.cwd, 'cli.mjs')), request.cwd);
    assert.notEqual(request.cwd, env.cwd);
    assert.equal(readFileSync(join(request.cwd, 'cli.mjs'), 'utf8'), cli);
    const doc = docOf(prompt, /^Verify these documentation claims from (\S+) /u);
    assert.ok(prompt.includes(`order you must answer them:\n${listing(doc, mode)}\n\n`), prompt);
    const drifts = mode === 'subdir' || (mode === 'mixed' && doc === 'docs/config.md');
    return { results: drifts ? [configDrift] : results[doc] };
  }
  if (/^docs\/\d+\/fix$/u.test(id)) return fixDoc(request, env, mode);
  throw new Error(`Unhandled docs-drift-audit step ${id} (${mode})`);
}

export function fail(request, mode) {
  return (
    (mode === 'checker-fails' && request.call.stepId === 'docs/0/check') ||
    (mode === 'fixer-fails' && request.call.stepId === 'docs/1/fix')
  );
}

/**
 * The latest approval question, for the checks, and the moved-wait mode's repository, which
 * answer() commits to while the run waits; modes run one at a time and setup() resets both.
 */
const seen = { question: null, moveOnAnswer: null };
const marker = /\n\[\.\.\. \d+ more bytes; the digest covers the whole patch\]$/u;

/**
 * Every approval's details fit the 16 KiB limit, say when they are cut and never split a
 * character. The declined mode's fixer marks its edit, since answer() does not receive the mode.
 */
export function answer(question) {
  seen.question = question;
  const { subject, details } = question;
  assert.ok(Buffer.byteLength(details) <= 16_384);
  assert.equal(marker.test(details), subject.truncated);
  assert.ok(!details.includes('�'));
  const moving = seen.moveOnAnswer;
  if (moving) {
    // Someone commits to the checkout while the approval waits.
    writeFileSync(join(moving.cwd, 'notes.txt'), 'Unrelated work\n');
    moving.moved = commitAll(moving.cwd, 'unrelated work');
    seen.moveOnAnswer = null;
  }
  return subject.docs.some((doc) => doc.edits.some((edit) => edit.startsWith('DECLINE ')))
    ? { approved: false }
    : undefined;
}

export const kill = {
  step: '^docs/\\d+/fix$',
  boundary: 'response',
  writeLocation: 'isolated-checkout',
};

const diffText = (cwd, from, to) =>
  spawnSync('git', ['diff', '--no-color', '--no-ext-diff', from, to, '--'], {
    cwd,
    encoding: 'utf8',
  }).stdout;
const diffDigest = (cwd, from, to) =>
  createHash('sha256')
    .update(diffText(cwd, from, to))
    .digest('hex');
/** The checkout is the base commit with its original docs, and nothing is left behind. */
function untouched(env) {
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.base);
  assert.equal(readFileSync(join(env.cwd, 'README.md'), 'utf8'), readme);
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
}
/** The checkout holds exactly the approved patch on top of the base, and nothing else. */
function published(env, output) {
  assert.equal(output.fix.status, 'applied');
  assert.equal(output.fix.commit, git(env.cwd, 'rev-parse', 'HEAD'));
  assert.equal(output.fix.digest, diffDigest(env.cwd, env.base, 'HEAD'));
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
}
/**
 * The approval showed the fixed docs and nothing else: its commit is the squash integration parented
 * on the base, and its diff names exactly the docs the subject lists.
 */
function approvedOnly(env) {
  const { subject } = seen.question;
  assert.equal(subject.base, env.base);
  assert.equal(git(env.cwd, 'rev-parse', `${subject.commit}^`), env.base);
  assert.deepEqual(
    git(env.cwd, 'diff', '--name-only', env.base, subject.commit).split('\n'),
    subject.docs.map((doc) => doc.doc).sort(),
  );
}
const statuses = (output) =>
  output.docs.map((doc) => [doc.path, ...doc.results.map((r) => r.status)]);
const callsTo = (calls, name) => calls.filter((call) => leaf(call.call.stepId) === name);
const noFix = { digest: null, commit: null, verification: [], omitted: [], failure: null };

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
    { argv: helpCommand, code: 0, truncated: false, failure: null, ok: true },
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
  // Published bytes are the approved bytes: the digest is of the patch from the base to HEAD, and
  // the human saw that whole patch.
  published(env, output);
  assert.deepEqual([output.fix.omitted, output.fix.failure], [[], null]);
  assert.deepEqual(
    output.fix.verification.map((row) => row.code),
    [0],
  );
  assert.equal(suspended, 1);
  assert.equal(seen.question.prompt, 'Publish this verified documentation patch to the checkout?');
  assert.equal(seen.question.details, diffText(env.cwd, env.base, 'HEAD'));
  assert.equal(seen.question.subject.digest, output.fix.digest);
  approvedOnly(env);
  assert.deepEqual(
    seen.question.subject.docs.map((doc) => doc.doc),
    ['README.md'],
  );
  assert.equal(readFileSync(join(env.cwd, 'README.md'), 'utf8'), fixedReadme);
  assert.equal(readFileSync(join(env.cwd, 'docs/config.md'), 'utf8'), config);
  // Only the fixer edits, in its own worktree; the librarian and the extractor have no tools.
  const [fixer, ...others] = callsTo(calls, 'fix');
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
  const checkers = callsTo(calls, 'check');
  assert.equal(checkers.length, 2);
  assert.ok(checkers.every((call) => call.options.prompt.includes(help)));
}

export const modes = [
  {
    // The extractor drops the backticks from the flag's quote; it still anchors and is checked.
    mode: 'report-only',
    input: () => ({ evidenceCommands: [helpCommand] }),
    check({ result, env, calls }) {
      assert.equal(result.output.status, 'complete');
      assert.equal(
        result.output.docs[1].results[0].quote,
        'Run node cli.mjs --yes to skip prompts.',
      );
      assert.deepEqual(
        result.output.docs.map((doc) => doc.unanchored),
        [[], []],
      );
      assert.deepEqual(result.output.fix, { ...noFix, status: 'not-requested' });
      assert.equal(result.output.totals.drifted, 1);
      assert.equal(result.output.totals.fixed, 0);
      assert.equal(callsTo(calls, 'fix').length, 0);
      untouched(env);
    },
  },
  {
    // A report-only run reads snapshots of the base, so a dirty checkout neither blocks nor
    // leaks into it: the checkers see the committed --help, and the edits stay where they were.
    mode: 'dirty-report',
    input: () => ({ evidenceCommands: [helpCommand] }),
    options(opts, env) {
      writeFileSync(join(env.cwd, 'cli.mjs'), "console.log('Usage: node cli.mjs [--yes]');\n");
      writeFileSync(join(env.cwd, 'scratch.txt'), 'local notes\n');
      return opts;
    },
    check({ result, env, calls }) {
      assert.equal(result.output.status, 'complete');
      assert.equal(result.output.totals.drifted, 1);
      const checkers = callsTo(calls, 'check');
      assert.ok(checkers.every((call) => call.options.prompt.includes(help)));
      assert.ok(checkers.every((call) => !call.options.prompt.includes('[--yes]')));
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.base);
      assert.equal(git(env.cwd, 'status', '--porcelain'), 'M cli.mjs\n?? scratch.txt');
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
      assert.deepEqual(seen.question.subject.docs[0].collateral, [
        'docs/config.md describes the settings',
      ]);
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
    // A passing suite that prints more than the retained output still passes.
    mode: 'loud-verify',
    input: () => ({
      fix: true,
      verifyCommands: [[process.execPath, '-e', "process.stdout.write('x'.repeat(100000))"]],
    }),
    check({ result, env }) {
      const { output } = result;
      assert.deepEqual(
        output.fix.verification.map((row) => [row.code, row.truncated]),
        [[0, true]],
      );
      published(env, output);
    },
  },
  {
    mode: 'overreach',
    check({ result, env }) {
      const { output } = result;
      const { fix } = output.docs[1];
      assert.equal(fix.status, 'refused');
      assert.deepEqual(fix.unexpected, [{ path: 'cli.mjs', status: 'modified' }]);
      // The drifted doc stays wrong, so the run says so.
      assert.equal(output.status, 'degraded');
      assert.equal(output.fix.status, 'refused');
      assert.deepEqual(output.fix.omitted, [{ doc: 'README.md', status: 'refused' }]);
      untouched(env);
    },
  },
  {
    mode: 'renamed',
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.docs[1].fix.status, 'refused');
      assert.deepEqual(output.docs[1].fix.unexpected, [{ path: 'GUIDE.md', status: 'renamed' }]);
      assert.equal(output.fix.status, 'refused');
      untouched(env);
    },
  },
  {
    mode: 'fixer-fails',
    check({ result, env, suspended }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.equal(output.docs[1].fix.status, 'failed');
      assert.match(output.docs[1].fix.failure, /exit code/u);
      assert.deepEqual(statuses(output)[1], ['README.md', 'drifted', 'true']);
      assert.equal(output.fix.status, 'failed');
      assert.deepEqual(output.fix.omitted, [{ doc: 'README.md', status: 'failed' }]);
      assert.equal(suspended, 0);
      untouched(env);
    },
  },
  {
    // HEAD moves while the fixer works. ctx.merge would integrate onto it, so the run stops
    // before integrating: nothing is verified, no question is asked and nothing is published.
    mode: 'moved',
    check({ result, env, suspended, calls }) {
      const { output } = result;
      assert.equal(suspended, 0);
      assert.equal(seen.question, null);
      assert.deepEqual(output.fix, { ...noFix, status: 'moved' });
      assert.equal(output.docs[1].fix.status, 'changed');
      assert.equal(output.totals.fixed, 0);
      assert.equal(callsTo(calls, 'fix').length, 1);
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.moved);
      assert.equal(readFileSync(join(env.cwd, 'README.md'), 'utf8'), readme);
      assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
    },
  },
  {
    // HEAD moves while the approval waits: the approved patch was the base plus the fix alone, and
    // the run refuses to publish it onto the moved HEAD.
    mode: 'moved-wait',
    options(opts, env) {
      seen.moveOnAnswer = env;
      return opts;
    },
    check({ result, env, suspended }) {
      const { output } = result;
      assert.equal(suspended, 1);
      assert.equal(output.fix.status, 'moved');
      approvedOnly(env);
      assert.equal(output.fix.commit, seen.question.subject.commit);
      assert.equal(output.fix.digest, diffDigest(env.cwd, env.base, output.fix.commit));
      assert.deepEqual(
        output.fix.verification.map((row) => row.code),
        [0],
      );
      assert.equal(output.totals.fixed, 0);
      assert.match(env.moved, /^[a-f0-9]{40}$/u);
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.moved);
      assert.equal(readFileSync(join(env.cwd, 'README.md'), 'utf8'), readme);
      assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
    },
  },
  {
    // The checkout gained an untracked file after the up-front check: ctx.merge refuses it, and
    // the settled failure keeps the approved digest and the run-owned commit.
    mode: 'dirtied',
    check({ result, env, suspended }) {
      const { output } = result;
      assert.equal(suspended, 1);
      assert.equal(output.fix.status, 'publish-failed');
      assert.match(output.fix.failure, /Merge target checkout is dirty/u);
      assert.equal(output.fix.digest, diffDigest(env.cwd, env.base, output.fix.commit));
      assert.equal(output.totals.fixed, 0);
      assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.base);
      assert.equal(readFileSync(join(env.cwd, 'README.md'), 'utf8'), readme);
      assert.equal(git(env.cwd, 'status', '--porcelain'), '?? scratch.txt');
    },
  },
  {
    // The approval shows a cut, marked preview of a patch over 15,000 bytes; the subject says so.
    mode: 'large-patch',
    check({ result, env }) {
      const { subject, details } = seen.question;
      assert.equal(subject.truncated, true);
      assert.ok(subject.bytes > 15_000);
      assert.equal(subject.bytes, Buffer.byteLength(diffText(env.cwd, env.base, 'HEAD')));
      assert.ok(diffText(env.cwd, env.base, 'HEAD').startsWith(details.replace(marker, '')));
      approvedOnly(env);
      published(env, result.output);
    },
  },
  {
    // No verification commands: the approved patch is published unverified, as the input asked.
    mode: 'checker-fails',
    input: () => ({ fix: true, evidenceCommands: [helpCommand] }),
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(
        output.failed.map((row) => [row.doc, row.step]),
        [['docs/config.md', 'docs/0/check']],
      );
      assert.deepEqual(statuses(output), [['README.md', 'drifted', 'true']]);
      assert.deepEqual(output.fix.verification, []);
      assert.equal(
        seen.question.prompt,
        'Publish this unverified documentation patch to the checkout?',
      );
      published(env, output);
      assert.equal(readFileSync(join(env.cwd, 'README.md'), 'utf8'), fixedReadme);
    },
  },
  {
    // A failed evidence command and a capped claim list degrade; a librarian skip only skips. The
    // operator accepts exit 2 from the second command, so it is not a failure.
    mode: 'weak-evidence',
    input: () => ({
      evidenceCommands: [
        [join(process.cwd(), 'no-such-fixture-tool'), '--help'],
        {
          argv: [process.execPath, '-e', "console.log('partial help'); process.exit(2)"],
          okExitCodes: [0, 2],
        },
      ],
    }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.skipped, [{ doc: 'docs/config.md', reason: 'classified-skip' }]);
      assert.deepEqual(
        output.evidence.map((row) => [row.code, row.truncated, row.failure === null, row.ok]),
        [
          [null, null, false, false],
          [2, false, true, true],
        ],
      );
      assert.deepEqual(
        output.docs.map((doc) => [doc.path, doc.capped]),
        [['README.md', true]],
      );
      const [checker, ...others] = callsTo(calls, 'check');
      assert.equal(others.length, 0);
      assert.match(checker.options.prompt, /outcome="exit 2">\npartial help\n<\/evidence>/u);
      assert.match(
        checker.options.prompt,
        new RegExp(`outcome="${output.evidence[0].failure}; failed"`, 'u'),
      );
      untouched(env);
    },
  },
  {
    // The tool's build is ignored, so it is absent from the fresh checkout the evidence runs in:
    // the command exits 1, which degrades the run, and the checkers are told its output is not
    // evidence. An ignored file does not block the fix run, which still publishes.
    mode: 'missing-build',
    input: () => ({
      fix: true,
      evidenceCommands: [[process.execPath, builtCli, '--help']],
      verifyCommands: [[process.execPath, '-e', noYes]],
    }),
    options(opts, env) {
      mkdirSync(join(env.cwd, 'node_modules/fixture-tool'), { recursive: true });
      writeFileSync(join(env.cwd, builtCli), cli);
      return opts;
    },
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.evidence, [
        {
          argv: [process.execPath, builtCli, '--help'],
          code: 1,
          truncated: false,
          failure: null,
          ok: false,
        },
      ]);
      for (const checker of callsTo(calls, 'check')) {
        assert.ok(checker.options.prompt.includes('outcome="exit 1; failed">'));
        assert.match(checker.options.prompt, /Cannot find module/u);
      }
      published(env, output);
      assert.equal(readFileSync(join(env.cwd, builtCli), 'utf8'), cli);
    },
  },
  {
    // Both docs drift; the config fixer also edits cli.mjs and is refused, and the README fix is
    // published alone. The run is degraded, since docs/config.md stays wrong.
    mode: 'mixed',
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(statuses(output), [
        ['docs/config.md', 'drifted'],
        ['README.md', 'drifted', 'true'],
      ]);
      assert.equal(output.docs[0].fix.status, 'refused');
      assert.deepEqual(output.docs[0].fix.unexpected, [{ path: 'cli.mjs', status: 'modified' }]);
      assert.deepEqual(output.fix.omitted, [{ doc: 'docs/config.md', status: 'refused' }]);
      assert.deepEqual(
        seen.question.subject.docs.map((doc) => doc.doc),
        ['README.md'],
      );
      assert.deepEqual(seen.question.subject.omitted, output.fix.omitted);
      approvedOnly(env);
      assert.deepEqual(output.totals, {
        docs: 2,
        claims: 3,
        drifted: 2,
        unverifiable: 0,
        fixed: 1,
      });
      published(env, output);
      assert.equal(readFileSync(join(env.cwd, 'README.md'), 'utf8'), fixedReadme);
      assert.equal(readFileSync(join(env.cwd, 'docs/config.md'), 'utf8'), config);
      assert.equal(readFileSync(join(env.cwd, 'cli.mjs'), 'utf8'), cli);
    },
  },
  {
    // The extractor paraphrases every quote, so no claim anchors and nothing is checked: an audit
    // that read nothing is degraded, not complete.
    mode: 'paraphrase',
    input: () => ({ fix: true }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(
        output.docs.map((doc) => [doc.path, doc.unanchored.length, doc.results.length]),
        [
          ['docs/config.md', 1, 0],
          ['README.md', 2, 0],
        ],
      );
      assert.equal(output.totals.claims, 0);
      assert.equal(output.fix.status, 'no-drift');
      assert.equal(callsTo(calls, 'check').length, 0);
      untouched(env);
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
      assert.equal(callsTo(calls, 'check').length, 1);
      untouched(env);
    },
  },
  {
    // A doc whose name has a backslash is reported, never audited, and the inventory cap passes
    // only the first supported doc to the librarian: limited, with every left-out doc named.
    mode: 'inventory-cap',
    input: () => ({ maxInventory: 1, evidenceCommands: [helpCommand] }),
    options(opts, env) {
      writeFileSync(join(env.cwd, 'docs/odd\\name.md'), '# Odd\n\nAn oddly named doc.\n');
      env.base = commitAll(env.cwd, 'add an oddly named doc');
      return opts;
    },
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'limited');
      assert.equal(output.base, env.base);
      assert.equal(output.listed, 3);
      assert.deepEqual(output.skipped, [
        { doc: 'docs/odd\\name.md', reason: 'unsupported-path' },
        { doc: 'docs/config.md', reason: 'inventory-cap' },
      ]);
      assert.deepEqual(statuses(output), [['README.md', 'drifted', 'true']]);
      assert.deepEqual([output.failed, output.unclassified], [[], []]);
      assert.equal(callsTo(calls, 'extract').length, 1);
      assert.ok(calls.every((call) => !call.options.prompt.includes('odd\\name')));
      untouched(env);
    },
  },
  {
    // Every matched doc is over the size cap: limited, not "no docs".
    mode: 'capped-out',
    input: () => ({ paths: ['docs/*.txt'], maxDocBytes: 1024, fix: true }),
    check({ result, calls }) {
      assert.equal(result.output.status, 'limited');
      assert.equal(result.output.listed, 1);
      assert.deepEqual(result.output.skipped, [{ doc: 'docs/notes.txt', reason: 'too-large' }]);
      assert.equal(calls.length, 0);
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
    // Started in docs/: pathspecs resolve there, paths stay root-relative, and the evidence
    // command keeps the run's position in its checkout while the agents start at the root.
    mode: 'subdir',
    input: () => ({
      fix: true,
      paths: ['*.md'],
      evidenceCommands: [[process.execPath, '../cli.mjs', '--help']],
    }),
    options: (opts, env) => ({ ...opts, cwd: join(env.cwd, 'docs') }),
    check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.equal(output.listed, 1);
      assert.deepEqual(statuses(output), [['docs/config.md', 'drifted']]);
      assert.equal(output.evidence[0].code, 0);
      assert.ok(callsTo(calls, 'check')[0].options.prompt.includes(help));
      assert.equal(output.docs[0].fix.resolved, 1);
      published(env, output);
      assert.equal(readFileSync(join(env.cwd, 'docs/config.md'), 'utf8'), fixedConfig);
      assert.equal(readFileSync(join(env.cwd, 'README.md'), 'utf8'), readme);
    },
  },
  {
    // A fix run publishes to the checkout, which ctx.merge refuses while an untracked file is
    // there; the workflow refuses before paying any agent.
    mode: 'untracked',
    options(opts, env) {
      writeFileSync(join(env.cwd, 'scratch.txt'), 'local notes\n');
      return opts;
    },
    rejects: /Commit, stash or remove these paths before a fix run[^]*scratch\.txt/u,
    check({ result, calls }) {
      assert.equal(result.status, 'failed');
      assert.equal(calls.length, 0);
    },
  },
  {
    mode: 'dirty',
    options(opts, env) {
      writeFileSync(join(env.cwd, 'docs/config.md'), `${config}Uncommitted.\n`);
      return opts;
    },
    rejects: /Commit, stash or remove these paths before a fix run[^]*docs\/config\.md/u,
    check({ result, calls }) {
      assert.equal(result.status, 'failed');
      assert.equal(calls.length, 0);
    },
  },
];

/**
 * A published fix whose drifted quote is still in its doc may have left the drift in place; the
 * human saw the unresolved claims on approval, so the run's status does not count them.
 */
export const degraded = (output) => output.docs.some((doc) => doc.fix?.unresolved.length > 0);
