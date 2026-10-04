#!/usr/bin/env node
// Deterministic git and GitHub plumbing for the merge-down-pr workflow
// (.claude/workflows/merge-down-pr.js).
//
// Every subcommand prints exactly one line of JSON on stdout. Failures print {"error": "..."} and
// exit 1. Workflow agents only run these commands and relay the JSON, so judgment stays in the
// workflow and mechanics stay here, where they can be run and tested by hand. Each output also
// carries "_nonce" (echoing --nonce) and "_fnv" (a hash of everything else) so the workflow can
// verify a relayed copy, and is saved under state/pr-N/last/ for re-reading with `last`.
//
//   prepare  --pr N           paths + state + sync in one call (the workflow's first step)
//   state    --pr N           snapshot PR, linked issue, review threads, CI, and Codex status
//   sync     --pr N           check out the PR in the worktree and rebase it onto the default branch
//   snapshot --pr N           record the rebased diff (run after resolving rebase conflicts)
//   check    --pr N [--label L] [--cmd "npm run check"]
//   check-start --pr N [--label L] [--cmd C]    start that check detached and return at once
//   check-wait  --pr N [--label L] [--max-seconds 540]   wait for it; {done: false} on timeout
//   publish  --pr N [--ensure-closes I | --keep-open I]   retarget, push with lease, fix keywords
//   reply    --pr N < replies.json        reply to review threads (resolves Codex threads by default)
//   request-review --pr N                comment "@codex review"
//   local-review-start --pr N [--sha S] [--model M] [--effort E]   run `codex review --base
//                                        origin/<default>` on the worktree head, detached, in a
//                                        throwaway worktree of its own
//   local-review-wait  --pr N [--sha S] [--max-seconds 540]  wait for it; {done: false} on timeout
//   local-review-stop  --pr N [--sha S]  kill that review if it is still running
//   rerun    --pr N --sha S              re-run failed CI jobs for S once (flake check)
//   verify-fixes --pr N --commits a,b    reported commits are in HEAD; last check passed at HEAD
//   await    --pr N --sha S --since ISO [--codex required|skip] [--ci wait|skip] [--stale-grace 90]
//            [--max-seconds 420]
//   land     --pr N --sha S [--issue I] [--expect-close | --keep-open I]
//   close    --pr N < comment.md          comment, then close (Dependabot commands self-close)
//   last     --pr N --cmd C               re-print the saved output of the last C run
//
// Common flags: --root DIR (default: <main checkout>-merge-down, holding worktree/ and state/),
// --repo OWNER/NAME (default: the current directory's GitHub repository).

import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism, loadavg } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';
const CODEX_AUTHOR = 'chatgpt-codex-connector';
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

class Failure extends Error {}
const fail = (message) => {
  throw new Failure(message);
};

// ---------------------------------------------------------------------------------------------
// Process helpers

// Reads that are safe to repeat: a transient network failure on one of them (a connection reset
// in the middle of a 140-call survey once blocked a whole run) is retried with backoff. Writes
// are never retried here: a lost response to a create or a comment could duplicate it.
const READ_VERBS = new Set(['view', 'list', 'checks', 'status', 'diff']);
const WRITE_FLAGS = new Set(['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input']);
const TRANSIENT =
  /connection reset|ECONNRESET|ETIMEDOUT|unexpected EOF|i\/o timeout|TLS handshake timeout|timeout awaiting|\b50[234]\b|Bad Gateway|Service Unavailable|Gateway Timeout|temporarily unavailable|secondary rate limit|could not resolve host|network is unreachable/i;
export function isRetryableRead(cmd, args) {
  if (cmd === 'gh') {
    if (args[0] === 'api') return !args.some((a) => WRITE_FLAGS.has(a));
    return ['issue', 'pr', 'repo', 'run', 'label'].includes(args[0]) && READ_VERBS.has(args[1]);
  }
  if (cmd === 'git') {
    const verb = args[0] === '-C' ? args[2] : args[0];
    return verb === 'fetch' || verb === 'ls-remote';
  }
  return false;
}
// The machine running these checks is shared. Under heavy load a full-parallel vitest run times
// out and every implementer re-ran it with fewer workers by hand, so cap the workers when the
// 1-minute load exceeds the core count (the cap only changes scheduling, not what is tested).
export function checkLoadEnv(load = loadavg()[0], cores = availableParallelism()) {
  return load > cores ? { VITEST_MAX_WORKERS: '4' } : {};
}
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function run(cmd, args, { cwd, input, env, allowFail = false } = {}) {
  const spawn = () =>
    spawnSync(cmd, args, {
      cwd,
      input,
      env: env ? { ...process.env, ...env } : process.env,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    });
  let r = spawn();
  if (r.status !== 0 && !r.error && isRetryableRead(cmd, args)) {
    for (const delay of [2000, 5000, 10000]) {
      if (!TRANSIENT.test(`${r.stderr ?? ''}\n${r.stdout ?? ''}`)) break;
      pause(delay);
      r = spawn();
      if (r.status === 0 || r.error) break;
    }
  }
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    const detail = (r.stderr || r.stdout || '').trim().slice(-2000);
    fail(`${cmd} ${args.join(' ')} exited ${r.status}: ${detail}`);
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const out = (cmd, args, opts) => run(cmd, args, opts).stdout.trim();
const gh = (args, opts) => out('gh', args, opts);
const ghJson = (args, opts) => JSON.parse(gh(args, opts) || 'null');
const ghPaged = (path) => JSON.parse(gh(['api', path, '--paginate', '--slurp'])).flat();
const git = (cwd, args, opts) => out('git', ['-C', cwd, ...args], opts);
const gitOk = (cwd, args) => run('git', ['-C', cwd, ...args], { allowFail: true }).status === 0;

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); // eslint-disable-line no-control-regex
const tail = (text, lines) => text.trimEnd().split('\n').slice(-lines).join('\n');
const nowIso = () => new Date().toISOString();
const writeExcerpt = (log, text) => {
  const file = log.replace(/\.log$/, '.excerpt.txt');
  writeFileSync(file, `${text}\n`);
  return file;
};

// FNV-1a over UTF-16 code units. Workflow agents relay this script's output by copying it; the
// workflow recomputes the hash to prove the copy is exact (see clerk() in merge-down-pr.js).
function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[token.slice(2)] = true;
    else {
      args[token.slice(2)] = next;
      i++;
    }
  }
  return args;
}

function requirePr(a) {
  const pr = Number(a.pr);
  if (!Number.isInteger(pr) || pr <= 0) fail('--pr N is required');
  return pr;
}

// ---------------------------------------------------------------------------------------------
// Paths and repository facts

