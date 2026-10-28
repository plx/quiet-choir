// codebase-atlas: a small key-value service with an API, a store, a CLI, a release script and a
// CI file. The survey names four subsystems (paths spelled loosely), each reader fills a card, the
// CLI card misses its dependency on the API, and the critic reports that twice under two spellings
// plus the ignored CI file; the repair round corrects the CLI card and adds a CI section, and code
// writes docs/atlas.md, whose map gains the CLI -> API edge only after the repair.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, enumOf, git, leaf, writeFiles } from './_support.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const readme = 'Fixture project\n';

export async function setup(env) {
  await writeFiles(env.cwd, {
    'package.json': '{ "name": "atlas-fixture", "type": "module", "bin": "bin/cli.mjs" }\n',
    'src/server.mjs':
      "import { load, save } from './store.mjs';\nexport const handle = (key, value) => (value === undefined ? load()[key] : save(key, value));\n",
    'src/store.mjs':
      "import { readFileSync, writeFileSync } from 'node:fs';\nexport const load = () => JSON.parse(readFileSync('data.json', 'utf8'));\nexport const save = (key, value) => writeFileSync('data.json', JSON.stringify({ ...load(), [key]: value }));\n",
    'bin/cli.mjs':
      "import { handle } from '../src/server.mjs';\nconsole.log(handle(process.argv[2], process.argv[3]));\n",
    'scripts/release.mjs':
      "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['tag', process.argv[2]]);\n",
    '.github/workflows/ci.yml': 'on: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n',
  });
  commitAll(env.cwd, 'add the key-value service');
}

export const input = () => ({});

const card = (overrides) => ({
  purpose: 'Fixture purpose.',
  entryPoints: [],
  dependsOn: [],
  dataFlows: null,
  gotchas: [],
  ...overrides,
});
const cards = {
  API: card({
    purpose: 'Answers key-value requests.',
    keyFiles: [{ path: 'src/server.mjs', role: 'Request handler' }],
    entryPoints: ['handle() in src/server.mjs'],
    dependsOn: ['Persistence'],
    dataFlows: 'A request reads from or writes to the store.',
    gotchas: ['handle() treats an undefined value as a read.'],
  }),
  Persistence: card({
    purpose: 'Keeps the values in data.json.',
    keyFiles: [{ path: './src/store.mjs', role: 'JSON-file store' }],
    dependsOn: ['the local filesystem'],
    gotchas: ['save() rewrites the whole file, so concurrent writers lose updates.'],
  }),
  // Misses its dependency on the API, which the critic reports.
  CLI: card({
    purpose: 'Runs one request from the command line.',
    keyFiles: [{ path: 'bin/cli.mjs', role: 'Command-line entry' }],
    entryPoints: ['main() in bin/cli.mjs'],
  }),
  'Release scripts': card({
    purpose: 'Tags a release.',
    keyFiles: [{ path: 'scripts/release.mjs', role: 'Tagger' }],
    dependsOn: ['git'],
    gotchas: ['Tags HEAD without checking for a clean tree.'],
  }),
};
const repairs = {
  CLI: card({
    purpose: 'Runs one request from the command line through the API handler.',
    keyFiles: [{ path: 'bin/cli.mjs', role: 'Command-line entry' }],
    entryPoints: ['The module body of bin/cli.mjs'],
    dependsOn: ['API'],
    gotchas: ['Prints the raw handler result.'],
  }),
  'Continuous integration': card({
    purpose: 'Runs the checks on every push.',
    keyFiles: [{ path: '.github/workflows/ci.yml', role: 'CI pipeline' }],
    entryPoints: ['push events'],
    dependsOn: ['GitHub Actions'],
  }),
};
const gaps = [
  {
    section: 'CLI',
    description: 'The CLI calls the API handler, but its card lists no dependency.',
    repairAction: 'Read bin/cli.mjs and list what it imports.',
  },
  {
    section: 'Continuous integration',
    description: '.github/workflows/ci.yml runs the checks, and the atlas ignores it.',
    repairAction: 'Read .github/workflows/ci.yml and describe what it runs.',
  },
  {
    section: 'cli',
    description: 'There is no main(); the module body is the entry point.',
    repairAction: 'Check how bin/cli.mjs starts.',
  },
];

