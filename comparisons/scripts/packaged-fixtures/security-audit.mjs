// security-audit: a commit adds a small HTTP server and a config module. Five lenses report seven
// findings: code dismisses three unpanelled (a missing file, a directory, a line past the end); a
// critical hardcoded key and a high command injection face three seats, a path traversal and an
// open redirect one. Two of three uphold the injection and a lone seat refutes the traversal. Every
// reader works in a snapshot of the pinned head, started at its root, and the checkout stays
// untouched.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, git, writeFiles } from './_support.mjs';

const server = [
  "import { createServer } from 'node:http';",
  "import { exec } from 'node:child_process';",
  "import { readFile } from 'node:fs/promises';",
  '',
  'export const server = createServer(async (req, res) => {',
  "  const url = new URL(req.url, 'http://localhost');",
  "  if (url.pathname === '/thumb') {",
  "    exec(`convert ${url.searchParams.get('file')} thumb.png`);",
  "    return res.end('ok');",
  '  }',
  "  if (url.pathname === '/doc') {",
  "    return res.end(await readFile(`docs/${url.searchParams.get('name')}`));",
  '  }',
  "  if (url.pathname === '/go') {",
  "    res.writeHead(302, { location: url.searchParams.get('to') });",
  '    return res.end();',
  '  }',
  '  res.statusCode = 404;',
  '  res.end();',
  '});',
].join('\n');
const config = "export const apiKey = 'sk_live_fixture_0000';\nexport const port = 8080;\n";

const surface = {
  entryPoints: ['server.mjs: GET /thumb', 'server.mjs: GET /doc', 'server.mjs: GET /go'],
  trustBoundaries: [],
  secretsHandling: ['config.mjs: apiKey'],
  dependencies: [],
  summary: 'One unauthenticated HTTP server with three routes.',
};
const finding = (title, file, line, severity) => ({
  title,
  file,
  line,
  severity,
  evidence: `Fixture evidence for ${title}`,
  attackScenario: `Any HTTP client, for ${title}`,
  remediation: `Fixture remediation for ${title}`,
});
const injection = finding('Command injection in /thumb', 'server.mjs', 8, 'high');
const traversal = finding('Path traversal in /doc', 'server.mjs', 12, 'medium');
const phantom = finding('Unauthenticated admin route', 'routes/admin.mjs', 3, 'high');
const folder = finding('Docs served without authorization', 'docs', null, 'medium');
const key = finding('Hardcoded live API key', 'config.mjs', 1, 'critical');
const pastEnd = finding('Key logged in plaintext', 'config.mjs', 40, 'low');
const redirect = finding('Open redirect in /go', 'server.mjs', 15, 'low');
const found = {
  injection: [injection, traversal, phantom],
  auth: [folder],
  secrets: [key],
  'supply-chain': [],
  'crypto-storage': [pastEnd],
  'request-forgery': [redirect],
};
// Which seats uphold each claim, by seat number.
const upholds = {
  [injection.title]: [true, true, false],
  [traversal.title]: [false],
  [key.title]: [true, true, true],
  [redirect.title]: [true],
};
const report = '## Security audit\n\nThree confirmed findings.';

export async function setup(env) {
  await writeFiles(env.cwd, {
    'server.mjs': `${server}\n`,
    'config.mjs': config,
    'docs/guide.md': 'How to call the server.\n',
  });
  env.head = commitAll(env.cwd, 'add the server');
}

export const input = () => ({});

/** A reader must run in a snapshot of the head, never in the checkout. */
function snapshotOf(request, env) {
  assert.notEqual(request.cwd, env.cwd);
  assert.equal(readFileSync(join(request.cwd, 'server.mjs'), 'utf8'), `${server}\n`);
  if (request.harness === 'codex') assert.equal(request.options.sandbox, 'read-only');
}