function paths(a) {
  let root = a.root;
  if (!root) {
    const common = out('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    root = `${dirname(common)}-merge-down`;
  }
  root = resolve(root);
  return {
    toolsDir: TOOLS_DIR,
    root,
    workdir: join(root, 'worktree'),
    stateDir: join(root, 'state'),
  };
}

function repoInfo(a, P) {
  const cache = join(P.stateDir, 'repo.json');
  const cached = readJson(cache);
  if (cached?.viewer && (!a.repo || cached.repo === a.repo)) return cached;
  const repo = a.repo ?? gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const def = gh([
    'repo',
    'view',
    repo,
    '--json',
    'defaultBranchRef',
    '-q',
    '.defaultBranchRef.name',
  ]);
  const [owner, name] = repo.split('/');
  const viewer = gh(['api', 'user', '--jq', '.login']);
  const info = { repo, owner, name, def, viewer };
  mkdirSync(P.stateDir, { recursive: true });
  writeJson(cache, info);
  return info;
}

function prDir(P, pr) {
  const dir = join(P.stateDir, `pr-${pr}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------------------------
// GitHub state

function ciSummary(rollup) {
  const failed = [];
  const pending = [];
  let passed = 0;
  for (const c of rollup ?? []) {
    const name = c.name ?? c.context ?? 'unknown';
    if (c.__typename === 'StatusContext') {
      if (c.state === 'SUCCESS') passed++;
      else if (c.state === 'PENDING' || c.state === 'EXPECTED') pending.push(name);
      else failed.push(name);
    } else if (c.status !== 'COMPLETED') pending.push(name);
    else if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion)) passed++;
    else failed.push(name);
  }
  const total = passed + failed.length + pending.length;
  const state =
    total === 0 ? 'none' : pending.length ? 'pending' : failed.length ? 'failure' : 'success';
  return { state, failed, pending, passed };
}

function parseSummaryRows(body) {
  // | 📝 **Code Review** | ✅ **Completed** <relative-time …>…</relative-time> | `15d5a1a` | PR opened |
  const rows = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\|([^|]*)\|([^|]*)\|\s*`([0-9a-f]{7,40})`\s*\|([^|]*)\|/);
    if (!m) continue;
    const clean = (s) =>
      s
        .replace(/<relative-time[^>]*>.*?<\/relative-time>/g, '')
        .replace(/<[^>]+>|\*/g, '')
        .replace(/^[^A-Za-z]+/, '')
        .trim();
    rows.push({ review: clean(m[1]), status: clean(m[2]), commit: m[3], trigger: clean(m[4]) });
  }
  return rows;
}

function codexActivity(R, pr) {
  const comments = ghPaged(`repos/${R.repo}/issues/${pr}/comments`);
  const summary =
    comments
      .filter((c) => c.user?.login === CODEX_LOGIN)
      .filter((c) => c.body?.includes('codex-pull-request-review-summary'))
      .at(-1) ?? null;
  const reviews = ghPaged(`repos/${R.repo}/pulls/${pr}/reviews`)
    .filter((r) => r.user?.login === CODEX_LOGIN)
    .map((r) => ({ id: r.id, commit: r.commit_id, submittedAt: r.submitted_at }));
  const reactions = ghPaged(`repos/${R.repo}/issues/${pr}/reactions`)
    .filter((r) => r.user?.login === CODEX_LOGIN)
    .map((r) => ({ content: r.content, createdAt: r.created_at }));
  // Codex answers a review request it cannot serve with a plain comment ("You have reached your
  // Codex usage limits for code reviews…") and no summary row, reaction, or review. Without this,
  // a gate would wait for a review that is never coming.
  const limitNotices = comments
    .filter((c) => c.user?.login === CODEX_LOGIN)
    .filter((c) => /usage limits?/i.test(c.body ?? '') && !/review-summary/.test(c.body ?? ''))
    .map((c) => ({ createdAt: c.created_at }));
  return {
    summaryUpdatedAt: summary?.updated_at ?? null,
    rows: summary ? parseSummaryRows(summary.body) : [],
    reviews,
    reactions,
    limitNotices,
  };
}

function cleanCommentBody(body) {
  return body
    .replace(/\*\*<sub><sub>!\[(P\d) Badge\]\([^)]*\)<\/sub><\/sub>\s*(.*?)\*\*/, '**[$1] $2**')
    .replace(/^Useful\? React with .*$/m, '')
    .trim();
}

function reviewThreads(R, pr) {
  const query = `query($o:String!,$n:String!,$p:Int!,$after:String){repository(owner:$o,name:$n){pullRequest(number:$p){
    reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line originalLine
      comments(first:50){nodes{databaseId author{login __typename} body url createdAt}}
      last: comments(last:1){nodes{author{login}}}}}}}}`;
  const nodes = [];
  let after = null;
  do {
    const data = ghJson([
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `o=${R.owner}`,
      '-f',
      `n=${R.name}`,
      '-F',
      `p=${pr}`,
      ...(after ? ['-f', `after=${after}`] : []),
    ]);
    const page = data.data.repository.pullRequest.reviewThreads;
    nodes.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return nodes.map((t) => {
    const comments = t.comments.nodes.map((c) => ({
      author: c.author?.login ?? 'ghost',
      isBot: c.author?.__typename === 'Bot',
      body: c.body,
      url: c.url,
      createdAt: c.createdAt,
    }));
    const first = comments[0] ?? { author: 'ghost', body: '' };
    return {
      id: t.id,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      line: t.line ?? t.originalLine,
      author: first.author,
      isCodex: first.author === CODEX_AUTHOR,
      isBot: Boolean(first.isBot),
      alert: Number(first.body.match(/security\/code-scanning\/(\d+)/)?.[1]) || null,
      lastAuthor: t.last?.nodes?.[0]?.author?.login ?? comments.at(-1)?.author ?? null,
      priority: first.body.match(/!\[(P\d) Badge\]/)?.[1] ?? null,
      title: cleanCommentBody(first.body).split('\n')[0].replace(/\*\*/g, '').trim(),
      url: first.url,
      comments,
    };
  });
}

// Open code-scanning alerts on the PR's merge ref. Only a repository without code scanning counts as
// "no alerts"; any other lookup failure propagates, so landing fails closed.
function openAlerts(R, pr) {
  try {
    return ghPaged(`repos/${R.repo}/code-scanning/alerts?ref=refs/pull/${pr}/merge&state=open`).map(
      (x) => ({
        number: x.number,
        rule: x.rule?.id ?? null,
        severity: x.rule?.security_severity_level ?? x.rule?.severity ?? null,
        path: x.most_recent_instance?.location?.path ?? null,
        line: x.most_recent_instance?.location?.start_line ?? null,
        message: x.most_recent_instance?.message?.text ?? '',
      }),
    );
  } catch (error) {
    const unavailable =
      /no analysis found|code scanning is not enabled|advanced security must be enabled/i;
    if (unavailable.test(error.message)) return [];
    throw error;
  }
}

function renderThreads(threads) {
  const open = threads.filter((t) => !t.isResolved);
  if (!open.length) return 'No unresolved review threads.\n';
  const blocks = open.map((t) => {
    const where = `${t.path}${t.line ? `:${t.line}` : ''}`;
    const meta = [
      t.priority,
      where,
      t.isOutdated ? 'outdated (code changed since)' : null,
      `by ${t.author}${t.isCodex ? ' (Codex)' : t.isBot ? ' (bot)' : ''}`,
      t.alert ? `code-scanning alert #${t.alert}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const body = t.comments
      .map((c, i) => `${i ? `**Reply from ${c.author}:** ` : ''}${cleanCommentBody(c.body)}`)
      .join('\n\n');
    return `## Thread ${t.id}\n\n${meta}\n\n${body}\n`;
  });
  return `# Unresolved review threads (${open.length})\n\n${blocks.join('\n')}`;
}

function linkedIssue(R, p) {
  const closing = (p.closingIssuesReferences ?? []).map((i) => i.number);
  let number = closing[0] ?? null;
  let keyword = number ? 'closes' : null;
  // Stacked PRs have no closingIssuesReferences yet: a closing keyword anywhere in the body beats
  // an earlier "Refs #N", which only names context.
  // References may be bare (#42) or repository-qualified (owner/repo#42); only this repository's
  // issues can be reviewed here, so other repositories count as extra closing references.
  const ref = String.raw`(?:([\w.-]+\/[\w.-]+))?#(\d+)`;
  const own = (m) => !m[2] || m[2].toLowerCase() === R.repo.toLowerCase();
  const closingPattern = new RegExp(
    String.raw`\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+${ref}`,
    'gi',
  );
  const refsPattern = new RegExp(String.raw`\b(refs?)\b:?\s+${ref}`, 'gi');
  const bodyMatches = (pattern) => [...(p.body ?? '').matchAll(pattern)];
  for (const pattern of [closingPattern, refsPattern]) {
    if (number) break;
    const m = bodyMatches(pattern).find(own);
    if (m) [keyword, number] = [m[1].toLowerCase(), Number(m[3])];
  }
  if (!number) {
    const m = /^[^/]+\/(\d+)-/.exec(p.headRefName);
    if (m) [keyword, number] = ['branch', Number(m[1])];
  }
  if (!number) return null;
  const kind = gh([
    'api',
    `repos/${R.repo}/issues/${number}`,
    '--jq',
    'if .pull_request then "pr" else "issue" end',
  ]);
  if (kind !== 'issue') return null;
  // GitHub closes every referenced issue on merge, but the review covers one: report the rest.
  const bodyClosing = bodyMatches(closingPattern).map((m) =>
    own(m) ? Number(m[3]) : `${m[2]}#${m[3]}`,
  );
  const alsoCloses = [...new Set([...closing, ...bodyClosing])].filter((n) => n !== number);
  return { number, keyword, closes: /^(close|fix|resolve)/.test(keyword), alsoCloses };
}

