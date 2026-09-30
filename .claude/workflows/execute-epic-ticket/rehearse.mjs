#!/usr/bin/env node
// Rehearse execute-epic-ticket.js with no GitHub, git, or models.
//
// The workflow script runs unmodified, with its hooks (agent, parallel, workflow, phase, log)
// replaced by fakes:
// - clerk agents (haiku) "run" epic.mjs / merge-down.mjs subcommands against a small in-memory
//   world (issues, the epic checklist, PRs) and relay nonce+FNV-stamped JSON, exactly as the real
//   helper prints it;
// - judgment agents return scripted results per scenario;
// - workflow('merge-down-pr') returns a scripted landing record.
// Each scenario asserts the outcome and the effects. Run: node rehearse.mjs [scenario-name…]
//
// This is the hand-built equivalent of quiet-choir's fixture rehearsal (`--dry-run`, fixture
// harnesses): see the README's porting notes.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { compactSurvey } from './epic.mjs';

const SOURCE = readFileSync(new URL('../execute-epic-ticket.js', import.meta.url), 'utf8').replace(
  /^export const meta\b/m,
  'const meta',
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
const stamp = (payload, nonce) => {
  const p = { ...payload, _nonce: nonce };
  return { ...p, _fnv: fnv(JSON.stringify(p)) };
};

// ── Parsing clerk prompts ────────────────────────────────────────────────────────────────────

// Split a shell command line into words. The workflow's sh() emits each value bare or single-quoted
// (with ' written as '\''), possibly glued to a flag (--title='a b'), so only that syntax matters.
function words(line) {
  const out = [];
  let word = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      word = (word ?? '') + line.slice(i + 1, end);
      i = end;
    } else if (ch === '\\' && line[i + 1] === "'") {
      word = (word ?? '') + "'";
      i++;
    } else if (/\s/.test(ch)) {
      if (word !== null) out.push(word);
      word = null;
    } else word = (word ?? '') + ch;
  }
  if (word !== null) out.push(word);
  return out;
}

function parseCommand(id, run) {
  const [line, ...rest] = run.split('\n');
  const heredoc = / <<'(\w+)'$/.exec(line);
  const argv = words(heredoc ? line.slice(0, heredoc.index) : line);
  const stdin = heredoc ? rest.slice(0, rest.lastIndexOf(heredoc[1])).join('\n') : null;
  assert.equal(argv[0], 'node', `unexpected command: ${line}`);
  const tool = argv[1].endsWith('merge-down.mjs') ? 'md' : 'epic';
  const sub = argv[2];
  const flags = {};
  for (let i = 3; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const eq = argv[i].indexOf('=');
    if (eq > 0) {
      flags[argv[i].slice(2, eq)] = argv[i].slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[argv[i].slice(2)] = true;
    else flags[argv[i].slice(2)] = argv[++i];
  }
  return { id, tool, sub, flags, stdin };
}

const commandsIn = (prompt) =>
  [...prompt.matchAll(/<command id="([^"]+)">\n([\s\S]*?)\n<\/command>/g)].map(([, id, run]) =>
    parseCommand(id, run),
  );

// ── The fake world ───────────────────────────────────────────────────────────────────────────

function makeWorld(spec) {
  const issues = new Map();
  for (const [n, i] of Object.entries(spec.issues)) {
    issues.set(Number(n), {
      title: i.title ?? `Ticket ${n}`,
      state: i.state ?? 'OPEN',
      labels: i.labels ?? [],
      deps: i.deps ?? [],
      split: i.split ?? null,
      pr: i.pr ?? null,
      checked: i.checked ?? false,
      comments: [],
    });
  }
  return {
    epic: spec.epic ?? 99,
    order: spec.order ?? [...issues.keys()],
    issues,
    nextNumber: 500,
    prs: new Map(),
    ledger: [],
    effects: [],
  };
}

