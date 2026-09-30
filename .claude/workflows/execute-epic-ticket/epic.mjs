#!/usr/bin/env node
// Deterministic git and GitHub plumbing for the execute-epic-ticket workflow
// (.claude/workflows/execute-epic-ticket.js). Sibling of merge-down-pr/merge-down.mjs, and it
// follows the same conventions.
//
// Every subcommand prints exactly one line of JSON on stdout. Failures print {"error": "..."} and
// exit 1. Workflow agents only run these commands and relay the JSON, so judgment stays in the
// workflow and mechanics stay here, where they can be run and tested by hand. Each output also
// carries "_nonce" (echoing --nonce) and "_fnv" (a hash of everything else) so the workflow can
// verify a relayed copy, and is saved for re-reading with `last`: under
// state/epic-E/issue-I/last/ when the command was given --issue I, else under state/epic-E/last/.
//
//   survey   --epic E [--prefer I] [--candidates N] [--hold-labels blocked,needs-decision,on-hold]
//                                     snapshot the epic's items and pick the next one
//   start    --epic E --issue I [--gate-cmd "npm run check"]
//                                     prepare the worktree and the issue's branch; write briefings
//   save     --epic E --issue I --name FILE < content      store a file in the issue's directory
//   check    --epic E --issue I [--label L] [--cmd "npm run check"]
//   snapshot --epic E --issue I       record the branch's diff, stat, and commits
//   verify   --epic E --issue I [--commits a,b]   named commits are in HEAD; last check passed there
//   open-pr  --epic E --issue I --title T < body.md        push with lease; open or update the PR
//   comment  --epic E --issue I [--add-label L] [--remove-label L] < body.md
//   close-issue --epic E --issue I --reason completed|not_planned < comment.md
//   file-issue  --epic E --title T [--label L] [--after I] < body.md   new sub-issue, listed in E
//   ensure-epic --title T < body.md   find (or create) an open issue with exactly this title
//   tick     --epic E --issue I       check the epic's checklist line for #I
//   ledger   --epic E < entry.json    append one JSON object to the epic's ledger
//   paths    --epic E                 root, worktree, state, and tools paths
//   last     --epic E [--issue I] --cmd C   re-print the saved output of the last C run
//
// Common flags: --root DIR (default: <main checkout>-epic-burndown, holding worktree/ and state/),
// --repo OWNER/NAME (default: the current directory's GitHub repository), --branch-prefix P
// (default: epic-E; issue branches are P/I-slug, and P must be one path segment). Every flag also
// accepts --flag=value; use that form for free text such as --title, because in the two-token
// form a value beginning with "--" would be read as another flag.
//
// The publishing gate (verify's checkPassedAtHead, open-pr's refusal) counts only a passing run of
// the gate command — `npm run check`, or what `start --gate-cmd` pinned in start.json — on a clean
// tree at the exact HEAD. Such a run is recorded in checks/gate.json; `check --cmd` with any other
// command is reported (its output names the cmd and says gate: false) but never opens the gate.
//
// Pure text helpers are exported so they can be tested by importing this module; main() runs only
// when the file is executed directly.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const HOLD_LABELS = ['blocked', 'needs-decision', 'on-hold'];
const LABEL_COLOR = 'BFD4F2';
const LABEL_DESCRIPTION = 'Set by the execute-epic-ticket workflow';
// The only command whose passing run opens the publishing gate, unless `start --gate-cmd` pins
// another. A check run with any other --cmd is recorded and relayed but never counts.
const DEFAULT_GATE_CMD = 'npm run check';
// Names in the issue directory that only this script may write. start.json and pr.json hold the
// branch identity, the gate command, and the push lease, so an agent's `save` must not forge them;
// the directories and generated files must not be shadowed, or later commands would break.
const RESERVED_NAMES = new Set([
  'start.json',
  'pr.json',
  'last',
  'checks',
  'issues',
  'issue.md',
  'epic.md',
  'rebase.log',
  'own.diff',
  'own.stat',
  'commits.txt',
]);
// Check logs and their excerpts (<label>.log, <label>.excerpt.txt) are generated too.
const isReservedName = (name) => RESERVED_NAMES.has(name) || /\.(log|excerpt\.txt)$/.test(name);

class Failure extends Error {}
const fail = (message) => {
  throw new Failure(message);
};

// ---------------------------------------------------------------------------------------------
// Process helpers (as in merge-down.mjs)