// Open PRs stacked above this one (children, grandchildren, …), bottom-up. Reviewers use this to
// avoid fixing now what a later PR in the stack already does.
function laterInStack(R, headRef) {
  const open = ghJson([
    'pr',
    'list',
    '-R',
    R.repo,
    '--state',
    'open',
    '--limit',
    '200',
    '--json',
    'number,title,baseRefName,headRefName,body',
  ]);
  const chain = [];
  const seen = new Set();
  const frontier = [headRef];
  while (frontier.length) {
    const base = frontier.shift();
    for (const q of open
      .filter((x) => x.baseRefName === base)
      .sort((x, y) => x.number - y.number)) {
      if (seen.has(q.number)) continue;
      seen.add(q.number);
      const issue =
        /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\b:?\s+#(\d+)/i.exec(q.body ?? '')?.[1] ??
        /^[^/]+\/(\d+)-/.exec(q.headRefName)?.[1] ??
        null;
      chain.push({ pr: q.number, title: q.title, issue: issue ? Number(issue) : null });
      frontier.push(q.headRefName);
    }
  }
  return chain;
}

function renderStack(later) {
  if (!later.length) return 'No open PRs are stacked above this one.\n';
  const lines = later.map((l) => `- #${l.pr}${l.issue ? ` (issue #${l.issue})` : ''}: ${l.title}`);
  return `# Later PRs in this stack (${later.length}), landing after this one, bottom-up\n\n${lines.join('\n')}\n`;
}

function prState(a, P, R) {
  const pr = requirePr(a);
  const dir = prDir(P, pr);
  const p = ghJson([
    'pr',
    'view',
    String(pr),
    '-R',
    R.repo,
    '--json',
    'number,url,title,body,state,isDraft,author,baseRefName,headRefName,headRefOid,mergeable,' +
      'mergeStateStatus,closingIssuesReferences,statusCheckRollup,additions,deletions,' +
      'changedFiles,labels,mergeCommit',
  ]);
  writeJson(join(dir, 'pr.json'), p);
  writeFileSync(join(dir, 'body.md'), `# #${p.number} ${p.title}\n\n${p.body ?? ''}\n`);

  let issue = linkedIssue(R, p);
  if (issue) {
    const i = ghJson([
      'issue',
      'view',
      String(issue.number),
      '-R',
      R.repo,
      '--json',
      'number,title,body,state,url,comments',
    ]);
    const comments = i.comments
      .map((c) => `\n---\n\n**${c.author.login}** (${c.createdAt}):\n\n${c.body}\n`)
      .join('');
    writeFileSync(
      join(dir, 'issue.md'),
      `# #${i.number} ${i.title}\n\nState: ${i.state} · ${i.url}\n\n${i.body}\n${comments}`,
    );
    issue = { ...issue, title: i.title, state: i.state, url: i.url };
  } else {
    writeFileSync(join(dir, 'issue.md'), 'No linked issue.\n');
  }

  let parent = null;
  if (p.baseRefName !== R.def) {
    const found = ghJson([
      'pr',
      'list',
      '-R',
      R.repo,
      '--head',
      p.baseRefName,
      '--state',
      'all',
      '--limit',
      '1',
      '--json',
      'number,state,url',
    ]);
    parent = found[0] ? { pr: found[0].number, state: found[0].state } : { pr: null, state: null };
  }
  const children = ghJson([
    'pr',
    'list',
    '-R',
    R.repo,
    '--base',
    p.headRefName,
    '--state',
    'open',
    '--json',
    'number,headRefName',
  ]).map((c) => ({ pr: c.number, headRef: c.headRefName }));
  const later = laterInStack(R, p.headRefName);
  writeFileSync(join(dir, 'stack.md'), renderStack(later));

  const threads = reviewThreads(R, pr);
  const alerts = openAlerts(R, pr);
  writeJson(join(dir, 'threads.json'), threads);
  writeJson(join(dir, 'alerts.json'), alerts);
  const threadFor = (n) => threads.find((t) => t.alert === n && !t.isResolved)?.id;
  const alertSection = alerts.length
    ? `\n# Open code-scanning alerts on this PR (${alerts.length})\n\nAn alert without a review thread is decided under the id alert:N.\n\n${alerts
        .map((x) => {
          const where = threadFor(x.number)
            ? `thread ${threadFor(x.number)}`
            : `id alert:${x.number}`;
          return `- #${x.number} ${x.rule} (${x.severity}) ${x.path}:${x.line}: ${x.message} [${where}]`;
        })
        .join('\n')}\n`
    : '';
  writeFileSync(join(dir, 'threads.md'), `${renderThreads(threads)}${alertSection}`);
  const open = threads.filter((t) => !t.isResolved);

  const activity = codexActivity(R, pr);
  const headRow = activity.rows.find((r) => p.headRefOid.startsWith(r.commit)) ?? null;
  const reviewedHead =
    activity.reviews.some((r) => r.commit === p.headRefOid) ||
    /complete/i.test(headRow?.status ?? '');

  const summary = {
    number: p.number,
    url: p.url,
    title: p.title,
    state: p.state,
    isDraft: p.isDraft,
    author: p.author?.login ?? null,
    isDependency: /dependabot/i.test(p.author?.login ?? ''),
    baseRef: p.baseRefName,
    headRef: p.headRefName,
    headSha: p.headRefOid,
    mergeable: p.mergeable,
    size: { files: p.changedFiles, additions: p.additions, deletions: p.deletions },
    issue,
    parent,
    children,
    ci: ciSummary(p.statusCheckRollup),
    codex: {
      reviewed: activity.rows.length > 0 || activity.reviews.length > 0,
      reviewedHead,
      thumbsUp: activity.reactions.some((r) => r.content === '+1'),
      reviews: activity.reviews.length,
      unresolvedThreads: open.filter((t) => t.isCodex).length,
      highPriorityOpen: open.filter((t) => t.isCodex && /P[01]/.test(t.priority ?? '')).length,
    },
    otherUnresolvedThreads: open.filter((t) => !t.isCodex).length,
    // Unresolved threads whose last word is not ours: nobody has answered them yet.
    untriagedThreads: open.filter((t) => t.lastAuthor !== R.viewer).length,
    openAlerts: alerts.map((x) => x.number),
    laterInStack: later.length,
    files: {
      dir,
      stack: join(dir, 'stack.md'),
      body: join(dir, 'body.md'),
      issue: join(dir, 'issue.md'),
      threads: join(dir, 'threads.md'),
    },
  };
  writeJson(join(dir, 'state.json'), summary);
  return summary;
}

// ---------------------------------------------------------------------------------------------
// Worktree and rebase

function ensureWorktree(P, R) {
  if (existsSync(join(P.workdir, '.git'))) return false;
  mkdirSync(P.root, { recursive: true });
  run('git', ['fetch', '--quiet', 'origin', R.def]);
  run('git', ['worktree', 'add', '--detach', P.workdir, `origin/${R.def}`]);
  return true;
}

const remoteBranchExists = (W, branch) =>
  gitOk(W, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);

// Stacked PRs lose their fork point once the PR below them is squash-merged or rewritten. Record
// each stacked PR's fork point (its parent's head as the child saw it) the first time any run
// sees it, and never overwrite it. Refs live in the shared repository, so every worktree sees them.
function recordForkPoints(W, R) {
  const prs = ghJson([
    'pr',
    'list',
    '-R',
    R.repo,
    '--state',
    'open',
    '--limit',
    '200',
    '--json',
    'number,baseRefName,headRefName',
  ]);
  const recorded = [];
  for (const q of prs) {
    if (q.baseRefName === R.def) continue;
    const ref = `refs/merge-down/fork-point/${q.number}`;
    if (gitOk(W, ['rev-parse', '--verify', '--quiet', ref])) continue;
    if (!remoteBranchExists(W, q.baseRefName) || !remoteBranchExists(W, q.headRefName)) continue;
    const base = `origin/${q.baseRefName}`;
    const head = `origin/${q.headRefName}`;
    // Only trust an intact stack: the parent's current head must be inside the child.
    if (!gitOk(W, ['merge-base', '--is-ancestor', base, head])) continue;
    git(W, ['update-ref', ref, git(W, ['rev-parse', base])]);
    recorded.push(q.number);
  }
  return recorded;
}

function rebaseInProgress(W) {
  return ['rebase-merge', 'rebase-apply'].some((name) =>
    existsSync(git(W, ['rev-parse', '--path-format=absolute', '--git-path', name])),
  );
}

function snapshotDiff(P, R, pr) {
  const W = P.workdir;
  const dir = prDir(P, pr);
  if (rebaseInProgress(W)) fail('a rebase is still in progress in the worktree');
  const target = `origin/${R.def}`;
  const head = git(W, ['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'own.diff'), `${git(W, ['diff', `${target}...HEAD`])}\n`);
  const stat = git(W, ['diff', '--stat=120', `${target}...HEAD`]);
  writeFileSync(join(dir, 'own.stat'), `${stat}\n`);
  const commits = git(W, ['log', '--reverse', '--format=%h %s', `${target}..HEAD`]);
  writeFileSync(join(dir, 'commits.txt'), `${commits}\n`);
  const sync = readJson(join(dir, 'sync.json'));
  if (sync) writeJson(join(dir, 'sync.json'), { ...sync, newHead: head });
  return {
    head,
    ownCommits: commits ? commits.split('\n').length : 0,
    stat: stat.split('\n').at(-1)?.trim() ?? '',
    files: {
      diff: join(dir, 'own.diff'),
      stat: join(dir, 'own.stat'),
      commits: join(dir, 'commits.txt'),
    },
  };
}

function sync(a, P, R) {
  const pr = requirePr(a);
  const dir = prDir(P, pr);
  const p = ghJson([
    'pr',
    'view',
    String(pr),
    '-R',
    R.repo,
    '--json',
    'state,baseRefName,headRefName,headRefOid',
  ]);
  if (p.state !== 'OPEN') return { status: 'blocked', reason: `PR is ${p.state}` };

  const created = ensureWorktree(P, R);
  // A new sync is a new baseline for publish's push lease.
  rmSync(join(dir, 'published.json'), { force: true });
  const W = P.workdir;
  git(W, ['fetch', '--quiet', '--prune', 'origin']);
  run('git', ['-C', W, 'rebase', '--abort'], { allowFail: true });
  run('git', ['-C', W, 'merge', '--abort'], { allowFail: true });
  git(W, ['reset', '--quiet', '--hard']);
  git(W, ['clean', '--quiet', '-fd']);
  const forkPointsRecorded = recordForkPoints(W, R);

  if (p.baseRefName !== R.def) {
    const parent = ghJson([
      'pr',
      'list',
      '-R',
      R.repo,
      '--head',
      p.baseRefName,
      '--state',
      'all',
      '--limit',
      '1',
      '--json',
      'number,state',
    ])[0];
    if (parent?.state !== 'MERGED') {
      const who = parent ? `#${parent.number} is ${parent.state}` : 'has no PR';
      return {
        status: 'blocked',
        reason: `base branch ${p.baseRefName} is not ${R.def} and ${who}; land the parent first`,
        forkPointsRecorded,
      };
    }
  }

  const localBranch = `merge-down/pr-${pr}`;
  git(W, ['checkout', '--quiet', '-B', localBranch, `origin/${p.headRefName}`]);
  const origHead = git(W, ['rev-parse', 'HEAD']);
  const target = `origin/${R.def}`;
  const targetSha = git(W, ['rev-parse', target]);

  const result = {
    status: 'up-to-date',
    worktreeCreated: created,
    localBranch,
    headRef: p.headRefName,
    origHead,
    target: targetSha,
    forkPoint: null,
    forkSource: null,
    conflictedFiles: [],
    forkPointsRecorded,
  };

  if (!gitOk(W, ['merge-base', '--is-ancestor', target, 'HEAD'])) {
    const ref = `refs/merge-down/fork-point/${pr}`;
    const recorded = gitOk(W, ['rev-parse', '--verify', '--quiet', ref])
      ? git(W, ['rev-parse', ref])
      : null;
    if (recorded && gitOk(W, ['merge-base', '--is-ancestor', recorded, 'HEAD'])) {
      [result.forkPoint, result.forkSource] = [recorded, 'recorded'];
    } else if (p.baseRefName !== R.def && remoteBranchExists(W, p.baseRefName)) {
      const fp = git(W, ['merge-base', 'HEAD', `origin/${p.baseRefName}`]);
      [result.forkPoint, result.forkSource] = [fp, 'base-branch'];
    } else {
      // A stacked PR whose parent branch is gone has no trustworthy fork point: the merge-base
      // with the default branch predates the parent's commits, so the rebase would replay them.
      const stacked =
        p.baseRefName !== R.def ||
        ghPaged(`repos/${R.repo}/issues/${pr}/timeline`).some((e) =>
          ['base_ref_changed', 'automatic_base_change_succeeded'].includes(e.event),
        );
      if (stacked) {
        return {
          ...result,
          status: 'blocked',
          reason:
            `PR was stacked on another branch, and no fork point was recorded before that branch ` +
            `was rewritten or deleted. Record refs/merge-down/fork-point/${pr} (the parent's head as ` +
            `this PR saw it) and re-run, or rebase it by hand.`,
        };
      }
      [result.forkPoint, result.forkSource] = [
        git(W, ['merge-base', 'HEAD', target]),
        'merge-base',
      ];
    }
    // What changed underneath this PR since it was written: the input to a semantic rebase.
    writeFileSync(
      join(dir, 'upstream-delta.patch'),
      `${git(W, ['diff', result.forkPoint, target])}\n`,
    );
    const deltaStat = git(W, ['diff', '--stat=120', result.forkPoint, target]);
    writeFileSync(join(dir, 'upstream-delta.stat'), `${deltaStat}\n`);
    result.upstreamDelta = deltaStat.split('\n').at(-1)?.trim() ?? '';

    result.originalCommits = Number(git(W, ['rev-list', '--count', `${result.forkPoint}..HEAD`]));
    const r = run('git', ['-C', W, 'rebase', '--onto', target, result.forkPoint], {
      allowFail: true,
      env: { GIT_EDITOR: 'true' },
    });
    writeFileSync(join(dir, 'rebase.log'), stripAnsi(r.stdout + r.stderr));
    if (r.status === 0) result.status = 'rebased';
    else {
      result.conflictedFiles = git(W, ['diff', '--name-only', '--diff-filter=U'])
        .split('\n')
        .filter(Boolean);
      result.status = rebaseInProgress(W) ? 'conflict' : 'error';
      result.log = join(dir, 'rebase.log');
    }
  }
  writeJson(join(dir, 'sync.json'), result);
  if (result.status === 'rebased' || result.status === 'up-to-date') {
    const snap = snapshotDiff(P, R, pr);
    Object.assign(result, { newHead: snap.head, ownCommits: snap.ownCommits, stat: snap.stat });
    result.files = result.forkPoint
      ? { ...snap.files, upstreamDelta: join(dir, 'upstream-delta.patch') }
      : snap.files;
    writeJson(join(dir, 'sync.json'), result);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Local checks

const checkLabel = (a) => (typeof a.label === 'string' ? a.label : 'check');
const checkResultFile = (P, pr, label) => join(prDir(P, pr), `${label}.result.json`);

// Each check also leaves its result in <label>.result.json (written whole, by rename), which is how
// check-wait sees a detached check finish.
function check(a, P) {
  const pr = requirePr(a);
  const result = runCheck(a, P);
  const file = checkResultFile(P, pr, checkLabel(a));
  writeJson(`${file}.tmp`, result);
  renameSync(`${file}.tmp`, file);
  return result;
}

// The suite can take longer than an agent's 10-minute shell limit, so a relaying clerk cannot run
// `check` in one call: its output never arrived (#273, #279), and the landing paid for a fix round
// that only re-ran the suite. check-start launches the same `check` detached (its own process group,
// so it outlives the clerk's shell) and returns at once; check-wait then waits in bounded slices.
function checkStart(a, P) {
  const pr = requirePr(a);
  const label = checkLabel(a);
  const file = checkResultFile(P, pr, label);
  rmSync(file, { force: true });
  const args = [fileURLToPath(import.meta.url), 'check', '--pr', String(pr), '--label', label];
  args.push('--root', P.root);
  if (typeof a.repo === 'string') args.push('--repo', a.repo);
  if (typeof a.cmd === 'string') args.push('--cmd', a.cmd);
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  const started = { label, pid: child.pid, startedAt: nowIso() };
  writeJson(join(prDir(P, pr), `${label}.started.json`), started);
  return { started: true, ...started };
}

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

async function checkWait(a, P) {
  const pr = requirePr(a);
  const label = checkLabel(a);
  const file = checkResultFile(P, pr, label);
  const started = readJson(join(prDir(P, pr), `${label}.started.json`));
  if (!started) fail(`no check was started with label ${label}; run check-start first`);
  const maxSeconds = Number(a['max-seconds'] ?? 540);
  const begin = Date.now();
  for (;;) {
    if (existsSync(file)) return { done: true, ...readJson(file) };
    if (!processAlive(started.pid)) {
      if (existsSync(file)) return { done: true, ...readJson(file) };
      return {
        done: true,
        passed: false,
        failedStep: null,
        error: `the check process (pid ${started.pid}) exited without a result`,
      };
    }
    const waitedSeconds = Math.round((Date.now() - begin) / 1000);
    if (waitedSeconds >= maxSeconds) {
      return { done: false, label, pid: started.pid, startedAt: started.startedAt, waitedSeconds };
    }
    await sleep(5_000);
  }
}

// ---------------------------------------------------------------------------------------------
// Local Codex review

// `codex review --base origin/<default>` over the worktree's head, instead of asking the GitHub
// Codex app with "@codex review" and waiting for its threads. A review takes many minutes, so it
// runs detached like the check suite: local-review-start launches it (or returns a finished review
// of the same head at once) and local-review-wait waits in bounded slices. The review text goes to
// codex-review-<sha>.md; the workflow's triage reads that file, not a relayed copy.
const reviewStem = (P, pr, sha) => join(prDir(P, pr), `codex-review-${sha.slice(0, 12)}`);
const requireSha = (a, W) => {
  const sha = typeof a.sha === 'string' ? a.sha : git(W, ['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{7,40}$/.test(sha)) fail(`--sha must be a commit SHA, got ${sha}`);
  return gitOk(W, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])
    ? git(W, ['rev-parse', sha])
    : fail(`commit ${sha} is not in the worktree`);
};

// Codex marks each finding with a priority tag such as "[P1]".
export function reviewFindings(text) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const m of text.matchAll(/\[(P[0-3])\]/g)) counts[m[1]]++;
  return { findings: Object.values(counts).reduce((x, y) => x + y, 0), priorities: counts };
}