function survey(world, prefer, limit) {
  const open = (n) => world.issues.get(n)?.state === 'OPEN';
  const items = world.order.map((n) => {
    const i = world.issues.get(n);
    const openDeps = i.deps.filter(open);
    const openSlices = (i.split ?? []).filter(open);
    const status =
      i.state === 'CLOSED'
        ? 'closed'
        : i.pr
          ? 'in-flight'
          : i.split && !openSlices.length
            ? 'close-split'
            : i.split
              ? 'split'
              : i.labels.some((l) => ['blocked', 'needs-decision', 'on-hold'].includes(l))
                ? 'held'
                : openDeps.length
                  ? 'waiting'
                  : 'ready';
    return {
      number: n,
      title: i.title,
      state: i.state,
      status,
      labels: i.labels,
      openDeps,
      pr: i.pr,
      split: i.split,
      openSlices,
    };
  });
  const count = (s) => items.filter((i) => i.status === s).length;
  const pick =
    (prefer && items.find((i) => i.number === prefer && i.state === 'OPEN')) ||
    items.find((i) => i.status === 'in-flight') ||
    items.find((i) => i.status === 'close-split') ||
    items.find((i) => i.status === 'ready') ||
    null;
  // The real helper's compaction, so the workflow sees exactly the shape clerks relay.
  return compactSurvey(
    {
      repo: 'plx/quiet-choir',
      defaultBranch: 'main',
      mainHead: 'f'.repeat(40),
      epic: { number: world.epic, title: 'Epic: rehearsal', url: 'u', state: 'OPEN' },
      items,
      counts: {
        total: items.length,
        open: items.filter((i) => i.state === 'OPEN').length,
        closed: count('closed'),
        ready: count('ready'),
        inFlight: count('in-flight'),
        waiting: count('waiting'),
        held: count('held'),
        split: count('split'),
      },
      next: pick ? { number: pick.number, title: pick.title, status: pick.status } : null,
      done: !items.some((i) => i.state === 'OPEN'),
      files: {
        dir: '/state/epic',
        survey: '/state/epic/survey.json',
        table: '/state/epic/items.md',
      },
    },
    Number(limit ?? 3),
  );
}