function run(cmd, args, { cwd, input, env, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
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

// Reading fd 0 from a terminal would block; a command run without a heredoc gets empty input.
const readStdinBuffer = () => (process.stdin.isTTY ? Buffer.alloc(0) : readFileSync(0));
const readStdin = () => readStdinBuffer().toString('utf8');

// FNV-1a over UTF-16 code units. Workflow agents relay this script's output by copying it; the
// workflow recomputes the hash to prove the copy is exact (see clerk() in the workflow).
export function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// As merge-down.mjs's parser, plus `--flag=value`. In the `--flag value` form a value that begins
// with "--" is read as the next flag, so free text (titles) should be passed as `--title=...`.
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > 2) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
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

function requireNumber(a, key) {
  const n = Number(a[key]);
  if (!Number.isInteger(n) || n <= 0) fail(`--${key} N is required`);
  return n;
}
const requireEpic = (a) => requireNumber(a, 'epic');
const requireIssue = (a) => requireNumber(a, 'issue');

function requireString(a, key) {
  const value = a[key];
  if (typeof value !== 'string' || !value.trim()) fail(`--${key} is required`);
  return value.trim();
}

// Comma-separated flag values: repeated flags would overwrite each other in parseArgs.
function listArg(value, fallback = []) {
  if (typeof value !== 'string') return fallback;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Paths and repository facts

function paths(a) {
  let root = typeof a.root === 'string' ? a.root : null;
  if (!root) {
    const common = out('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    root = `${dirname(common)}-epic-burndown`;
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

const epicPath = (P, epic) => join(P.stateDir, `epic-${epic}`);
const issuePath = (P, epic, issue) => join(epicPath(P, epic), `issue-${issue}`);

function epicDir(P, epic) {
  const dir = epicPath(P, epic);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function issueDir(P, epic, issue) {
  const dir = issuePath(P, epic, issue);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function branchPrefix(a, epic) {
  const prefix = typeof a['branch-prefix'] === 'string' ? a['branch-prefix'] : `epic-${epic}`;
  // merge-down.mjs recovers the issue from a head ref with ^[^/]+\/(\d+)-, so one segment only.
  if (!/^[\w.-]+$/.test(prefix)) fail(`--branch-prefix must be one path segment, got "${prefix}"`);
  return prefix;
}

// ---------------------------------------------------------------------------------------------
// Pure text helpers (exported for tests)

// An issue reference: bare (#12) or repository-qualified (owner/name#12). The lookbehind keeps
// "owner/name#12" from also matching as a bare "#12", and skips anchors such as "page#12".
const REF = String.raw`(?<![\w./-])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b`;
// A full issue URL, which GitHub also honours after a closing keyword.
const URL_REF = String.raw`https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\b`;
const CLOSING = String.raw`\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b`;
const CHECKLIST = /^(\s*[-*]\s+)\[( |x|X)\](\s+)(.*)$/;

const isOwn = (qualifier, repo) => !qualifier || qualifier.toLowerCase() === repo.toLowerCase();

// A closing keyword and what it closes. Groups: 1 keyword, 2 separator, 3-4 qualifier and number
// of a #ref, 5-6 repository and number of an issue URL.
const closingRe = () => new RegExp(String.raw`${CLOSING}(:?\s+)(?:${REF}|${URL_REF})`, 'gi');
function closingTarget(m, repo) {
  const [qualifier, number] = m[4] !== undefined ? [m[3], m[4]] : [m[5], m[6]];
  return { own: isOwn(qualifier, repo), number: Number(number) };
}

/** This repository's issue numbers referenced in `text`, in order (other repositories skipped). */
export function ownRefs(text, repo) {
  const found = [];
  for (const m of String(text ?? '').matchAll(new RegExp(REF, 'g'))) {
    if (isOwn(m[1], repo)) found.push(Number(m[2]));
  }
  return found;
}
export const firstOwnRef = (text, repo) => ownRefs(text, repo)[0] ?? null;

/**
 * For each line, whether it belongs to a fenced code block (``` or ~~~, fence lines included).
 * A closing fence uses the opening fence's character and is at least as long; an unclosed fence
 * runs to the end, as in CommonMark. Examples in fences are never checklist items or markers.
 */
export function fenceMask(lines) {
  let fence = null;
  return lines.map((line) => {
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return true;
    }
    const open = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    // A backtick fence's info string cannot contain a backtick (that line is inline code).
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1];
      return true;
    }
    return false;
  });
}

const indentOf = (line) => /^\s*/.exec(line)[0].length;

/** Per line: {m, ref, indent} for a checklist line outside fenced code, else null. */
function checklistLines(lines, repo) {
  const fenced = fenceMask(lines);
  return lines.map((line, k) => {
    const m = fenced[k] ? null : CHECKLIST.exec(line);
    return m ? { m, ref: firstOwnRef(m[4], repo), indent: indentOf(line) } : null;
  });
}

/** Text with fenced blocks and inline code spans removed, so quoted examples are not read. */
export function stripCode(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const fenced = fenceMask(lines);
  return lines
    .filter((_, k) => !fenced[k])
    .join('\n')
    .replace(/(`+)[^\n]*?\1/g, '');
}

/** Checklist lines that name one of this repository's issues, in body order, first line wins. */
export function parseChecklist(body, repo) {
  const items = [];
  const seen = new Set();
  for (const p of checklistLines(String(body ?? '').split(/\r?\n/), repo)) {
    if (!p || p.ref === null || seen.has(p.ref)) continue;
    seen.add(p.ref);
    items.push({ number: p.ref, checked: p.m[2] !== ' ', text: p.m[4].trim() });
  }
  return items;
}

const DEP_REF = String.raw`(?:[\w.-]+\/[\w.-]+)?#\d+`;
const DEP_SEP = String.raw`(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s+)`;
const DEP_PHRASE = new RegExp(
  String.raw`\b(?:depends\s+on|blocked\s+by|requires)\b\s*:?\s*(${DEP_REF}(?:${DEP_SEP}${DEP_REF})*)`,
  'gi',
);
// Markers must list at least one number: a template such as <!-- epic:split a,b --> is not one.
const NUMBER_LIST = String.raw`(\d+(?:\s*,\s*\d+)*)`;
const DEP_MARKER = new RegExp(String.raw`<!--\s*epic:depends-on\s+${NUMBER_LIST}\s*-->`, 'gi');
const SPLIT_MARKER = new RegExp(String.raw`<!--\s*epic:split\s+${NUMBER_LIST}\s*-->`, 'gi');
const numbersIn = (text) => (String(text).match(/\d+/g) ?? []).map(Number);

/**
 * Dependencies declared in prose ("Depends on #3", "blocked by: #4, #5 and #6", "requires #7") or
 * by the machine marker <!-- epic:depends-on 3,4 -->, across all given texts; unique, never self.
 * Code (fenced or inline) is ignored. A wrongly read dependency only delays an item, so these are
 * honoured from any author.
 */
export function parseDependencies(texts, repo, self) {
  const deps = [];
  for (const raw of texts) {
    const text = stripCode(raw);
    for (const m of text.matchAll(DEP_PHRASE)) deps.push(...ownRefs(m[1], repo));
    for (const m of text.matchAll(DEP_MARKER)) deps.push(...numbersIn(m[1]));
  }
  return [...new Set(deps)].filter((n) => n !== self);
}

/**
 * The slices named by the last <!-- epic:split a,b --> marker outside code (a re-split replaces),
 * never self; null when there is none or it names only self.
 */
export function parseSplit(texts, self = null) {
  let split = null;
  for (const text of texts) {
    for (const m of stripCode(text).matchAll(SPLIT_MARKER)) {
      split = [...new Set(numbersIn(m[1]))].filter((n) => n !== self);
    }
  }
  return split?.length ? split : null;
}

/**
 * A split closes an item, so only markers in comments by `viewer` (the account this workflow
 * posts as) count: anyone else quoting the syntax must not get an unfinished issue closed.
 */
export function splitFromComments(comments, viewer, self) {
  const who = String(viewer ?? '').toLowerCase();
  const mine = (comments ?? []).filter((c) => who && c.author?.login?.toLowerCase() === who);
  return parseSplit(
    mine.map((c) => c.body),
    self,
  );
}

/** A PR works on issue `number` if its body closes it or its head branch is <prefix>/<number>-… */
export function prLinksIssue(pr, number, repo) {
  for (const m of String(pr.body ?? '').matchAll(closingRe())) {
    const t = closingTarget(m, repo);
    if (t.own && t.number === number) return true;
  }
  return new RegExp(String.raw`^[^/]+\/${number}-`).test(pr.headRefName ?? '');
}

export function statusOf(item, holdLabels = HOLD_LABELS) {
  const hold = holdLabels.map((l) => l.toLowerCase());
  if (item.state !== 'OPEN') return 'closed'; // CLOSED, or MERGED for a PR listed by mistake
  if (item.pr) return 'in-flight';
  if (item.split?.length && !item.openSlices.length) return 'close-split';
  if (item.split?.length) return 'split';
  if (item.labels.some((l) => hold.includes(l.toLowerCase()))) return 'held';
  if (item.openDeps.length) return 'waiting';
  return 'ready';
}

// Finish what is already under way before starting anything new.
export function pickNext(items, prefer = null) {
  const open = items.filter((i) => i.state === 'OPEN');
  const chosen =
    (prefer ? open.find((i) => i.number === prefer) : undefined) ??
    open.find((i) => i.status === 'in-flight') ??
    open.find((i) => i.status === 'close-split') ??
    open.find((i) => i.status === 'ready') ??
    null;
  return chosen ? { number: chosen.number, title: chosen.title, status: chosen.status } : null;
}

/** Branch-name slug: lowercase, non-alphanumeric runs to "-", at most `max` chars at a dash. */
export function slugify(title, max = 40) {
  const s = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length <= max) return s || 'issue';
  if (s[max] === '-') return s.slice(0, max);
  const cut = s.slice(0, max);
  const dash = cut.lastIndexOf('-');
  return dash > 0 ? cut.slice(0, dash) : cut;
}

export function renderIssue(i) {
  const labels = (i.labels ?? []).map((l) => l.name ?? l);
  const state = i.stateReason ? `${i.state} (${i.stateReason})` : i.state;
  const meta = [`State: ${state}`, labels.length ? `Labels: ${labels.join(', ')}` : null, i.url]
    .filter(Boolean)
    .join(' · ');
  const comments = (i.comments ?? [])
    .map((c) => `\n---\n\n**${c.author?.login ?? 'ghost'}** (${c.createdAt}):\n\n${c.body}\n`)
    .join('');
  return `# #${i.number} ${i.title}\n\n${meta}\n\n${i.body ?? ''}\n${comments}`;
}

export function renderItemsTable(items) {
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const rows = items.map((i) => {
    const checked = i.inChecklist ? (i.checked ? 'x' : ' ') : '-';
    const deps =
      i.dependsOn.map((d) => `#${d}${i.openDeps.includes(d) ? ' (open)' : ''}`).join(', ') || '-';
    const pr = i.pr ? `#${i.pr.number}` : '-';
    return `| #${i.number} | ${cell(i.title)} | ${i.status} | ${checked} | ${deps} | ${pr} |`;
  });
  return `| # | Title | Status | Checked | Deps | PR |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`;
}

/**
 * Make a PR body close exactly issue `issue`: closing keywords aimed at any other issue (#N,
 * owner/repo#N, or an issue URL) become "Refs" (GitHub would close those on merge), "Closes
 * #issue." is appended if missing, and "Part of #epic." is appended if the epic is not mentioned.
 * Never adds a keyword for the epic.
 */
export function normalizePrBody(body, { issue, epic, repo }) {
  const aimsAtIssue = (m) => {
    const t = closingTarget(m, repo);
    return t.own && t.number === issue;
  };
  let text = String(body ?? '')
    .replace(/\s+$/, '')
    .replace(closingRe(), (...m) =>
      aimsAtIssue(m) ? m[0] : `Refs${m[2]}${m[0].slice(m[1].length + m[2].length)}`,
    );
  const closesIssue = [...text.matchAll(closingRe())].some(aimsAtIssue);
  const additions = [];
  if (!closesIssue) additions.push(`Closes #${issue}.`);
  if (!ownRefs(text, repo).includes(epic)) additions.push(`Part of #${epic}.`);
  text = [text, additions.join('\n')].filter(Boolean).join('\n\n');
  return `${text}\n`;
}

const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

// The last line of the list item starting at `at`: its nested items and continuation lines are
// indented deeper. Blank lines belong to it only when deeper content follows them.
function endOfItem(lines, at, indent) {
  let end = at;
  for (let k = at + 1; k < lines.length; k++) {
    if (!lines[k].trim()) continue;
    if (indentOf(lines[k]) <= indent) break;
    end = k;
  }
  return end;
}

/**
 * Add "- [ ] #number title" to an epic body: after the checklist item for #after (and its nested
 * items), else after the last outermost checklist item, else under a new "## Items" heading.
 * No change if #number is already listed. Lines in fenced code are never items.
 */
export function insertChecklistLine(body, { number, title, after = null, repo }) {
  const text = String(body ?? '');
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const parsed = checklistLines(lines, repo);
  if (parsed.some((p) => p?.ref === number)) return { body: text, changed: false };
  const entry = `[ ] #${number} ${String(title)
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim()}`;
  let at = after ? parsed.findIndex((p) => p?.ref === after) : -1;
  if (at < 0) {
    // A new item belongs to the outer list, not under whichever nested item happens to be last.
    const outer = Math.min(...parsed.filter(Boolean).map((p) => p.indent));
    at = parsed.findLastIndex((p) => p !== null && p.indent === outer);
  }
  if (at < 0) {
    // No checklist yet: start one under an existing "## Items" heading (an epic created with an
    // empty Items section), else under a new heading at the end.
    const heading = lines.findIndex((l) => /^##\s+Items\s*$/i.test(l));
    if (heading >= 0) {
      lines.splice(heading + 1, 0, '', `- ${entry}`);
      return { body: lines.join(eol), changed: true };
    }
    const base = text.replace(/\s+$/, '');
    return {
      body: `${base}${base ? eol + eol : ''}## Items${eol}${eol}- ${entry}${eol}`,
      changed: true,
    };
  }
  // Reuse the chosen item's indentation and bullet so the list stays one list.
  lines.splice(endOfItem(lines, at, parsed[at].indent) + 1, 0, `${parsed[at].m[1]}${entry}`);
  return { body: lines.join(eol), changed: true };
}

/** Check the first checklist line (outside fenced code) whose first own-repo reference is #number. */
export function tickChecklist(body, number, repo) {
  const text = String(body ?? '');
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const at = checklistLines(lines, repo).findIndex((p) => p?.ref === number);
  if (at < 0) return { body: text, changed: false, checked: false, listed: false, line: null };
  const m = CHECKLIST.exec(lines[at]);
  if (m[2] !== ' ')
    return { body: text, changed: false, checked: true, listed: true, line: lines[at] };
  lines[at] = `${m[1]}[x]${m[3]}${m[4]}`;
  return { body: lines.join(eol), changed: true, checked: true, listed: true, line: lines[at] };
}

// ---------------------------------------------------------------------------------------------
// GitHub lookups

const ISSUE_FIELDS = 'number,title,state,stateReason,labels,body,url,comments,updatedAt';
const fetchIssue = (R, n) =>
  ghJson(['issue', 'view', String(n), '-R', R.repo, '--json', ISSUE_FIELDS]);
const fetchEpic = (R, epic) =>
  ghJson(['issue', 'view', String(epic), '-R', R.repo, '--json', 'number,title,url,state,body']);
const setIssueBody = (R, n, body) =>
  gh(['issue', 'edit', String(n), '-R', R.repo, '--body-file', '-'], { input: body });
const inRepo = (R, x) =>
  String(x.repository_url ?? '')
    .toLowerCase()
    .endsWith(`/repos/${R.repo.toLowerCase()}`);
const subIssues = (R, epic) =>
  ghPaged(`repos/${R.repo}/issues/${epic}/sub_issues`)
    .filter((x) => inRepo(R, x))
    .map((x) => x.number);

// GitHub's issue-dependency API is not enabled everywhere; its absence must not stop a survey.
function blockedByApi(R, n) {
  try {
    return ghPaged(`repos/${R.repo}/issues/${n}/dependencies/blocked_by`)
      .filter((x) => inRepo(R, x))
      .map((x) => x.number);
  } catch {
    return [];
  }
}

// Search can lag a just-created issue, so callers check their own records first. The quoted
// phrase keeps words such as "fix:" from being read as search qualifiers.
function findOpenByTitle(R, title) {
  return (
    ghJson([
      'issue',
      'list',
      '-R',
      R.repo,
      '--state',
      'open',
      '--search',
      `"${title.replace(/"/g, '')}" in:title`,
      '--limit',
      '100',
      '--json',
      'number,title,url',
    ]).find((i) => i.title === title) ?? null
  );
}

function ensureLabel(R, label) {
  // Fails harmlessly when the label already exists.
  run(
    'gh',
    [
      'label',
      'create',
      label,
      '-R',
      R.repo,
      '--color',
      LABEL_COLOR,
      '--description',
      LABEL_DESCRIPTION,
    ],
    { allowFail: true },
  );
}

const issueNumberFromUrl = (url) =>
  Number(/\/(?:issues|pull)\/(\d+)\s*$/.exec(url)?.[1]) || fail(`unexpected URL from gh: ${url}`);

// ---------------------------------------------------------------------------------------------
// Survey

function survey(a, P, R) {
  const epic = requireEpic(a);
  const dir = epicDir(P, epic);
  const issuesDir = join(dir, 'issues');
  mkdirSync(issuesDir, { recursive: true });
  const holdLabels = listArg(a['hold-labels'], HOLD_LABELS);
  const prefer = a.prefer ? requireNumber(a, 'prefer') : null;

  run('git', ['fetch', '--quiet', 'origin', R.def]);
  const mainHead = git('.', ['rev-parse', `origin/${R.def}`]);

  const e = fetchEpic(R, epic);
  const listed = parseChecklist(e.body, R.repo).filter((x) => x.number !== epic);
  const listedNumbers = new Set(listed.map((x) => x.number));
  const subs = new Set(subIssues(R, epic));
  const order = [
    ...listed.map((x) => x.number),
    ...[...subs].filter((n) => !listedNumbers.has(n)).sort((x, y) => x - y),
  ];
  const fetched = new Map(order.map((n) => [n, fetchIssue(R, n)]));

  // Dependencies and slices may name issues outside the epic; look those up once each. A state we
  // cannot read counts as open: an unknown dependency is not known to be done.
  const states = new Map([...fetched].map(([n, i]) => [n, i.state]));
  const stateOf = (n) => {
    if (!states.has(n)) {
      let state = 'UNKNOWN';
      try {
        state = gh(['api', `repos/${R.repo}/issues/${n}`, '--jq', '.state']).toUpperCase();
      } catch {
        // keep UNKNOWN
      }
      states.set(n, state);
    }
    return states.get(n);
  };
  const isOpen = (n) => stateOf(n) !== 'CLOSED';

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
    'number,title,url,headRefName,headRefOid,body,isDraft,author,createdAt',
  ]).sort((x, y) => x.number - y.number);

  const items = order.map((n) => {
    const i = fetched.get(n);
    writeFileSync(join(issuesDir, `${n}.md`), renderIssue(i));
    const comments = (i.comments ?? []).map((c) => c.body);
    const dependsOn = [
      ...new Set([...parseDependencies([i.body, ...comments], R.repo, n), ...blockedByApi(R, n)]),
    ].filter((d) => d !== n);
    const split = splitFromComments(i.comments, R.viewer, n);
    const pr = prs.find((p) => prLinksIssue(p, n, R.repo));
    const started = readJson(join(issuePath(P, epic, n), 'start.json'));
    const branch =
      started?.branch &&
      gitOk('.', ['show-ref', '--verify', '--quiet', `refs/heads/${started.branch}`])
        ? {
            name: started.branch,
            ahead: Number(git('.', ['rev-list', '--count', `origin/${R.def}..${started.branch}`])),
          }
        : null;
    const entry = listed.find((x) => x.number === n);
    const item = {
      number: n,
      title: i.title,
      url: i.url,
      state: i.state,
      stateReason: i.stateReason || null,
      status: null,
      checked: entry?.checked ?? false,
      inChecklist: Boolean(entry),
      isSubIssue: subs.has(n),
      labels: (i.labels ?? []).map((l) => l.name),
      dependsOn,
      openDeps: dependsOn.filter(isOpen),
      split,
      openSlices: (split ?? []).filter(isOpen),
      pr: pr
        ? {
            number: pr.number,
            url: pr.url,
            headRef: pr.headRefName,
            headSha: pr.headRefOid,
            isDraft: pr.isDraft,
            createdAt: pr.createdAt,
          }
        : null,
      branch,
    };
    item.status = statusOf(item, holdLabels);
    return item;
  });

  const by = (status) => items.filter((i) => i.status === status).length;
  const open = items.filter((i) => i.state === 'OPEN').length;
  const table = join(dir, 'items.md');
  const result = {
    repo: R.repo,
    defaultBranch: R.def,
    mainHead,
    surveyedAt: nowIso(),
    paths: P,
    epic: { number: e.number, title: e.title, url: e.url, state: e.state },
    items,
    counts: {
      total: items.length,
      open,
      closed: items.length - open,
      ready: by('ready'),
      inFlight: by('in-flight'),
      waiting: by('waiting'),
      held: by('held'),
      split: by('split') + by('close-split'),
    },
    next: pickNext(items, prefer),
    done: open === 0,
    files: { dir, survey: join(dir, 'survey.json'), table, issuesDir },
  };
  writeJson(result.files.survey, result);
  writeFileSync(
    table,
    `# #${e.number} ${e.title}\n\nSurveyed ${result.surveyedAt} at ${R.def} ${mainHead.slice(0, 7)}.\n\n${renderItemsTable(items)}`,
  );
  return compactSurvey(result, Number(a.candidates ?? 3));
}

// Clerks relay stdout by copying it, and long copies go wrong, so stdout stays small: every open
// item's status in one short entry, full detail only for the next item and the first few ready
// ones the workflow may try. survey.json keeps everything.
export function compactSurvey(result, limit = 3) {
  const open = result.items.filter((i) => i.state === 'OPEN');
  const wanted = new Set(
    [result.next?.number, ...open.filter((i) => i.status === 'ready').map((i) => i.number)]
      .filter(Boolean)
      .slice(0, limit + 1),
  );
  const rest = { ...result };
  delete rest.paths;
  delete rest.items;
  return {
    ...rest,
    items: open.map((i) => ({
      number: i.number,
      status: i.status,
      ...(i.openDeps.length ? { openDeps: i.openDeps } : {}),
    })),
    candidates: open
      .filter((i) => wanted.has(i.number))
      .map((i) => ({
        number: i.number,
        title: i.title,
        status: i.status,
        labels: i.labels,
        openDeps: i.openDeps,
        split: i.split,
        openSlices: i.openSlices,
        pr: i.pr,
      })),
  };
}

// ---------------------------------------------------------------------------------------------
// Worktree

function ensureWorktree(P, R) {
  if (existsSync(join(P.workdir, '.git'))) return false;
  mkdirSync(P.root, { recursive: true });
  run('git', ['fetch', '--quiet', 'origin', R.def]);
  run('git', ['worktree', 'add', '--detach', P.workdir, `origin/${R.def}`]);
  return true;
}

const requireWorktree = (P) =>
  existsSync(join(P.workdir, '.git')) ? P.workdir : fail('no worktree yet; run start first');

const gitPathExists = (W, name) =>
  existsSync(git(W, ['rev-parse', '--path-format=absolute', '--git-path', name]));
const rebaseInProgress = (W) => ['rebase-merge', 'rebase-apply'].some((n) => gitPathExists(W, n));
const mergeInProgress = (W) => gitPathExists(W, 'MERGE_HEAD');

// `git status --porcelain` lines. Not via git(): trimming would eat the first line's status column.
const porcelain = (W) =>
  run('git', ['-C', W, 'status', '--porcelain']).stdout.split('\n').filter(Boolean);
const currentBranch = (W) =>
  run('git', ['-C', W, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
    allowFail: true,
  }).stdout.trim() || null;
const countRange = (W, range) => Number(git(W, ['rev-list', '--count', range]));

// The command whose passing run opens the publishing gate for this issue (pinned by start).
const gateCmdOf = (dir) => readJson(join(dir, 'start.json'))?.gateCmd ?? DEFAULT_GATE_CMD;

// The last run of the gate command (checks/gate.json), which only `check` writes. Other checks
// (last/check.json) are for relaying and never count.
function gateCheck(dir) {
  const saved = readJson(join(dir, 'checks', 'gate.json'));
  return saved && !saved.error && saved.cmd === gateCmdOf(dir) ? saved : null;
}

// The facts every publishing gate needs. A check only counts if it was the gate command and ran
// on a clean tree at HEAD: uncommitted edits could have made it pass without being part of what
// gets pushed.
function gateState(W, R, dir) {
  const head = git(W, ['rev-parse', 'HEAD']);
  const saved = gateCheck(dir);
  return {
    head,
    ahead: countRange(W, `origin/${R.def}..HEAD`),
    dirty: porcelain(W),
    gateCmd: gateCmdOf(dir),
    checkPassedAtHead: saved?.passed === true && saved.head === head && saved.clean === true,
    checkHead: saved?.head ?? null,
  };
}

function start(a, P, R) {
  const epic = requireEpic(a);
  const issue = requireIssue(a);
  const prefix = branchPrefix(a, epic);
  const dir = issueDir(P, epic, issue);
  const i = fetchIssue(R, issue);
  const created = ensureWorktree(P, R);
  const W = P.workdir;
  const target = `origin/${R.def}`;
  git(W, ['fetch', '--quiet', 'origin', R.def]);
  // Branches pushed by earlier runs for this epic, so an interrupted issue resumes where it was.
  git(W, ['fetch', '--quiet', 'origin', `+refs/heads/${prefix}/*:refs/remotes/origin/${prefix}/*`]);
  if (rebaseInProgress(W)) fail(`a rebase is in progress in ${W}; finish or abort it first`);
  if (mergeInProgress(W)) fail(`a merge is in progress in ${W}; finish or abort it first`);

  const saved = readJson(join(dir, 'start.json'));
  const hasLocal = (b) => gitOk(W, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`]);
  const matching = (ns) =>
    git(W, ['for-each-ref', '--format=%(refname)', `${ns}/${prefix}/`])
      .split('\n')
      .filter(Boolean)
      .map((ref) => ref.slice(ns.length + 1))
      .filter((b) => b.startsWith(`${prefix}/${issue}-`))
      .sort();
  let branch;
  let source;
  const localMatch = matching('refs/heads')[0];
  const remoteMatch = matching('refs/remotes/origin')[0];
  if (saved?.branch && hasLocal(saved.branch)) [branch, source] = [saved.branch, 'local'];
  else if (localMatch) [branch, source] = [localMatch, 'local'];
  else if (remoteMatch) [branch, source] = [remoteMatch, 'remote'];
  else [branch, source] = [`${prefix}/${issue}-${slugify(i.title)}`, 'new'];
  const resumed = source !== 'new';

  const current = currentBranch(W);
  if (porcelain(W).length && current !== branch) {
    fail(
      `the worktree ${W} has uncommitted changes on ${current ?? 'a detached HEAD'}, not ${branch}; ` +
        `commit, stash, or discard them before starting #${issue}:\n${porcelain(W).join('\n')}`,
    );
  }
  // Commits made on a detached HEAD (say, after a botched rebase) are held by no branch; checking
  // out another branch would leave them only in the reflog.
  if (current === null) {
    const orphans = git(W, ['log', '--format=%h %s', 'HEAD', '--not', '--branches', '--remotes']);
    if (orphans) {
      fail(
        `the worktree ${W} is on a detached HEAD with commits no branch holds; put them on a ` +
          `branch (git -C ${W} branch <name>) before starting #${issue}:\n${orphans}`,
      );
    }
  }
  const gateCmd =
    typeof a['gate-cmd'] === 'string' && a['gate-cmd'].trim()
      ? a['gate-cmd'].trim()
      : (saved?.gateCmd ?? DEFAULT_GATE_CMD);
  let adoptedRemoteSha = saved?.branch === branch ? (saved.adoptedRemoteSha ?? null) : null;
  if (current !== branch) {
    if (source === 'local') git(W, ['checkout', '--quiet', branch]);
    else if (source === 'remote') {
      git(W, ['checkout', '--quiet', '-b', branch, '--track', `origin/${branch}`]);
      // An earlier run pushed this branch and lost its state; open-pr may lease against this sha.
      adoptedRemoteSha = git(W, ['rev-parse', `origin/${branch}`]);
    } else git(W, ['checkout', '--quiet', '--no-track', '-B', branch, target]);
  }

  let rebase = 'up-to-date';
  if (resumed && countRange(W, `HEAD..${target}`) > 0) {
    if (porcelain(W).length) rebase = 'skipped-dirty';
    else {
      const r = run('git', ['-C', W, 'rebase', target], {
        allowFail: true,
        env: { GIT_EDITOR: 'true' },
      });
      writeFileSync(join(dir, 'rebase.log'), stripAnsi(r.stdout + r.stderr));
      if (r.status === 0) rebase = 'rebased';
      else {
        run('git', ['-C', W, 'rebase', '--abort'], { allowFail: true });
        rebase = 'conflict';
      }
    }
  }

  const files = {
    issue: join(dir, 'issue.md'),
    epic: join(dir, 'epic.md'),
    plan: existsSync(join(dir, 'plan.json')) ? join(dir, 'plan.json') : null,
  };
  writeFileSync(files.issue, renderIssue(i));
  const e = fetchEpic(R, epic);
  const surveyed = readJson(join(epicPath(P, epic), 'survey.json'));
  const itemsSection = surveyed
    ? `\n## Items as of the last survey (${surveyed.surveyedAt ?? 'unknown time'})\n\n${renderItemsTable(surveyed.items)}`
    : '';
  writeFileSync(
    files.epic,
    `# #${e.number} ${e.title}\n\nState: ${e.state} · ${e.url}\n\n${e.body ?? ''}\n${itemsSection}`,
  );
  const baseSha = git(W, ['rev-parse', target]);
  const at = nowIso();
  writeJson(join(dir, 'start.json'), {
    branch,
    base: target,
    baseSha,
    startedAt: saved?.branch === branch ? (saved.startedAt ?? at) : at,
    resumedAt: resumed ? at : null,
    adoptedRemoteSha,
    gateCmd,
  });

  const check = gateCheck(dir);
  return {
    worktree: W,
    worktreeCreated: created,
    branch,
    base: target,
    baseSha,
    resumed,
    source,
    ahead: countRange(W, `${target}..HEAD`),
    behind: countRange(W, `HEAD..${target}`),
    dirty: porcelain(W),
    rebase,
    dir,
    files,
    gateCmd,
    lastCheck: check ? { passed: Boolean(check.passed), head: check.head ?? null } : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Files, checks, and verification

function save(a, P) {
  const epic = requireEpic(a);
  const issue = requireIssue(a);
  const name = a.name;
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name) || /^\.+$/.test(name)) {
    fail('--name must be a plain file name (letters, digits, "_", ".", "-")');
  }
  if (isReservedName(name)) fail(`${name} is written only by epic.mjs itself`);
  const content = readStdinBuffer();
  const file = join(issueDir(P, epic, issue), name);
  writeFileSync(file, content);
  return {
    path: file,
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

// As merge-down.mjs's check, plus `head` (HEAD when the check started), `clean` (no uncommitted
// changes then), `cmd`, and `gate`: whether this was the issue's gate command. Only a gate run is
// recorded in checks/gate.json, which the publishing gate reads; a failing gate run replaces an
// earlier passing one.
function check(a, P) {
  const epic = requireEpic(a);
  const issue = requireIssue(a);
  const W = requireWorktree(P);
  const dir = issueDir(P, epic, issue);
  const label = typeof a.label === 'string' ? a.label : 'check';
  if (!/^[\w.-]+$/.test(label) || /^\.+$/.test(label)) fail('--label must be a plain name');
  if (label === 'gate') fail('--label gate is reserved for the gate record');
  const cmd = typeof a.cmd === 'string' && a.cmd.trim() ? a.cmd.trim() : DEFAULT_GATE_CMD;
  const gate = cmd === gateCmdOf(dir);
  mkdirSync(join(dir, 'checks'), { recursive: true });
  const record = (fields) => {
    const result = { cmd, gate, ...fields };
    writeJson(join(dir, 'checks', `${label}.json`), result);
    if (gate) writeJson(join(dir, 'checks', 'gate.json'), { ...result, label, at: nowIso() });
    return result;
  };
  const log = join(dir, `${label}.log`);
  const started = Date.now();
  const head = git(W, ['rev-parse', 'HEAD']);
  const clean = porcelain(W).length === 0;

  const lockHash = createHash('sha256')
    .update(readFileSync(join(W, 'package-lock.json')))
    .digest('hex');
  const stamp = join(W, 'node_modules', '.epic-burndown-lock-hash');
  let installed = false;
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== lockHash) {
    const r = run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: W, allowFail: true });
    if (r.status !== 0) {
      writeFileSync(log, stripAnsi(r.stdout + r.stderr));
      return record({
        passed: false,
        head,
        clean,
        failedStep: 'npm ci',
        seconds: Math.round((Date.now() - started) / 1000),
        log,
        excerptFile: writeExcerpt(log, tail(stripAnsi(r.stderr || r.stdout), 30)),
      });
    }
    writeFileSync(stamp, lockHash);
    installed = true;
  }

  const r = run('bash', ['-c', cmd], {
    cwd: W,
    allowFail: true,
    env: { NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const text = stripAnsi(`${r.stdout}\n${r.stderr}`);
  writeFileSync(log, text);
  const steps = [...text.matchAll(/^> \S+ ([\w:.-]+)$/gm)].map((m) => m[1]);
  const passed = r.status === 0;
  return record({
    passed,
    head,
    clean,
    exitCode: r.status,
    failedStep: passed ? null : (steps.at(-1) ?? null),
    seconds: Math.round((Date.now() - started) / 1000),
    installedDependencies: installed,
    log,
    excerptFile: passed ? null : writeExcerpt(log, tail(text, 40)),
  });
}

function snapshot(a, P, R) {
  const epic = requireEpic(a);
  const issue = requireIssue(a);
  const W = requireWorktree(P);
  const dir = issueDir(P, epic, issue);
  if (rebaseInProgress(W)) fail('a rebase is still in progress in the worktree');
  const target = `origin/${R.def}`;
  const head = git(W, ['rev-parse', 'HEAD']);
  const files = {
    diff: join(dir, 'own.diff'),
    stat: join(dir, 'own.stat'),
    commits: join(dir, 'commits.txt'),
  };
  writeFileSync(files.diff, `${git(W, ['diff', `${target}...HEAD`])}\n`);
  const stat = git(W, ['diff', '--stat=120', `${target}...HEAD`]);
  writeFileSync(files.stat, `${stat}\n`);
  const commits = git(W, ['log', '--reverse', '--format=%h %s', `${target}..HEAD`]);
  writeFileSync(files.commits, `${commits}\n`);
  return {
    head,
    ahead: countRange(W, `${target}..HEAD`),
    commits: commits ? commits.split('\n') : [],
    stat: stat.split('\n').at(-1)?.trim() ?? '',
    dirty: porcelain(W),
    files,
  };
}

// Check an implementer's report mechanically: every commit it names is in the branch, and the
// last run of the gate command passed on a clean tree at the exact current head.
function verify(a, P, R) {
  const epic = requireEpic(a);
  const issue = requireIssue(a);
  const W = requireWorktree(P);
  const dir = issueDir(P, epic, issue);
  const g = gateState(W, R, dir);
  const commits = listArg(a.commits);
  const missing = commits.filter(
    (c) =>
      !gitOk(W, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`]) ||
      !gitOk(W, ['merge-base', '--is-ancestor', c, g.head]),
  );
  return {
    head: g.head,
    ahead: g.ahead,
    dirty: g.dirty,
    missingCommits: missing,
    gateCmd: g.gateCmd,
    checkPassedAtHead: g.checkPassedAtHead,
    checkHead: g.checkHead,
  };
}

// ---------------------------------------------------------------------------------------------
// Publishing

function openPr(a, P, R) {
  const epic = requireEpic(a);
  const issue = requireIssue(a);
  const title = requireString(a, 'title');
  const W = requireWorktree(P);
  const dir = issueDir(P, epic, issue);
  const started = readJson(join(dir, 'start.json')) ?? fail(`run start for #${issue} first`);
  const branch = started.branch;
  const current = currentBranch(W);
  if (current !== branch) fail(`the worktree is on ${current ?? 'a detached HEAD'}, not ${branch}`);
  if (rebaseInProgress(W) || mergeInProgress(W)) fail('a rebase or merge is in progress');

  // Structural gate: nothing unverified gets published.
  const g = gateState(W, R, dir);
  if (g.dirty.length) fail(`the worktree has uncommitted changes:\n${g.dirty.join('\n')}`);
  if (g.ahead === 0) fail(`${branch} has no commits ahead of origin/${R.def}`);
  if (!g.checkPassedAtHead) {
    fail(
      `no passing \`${g.gateCmd}\` on a clean tree at HEAD ${g.head} (last gate run: ${g.checkHead ?? 'none'}); run check first`,
    );
  }
  const body = normalizePrBody(readStdin(), { issue, epic, repo: R.repo });

  const published = readJson(join(dir, 'pr.json'));
  const remoteSha =
    git(W, ['ls-remote', 'origin', `refs/heads/${branch}`])
      .split('\n')
      .map((line) => line.split(/\s+/))
      .find(([, ref]) => ref === `refs/heads/${branch}`)?.[0] ?? null;
  let pushed = false;
  let pushedAt = published?.pushedAt ?? null;
  if (remoteSha !== g.head) {
    if (!remoteSha) {
      run('git', ['-C', W, 'push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${branch}`]);
    } else {
      // Lease against the sha we last pushed (or adopted in start): if anyone else pushed since,
      // git refuses and nothing of theirs is lost.
      const expected = published?.pushedSha ?? started.adoptedRemoteSha ?? null;
      if (!expected) {
        fail(
          `origin/${branch} exists (${remoteSha}) but this workflow never pushed it; refusing to overwrite`,
        );
      }
      run('git', [
        '-C',
        W,
        'push',
        '--quiet',
        `--force-with-lease=refs/heads/${branch}:${expected}`,
        'origin',
        `HEAD:refs/heads/${branch}`,
      ]);
    }
    pushed = true;
    pushedAt = nowIso();
  }
  pushedAt ??= nowIso();

  const existing = ghJson([
    'pr',
    'list',
    '-R',
    R.repo,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number,url,createdAt',
  ])[0];
  let pr;
  if (existing) {
    gh(
      ['pr', 'edit', String(existing.number), '-R', R.repo, '--title', title, '--body-file', '-'],
      {
        input: body,
      },
    );
    pr = existing;
  } else {
    // Never a draft, and never via auto-merge: the workflow gates landing itself.
    const url = gh(
      [
        'pr',
        'create',
        '-R',
        R.repo,
        '--base',
        R.def,
        '--head',
        branch,
        '--title',
        title,
        '--body-file',
        '-',
      ],
      { input: body },
    );
    const number = issueNumberFromUrl(url.split('\n').at(-1));
    pr = ghJson(['pr', 'view', String(number), '-R', R.repo, '--json', 'number,url,createdAt']);
  }
  writeJson(join(dir, 'pr.json'), {
    pr: pr.number,
    url: pr.url,
    head: branch,
    pushedSha: g.head,
    createdAt: pr.createdAt,
    pushedAt,
  });
  return {
    pr: pr.number,
    url: pr.url,
    branch,
    head: g.head,
    created: !existing,
    pushed,
    openedAt: pr.createdAt,
    pushedAt,
  };
}

function comment(a, P, R) {
  requireEpic(a);
  const issue = requireIssue(a);
  const body = readStdin().trim();
  let url = null;
  if (body) {
    url =
      gh(['issue', 'comment', String(issue), '-R', R.repo, '--body-file', '-'], { input: body })
        .split('\n')
        .at(-1)
        .trim() || null;
  }
  const labels = () =>
    ghJson(['issue', 'view', String(issue), '-R', R.repo, '--json', 'labels']).labels.map(
      (l) => l.name,
    );
  for (const label of listArg(a['add-label'])) {
    ensureLabel(R, label);
    gh(['issue', 'edit', String(issue), '-R', R.repo, '--add-label', label]);
  }
  const remove = listArg(a['remove-label']);
  if (remove.length) {
    const have = labels();
    for (const label of remove.filter((l) => have.includes(l))) {
      gh(['issue', 'edit', String(issue), '-R', R.repo, '--remove-label', label]);
    }
  }
  return { url, labels: labels() };
}

function closeIssue(a, P, R) {
  requireEpic(a);
  const issue = requireIssue(a);
  const reason = a.reason;
  if (reason !== 'completed' && reason !== 'not_planned') {
    fail('--reason must be completed or not_planned');
  }
  const body = readStdin().trim();
  const view = () =>
    ghJson(['issue', 'view', String(issue), '-R', R.repo, '--json', 'state,stateReason']);
  const before = view();
  // Already closed: a retry must not post the comment twice.
  if (before.state === 'CLOSED') {
    return {
      closed: true,
      state: before.state,
      stateReason: before.stateReason || null,
      commentUrl: null,
      alreadyClosed: true,
    };
  }
  const commentUrl = body
    ? gh(['issue', 'comment', String(issue), '-R', R.repo, '--body-file', '-'], { input: body })
        .split('\n')
        .at(-1)
        .trim()
    : null;
  const why = reason === 'completed' ? 'completed' : 'not planned';
  gh(['issue', 'close', String(issue), '-R', R.repo, '--reason', why]);
  const after = view();
  return {
    closed: after.state === 'CLOSED',
    state: after.state,
    stateReason: after.stateReason || null,
    commentUrl,
    alreadyClosed: false,
  };
}

function fileIssue(a, P, R) {
  const epic = requireEpic(a);
  const title = requireString(a, 'title');
  const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim() : null;
  const after = a.after ? requireNumber(a, 'after') : null;
  const body = readStdin();
  const dir = epicDir(P, epic);
  const filedFile = join(dir, 'filed.json');
  const filed = readJson(filedFile) ?? {};

  // Our own record first: GitHub's search index can lag a just-created issue by minutes, and a
  // retried file-issue must not create a duplicate.
  let found = null;
  if (filed[title]) {
    const x = ghJson([
      'issue',
      'view',
      String(filed[title]),
      '-R',
      R.repo,
      '--json',
      'number,title,url,state',
    ]);
    if (x.state === 'OPEN') found = x;
  }
  found ??= findOpenByTitle(R, title);
  const created = !found;
  if (!found) {
    if (label) ensureLabel(R, label);
    const url = gh(
      [
        'issue',
        'create',
        '-R',
        R.repo,
        '--title',
        title,
        '--body-file',
        '-',
        ...(label ? ['--label', label] : []),
      ],
      { input: body },
    )
      .split('\n')
      .at(-1)
      .trim();
    found = { number: issueNumberFromUrl(url), url };
    writeJson(filedFile, { ...filed, [title]: found.number });
  }

  let attached = subIssues(R, epic).includes(found.number);
  let attachError = null;
  if (!attached) {
    const id = gh(['api', `repos/${R.repo}/issues/${found.number}`, '--jq', '.id']);
    const r = run(
      'gh',
      [
        'api',
        '-X',
        'POST',
        `repos/${R.repo}/issues/${epic}/sub_issues`,
        '-F',
        `sub_issue_id=${id}`,
      ],
      { allowFail: true },
    );
    // Judge by the list, not the error text: "already a sub-issue" is success, anything else is not.
    attached = r.status === 0 || subIssues(R, epic).includes(found.number);
    if (!attached) attachError = (r.stderr || r.stdout).trim().slice(-500);
  }

  const e = fetchEpic(R, epic);
  const next = insertChecklistLine(e.body, {
    number: found.number,
    title,
    after,
    repo: R.repo,
  });
  if (next.changed) setIssueBody(R, epic, next.body);
  return {
    number: found.number,
    url: found.url,
    created,
    attached,
    listed: true,
    ...(attachError ? { attachError } : {}),
  };
}

function ensureEpic(a, P, R) {
  const title = requireString(a, 'title');
  const body = readStdin();
  const knownFile = join(P.stateDir, 'epics.json');
  const known = readJson(knownFile) ?? {};
  let found = null;
  if (known[title]) {
    const x = ghJson([
      'issue',
      'view',
      String(known[title]),
      '-R',
      R.repo,
      '--json',
      'number,title,url,state',
    ]);
    if (x.state === 'OPEN' && x.title === title) found = x;
  }
  found ??= findOpenByTitle(R, title);
  if (found) return { number: found.number, url: found.url, created: false };
  const url = gh(['issue', 'create', '-R', R.repo, '--title', title, '--body-file', '-'], {
    input: body.trim() ? body : '_Created by the execute-epic-ticket workflow._\n',
  })
    .split('\n')
    .at(-1)
    .trim();
  const number = issueNumberFromUrl(url);
  mkdirSync(P.stateDir, { recursive: true });
  writeJson(knownFile, { ...known, [title]: number });
  return { number, url, created: true };
}

function tick(a, P, R) {
  const epic = requireEpic(a);
  const issue = requireIssue(a);
  const e = fetchEpic(R, epic);
  const t = tickChecklist(e.body, issue, R.repo);
  if (t.changed) setIssueBody(R, epic, t.body);
  return { changed: t.changed, checked: t.checked, listed: t.listed, line: t.line };
}

function ledger(a, P) {
  const epic = requireEpic(a);
  let entry;
  try {
    entry = JSON.parse(readStdin());
  } catch (error) {
    fail(`stdin must be one JSON object: ${error.message}`);
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail('stdin must be one JSON object');
  }
  const file = join(epicDir(P, epic), 'ledger.jsonl');
  appendFileSync(file, `${JSON.stringify({ ...entry, at: nowIso() })}\n`);
  return { path: file, lines: readFileSync(file, 'utf8').split('\n').filter(Boolean).length };
}

// ---------------------------------------------------------------------------------------------

const COMMANDS = {
  paths: (a, P, R) => ({ paths: P, repo: R.repo, defaultBranch: R.def }),
  survey,
  start,
  save: (a, P) => save(a, P),
  check: (a, P) => check(a, P),
  snapshot,
  verify,
  'open-pr': openPr,
  comment,
  'close-issue': closeIssue,
  'file-issue': fileIssue,
  'ensure-epic': ensureEpic,
  tick,
  ledger: (a, P) => ledger(a, P),
};

// Where a command's output is saved: ensure-epic runs before any epic exists, so it saves under
// state/last/; commands given --issue save under the issue, everything else under the epic.
function savedOutputPath(P, command, epic, issue) {
  if (command === 'ensure-epic') return join(P.stateDir, 'last', `${command}.json`);
  if (!epic) fail('--epic N is required');
  return join(issue ? issuePath(P, epic, issue) : epicPath(P, epic), 'last', `${command}.json`);
}

function errorOutput(error) {
  process.exitCode = 1;
  return { error: error instanceof Failure ? error.message : (error?.stack ?? String(error)) };
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const a = parseArgs(rest);
  let saveTo = null;
  let output;
  try {
    const P = paths(a);
    const epic = a.epic ? requireEpic(a) : null;
    const issue = a.issue ? requireIssue(a) : null;
    if (command === 'last') {
      // Re-print a saved output verbatim, so a relay can be retried without repeating effects.
      if (typeof a.cmd !== 'string' || !/^[\w-]+$/.test(a.cmd)) fail('--cmd C is required');
      const file = savedOutputPath(P, a.cmd, epic, issue);
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
    saveTo = savedOutputPath(P, command, epic, issue);
    output = await handler(a, P, repoInfo(a, P));
  } catch (error) {
    output = errorOutput(error);
  }
  const render = (o) => {
    const payload = { ...o, _nonce: typeof a.nonce === 'string' ? a.nonce : null };
    return `${JSON.stringify({ ...payload, _fnv: fnv(JSON.stringify(payload)) })}\n`;
  };
  let line = render(output);
  if (saveTo) {
    // Printing exactly one JSON line matters more than the saved copy: report a failed save.
    try {
      mkdirSync(dirname(saveTo), { recursive: true });
      writeFileSync(saveTo, line);
    } catch (error) {
      line = render({
        error: `could not save the output to ${saveTo}: ${error.message}`,
        output,
      });
      process.exitCode = 1;
    }
  }
  return line;
}

// Compare real paths: on macOS /tmp is a symlink to /private/tmp, and Node resolves the main
// module's symlinks, so a plain URL comparison would silently skip main().
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.stdout.write(await main());