// Each review runs in a throwaway worktree of its own at the reviewed head (removed afterwards),
// under Codex's read-only sandbox. The workflow's worktree is shared with the check suite running
// at the same time and with later fix rounds, and a review can outlive a failed or timed-out wait,
// so a review never reads from or writes to it.
const reviewWorktree = (P, pr, sha) => join(prDir(P, pr), `review-${sha.slice(0, 12)}`);
function removeReviewWorktree(W, dir) {
  run('git', ['-C', W, 'worktree', 'remove', '--force', dir], { allowFail: true });
  rmSync(dir, { recursive: true, force: true });
  run('git', ['-C', W, 'worktree', 'prune'], { allowFail: true });
}

function localReview(a, P, R) {
  const pr = requirePr(a);
  const W = P.workdir;
  const sha = requireSha(a, W);
  const stem = reviewStem(P, pr, sha);
  const base = `origin/${R.def}`;
  const model = typeof a.model === 'string' ? a.model : 'gpt-6-astra';
  const args = [
    'review',
    '--base',
    base,
    '-c',
    `model="${model}"`,
    '-c',
    'sandbox_mode="read-only"',
  ];
  if (typeof a.effort === 'string') args.push('-c', `model_reasoning_effort="${a.effort}"`);
  const RW = reviewWorktree(P, pr, sha);
  removeReviewWorktree(W, RW); // left behind by a review that was killed
  git(W, ['worktree', 'add', '--detach', RW, sha]);
  try {
    const started = Date.now();
    const r = spawnSync('codex', args, {
      cwd: RW,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      timeout: Number(a['timeout-minutes'] ?? 40) * 60_000,
    });
    const text = stripAnsi(r.stdout ?? '').trim();
    writeFileSync(`${stem}.md`, `${text}\n`);
    writeFileSync(`${stem}.log`, stripAnsi(r.stderr ?? ''));
    const result = {
      sha,
      base,
      model,
      file: `${stem}.md`,
      log: `${stem}.log`,
      exitCode: r.status,
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
      ...reviewFindings(text),
    };
    if (r.error) result.error = `codex review failed to run: ${r.error.message}`;
    else if (r.status !== 0)
      result.error = `codex review exited ${r.status}: ${tail(stripAnsi(r.stderr ?? ''), 5)}`;
    else if (!text) result.error = 'codex review printed no review';
    // Both are about the review's own worktree, which is discarded: reported for information.
    const dirty = git(RW, ['status', '--porcelain']);
    if (dirty) result.dirty = dirty.split('\n');
    if (git(RW, ['rev-parse', 'HEAD']) !== sha) {
      result.moved = true;
      result.error ??= `the review moved its worktree off ${sha.slice(0, 7)}`;
    }
    return result;
  } finally {
    removeReviewWorktree(W, RW);
  }
}