function survey(mode) {
  if (mode === 'empty')
    return {
      projectSummary: 'Nothing the survey names exists.',
      subsystems: [{ name: 'Ghost', paths: ['lib/ghost/'], importance: 'core', hint: null }],
    };
  return {
    projectSummary: 'A tiny key-value service with a command line.',
    subsystems: [
      { name: 'CLI', paths: ['bin/'], importance: 'supporting', hint: 'Command-line entry' },
      { name: 'API', paths: ['src/server.mjs'], importance: 'core', hint: 'Request handling' },
      { name: 'Persistence', paths: ['./src/store.mjs'], importance: 'core', hint: null },
      { name: 'Release scripts', paths: ['scripts'], importance: 'peripheral', hint: null },
      ...(mode === 'degraded'
        ? [{ name: 'Ghost', paths: ['lib/ghost/', '**/*.ts'], importance: 'core', hint: null }]
        : []),
    ],
  };
}

export function reply(request, env, mode) {
  const id = request.call.stepId,
    prompt = request.options.prompt;
  if (id === 'survey') return survey(mode);
  if (/^read\/\d+\/card$/u.test(id)) {
    const name = /^Deep-read the "(.+)" subsystem/u.exec(prompt)[1];
    // In the degraded mode the API card also cites a file that does not exist.
    if (mode === 'degraded' && name === 'API')
      return {
        ...cards.API,
        keyFiles: [...cards.API.keyFiles, { path: 'src/router.mjs', role: 'Invented router' }],
      };
    return cards[name];
  }
  if (id === 'synthesize') {
    const paths = enumOf(request.outputSchema, 'startHere', 'items', 'path');
    return {
      overview:
        'atlas-fixture is a tiny key-value service.\n\nRequests enter through the CLI, pass the API handler and end in the JSON-file store.',
      startHere: paths.slice(0, 3).map((path) => ({ path, why: `Read ${path} early.` })),
    };
  }
  if (id === 'critique')
    return mode === 'replace'
      ? { gaps: [], verdict: 'Complete for a newcomer.' }
      : { gaps, verdict: 'Two sections need repair.' };
  if (/^repairs\/\d+\/repair$/u.test(id))
    return repairs[/^Repair the "(.+)" section/u.exec(prompt)[1]];
  throw new Error(`Unhandled codebase-atlas step ${id} (${mode})`);
}

export function fail(request, mode) {
  const id = request.call.stepId;
  return (
    (mode === 'degraded' && id === 'read/1/card') || (mode === 'critic-fails' && id === 'critique')
  );
}

const shape = (output) =>
  output.subsystems.map((entry) => [entry.name, entry.importance, entry.origin]);
const promptOf = (calls, id) => calls.find((call) => call.call.stepId === id).options.prompt;
/** The text between a template's <tag> delimiters. */
const between = (text, tag) => text.split(`<${tag}>\n`)[1].split(`\n</${tag}>`)[0];