export function reply(request, env, mode) {
  const id = request.call.stepId;
  if (id === 'recon') {
    snapshotOf(request, env);
    return surface;
  }
  const sweep = /^lenses\/([a-z-]+)\/sweep$/u.exec(id);
  if (sweep) {
    snapshotOf(request, env);
    return { findings: mode === 'no-findings' ? [] : found[sweep[1]] };
  }
  const seat = /^lenses\/[a-z-]+\/panels\/\d+\/seats\/(\d+)\/refute$/u.exec(id);
  if (seat) {
    snapshotOf(request, env);
    const title = /^Claim: (.+) \((?:critical|high|medium|low),/mu.exec(request.options.prompt)[1];
    const upheld = mode !== 'all-refuted' && upholds[title][Number(seat[1]) - 1];
    return { refuted: !upheld, reasoning: `Seat ${seat[1]} ${upheld ? 'upholds' : 'refutes'}` };
  }
  if (id === 'report') return report;
  throw new Error(`Unhandled security-audit step ${id} (${mode})`);
}

export function fail(request, mode) {
  const id = request.call.stepId;
  return (
    (mode === 'failed-seat' && id === 'lenses/injection/panels/0/seats/2/refute') ||
    (mode === 'failed-lens' && id === 'lenses/secrets/sweep')
  );
}

const unlocated = [
  [phantom.title, 'injection', 'routes/admin.mjs does not exist at the revision'],
  [folder.title, 'auth', 'docs is a tree, not a file'],
  [pastEnd.title, 'crypto-storage', 'Line 40 is past the end of config.mjs (2 text lines)'],
];
const titles = (list) => list.map((item) => item.title);
const seatIds = (calls) => calls.map((c) => c.call.stepId).filter((id) => id.endsWith('/refute'));
/**
 * The checkout is exactly the fixture's HEAD and clean. Each snapshot call pins its base, so the
 * run's refs are one per call, every one at the head: no snapshot captured a change.
 */
function untouched(env, snapshots) {
  assert.equal(git(env.cwd, 'rev-parse', 'HEAD'), env.head);
  assert.equal(git(env.cwd, 'status', '--porcelain', '--untracked-files=all'), '');
  const pins = git(env.cwd, 'for-each-ref', '--format=%(objectname)', 'refs/quiet-choir');
  assert.deepEqual(pins.split('\n').filter(Boolean), Array(snapshots).fill(env.head));
}

export function check({ result, env, calls, record }) {
  const { output } = result;
  assert.equal(output.status, 'complete');
  assert.equal(output.revision, env.head);
  assert.deepEqual(output.surface, surface);
  assert.deepEqual(output.lenses, Object.keys(found));
  assert.deepEqual(output.failedLenses, []);
  assert.equal(output.rawFindings, 7);
  assert.deepEqual(
    output.confirmed.map((f) => [f.title, f.severity, f.lens, f.upheld, f.seats, f.failedSeats]),
    [
      [key.title, 'critical', 'secrets', 3, 3, 0],
      [injection.title, 'high', 'injection', 2, 3, 0],
      [redirect.title, 'low', 'request-forgery', 1, 1, 0],
    ],
  );
  assert.deepEqual(
    output.confirmed[1].verdicts.map((v) => [v.seat, v.harness, v.refuted]),
    [
      [1, 'claude', false],
      [2, 'claude', false],
      [3, 'claude', true],
    ],
  );
  assert.deepEqual(
    output.refuted.map((f) => [f.title, f.upheld, f.seats, f.verdicts[0].reasoning]),
    [[traversal.title, 0, 1, 'Seat 1 refutes']],
  );
  assert.deepEqual([output.undecided, output.unchecked], [[], []]);
  // Code dismissed the phantom file, the directory and the line past the end without a panel.
  assert.deepEqual(
    output.unlocated.map((f) => [f.title, f.lens, f.why]),
    unlocated,
  );
  assert.equal(output.report, report);
  // Seats run concurrently, so compare the calls as a set; no dismissed claim reached a seat.
  assert.deepEqual(
    calls.map((call) => call.call.stepId).sort(),
    [
      'recon',
      'report',
      ...Object.keys(found).map((lens) => `lenses/${lens}/sweep`),
      'lenses/injection/panels/0/seats/1/refute',
      'lenses/injection/panels/0/seats/2/refute',
      'lenses/injection/panels/0/seats/3/refute',
      'lenses/injection/panels/1/seats/1/refute',
      'lenses/secrets/panels/0/seats/1/refute',
      'lenses/secrets/panels/0/seats/2/refute',
      'lenses/secrets/panels/0/seats/3/refute',
      'lenses/request-forgery/panels/0/seats/1/refute',
    ].sort(),
  );
  const prompt = (id) => calls.find((call) => call.call.stepId === id).options.prompt;
  assert.match(prompt('lenses/injection/panels/0/seats/2/refute'), /^Skeptic 2 of 3: /u);
  assert.match(prompt('lenses/auth/sweep'), /- Entry points: server\.mjs: GET \/thumb; /u);
  assert.match(prompt('lenses/auth/sweep'), /- Trust boundaries: none identified\n/u);
  // The reporter sees the survivors only.
  const reporter = prompt('report');
  for (const confirmed of [key, injection, redirect]) assert.ok(reporter.includes(confirmed.title));
  for (const dismissed of [traversal, phantom, folder, pastEnd])
    assert.ok(!reporter.includes(dismissed.title), dismissed.title);
  assert.doesNotMatch(reporter, /audit was incomplete/u);
  // Code looked up only cited files: no lookup for an empty lens, no line count without a blob.
  assert.ok(record.steps['lenses/injection/locate']);
  assert.ok(record.steps['lenses/injection/lines']);
  assert.equal(record.steps['lenses/auth/lines'], undefined);
  assert.equal(record.steps['lenses/supply-chain/locate'], undefined);
  // Nobody may edit; the Reporter has no tools at all.
  assert.ok(
    calls.every((call) => !(call.options.tools ?? []).some((t) => /Write|Edit|Bash/u.test(t))),
  );
  assert.deepEqual(calls.find((call) => call.call.stepId === 'report').options.tools, []);
  untouched(env, 15);
}

export const readOnly =
  'Read-only audit: every reader works in an unchanged per-call snapshot of the pinned revision';

export const modes = [
  {
    mode: 'failed-seat',
    check({ result, calls, env }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      // One upheld, one refuted, one failed: the failed seat could still have made a majority.
      assert.deepEqual(
        output.undecided.map((f) => [f.title, f.upheld, f.failedSeats, f.verdicts.length]),
        [[injection.title, 1, 1, 2]],
      );
      assert.deepEqual(titles(output.confirmed), [key.title, redirect.title]);
      assert.deepEqual(titles(output.refuted), [traversal.title]);
      const reporter = calls.find((call) => call.call.stepId === 'report').options.prompt;
      const [survivors, rest] = reporter.split('These findings were neither confirmed nor refuted');
      assert.ok(!survivors.includes(injection.title));
      assert.match(rest, new RegExp(`- high: ${injection.title}, at server\\.mjs:8`, 'u'));
      assert.match(rest, /Findings left unverified by a failed skeptic: 1\./u);
      untouched(env, 15);
    },
  },
  {
    mode: 'failed-lens',
    check({ result, calls }) {
      const { output } = result;
      assert.equal(output.status, 'degraded');
      assert.deepEqual(
        output.failedLenses.map((f) => f.lens),
        ['secrets'],
      );
      assert.match(output.failedLenses[0].why, /^process: /u);
      assert.ok(!output.lenses.includes('secrets'));
      assert.deepEqual(titles(output.confirmed), [injection.title, redirect.title]);
      assert.equal(output.rawFindings, 6);
      assert.ok(!seatIds(calls).some((id) => id.startsWith('lenses/secrets/')));
      const reporter = calls.find((call) => call.call.stepId === 'report').options.prompt;
      assert.match(reporter, /Lenses whose sweep failed, so their area is unaudited: secrets\./u);
    },
  },
  {
    mode: 'capped',
    input: () => ({ maxFindingsPerLens: 1 }),
    check({ result, calls }) {
      const { output } = result;
      assert.equal(output.status, 'limited');
      // The high injection outranks the medium traversal for the lens's only panel.
      assert.deepEqual(titles(output.unchecked), [traversal.title]);
      assert.deepEqual(output.refuted, []);
      assert.equal(output.unlocated.length, 3);
      assert.equal(seatIds(calls).length, 7);
      const reporter = calls.find((call) => call.call.stepId === 'report').options.prompt;
      assert.match(reporter, /past the per-lens panel cap, never verified: 1\./u);
    },
  },
  {
    mode: 'cross-harness',
    input: () => ({ crossHarness: true }),
    check({ result, calls, env }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.deepEqual(
        calls
          .filter((call) => call.harness === 'codex')
          .map((call) => call.call.stepId)
          .sort(),
        ['lenses/injection/panels/0/seats/2/refute', 'lenses/secrets/panels/0/seats/2/refute'],
      );
      assert.deepEqual(
        output.confirmed.map((f) => f.verdicts.map((v) => v.harness)),
        [['claude', 'codex', 'claude'], ['claude', 'codex', 'claude'], ['claude']],
      );
      untouched(env, 15);
    },
  },
  {
    mode: 'all-refuted',
    check({ result, calls, env }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.deepEqual(output.confirmed, []);
      assert.equal(output.refuted.length, 4);
      assert.equal(
        output.report,
        `Audited the entire repository at ${env.head.slice(0, 12)} across 6 lenses over a mapped surface of 3 entry points. 7 candidate findings, none confirmed: 4 refuted by a panel majority; 3 naming a file or line that is absent.`,
      );
      assert.equal(
        calls.some((call) => call.call.stepId === 'report'),
        false,
      );
    },
  },
  {
    mode: 'no-findings',
    input: () => ({ lenses: ['request-forgery', 'injection', 'injection'] }),
    check({ result, calls, env, record }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      // Lenses run once each, in their fixed order, whatever order the input named them in.
      assert.deepEqual(output.lenses, ['injection', 'request-forgery']);
      assert.match(
        calls.find((call) => call.call.stepId === 'recon').options.prompt,
        /\(injection, request-forgery\)/u,
      );
      assert.equal(
        output.report,
        `Audited the entire repository at ${env.head.slice(0, 12)} across 2 lenses over a mapped surface of 3 entry points. No candidate findings.`,
      );
      assert.deepEqual(calls.map((call) => call.call.stepId).sort(), [
        'lenses/injection/sweep',
        'lenses/request-forgery/sweep',
        'recon',
      ]);
      assert.ok(!Object.keys(record.steps).some((id) => id.endsWith('/locate')));
      untouched(env, 3);
    },
  },
  {
    // From a subdirectory, readers still start at the snapshot's root (reply reads server.mjs
    // there) and the lookups stay root-relative, so the outcome is the root run's.
    mode: 'from-subdirectory',
    options: (opts, env) => ({ ...opts, cwd: join(env.cwd, 'docs') }),
    check({ result, env }) {
      const { output } = result;
      assert.equal(output.status, 'complete');
      assert.deepEqual(titles(output.confirmed), [key.title, injection.title, redirect.title]);
      assert.deepEqual(
        output.unlocated.map((f) => [f.title, f.lens, f.why]),
        unlocated,
      );
      untouched(env, 15);
    },
  },
  {
    mode: 'unknown-revision',
    input: () => ({ revision: 'no-such-revision' }),
    rejects:
      /Cannot resolve the revision "no-such-revision" to a commit: fatal: Needed a single revision/u,
    check({ record, calls }) {
      assert.equal(record.status, 'failed');
      assert.equal(calls.length, 0);
    },
  },
];

/** A failed lens or seat hides behind 'limited' when the per-lens cap also applied. */
export const degraded = (output) =>
  output.status === 'limited' && (output.failedLenses.length > 0 || output.undecided.length > 0);