function localReviewRun(a, P, R) {
  const pr = requirePr(a);
  const sha = requireSha(a, P.workdir);
  const result = localReview({ ...a, sha }, P, R);
  const file = `${reviewStem(P, pr, sha)}.result.json`;
  writeJson(`${file}.tmp`, result);
  renameSync(`${file}.tmp`, file);
  return result;
}

function localReviewStart(a, P) {
  const pr = requirePr(a);
  const sha = requireSha(a, P.workdir);
  const stem = reviewStem(P, pr, sha);
  const previous = readJson(`${stem}.result.json`);
  // A finished review of the same head is reused: a resumed run does not pay for it twice.
  if (previous && !previous.error) return { started: false, cached: true, done: true, ...previous };
  rmSync(`${stem}.result.json`, { force: true });
  const args = [fileURLToPath(import.meta.url), 'local-review', '--pr', String(pr), '--sha', sha];
  args.push('--root', P.root);
  for (const flag of ['repo', 'model', 'effort', 'timeout-minutes']) {
    if (typeof a[flag] === 'string') args.push(`--${flag}`, a[flag]);
  }
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  const started = { sha, pid: child.pid, startedAt: nowIso() };
  writeJson(`${stem}.started.json`, started);
  return { started: true, cached: false, ...started };
}

async function localReviewWait(a, P) {
  const pr = requirePr(a);
  const sha = requireSha(a, P.workdir);
  const stem = reviewStem(P, pr, sha);
  const file = `${stem}.result.json`;
  const started = readJson(`${stem}.started.json`);
  if (!started && !existsSync(file)) fail(`no review of ${sha.slice(0, 7)} was started`);
  const maxSeconds = Number(a['max-seconds'] ?? 540);
  const begin = Date.now();
  for (;;) {
    if (existsSync(file)) return { done: true, ...readJson(file) };
    if (!processAlive(started.pid)) {
      if (existsSync(file)) return { done: true, ...readJson(file) };
      return {
        done: true,
        sha,
        error: `the review process (pid ${started.pid}) exited without a result`,
      };
    }
    const waitedSeconds = Math.round((Date.now() - begin) / 1000);
    if (waitedSeconds >= maxSeconds) {
      return { done: false, sha, pid: started.pid, startedAt: started.startedAt, waitedSeconds };
    }
    await sleep(5_000);
  }
}