// epic.mjs / merge-down.mjs, against the world. Returns the payload (without _nonce/_fnv).
function execute(world, scenario, c) {
  const n = Number(c.flags.issue);
  const issue = world.issues.get(n);
  world.effects.push(`${c.sub}${c.flags.issue ? ` #${n}` : ''}`);
  const override = scenario.exec?.(c, world);
  if (override !== undefined) return override;
  const dir = `/state/epic-${c.flags.epic}/issue-${n}`;
  switch (`${c.tool}:${c.sub}`) {
    case 'epic:survey':
      return survey(world, c.flags.prefer ? Number(c.flags.prefer) : null, c.flags.candidates);
    case 'epic:start':
      return {
        worktree: '/wt',
        branch: `epic-${world.epic}/${n}-ticket`,
        base: 'origin/main',
        baseSha: 'b'.repeat(40),
        resumed: false,
        ahead: 0,
        behind: 0,
        dirty: [],
        rebase: 'up-to-date',
        dir,
        files: { issue: `${dir}/issue.md`, epic: `${dir}/epic.md`, plan: null },
        lastCheck: null,
      };
    case 'epic:save':
      return { path: `${dir}/${c.flags.name}`, bytes: c.stdin.length, sha256: 'x' };
    case 'epic:verify':
      return {
        head: 'a'.repeat(40),
        ahead: 2,
        dirty: [],
        missingCommits: [],
        checkPassedAtHead: true,
        checkHead: 'a'.repeat(40),
      };
    case 'epic:snapshot':
      return {
        head: 'a'.repeat(40),
        ahead: 2,
        commits: ['aaaaaaa Do it'],
        stat: '3 files changed',
        dirty: [],
        files: { diff: `${dir}/own.diff`, stat: `${dir}/own.stat`, commits: `${dir}/commits.txt` },
      };
    case 'epic:open-pr': {
      assert.ok(c.flags.title, 'open-pr needs a title');
      world.prTitle = c.flags.title;
      const pr = { number: 300 + n, url: `pr/${300 + n}`, headSha: 'a'.repeat(40) };
      issue.pr = { ...pr, isDraft: false, createdAt: '2026-09-29T00:00:00Z' };
      return {
        pr: pr.number,
        url: pr.url,
        head: pr.headSha,
        created: true,
        openedAt: '2026-09-29T00:00:00Z',
        pushedAt: '2026-09-29T00:00:00Z',
      };
    }
    case 'epic:comment': {
      if (c.stdin?.trim()) issue.comments.push(c.stdin);
      if (c.flags['add-label'])
        issue.labels = [...new Set([...issue.labels, c.flags['add-label']])];
      if (c.flags['remove-label'])
        issue.labels = issue.labels.filter((l) => l !== c.flags['remove-label']);
      return { url: `comment/${n}`, labels: issue.labels };
    }
    case 'epic:close-issue':
      issue.state = 'CLOSED';
      return { closed: true, state: 'CLOSED', stateReason: c.flags.reason, commentUrl: 'c' };
    case 'epic:file-issue': {
      const number = world.nextNumber++;
      world.issues.set(number, {
        title: c.flags.title,
        state: 'OPEN',
        labels: [c.flags.label],
        deps: [],
        split: null,
        pr: null,
        checked: false,
        comments: [],
        epic: Number(c.flags.epic),
      });
      if (Number(c.flags.epic) === world.epic) {
        const at = world.order.indexOf(Number(c.flags.after));
        world.order.splice(at < 0 ? world.order.length : at + 1, 0, number);
      }
      return { number, url: `issue/${number}`, created: true, attached: true, listed: true };
    }
    case 'epic:ensure-epic':
      world.followupEpic ??= world.nextNumber++;
      return { number: world.followupEpic, url: 'e', created: true };
    case 'epic:tick':
      if (issue) issue.checked = true;
      return { changed: true, checked: true, line: `- [x] #${n}` };
    case 'epic:ledger':
      world.ledger.push(JSON.parse(c.stdin));
      return { path: '/state/ledger.jsonl', lines: world.ledger.length };
    case 'md:await':
      return {
        done: true,
        headMoved: false,
        timedOut: false,
        ci: { state: 'success' },
        codex: { state: 'findings' },
        elapsedSeconds: 300,
      };
    default:
      throw new Error(`rehearsal has no fake for ${c.tool}:${c.sub}`);
  }
}

// ── Scripted judgment ────────────────────────────────────────────────────────────────────────

const PLAN_READY = (n, extra = {}) => ({
  readiness: 'ready',
  rationale: 'Still needed.',
  issueComment: '',
  obsoleteKind: 'n/a',
  decision: { question: '', options: [], recommendation: '' },
  blockedBy: [],
  slices: [],
  plan: {
    title: `Implement ticket ${n}`,
    approach: 'Do it.',
    steps: [{ id: 's1', description: 'Change the code', files: ['src/x.ts'] }],
    acceptance: [
      { id: 'a1', criterion: 'It works', how: 'test' },
      { id: 'a2', criterion: 'Docs updated', how: 'docs' },
    ],
    tests: ['test/x.test.ts'],
    docs: [],
    risks: [],
    outOfScope: [],
    complexity: 'mechanical',
    size: 'small',
  },
  ...extra,
});
const verdict = (readiness, extra = {}) => ({ ...PLAN_READY(0), readiness, ...extra });
const IMPL_DONE = (extra = {}) => ({
  criteria: [
    { id: 'a1', status: 'done', commit: 'aaaaaaa', evidence: 'test/x.test.ts' },
    { id: 'a2', status: 'done', commit: 'aaaaaaa', evidence: 'docs/x.md' },
  ],
  checkPassed: true,
  head: 'a'.repeat(40),
  deviations: [],
  followups: [],
  notes: [],
  ...extra,
});
const MERGED = (pr) => ({
  status: 'merged',
  pr,
  mergeCommit: 'm'.repeat(40),
  threads: [{ id: 't1' }],
  fixes: [{ key: 'thread:t1' }],
  followups: [],
  headline: 'Merged after 1 fix.',
});

// ── Runner ───────────────────────────────────────────────────────────────────────────────────

async function rehearse(scenario) {
  const world = makeWorld(scenario.world);
  const saved = new Map(); // `${tool}:${scope}:${sub}` → stamped line (the helper's "last" copy)
  const calls = [];
  const corrupt = new Set(scenario.corrupt ?? []);
  const counters = {};
  const nth = (key) => (counters[key] = (counters[key] ?? 0) + 1);
  const scopeOf = (c) => `${c.flags.epic ?? ''}/${c.flags.issue ?? c.flags.pr ?? ''}`;

  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, model: opts.model, effort: opts.effort, phase: opts.phase });
    assert.ok(opts.model && opts.effort, `agent "${opts.label}" must set model and effort`);
    if (opts.model === 'haiku') {
      // A clerk that dies (usage limit, API error) returns null, as agent() does.
      const subs = commandsIn(prompt).map((c) => (c.sub === 'last' ? c.flags.cmd : c.sub));
      if (subs.some((sub) => scenario.deadClerk?.includes(sub))) return null;
      const out = {};
      for (const c of commandsIn(prompt)) {
        const key = `${c.tool}:${scopeOf(c)}:${c.sub === 'last' ? c.flags.cmd : c.sub}`;
        let line;
        if (c.sub === 'last') line = saved.get(key) ?? { error: 'no saved output' };
        else {
          line = stamp(execute(world, scenario, c), c.flags.nonce);
          saved.set(key, line);
        }
        // A corrupted relay changes one character; the workflow must re-read, not re-run.
        if (c.sub !== 'last' && corrupt.delete(c.sub)) {
          line = { ...line, _fnv: '00000000' };
        }
        out[c.id] = line;
        if (line.error) break;
      }
      return JSON.stringify(out);
    }
    const label = opts.label;
    const kind = label.startsWith('plan #')
      ? 'plan'
      : label.startsWith('skeptic #')
        ? 'skeptic'
        : label.startsWith('impl-')
          ? 'impl'
          : label.startsWith('PR text')
            ? 'pr'
            : label.startsWith('write follow-ups')
              ? 'followups'
              : label.startsWith('write slices')
                ? 'slices'
                : 'unknown';
    const ticket = Number(/#(\d+)/.exec(label)?.[1] ?? 0);
    const handler = scenario.agents?.[kind];
    if (handler) return handler({ ticket, n: nth(`${kind}:${ticket}`), prompt, opts, world });
    switch (kind) {
      case 'plan':
        return PLAN_READY(ticket);
      case 'impl':
        return IMPL_DONE();
      case 'pr':
        return { title: 'Implement it', body: `Closes #${ticket}.\n\nPart of #99.` };
      case 'followups':
        return {
          issues: [
            {
              key: 'f1',
              duplicateOf: 0,
              title: 'Follow-up',
              label: 'enhancement',
              body: '## Summary',
            },
          ],
        };
      case 'slices':
        return {
          issues: [1, 2].map((i) => ({
            key: `slice-${i}`,
            duplicateOf: 0,
            title: `Slice ${i}`,
            label: 'enhancement',
            body: `## Summary ${i}`,
          })),
        };
      default:
        throw new Error(`no scripted result for agent "${label}"`);
    }
  };
  const parallel = async (thunks) =>
    Promise.all(
      thunks.map(async (t) => {
        try {
          return await t();
        } catch {
          return null;
        }
      }),
    );
  const pipeline = async (items, ...stages) =>
    Promise.all(
      items.map(async (item, i) => {
        let value = item;
        for (const s of stages) value = await s(value, item, i);
        return value;
      }),
    );
  const workflow = async (name, childArgs) => {
    calls.push({ label: `workflow:${name}`, args: childArgs });
    assert.equal(name, 'merge-down-pr');
    world.effects.push(`merge-down-pr #${childArgs.pr}`);
    const landed = scenario.land ? scenario.land(childArgs, world) : MERGED(childArgs.pr);
    if (landed?.status === 'merged') {
      for (const i of world.issues.values())
        if (i.pr?.number === childArgs.pr) {
          i.state = 'CLOSED';
          i.pr = null;
        }
    }
    return landed;
  };
  const logs = [];
  const run = new AsyncFunction(
    'args',
    'agent',
    'parallel',
    'pipeline',
    'phase',
    'log',
    'workflow',
    'budget',
    SOURCE,
  );
  const result = await run(
    { epic: 99, ...scenario.args },
    agent,
    parallel,
    pipeline,
    () => {},
    (m) => logs.push(m),
    workflow,
    { total: null, spent: () => 0, remaining: () => Infinity },
  );
  return { result, world, calls, logs };
}