export async function check({ result, env, calls }) {
  const { output } = result;
  assert.equal(output.status, 'repaired');
  assert.equal(output.commit, git(env.cwd, 'rev-parse', 'HEAD'));
  assert.equal(output.dirty, false);
  const written = await readFile(join(env.cwd, 'docs/atlas.md'), 'utf8');
  assert.equal(written, output.atlas);
  assert.deepEqual(output.written, {
    path: join(env.cwd, 'docs/atlas.md'),
    sha256: sha256(written),
    bytes: Buffer.byteLength(written),
    previousSha256: null,
  });
  assert.equal(output.atlasPath, 'docs/atlas.md');
  // Core first, the normalized paths matched, and the repair round corrected one and added one.
  assert.deepEqual(shape(output), [
    ['API', 'core', 'read'],
    ['Persistence', 'core', 'read'],
    ['CLI', 'supporting', 'repaired'],
    ['Release scripts', 'peripheral', 'read'],
    ['Continuous integration', null, 'added'],
  ]);
  assert.deepEqual(output.repairs, [
    { section: 'CLI', gaps: 2, outcome: 'repaired' },
    { section: 'Continuous integration', gaps: 1, outcome: 'added' },
  ]);
  assert.deepEqual(
    [output.skipped, output.unmatched, output.unread, output.droppedPaths, output.unrepaired],
    [[], [], [], [], []],
  );
  assert.deepEqual(output.uncovered, [
    { area: '.github/', files: 1 },
    { area: '.gitignore', files: 1 },
    { area: 'README.md', files: 1 },
    { area: 'package.json', files: 1 },
    { area: 'target.mjs', files: 1 },
  ]);
  assert.equal(output.critique, 'Two sections need repair.');
  // The map is code: its edges are the cards' dependsOn, and the CLI -> API edge exists only after
  // the repair, so the critic's draft lacks it.
  for (const edge of ['s0 --> s1', 's1 --> x0', 's2 --> s0', 's3 --> x1', 's4 --> x2'])
    assert.ok(written.includes(`  ${edge}\n`), edge);
  assert.ok(written.includes('  x0(["the local filesystem"])\n'));
  const draft = between(promptOf(calls, 'critique'), 'atlas');
  assert.ok(draft.includes('  s0 --> s1\n') && !draft.includes('s2 --> s0'));
  assert.ok(!draft.includes('### Continuous integration') && draft.includes('### CLI'));
  assert.ok(promptOf(calls, 'critique').includes('- .github/ (1 file)'));
  assert.ok(
    written.includes(
      '> **Gotchas**\n>\n> - save() rewrites the whole file, so concurrent writers lose updates.',
    ),
  );
  assert.ok(written.includes('- `src/store.mjs`: JSON-file store'));
  assert.ok(written.includes('## Start here\n\n1. `src/server.mjs`: Read src/server.mjs early.\n'));
  assert.ok(!written.includes('## Not covered'));
  // The CLI reader saw its tracked files and the other names; its repair saw both gaps and the card.
  const cli = promptOf(calls, 'read/2/card');
  assert.ok(cli.includes('Its tracked files:\n- bin/cli.mjs'));
  assert.ok(cli.includes('Other sections, by name: API, Persistence, Release scripts.'));
  const repair = promptOf(calls, 'repairs/0/repair');
  assert.ok(repair.includes('Repair the "CLI" section') && repair.includes('There is no main()'));
  assert.deepEqual(JSON.parse(between(repair, 'card')), { ...cards.CLI });
  // The map runs its readers concurrently, so the order of the calls is not the order of the IDs.
  assert.deepEqual(calls.map((call) => call.call.stepId).sort(), [
    'critique',
    'read/0/card',
    'read/1/card',
    'read/2/card',
    'read/3/card',
    'repairs/0/repair',
    'repairs/1/repair',
    'survey',
    'synthesize',
  ]);
  // Nothing an agent runs can write: Claude roles have no write tool, the synthesizer no tool at
  // all, and the critic is Codex in a read-only sandbox.
  for (const call of calls)
    assert.ok(!(call.options.tools ?? []).some((tool) => /^(?:Write|Edit|Bash)/u.test(tool)));
  assert.deepEqual(calls.find((call) => call.call.stepId === 'synthesize').options.tools, []);
  const critic = calls.find((call) => call.call.stepId === 'critique');
  assert.equal(critic.harness, 'codex');
  assert.equal(critic.options.sandbox, 'read-only');
  assert.equal(git(env.cwd, 'status', '--porcelain'), '?? docs/');
}

export const kill = { step: '^write$', boundary: 'checkpoint', writeLocation: 'source-checkout' };