// A review whose wait failed or timed out is stopped, so it does not run on unobserved. The
// review is its own process group (spawned detached), so the group signal reaches codex too.
const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
async function localReviewStop(a, P) {
  const pr = requirePr(a);
  const sha = requireSha(a, P.workdir);
  const stem = reviewStem(P, pr, sha);
  const started = readJson(`${stem}.started.json`);
  const pid = started?.sha === sha ? started.pid : null;
  let signalled = false;
  if (pid && !existsSync(`${stem}.result.json`) && groupAlive(pid)) {
    for (const [signal, seconds] of [
      ['SIGTERM', 20],
      ['SIGKILL', 10],
    ]) {
      if (!groupAlive(pid)) break;
      try {
        process.kill(-pid, signal);
        signalled = true;
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      for (let i = 0; i < seconds && groupAlive(pid); i++) await sleep(1_000);
    }
  }
  const alive = pid ? groupAlive(pid) : false;
  if (alive) fail(`the review process group ${pid} is still running after SIGKILL`);
  removeReviewWorktree(P.workdir, reviewWorktree(P, pr, sha));
  return { sha, pid, stopped: signalled };
}

function runCheck(a, P) {
  const pr = requirePr(a);
  const W = P.workdir;
  const dir = prDir(P, pr);
  const label = checkLabel(a);
  const log = join(dir, `${label}.log`);
  const started = Date.now();

  const lockHash = createHash('sha256')
    .update(readFileSync(join(W, 'package-lock.json')))
    .digest('hex');
  const stamp = join(W, 'node_modules', '.merge-down-lock-hash');
  let installed = false;
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== lockHash) {
    const r = run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: W, allowFail: true });
    if (r.status !== 0) {
      writeFileSync(log, stripAnsi(r.stdout + r.stderr));
      return {
        passed: false,
        failedStep: 'npm ci',
        seconds: Math.round((Date.now() - started) / 1000),
        log,
        excerptFile: writeExcerpt(log, tail(stripAnsi(r.stderr || r.stdout), 30)),
      };
    }
    writeFileSync(stamp, lockHash);
    installed = true;
  }

  const cmd = typeof a.cmd === 'string' ? a.cmd : 'npm run check';
  const loadEnv = checkLoadEnv();
  const r = run('bash', ['-c', cmd], {
    cwd: W,
    allowFail: true,
    env: { NO_COLOR: '1', FORCE_COLOR: '0', ...loadEnv },
  });
  const text = stripAnsi(`${r.stdout}\n${r.stderr}`);
  writeFileSync(log, text);
  const steps = [...text.matchAll(/^> \S+ ([\w:.-]+)$/gm)].map((m) => m[1]);
  const passed = r.status === 0;
  return {
    passed,
    head: git(W, ['rev-parse', 'HEAD']),
    maxWorkers: loadEnv.VITEST_MAX_WORKERS ?? null,
    exitCode: r.status,
    failedStep: passed ? null : (steps.at(-1) ?? null),
    seconds: Math.round((Date.now() - started) / 1000),
    installedDependencies: installed,
    log,
    excerptFile: passed ? null : writeExcerpt(log, tail(text, 40)),
  };
}

// ---------------------------------------------------------------------------------------------
// Publishing, replies, and waiting

async function publish(a, P, R) {
  const pr = requirePr(a);
  const dir = prDir(P, pr);
  const W = P.workdir;
  const synced = readJson(join(dir, 'sync.json')) ?? fail('run sync first');
  const published = readJson(join(dir, 'published.json'));
  const head = git(W, ['rev-parse', 'HEAD']);
  const p = ghJson([
    'pr',
    'view',
    String(pr),
    '-R',
    R.repo,
    '--json',
    'state,baseRefName,headRefName,headRefOid,body',
  ]);
  if (p.state !== 'OPEN') fail(`PR is ${p.state}`);
  const expected = published?.head ?? synced.origHead;
  if (p.headRefOid !== expected && p.headRefOid !== head) {
    fail(`remote head moved to ${p.headRefOid} (expected ${expected}); someone else pushed`);
  }

  const result = { head, retargeted: false, pushed: false, bodyUpdated: false, linked: null };
  if (p.baseRefName !== R.def) {
    gh(['pr', 'edit', String(pr), '-R', R.repo, '--base', R.def]);
    result.retargeted = true;
  }
  if (p.headRefOid !== head) {
    run('git', [
      '-C',
      W,
      'push',
      '--quiet',
      `--force-with-lease=refs/heads/${p.headRefName}:${p.headRefOid}`,
      'origin',
      `HEAD:refs/heads/${p.headRefName}`,
    ]);
    result.pushed = true;
  }
  if (a['keep-open']) {
    // The issue must survive this merge: neutralize closing keywords that GitHub would act on.
    const issue = Number(a['keep-open']);
    const qualified = R.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const closing = new RegExp(
      `\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\b(:?\\s+)(?:${qualified})?#${issue}\\b`,
      'gi',
    );
    if (closing.test(p.body ?? '')) {
      const body = (p.body ?? '').replace(closing, `Refs #${issue}`);
      gh(['pr', 'edit', String(pr), '-R', R.repo, '--body-file', '-'], { input: body });
      result.bodyUpdated = true;
    }
  }
  if (a['ensure-closes']) {
    const issue = Number(a['ensure-closes']);
    const keyword = new RegExp(
      `\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\b:?\\s+#${issue}\\b`,
      'i',
    );
    const setBody = (body) =>
      gh(['pr', 'edit', String(pr), '-R', R.repo, '--body-file', '-'], { input: body });
    if (!keyword.test(p.body ?? '')) {
      setBody(`${(p.body ?? '').trimEnd()}\n\nCloses #${issue}.\n`);
      result.bodyUpdated = true;
    }
    const isLinked = () =>
      ghJson(['pr', 'view', String(pr), '-R', R.repo, '--json', 'closingIssuesReferences'])
        .closingIssuesReferences.map((x) => x.number)
        .includes(issue);
    for (let i = 0; i < 12 && !result.linked; i++) {
      if (i) await sleep(2000);
      // Keywords in a PR that targeted another branch are not linked; re-saving the body after
      // the retarget makes GitHub parse them again.
      if (i === 5 && !result.bodyUpdated) setBody(p.body ?? '');
      result.linked = isLinked();
    }
  }
  result.at = nowIso();
  writeJson(join(dir, 'published.json'), { head, at: result.at });
  return result;
}