// ── Scenarios ────────────────────────────────────────────────────────────────────────────────

const PUBLISHING = ['open-pr', 'comment', 'close-issue', 'file-issue', 'ensure-epic', 'tick'];
const published = (world) =>
  world.effects.filter((e) => PUBLISHING.includes(e.split(' ')[0]) || e.startsWith('merge-down'));

const SCENARIOS = {
  'lands the first ready ticket': {
    world: { issues: { 101: { checked: true, state: 'CLOSED' }, 102: {}, 103: {} } },
    check({ result, world, calls }) {
      assert.equal(result.status, 'landed', JSON.stringify(result));
      assert.equal(result.ticket.number, 102);
      assert.equal(result.pr.number, 402);
      assert.equal(world.issues.get(102).state, 'CLOSED');
      assert.ok(world.issues.get(102).checked, 'epic line ticked');
      assert.equal(result.next.number, 103, 'next ticket reported');
      assert.equal(world.ledger.length, 1);
      assert.deepEqual(
        calls.filter((c) => c.model && c.model !== 'haiku').map((c) => `${c.model}/${c.effort}`),
        ['opus/high', 'sonnet/high', 'sonnet/medium'],
      );
      const child = calls.find((c) => c.label === 'workflow:merge-down-pr');
      assert.equal(child.args.parentEpic, 99);
      assert.ok(child.args.followupEpic, 'follow-up epic passed to the child');
    },
  },
  'resumes an in-flight PR at landing': {
    world: {
      issues: {
        102: {},
        103: {
          pr: { number: 77, url: 'pr/77', headSha: 'c'.repeat(40), isDraft: false, createdAt: 't' },
        },
      },
    },
    check({ result, calls }) {
      assert.equal(result.status, 'landed');
      assert.equal(result.ticket.number, 103);
      assert.equal(result.pr.number, 77);
      assert.ok(
        !calls.some((c) => c.label?.startsWith('plan #')),
        'no planning for in-flight work',
      );
      assert.ok(!calls.some((c) => c.label?.startsWith('await review')), 'no first-review wait');
    },
  },
  'refuses a draft in-flight PR': {
    world: {
      issues: {
        103: { pr: { number: 77, url: 'u', headSha: 'c', isDraft: true, createdAt: 't' } },
      },
    },
    check({ result }) {
      assert.equal(result.status, 'blocked');
      assert.match(result.blocked.reason, /draft/);
    },
  },
  'closes an obsolete ticket only when the skeptic agrees': {
    world: { issues: { 102: {} } },
    agents: {
      plan: () =>
        verdict('obsolete', {
          obsoleteKind: 'already-done',
          rationale: 'Done in #95. See x.ts.',
          issueComment: 'Already done in #95.',
        }),
      skeptic: () => ({ agree: true, evidence: 'checked', remaining: [] }),
    },
    check({ result, world }) {
      assert.equal(result.status, 'closed-obsolete');
      assert.equal(world.issues.get(102).state, 'CLOSED');
      assert.ok(world.issues.get(102).checked);
    },
  },
  'replans when the skeptic finds remaining work': {
    world: { issues: { 102: {} } },
    agents: {
      plan: ({ n, prompt }) => {
        if (n === 1)
          return verdict('obsolete', { obsoleteKind: 'already-done', rationale: 'Done.' });
        assert.match(prompt, /independent check found work remaining/);
        return PLAN_READY(102);
      },
      skeptic: () => ({ agree: false, evidence: 'no test', remaining: ['a2 docs missing'] }),
    },
    check({ result }) {
      assert.equal(result.status, 'landed');
      assert.ok(result.notes.some((n) => /not obsolete/.test(n)));
    },
  },
  'posts a needs-decision question and labels the ticket': {
    world: { issues: { 102: {} } },
    agents: {
      plan: () =>
        verdict('needs-decision', {
          decision: {
            question: 'A or B?',
            options: [{ label: 'A', consequence: 'x' }],
            recommendation: 'A',
          },
          issueComment: 'Question: A or B?',
        }),
    },
    check({ result, world }) {
      assert.equal(result.status, 'needs-decision');
      assert.equal(result.decision.question, 'A or B?');
      assert.ok(world.issues.get(102).labels.includes('needs-decision'));
    },
  },
  'delivers a decision and proceeds': {
    world: { issues: { 102: { labels: ['needs-decision'] }, 103: {} } },
    args: { ticket: 102, decision: 'Use A.' },
    agents: {
      plan: ({ prompt }) => {
        assert.match(prompt, /The maintainer answered the open question on this ticket: "Use A\."/);
        return PLAN_READY(102);
      },
    },
    check({ result, world }) {
      assert.equal(result.status, 'landed');
      assert.equal(result.ticket.number, 102);
      assert.ok(!world.issues.get(102).labels.includes('needs-decision'));
      assert.match(world.issues.get(102).comments[0], /\*\*Decision\*\*/);
    },
  },
  'stays held without a decision': {
    world: { issues: { 102: { labels: ['needs-decision'] } } },
    args: { ticket: 102 },
    check({ result, world }) {
      assert.equal(result.status, 'held');
      assert.deepEqual(published(world), []);
    },
  },
  'records an undeclared dependency and takes the next candidate': {
    world: { issues: { 102: {}, 103: {} } },
    agents: {
      plan: ({ ticket }) =>
        ticket === 102
          ? verdict('blocked', {
              blockedBy: [103],
              issueComment: 'Depends on #103: needs its API.',
            })
          : PLAN_READY(ticket),
    },
    check({ result, world }) {
      assert.equal(result.status, 'landed');
      assert.equal(result.ticket.number, 103);
      assert.deepEqual(
        result.skipped.map((s) => s.number),
        [102],
      );
      assert.match(world.issues.get(102).comments[0], /Depends on #103/);
    },
  },
  'splits a large ticket into ordered epic items': {
    world: { issues: { 102: {}, 103: {} } },
    agents: {
      plan: () =>
        verdict('split', {
          issueComment: 'Too large; splitting.',
          slices: [
            { title: 'Slice 1', summary: 's', acceptance: ['x'], dependsOnPrevious: false },
            { title: 'Slice 2', summary: 's', acceptance: ['y'], dependsOnPrevious: true },
          ],
        }),
    },
    check({ result, world }) {
      assert.equal(result.status, 'split');
      assert.deepEqual(
        result.slices.map((s) => s.number),
        [500, 501],
      );
      assert.deepEqual(world.order, [102, 500, 501, 103], 'slices listed right after the parent');
      assert.match(world.issues.get(102).comments.at(-1), /<!-- epic:split 500,501 -->/);
    },
  },
  'closes a split parent once its slices are closed': {
    world: {
      issues: { 102: { split: [500, 501] }, 500: { state: 'CLOSED' }, 501: { state: 'CLOSED' } },
      order: [102, 500, 501],
    },
    check({ result, world }) {
      assert.equal(result.status, 'closed-split');
      assert.equal(world.issues.get(102).state, 'CLOSED');
    },
  },
  'escalates from mechanic to surgeon when checks fail': {
    world: { issues: { 102: {} } },
    agents: {
      impl: ({ opts }) =>
        opts.model === 'sonnet' ? IMPL_DONE({ checkPassed: false }) : IMPL_DONE(),
    },
    check({ result, calls }) {
      assert.equal(result.status, 'landed');
      assert.equal(result.implementer.tier, 'surgeon');
      assert.deepEqual(
        calls.filter((c) => c.label?.startsWith('impl-')).map((c) => c.model),
        ['sonnet', 'opus'],
      );
    },
  },
  'uses the surgeon directly for subtle plans': {
    world: { issues: { 102: {} } },
    agents: {
      plan: () => {
        const p = PLAN_READY(102);
        p.plan.complexity = 'subtle';
        return p;
      },
    },
    check({ result }) {
      assert.equal(result.implementer.tier, 'surgeon');
    },
  },
  'blocks when a reported commit is not on the branch': {
    world: { issues: { 102: {} } },
    exec: (c) =>
      c.sub === 'verify'
        ? {
            head: 'a'.repeat(40),
            ahead: 1,
            dirty: [],
            missingCommits: ['aaaaaaa'],
            checkPassedAtHead: true,
            checkHead: 'a'.repeat(40),
          }
        : undefined,
    check({ result, world }) {
      assert.equal(result.status, 'blocked');
      assert.equal(result.blocked.stage, 'implement');
      assert.ok(!world.effects.includes('open-pr #102'), 'nothing published');
    },
  },
  'blocks when an acceptance criterion is unfinished': {
    world: { issues: { 102: {} } },
    agents: {
      impl: () =>
        IMPL_DONE({
          criteria: [
            { id: 'a1', status: 'done', commit: 'aaaaaaa', evidence: 't' },
            { id: 'a2', status: 'partial', commit: '', evidence: 'docs pending' },
          ],
        }),
    },
    check({ result }) {
      assert.equal(result.status, 'blocked');
      assert.match(result.blocked.reason, /a2 \(partial/);
    },
  },
  'hands criteria that need the PR to the landing review instead of blocking': {
    world: { issues: { 102: {} } },
    agents: {
      impl: () =>
        IMPL_DONE({
          criteria: [
            { id: 'a1', status: 'done', commit: 'aaaaaaa', evidence: 't' },
            {
              id: 'a2',
              status: 'verify-on-pr',
              commit: 'aaaaaaa',
              evidence: 'the quality job finishes in under 6 minutes on the PR',
            },
          ],
        }),
    },
    check({ result, calls }) {
      assert.equal(result.status, 'landed');
      assert.deepEqual(
        result.verifyOnPr.map((c) => c.id),
        ['a2'],
      );
      const child = calls.find((c) => c.label === 'workflow:merge-down-pr');
      assert.ok(child.args.standingNotes.some((n) => /\[a2\] the quality job/.test(n)));
    },
  },
  'files implementer follow-ups under the follow-up epic, not the burned-down one': {
    world: { issues: { 102: {} } },
    agents: {
      impl: () => IMPL_DONE({ followups: [{ title: 'Out of scope thing', detail: 'x.ts:1' }] }),
    },
    check({ result, world }) {
      assert.equal(result.status, 'landed');
      const filed = result.followups[0];
      assert.equal(world.issues.get(filed.number).epic, result.followupEpic);
      assert.ok(!world.order.includes(filed.number), 'the burned-down epic did not grow');
    },
  },
  'passes through a landing that ends blocked': {
    world: { issues: { 102: {} } },
    land: () => ({ status: 'blocked', blocked: { stage: 'gate', reason: 'CI red' } }),
    check({ result, world }) {
      assert.equal(result.status, 'blocked');
      assert.equal(result.blocked.stage, 'land');
      assert.equal(world.issues.get(102).state, 'OPEN');
      assert.ok(!world.issues.get(102).checked);
    },
  },
  'recovers a corrupted relay by re-reading, not re-running': {
    world: { issues: { 102: {} } },
    corrupt: ['open-pr', 'survey'],
    check({ result, world }) {
      assert.equal(result.status, 'landed');
      assert.equal(world.effects.filter((e) => e === 'open-pr #102').length, 1, 'PR opened once');
    },
  },
  'reports a dead clerk as an API failure, not relay corruption': {
    world: { issues: { 102: {} } },
    deadClerk: ['open-pr'],
    check({ result, calls }) {
      assert.equal(result.status, 'blocked');
      assert.match(result.blocked.reason, /clerk agent died/);
      // One re-read in case the command ran before the clerk died, then stop.
      assert.equal(calls.filter((c) => c.label?.startsWith('open PR')).length, 2);
    },
  },
  'reports an epic with no open tickets as done': {
    world: { issues: { 101: { state: 'CLOSED' } } },
    check({ result }) {
      assert.equal(result.status, 'epic-done');
    },
  },
  'reports a stalled epic': {
    world: { issues: { 102: { deps: [103] }, 103: { labels: ['on-hold'] } } },
    check({ result }) {
      assert.equal(result.status, 'stalled');
      assert.match(result.headline, /#102 waiting on #103/);
    },
  },
  'survey dry run changes nothing': {
    world: { issues: { 102: {} } },
    args: { until: 'survey' },
    check({ result, world, calls }) {
      assert.equal(result.status, 'stopped');
      assert.equal(result.ticket.number, 102);
      assert.deepEqual(published(world), []);
      assert.equal(calls.length, 1);
    },
  },
  'plan and implement dry runs publish nothing': {
    world: { issues: { 102: {} } },
    args: { until: 'implement' },
    agents: { impl: () => IMPL_DONE({ followups: [{ title: 'x', detail: 'y' }] }) },
    check({ result, world }) {
      assert.equal(result.status, 'stopped');
      assert.deepEqual(published(world), []);
    },
  },
  ...Object.fromEntries(
    [
      ['obsolete', { obsoleteKind: 'already-done', rationale: 'Done.', issueComment: 'Done.' }],
      ['needs-decision', { issueComment: 'Q?' }],
      ['blocked', { blockedBy: [103], issueComment: 'Depends on #103: x.' }],
      [
        'split',
        {
          issueComment: 'Split.',
          slices: [{ title: 'S1', summary: 's', acceptance: [], dependsOnPrevious: false }],
        },
      ],
    ].map(([readiness, extra]) => [
      `plan dry run publishes nothing for a ${readiness} verdict`,
      {
        world: { issues: { 102: {}, 103: {} } },
        args: { until: 'plan' },
        agents: {
          plan: ({ ticket }) => (ticket === 102 ? verdict(readiness, extra) : PLAN_READY(ticket)),
          skeptic: () => ({ agree: true, evidence: 'checked', remaining: [] }),
        },
        check({ result, world }) {
          assert.equal(result.status, 'stopped', JSON.stringify(result));
          assert.deepEqual(published(world), []);
        },
      },
    ]),
  ),
  'passes a hostile PR title through intact': {
    world: { issues: { 102: {} } },
    agents: {
      pr: () => ({ title: `--draft it's "quoted" $(rm -rf /) \`x\``, body: 'Closes #102.' }),
    },
    check({ result, world }) {
      assert.equal(result.status, 'landed');
      assert.equal(world.prTitle, `--draft it's "quoted" $(rm -rf /) \`x\``);
    },
  },
  'stops at an open PR': {
    world: { issues: { 102: {} } },
    args: { until: 'pr' },
    check({ result, world }) {
      assert.equal(result.status, 'pr-open');
      assert.ok(world.effects.includes('open-pr #102'));
      assert.ok(!world.effects.some((e) => e.startsWith('merge-down')));
    },
  },
  'rejects a forced ticket outside the epic': {
    world: { issues: { 102: {} } },
    args: { ticket: 7 },
    check({ result }) {
      assert.equal(result.status, 'blocked');
      assert.match(result.blocked.reason, /not an open ticket/);
    },
  },
};

const only = process.argv.slice(2);
let failed = 0;
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  if (only.length && !only.some((o) => name.includes(o))) continue;
  try {
    const outcome = await rehearse(scenario);
    scenario.check(outcome);
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(
      `FAIL ${name}\n     ${String(error?.stack ?? error)
        .split('\n')
        .slice(0, 6)
        .join('\n     ')}`,
    );
  }
}
if (failed) {
  console.log(`\n${failed} scenario(s) failed`);
  process.exitCode = 1;
} else console.log('\nall scenarios pass');