export const modes = [
  {
    mode: 'refused',
    input: () => ({ out: 'README.md' }),
    async check({ result, env, calls }) {
      assert.equal(result.output.status, 'refused');
      assert.equal(calls.length, 0);
      assert.equal(result.output.atlas, null);
      assert.equal(await readFile(join(env.cwd, 'README.md'), 'utf8'), readme);
      assert.equal(git(env.cwd, 'status', '--porcelain'), '');
    },
  },
  {
    mode: 'replace',
    input: () => ({ out: 'README.md', replace: true }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.equal(output.critique, 'Complete for a newcomer.');
      assert.equal(output.written.previousSha256, sha256(readme));
      assert.equal(await readFile(join(env.cwd, 'README.md'), 'utf8'), output.atlas);
      assert.equal(calls.filter((call) => leaf(call.call.stepId) === 'repair').length, 0);
      assert.equal(git(env.cwd, 'status', '--porcelain'), 'M README.md');
    },
  },
  {
    mode: 'degraded',
    input: () => ({ maxSubsystems: 3, maxRepairs: 1 }),
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(output.unmatched, ['Ghost']);
      assert.deepEqual(output.skipped, ['Release scripts']);
      assert.deepEqual(output.unread, ['Persistence']);
      assert.deepEqual(output.droppedPaths, [{ section: 'API', path: 'src/router.mjs' }]);
      assert.deepEqual(output.repairs, [{ section: 'CLI', gaps: 2, outcome: 'repaired' }]);
      assert.deepEqual(output.unrepaired, [{ section: 'Continuous integration', gaps: 1 }]);
      assert.deepEqual(shape(output), [
        ['API', 'core', 'read'],
        ['CLI', 'supporting', 'repaired'],
      ]);
      // Only verified key files of carded sections may start a newcomer off.
      const schema = calls.find((call) => call.call.stepId === 'synthesize').outputSchema;
      assert.deepEqual(enumOf(schema, 'startHere', 'items', 'path'), [
        'src/server.mjs',
        'bin/cli.mjs',
      ]);
      const critique = promptOf(calls, 'critique');
      assert.ok(critique.includes('No card because the reader failed: Persistence.'));
      assert.ok(
        critique.includes(
          'Skipped by the deep-read cap (expected, still worth listing): Release scripts.',
        ),
      );
      const written = await readFile(join(env.cwd, 'docs/atlas.md'), 'utf8');
      assert.equal(written, output.atlas);
      assert.ok(!written.includes('src/router.mjs'));
      assert.ok(written.includes('  x0["Persistence (not deep-read)"]:::uncarded\n'));
      assert.ok(written.includes('- Skipped by the deep-read cap: Release scripts.'));
      assert.ok(written.includes('- Not deep-read because the reader failed: Persistence.'));
      assert.ok(written.includes('- Surveyed, but matching no tracked file: Ghost.'));
    },
  },
  {
    mode: 'critic-fails',
    async check({ result, env, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.equal(output.critique, 'critic unavailable');
      assert.deepEqual(output.repairs, []);
      assert.equal(calls.filter((call) => leaf(call.call.stepId) === 'repair').length, 0);
      // The atlas still lands: it is the draft the critic would have audited.
      const written = await readFile(join(env.cwd, 'docs/atlas.md'), 'utf8');
      assert.equal(written, between(promptOf(calls, 'critique'), 'atlas') + '\n');
      assert.equal(result.steps.critique.status, 'settled-failed');
    },
  },
  {
    mode: 'empty',
    check({ result, env, calls }) {
      assert.equal(result.output.status, 'empty');
      assert.deepEqual(result.output.unmatched, ['Ghost']);
      assert.equal(calls.length, 1);
      assert.equal(existsSync(join(env.cwd, 'docs')), false);
    },
  },
];

/** The fault matrix's status list does not name limited, which a cap leaves the atlas. */
export const degraded = (output) => output.status === 'limited';