// Check an implementer's report mechanically: every commit it names is in the branch, and the
// last check run passed against the exact current head.
function verifyFixes(a, P) {
  const pr = requirePr(a);
  const W = P.workdir;
  const commits = String(a.commits ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const head = git(W, ['rev-parse', 'HEAD']);
  const missing = commits.filter(
    (c) =>
      !gitOk(W, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`]) ||
      !gitOk(W, ['merge-base', '--is-ancestor', c, head]),
  );
  const saved = readJson(join(prDir(P, pr), 'last', 'check.json'));
  const checkOk = Boolean(saved?.passed) && saved?.head === head;
  return {
    head,
    missingCommits: missing,
    checkPassedAtHead: checkOk,
    checkHead: saved?.head ?? null,
  };
}

function dismissAlert(R, number, path, comment, deferred = false) {
  const where =
    path ??
    ghJson(['api', `repos/${R.repo}/code-scanning/alerts/${number}`]).most_recent_instance?.location
      ?.path ??
    '';
  const testOnly = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]s$/.test(where);
  gh([
    'api',
    '-X',
    'PATCH',
    `repos/${R.repo}/code-scanning/alerts/${number}`,
    '-f',
    'state=dismissed',
    '-f',
    `dismissed_reason=${deferred ? "won't fix" : testOnly ? 'used in tests' : 'false positive'}`,
    '-f',
    `dismissed_comment=${comment.slice(0, 280)}`,
  ]);
}

function reply(a, P, R) {
  const pr = requirePr(a);
  const dir = prDir(P, pr);
  const items = JSON.parse(readFileSync(0, 'utf8'));
  if (!Array.isArray(items)) fail('stdin must be a JSON array of {threadId, body, resolve}');
  writeJson(join(dir, `replies-${Date.now()}.json`), items);
  // Resolve Codex threads by default; leave human threads open for their author.
  const known = readJson(join(dir, 'threads.json')) ?? [];
  const results = [];
  for (const item of items) {
    const entry = { threadId: item.threadId, replied: false, resolved: false };
    const standalone = /^alert:(\d+)$/.exec(item.threadId);
    if (standalone) {
      // A code-scanning alert with no review thread: nothing to reply to, only an alert to settle.
      try {
        if (item.dismiss) {
          dismissAlert(R, Number(standalone[1]), null, item.body, item.dismiss === 'defer');
        }
        entry.dismissedAlert = item.dismiss ? Number(standalone[1]) : null;
      } catch (error) {
        entry.error = error.message;
      }
      results.push(entry);
      continue;
    }
    try {
      const posted = ghJson([
        'api',
        'graphql',
        '-f',
        'query=mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{url}}}',
        '-f',
        `t=${item.threadId}`,
        '-f',
        `b=${item.body}`,
      ]);
      entry.replied = true;
      entry.url = posted.data.addPullRequestReviewThreadReply.comment.url;
      const thread = known.find((t) => t.id === item.threadId);
      if (item.dismiss && thread?.alert) {
        dismissAlert(R, thread.alert, thread.path, item.body, item.dismiss === 'defer');
        entry.dismissedAlert = thread.alert;
      }
      if (item.resolve ?? (thread?.isCodex || thread?.isBot) ?? false) {
        ghJson([
          'api',
          'graphql',
          '-f',
          'query=mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}',
          '-f',
          `t=${item.threadId}`,
        ]);
        entry.resolved = true;
      }
    } catch (error) {
      entry.error = error.message;
    }
    results.push(entry);
  }
  return { results, failures: results.filter((r) => r.error).length };
}

function requestReview(a, P, R) {
  const pr = requirePr(a);
  const since = nowIso();
  const url = gh(['pr', 'comment', String(pr), '-R', R.repo, '--body', '@codex review']);
  return { requested: true, since, commentUrl: url };
}

// Re-run failed jobs for a commit once, to separate flakes from real failures. Returns after
// GitHub reports the re-run as in progress, so a following await sees pending checks.
async function rerunFailed(a, P, R) {
  const sha = a.sha ?? fail('--sha is required');
  const list = () =>
    ghJson([
      'run',
      'list',
      '-R',
      R.repo,
      '--commit',
      sha,
      '--json',
      'databaseId,name,status,conclusion,attempt',
    ]);
  const failed = list().filter((r) => r.status === 'completed' && r.conclusion === 'failure');
  for (const r of failed) gh(['run', 'rerun', String(r.databaseId), '--failed', '-R', R.repo]);
  const ids = failed.map((r) => r.databaseId);
  for (let i = 0; i < 20 && ids.length; i++) {
    await sleep(3000);
    if (list().some((r) => ids.includes(r.databaseId) && r.status !== 'completed')) break;
  }
  return { rerun: failed.map((r) => ({ id: r.databaseId, name: r.name, attempt: r.attempt })) };
}

function codexProgress(R, pr, sha, since, seenComplete) {
  const act = codexActivity(R, pr);
  const t = Date.parse(since) - 5000; // tolerate clock skew
  const fresh = (iso) => Boolean(iso) && Date.parse(iso) >= t;
  const findings = act.reviews.filter((r) => r.commit === sha && fresh(r.submittedAt));
  if (findings.length) return { state: 'findings', reviewIds: findings.map((r) => r.id) };
  if (act.reactions.some((r) => r.content === '+1' && fresh(r.createdAt))) {
    return { state: 'clean', via: 'reaction' };
  }
  if (act.limitNotices.some((n) => fresh(n.createdAt))) {
    return { state: 'error', reason: 'Codex usage limit reached' };
  }
  const row = act.rows.find((r) => sha.startsWith(r.commit));
  if (row && fresh(act.summaryUpdatedAt)) {
    if (/fail|error|cancel/i.test(row.status)) return { state: 'error', row };
    // A finished review posts its findings right after updating the summary; require the
    // "Completed" row on two consecutive polls before calling it clean.
    if (/complete/i.test(row.status)) return { state: seenComplete ? 'clean' : 'completing', row };
    return { state: 'running', row };
  }
  if (act.reactions.some((r) => r.content === 'eyes')) return { state: 'running', via: 'reaction' };
  return { state: 'pending' };
}

async function awaitGate(a, P, R) {
  const pr = requirePr(a);
  const sha = a.sha ?? fail('--sha is required');
  const since = a.since ?? nowIso();
  const codexMode = a.codex ?? 'required';
  // --ci skip: wait for the Codex review alone (a caller that gates on CI later, e.g. the
  // epic workflow's first-review wait, should not sit out a slow CI queue here).
  const ciMode = a.ci ?? 'wait';
  const maxSeconds = Number(a['max-seconds'] ?? 420);
  const ciGraceMs = Number(a['ci-grace'] ?? 300) * 1000;
  // GitHub can report the previous head for a while after a push. A head that is an ancestor of
  // the one we pushed is that stale view, not someone else's push: keep polling through a short
  // grace period (--stale-grace seconds) before calling it moved.
  const staleGraceMs = Number(a['stale-grace'] ?? 0) * 1000;
  const isAncestor = (older) =>
    existsSync(join(P.workdir, '.git')) &&
    gitOk(P.workdir, ['merge-base', '--is-ancestor', older, sha]);
  const started = Date.now();
  let seenComplete = false;
  for (;;) {
    const p = ghJson([
      'pr',
      'view',
      String(pr),
      '-R',
      R.repo,
      '--json',
      'state,headRefOid,statusCheckRollup',
    ]);
    if (p.headRefOid !== sha) {
      if (Date.now() - started < staleGraceMs && isAncestor(p.headRefOid)) {
        await sleep(10_000);
        continue;
      }
      return { done: true, headMoved: true, headSha: p.headRefOid, state: p.state };
    }
    const ci = ciSummary(p.statusCheckRollup);
    const ciDone =
      ciMode === 'skip' ||
      ci.state === 'success' ||
      ci.state === 'failure' ||
      (ci.state === 'none' && Date.now() - Date.parse(since) > ciGraceMs);
    const codex =
      codexMode === 'skip' ? { state: 'skipped' } : codexProgress(R, pr, sha, since, seenComplete);
    seenComplete = codex.state === 'completing';
    const codexDone = ['skipped', 'clean', 'findings', 'error'].includes(codex.state);
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    if (ciDone && codexDone) {
      // Code-scanning review comments land shortly after the CodeQL check completes.
      await sleep(20_000);
      const refreshed = prState({ ...a, pr }, P, R);
      return {
        done: true,
        headMoved: false,
        timedOut: false,
        ci,
        codex,
        elapsedSeconds,
        unresolvedThreads: refreshed.codex.unresolvedThreads,
        attention: {
          untriagedThreads: refreshed.untriagedThreads,
          openAlerts: refreshed.openAlerts.length,
        },
        threadsFile: refreshed.files.threads,
      };
    }
    // Stop before a sleep that would start the next poll past the deadline: the final poll, the
    // 20 s code-scanning settle and the refresh can take a minute under load, and a caller that
    // runs this under a 10-minute shell limit must get its line before that limit (#359's landing
    // lost a round when the command outlived it and was moved to the background).
    if (elapsedSeconds + 30 >= maxSeconds) {
      return { done: false, headMoved: false, timedOut: true, ci, codex, elapsedSeconds };
    }
    await sleep(30_000);
  }
}

// ---------------------------------------------------------------------------------------------
// Landing

async function land(a, P, R) {
  const pr = requirePr(a);
  const sha = a.sha ?? fail('--sha is required');
  const issue = a.issue ? Number(a.issue) : null;
  const dir = prDir(P, pr);
  const p = ghJson([
    'pr',
    'view',
    String(pr),
    '-R',
    R.repo,
    '--json',
    'state,headRefOid,baseRefName,headRefName,closingIssuesReferences',
  ]);
  if (p.state !== 'OPEN') fail(`PR is ${p.state}`);
  if (p.headRefOid !== sha) return { merged: false, reason: `head moved to ${p.headRefOid}` };
  if (p.baseRefName !== R.def) {
    return { merged: false, reason: `base is ${p.baseRefName}, expected ${R.def}` };
  }
  const linked = p.closingIssuesReferences.map((x) => x.number);
  const untriaged = reviewThreads(R, pr).filter(
    (t) => !t.isResolved && (t.lastAuthor ?? t.author) !== R.viewer,
  );
  if (untriaged.length && !a['allow-untriaged']) {
    const list = untriaged.map((t) => `${t.id} (${t.author}: ${t.title})`).join('; ');
    return { merged: false, reason: `unanswered review threads: ${list}` };
  }
  const alerts = openAlerts(R, pr);
  if (alerts.length && !a['allow-alerts']) {
    const list = alerts.map((x) => `#${x.number} ${x.rule} ${x.path}:${x.line}`).join('; ');
    return { merged: false, reason: `open code-scanning alerts on the PR: ${list}` };
  }

  // The REST endpoint merges now or fails; `gh pr merge` may instead enqueue the PR or enable
  // auto-merge, which would land it later without this workflow's verification.
  gh([
    'api',
    '-X',
    'PUT',
    `repos/${R.repo}/pulls/${pr}/merge`,
    '-f',
    'merge_method=squash',
    '-f',
    `sha=${sha}`,
  ]);
  let mergeCommit = null;
  for (let i = 0; i < 20 && !mergeCommit; i++) {
    if (i) await sleep(3000);
    const q = ghJson(['pr', 'view', String(pr), '-R', R.repo, '--json', 'state,mergeCommit']);
    if (q.state === 'MERGED') mergeCommit = q.mergeCommit?.oid ?? 'unknown';
  }
  if (!mergeCommit) fail('merge command succeeded but the PR never reported MERGED');

  const result = { merged: true, mergeCommit, issue: null, children: [] };
  if (issue) {
    let state = null;
    for (let i = 0; i < 20; i++) {
      if (i) await sleep(3000);
      state = ghJson(['issue', 'view', String(issue), '-R', R.repo, '--json', 'state']).state;
      if (state === 'CLOSED' || !a['expect-close']) break;
    }
    if (a['keep-open']) {
      // Commit messages can still carry a closing keyword; give GitHub a moment, then undo it.
      await sleep(5000);
      state = ghJson(['issue', 'view', String(issue), '-R', R.repo, '--json', 'state']).state;
      if (state === 'CLOSED') {
        const note = `Reopened: #${pr} landed only part of this issue; the merge-down review kept it open for the remaining items.`;
        gh(['issue', 'reopen', String(issue), '-R', R.repo, '--comment', note]);
        state = 'OPEN';
        result.reopened = true;
      }
    }
    result.issue = { number: issue, state, linked: linked.includes(issue), closedManually: false };
    if (a['expect-close'] && state !== 'CLOSED') {
      const comment = `Closed by #${pr} (merged as ${mergeCommit.slice(0, 7)}).`;
      gh([
        'issue',
        'close',
        String(issue),
        '-R',
        R.repo,
        '--reason',
        'completed',
        '--comment',
        comment,
      ]);
      result.issue = { ...result.issue, state: 'CLOSED', closedManually: true };
    }
  }
  const known = readJson(join(dir, 'state.json'))?.children ?? [];
  // GitHub deletes the merged head branch and retargets children shortly after the merge.
  for (const child of known) {
    let c = null;
    for (let i = 0; i < 10; i++) {
      if (i) await sleep(3000);
      c = ghJson(['pr', 'view', String(child.pr), '-R', R.repo, '--json', 'state,baseRefName']);
      if (c.baseRefName !== p.headRefName) break;
    }
    result.children.push({ pr: child.pr, state: c.state, base: c.baseRefName });
  }
  const W = P.workdir;
  if (existsSync(join(W, '.git'))) {
    run('git', ['-C', W, 'checkout', '--quiet', '--detach'], { allowFail: true });
    run('git', ['-C', W, 'branch', '--quiet', '-D', `merge-down/pr-${pr}`], { allowFail: true });
  }
  return result;
}

async function close(a, P, R) {
  const pr = requirePr(a);
  const body = readFileSync(0, 'utf8').trim();
  if (body) gh(['pr', 'comment', String(pr), '-R', R.repo, '--body-file', '-'], { input: body });
  for (let i = 0; i < 30; i++) {
    const state = ghJson(['pr', 'view', String(pr), '-R', R.repo, '--json', 'state']).state;
    if (state !== 'OPEN') return { closed: true, by: 'bot-or-comment', state };
    await sleep(3000);
  }
  gh(['pr', 'close', String(pr), '-R', R.repo]);
  return { closed: true, by: 'workflow', state: 'CLOSED' };
}

// ---------------------------------------------------------------------------------------------

const COMMANDS = {
  prepare: (a, P, R) => {
    const state = prState(a, P, R);
    const synced =
      state.state === 'OPEN' ? sync(a, P, R) : { status: 'blocked', reason: 'not open' };
    return { paths: P, repo: R.repo, defaultBranch: R.def, pr: state, sync: synced };
  },
  paths: (a, P, R) => ({ paths: P, repo: R.repo, defaultBranch: R.def }),
  state: prState,
  sync,
  snapshot: (a, P, R) => snapshotDiff(P, R, requirePr(a)),
  check: (a, P) => check(a, P),
  'check-start': (a, P) => checkStart(a, P),
  'check-wait': (a, P) => checkWait(a, P),
  'local-review': localReviewRun,
  'local-review-start': (a, P) => localReviewStart(a, P),
  'local-review-wait': (a, P) => localReviewWait(a, P),
  'local-review-stop': (a, P) => localReviewStop(a, P),
  publish,
  reply,
  'request-review': requestReview,
  rerun: rerunFailed,
  'verify-fixes': (a, P) => verifyFixes(a, P),
  await: awaitGate,
  land,
  close,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  let saveTo = null;
  let output;
  try {
    const P = paths(a);
    const pr = a.pr ? requirePr(a) : null;
    if (command === 'last') {
      // Re-print a saved output verbatim, so a relay can be retried without repeating effects.
      const file = join(P.stateDir, `pr-${pr}`, 'last', `${a.cmd}.json`);
      return existsSync(file)
        ? readFileSync(file, 'utf8')
        : `${JSON.stringify({ error: 'no saved output' })}\n`;
    }
    const handler = COMMANDS[command];
    if (!handler) {
      fail(
        `unknown command "${command}"; expected one of last, ${Object.keys(COMMANDS).join(', ')}`,
      );
    }
    if (pr) saveTo = join(prDir(P, pr), 'last', `${command}.json`);
    output = await handler(a, P, repoInfo(a, P));
  } catch (error) {
    output = { error: error instanceof Failure ? error.message : (error?.stack ?? String(error)) };
    process.exitCode = 1;
  }
  const payload = { ...output, _nonce: typeof a.nonce === 'string' ? a.nonce : null };
  const line = `${JSON.stringify({ ...payload, _fnv: fnv(JSON.stringify(payload)) })}\n`;
  if (saveTo) {
    mkdirSync(dirname(saveTo), { recursive: true });
    writeFileSync(saveTo, line);
  }
  return line;
}

process.stdout.write(await main());
