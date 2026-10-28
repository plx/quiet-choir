// Pure decision rules of merge-down-pr, ported from the native script and its helper CLI. Nothing
// here imports quiet-choir or touches I/O, so test/merge-down-package.test.ts checks it directly.

/** Severity of a review finding, a thread or a work item. */
export type Severity = 'blocker' | 'major' | 'minor';
/** Who should implement a work item: a mid-tier model or a stronger one. */
export type Complexity = 'mechanical' | 'subtle';

/** One unit of work for the fixer or the follow-up scribe. */
export interface WorkItem {
  /** `thread:<id>`, `finding:<id>`, `check:<label>`, `ci:<round>` or `fix:<id>`. */
  readonly key: string;
  readonly source: string;
  readonly title: string;
  readonly severity: Severity;
  readonly complexity: Complexity;
  readonly plan: string;
  readonly detail: string;
  readonly files: readonly string[];
}

/** A triaged review thread, as the reviewer and the thread triage return it. */
export interface ThreadDecision {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'valid' | 'partly-valid' | 'invalid' | 'obsolete';
  readonly action: 'fix' | 'defer' | 'reject' | 'none';
  readonly severity: Severity;
  readonly complexity: Complexity;
  readonly plan: string;
  readonly reply: string;
}

/** A finding of the merge-down review. */
export interface FindingDecision {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly disposition: 'fix' | 'follow-up' | 'note';
  readonly complexity: Complexity;
  readonly detail: string;
  readonly plan: string;
  readonly files: readonly string[];
}

/** One item of a fixer's report. */
export interface FixReport {
  readonly key: string;
  readonly status: 'fixed' | 'partly' | 'not-fixed';
  readonly commit: string;
  readonly summary: string;
}

/** Models sometimes HTML-escape plain text; ledger text should read as written. */
export function plain(text: string): string;
export function plain(text: string | null): string | null;
export function plain(text: string | null): string | null {
  if (text === null) return null;
  return text
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** The issue a pull request implements, as `linkedIssue` finds it. */
export interface LinkedIssue {
  readonly number: number;
  /** `closes`, `fixes`, `resolves` (and their forms), `refs`, or `branch`. */
  readonly keyword: string;
  /** Whether merging closes it (a closing keyword or a GitHub closing reference). */
  readonly closes: boolean;
  /** Every other issue GitHub would close on merge: numbers here, `OWNER/REPO#N` elsewhere. */
  readonly alsoCloses: readonly (number | string)[];
}

/** The pull request facts `linkedIssue` reads. */
export interface LinkSource {
  readonly body: string;
  readonly headRefName: string;
  readonly closingIssues: readonly { readonly number: number; readonly repository: string }[];
}

const REF = String.raw`(?:([\w.-]+\/[\w.-]+))?#(\d+)`;
const closingPattern = (): RegExp =>
  new RegExp(String.raw`\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+${REF}`, 'gi');
const refsPattern = (): RegExp => new RegExp(String.raw`\b(refs?)\b:?\s+${REF}`, 'gi');

/**
 * The one issue this pull request is reviewed against: GitHub's closing references first, then a
 * closing keyword anywhere in the body (it beats an earlier `Refs #N`, which only names context),
 * then `Refs #N`, then a `<prefix>/<N>-` branch name. References may be bare or qualified with this
 * repository; other repositories' issues count only as extra closing references in `alsoCloses`.
 * Whether the number is an issue rather than a pull request is the caller's to check.
 */
export function linkedIssue(pr: LinkSource, repo: string): LinkedIssue | null {
  const same = (name: string): boolean => name.toLowerCase() === repo.toLowerCase();
  const own = (m: RegExpMatchArray): boolean => m[2] === undefined || same(m[2]);
  const closing = pr.closingIssues.map((i) =>
    same(i.repository) ? i.number : `${i.repository}#${String(i.number)}`,
  );
  let number: number | null = closing.find((n): n is number => typeof n === 'number') ?? null;
  let keyword: string | null = number === null ? null : 'closes';
  for (const pattern of [closingPattern(), refsPattern()]) {
    if (number !== null) break;
    const m = [...pr.body.matchAll(pattern)].find(own);
    if (m) [keyword, number] = [String(m[1]).toLowerCase(), Number(m[3])];
  }
  if (number === null) {
    const m = /^[^/]+\/(\d+)-/.exec(pr.headRefName);
    if (m) [keyword, number] = ['branch', Number(m[1])];
  }
  if (number === null || keyword === null) return null;
  const bodyClosing = [...pr.body.matchAll(closingPattern())].map((m) =>
    own(m) ? Number(m[3]) : `${String(m[2])}#${String(m[3])}`,
  );
  const primary = number;
  const alsoCloses = [...new Set([...closing, ...bodyClosing])].filter((n) => n !== primary);
  return { number, keyword, closes: /^(close|fix|resolve)/.test(keyword), alsoCloses };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The body with every closing keyword that names `issue` (bare or qualified with `repo`) rewritten
 * to `Refs #issue`, so merging does not close an issue the review kept open; null when the body has
 * none.
 */
export function keepOpenBody(body: string, issue: number, repo: string): string | null {
  const closing = new RegExp(
    `\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\b(:?\\s+)(?:${escapeRegExp(repo)})?#${String(issue)}\\b`,
    'gi',
  );
  const next = body.replace(closing, `Refs #${String(issue)}`);
  return next === body ? null : next;
}

/** The body with `Closes #issue.` appended when no closing keyword names it; null otherwise. */
export function ensureClosesBody(body: string, issue: number): string | null {
  const keyword = new RegExp(
    `\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\b:?\\s+#${String(issue)}\\b`,
    'i',
  );
  return keyword.test(body) ? null : `${body.trimEnd()}\n\nCloses #${String(issue)}.\n`;
}

/** What the publish step does: push the checked head, skip a push that happened, or refuse. */
export type PublishPlan = { readonly action: 'push' | 'skip' } | { readonly refused: string };

/**
 * Why the shared worktree is not this run's, or null when it is: `ref` is the worktree's
 * `git symbolic-ref HEAD` (null when detached). Every run on a root checks out its own branch, so
 * another branch means another PR's run took the worktree over since this run synced.
 */
export function foreignWorktree(ref: string | null, pr: number): string | null {
  if (ref === `refs/heads/${localBranch(pr)}`) return null;
  const on = ref === null ? 'a detached HEAD' : ref.replace(/^refs\/heads\//, '');
  return `worktree belongs to another run (on ${on}); re-run this PR from the start`;
}

/**
 * The publish decision. `sha` is the head that passed the local checks, `head` the worktree's HEAD,
 * `remote` the PR branch on GitHub and `expected` the head this run last saw there; `ref` is the
 * worktree's branch and `descends` whether `sha` descends from `synced`, the head this run synced.
 * A worktree another run took over, or a checked head not built on this run's sync, is refused; so
 * is a worktree that moved off the checked head. A remote already at `sha` (pushed before a crash,
 * or nothing changed) is skipped; any remote but `expected` means someone else pushed.
 */
export function publishPlan(state: {
  readonly sha: string;
  readonly head: string;
  readonly remote: string;
  readonly expected: string;
  readonly pr: number;
  readonly ref: string | null;
  readonly synced: string;
  readonly descends: boolean;
}): PublishPlan {
  const foreign = foreignWorktree(state.ref, state.pr);
  if (foreign !== null) return { refused: foreign };
  if (!state.descends)
    return {
      refused: `worktree belongs to another run (the checked head ${state.sha} does not descend from this run's synced head ${state.synced}); re-run this PR from the start`,
    };
  if (state.head !== state.sha)
    return {
      refused: `worktree HEAD drifted from the checked head (HEAD ${state.head}, checked ${state.sha})`,
    };
  if (state.remote === state.sha) return { action: 'skip' };
  if (state.remote !== state.expected)
    return {
      refused: `remote head moved to ${state.remote || 'nothing'} (expected ${state.expected}); someone else pushed`,
    };
  return { action: 'push' };
}

/** Counts of Codex's `[P0]`-`[P3]` priority tags in a review. */
export interface ReviewCounts {
  readonly findings: number;
  readonly priorities: {
    readonly P0: number;
    readonly P1: number;
    readonly P2: number;
    readonly P3: number;
  };
}

/** Count the `[P0]`-`[P3]` tags Codex puts on each finding (a quoted tag overcounts). */
export function reviewFindings(text: string): ReviewCounts {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const m of text.matchAll(/\[(P[0-3])\]/g)) counts[m[1] as keyof typeof counts]++;
  return { findings: counts.P0 + counts.P1 + counts.P2 + counts.P3, priorities: counts };
}

/** Work derived from triaged threads and findings, plus the finding summary the ledger keeps. */
export interface DerivedWork {
  readonly fix: WorkItem[];
  readonly followup: WorkItem[];
  readonly recorded: { id: string; title: string; severity: Severity; disposition: string }[];
}

/**
 * Turn thread decisions and review findings into work items: a thread to fix or defer, a finding
 * to fix or follow up. `source` names where the findings came from.
 */
export function itemsFrom(
  threads: readonly ThreadDecision[],
  findings: readonly FindingDecision[],
  source = 'merge-down review',
): DerivedWork {
  const fix: WorkItem[] = [];
  const followup: WorkItem[] = [];
  for (const t of threads) {
    const item: WorkItem = {
      key: `thread:${t.id}`,
      source: 'review thread',
      title: t.title,
      severity: t.severity,
      complexity: t.complexity,
      plan: t.plan,
      detail: t.reply,
      files: [],
    };
    if (t.action === 'fix') fix.push(item);
    if (t.action === 'defer') followup.push(item);
  }
  for (const f of findings) {
    const item: WorkItem = {
      key: `finding:${f.id}`,
      source,
      title: f.title,
      severity: f.severity,
      complexity: f.complexity,
      plan: f.plan,
      detail: f.detail,
      files: f.files,
    };
    if (f.disposition === 'fix') fix.push(item);
    if (f.disposition === 'follow-up') followup.push(item);
  }
  const recorded = findings.map((f) => ({
    id: f.id,
    title: f.title,
    severity: f.severity,
    disposition: f.disposition,
  }));
  return { fix, followup, recorded };
}

/** The facts of a local check run that `checkItem` reads. */
export interface CheckOutcome {
  readonly passed: boolean;
  readonly failedStep: string | null;
  readonly log: string | null;
  readonly excerptFile: string | null;
  readonly error?: string | null | undefined;
}

/**
 * A failed local check as a fix item. After a conflicted rebase the failure usually means adapting
 * the PR to what changed beneath it, so it is subtle; otherwise mechanical.
 */
export function checkItem(result: CheckOutcome, label: string, conflicted: boolean): WorkItem[] {
  if (result.passed) return [];
  const step = result.failedStep === null ? '' : ` at "${result.failedStep}"`;
  const error = result.error ? ` Error: ${result.error}` : '';
  return [
    {
      key: `check:${label}`,
      source: 'local check suite',
      title: `Local check fails${step}`,
      severity: 'major',
      complexity: conflicted ? 'subtle' : 'mechanical',
      plan: `Read ${result.log ?? 'the check log'} and make the suite pass without weakening tests. After a rebase this usually means adapting this PR's code to changes beneath it (see upstream-delta.patch).${error}`,
      detail: result.excerptFile ? `Failure excerpt: ${result.excerptFile}` : '',
      files: [],
    },
  ];
}

/** A red GitHub CI run as a fix item. */
export function ciItem(input: {
  readonly round: number;
  readonly failed: readonly string[];
  readonly pr: number;
  readonly repo: string;
  readonly rerun: boolean;
}): WorkItem {
  const names = input.failed.join(', ');
  const survived = input.rerun ? ' The failure survived one re-run of the failed jobs.' : '';
  return {
    key: `ci:${String(input.round)}`,
    source: 'GitHub CI',
    title: `CI failed: ${names}`,
    severity: 'major',
    complexity: 'mechanical',
    plan: `Diagnose with \`gh pr checks ${String(input.pr)} -R ${input.repo}\` and \`gh run view <run-id> -R ${input.repo} --log-failed\`, reproduce locally if possible (CI runs Node 22.13, 24, and 26), and fix the cause.${survived} If the failing code is outside this PR's changes, make the narrowest fix and say so in notes.`,
    detail: '',
    files: [],
  };
}

/**
 * Why a CI wait must block because required checks never registered; null otherwise. Without
 * `requiredChecks`, `no-checks` means the repository has no CI and does not block. With them,
 * `waitChecks` ends with `no-checks` once nothing registered is pending, so `pending` names exactly
 * the required checks that never registered.
 */
export function unregisteredRequired(
  ci: { readonly status: string; readonly pending: readonly string[] },
  requiredChecks: readonly string[],
): string | null {
  if (ci.status !== 'no-checks' || requiredChecks.length === 0) return null;
  const missing = ci.pending.length ? ci.pending : requiredChecks;
  return `required check(s) never registered: ${missing.join(', ')}`;
}

/** A thread reply to publish, with how to settle a linked code-scanning alert. */
export interface PlannedReply {
  readonly threadId: string;
  readonly body: string;
  readonly dismiss?: 'reject' | 'defer';
}

/**
 * The reply for a triaged thread. A fixed (or partly fixed) thread gets `Addressed in <sha>` and
 * needs that commit; a thread planned for a fix that was not fixed gets no reply. A deferred
 * thread names its follow-up. A rejected or deferred code-scanning thread also dismisses its alert.
 */
export function replyFor(
  thread: Pick<ThreadDecision, 'id' | 'action' | 'reply'>,
  fixed: readonly FixReport[] | null,
  filed: readonly { readonly key: string; readonly number: number }[] | null,
): PlannedReply | null {
  let body = thread.reply.trim();
  const key = `thread:${thread.id}`;
  if (thread.action === 'fix') {
    const done = fixed?.find((i) => i.key === key);
    if (!done || done.status === 'not-fixed' || !done.commit.trim()) return null;
    body += `\n\nAddressed in ${done.commit.trim()}${done.summary ? `: ${done.summary}` : '.'}`;
  }
  if (thread.action === 'defer') {
    const issue = filed?.find((i) => i.key === key);
    if (issue) body += `\n\nTracked in #${String(issue.number)}.`;
  }
  const dismiss =
    thread.action === 'reject' ? 'reject' : thread.action === 'defer' ? 'defer' : null;
  return { threadId: thread.id, body, ...(dismiss ? { dismiss } : {}) };
}

/**
 * Agents sometimes report a key without its prefix (`F1` for `finding:F1`). Map each reported key
 * back to the one item it names; a key that matches no item, or several, is left alone.
 */
export function canonicalizeKeys<T extends { readonly key: string }>(
  items: readonly { readonly key: string }[],
  reported: readonly T[],
): T[] {
  const keys = items.map((i) => i.key);
  return reported.map((r) => {
    if (keys.includes(r.key)) return r;
    const [only, ...more] = keys.filter((k) => k.endsWith(`:${r.key}`));
    return only !== undefined && more.length === 0 ? { ...r, key: only } : r;
  });
}

/**
 * A minor finding of the workflow's own review that the fixer could not fully address becomes a
 * follow-up instead of blocking the merge. Threads still need a truthful reply, check and CI items a
 * green suite, and anything above minor is a real defect to fix here.
 */
export function deferrable(report: FixReport, work: readonly WorkItem[]): boolean {
  return (
    report.status !== 'fixed' &&
    report.key.startsWith('finding:') &&
    work.find((w) => w.key === report.key)?.severity === 'minor'
  );
}

/**
 * Whether a fixed item must name the commit that fixed it. A failed check or CI run may be resolved
 * by a green re-run at the same head, with no commit; the suite at the published head still gates it.
 */
export function needsCommit(key: string): boolean {
  return !/^(check|ci):/.test(key);
}

/** The items a fixer left unfinished that block the round: neither deferrable nor really fixed. */
export function unfixed(reports: readonly FixReport[], work: readonly WorkItem[]): FixReport[] {
  return reports.filter(
    (i) =>
      !deferrable(i, work) && (i.status !== 'fixed' || (needsCommit(i.key) && !i.commit.trim())),
  );
}

/** The parts of a review the escalation rule reads. */
export interface EscalationInput {
  readonly escalate: boolean;
  readonly escalateReason: string;
  readonly findings: readonly Pick<FindingDecision, 'severity' | 'disposition'>[];
  readonly alignment: { readonly verdict: string };
}

/** Why a first-pass review goes to the judge; empty when it stands. */
export function escalationReasons(review: EscalationInput): string[] {
  const blockers = review.findings.filter((f) => f.severity === 'blocker').length;
  const majorFixes = review.findings.filter(
    (f) => f.severity === 'major' && f.disposition === 'fix',
  ).length;
  return [
    review.escalate ? review.escalateReason || 'reviewer requested escalation' : null,
    blockers ? `${String(blockers)} blocker finding(s)` : null,
    ['partial', 'misaligned'].includes(review.alignment.verdict)
      ? `alignment is ${review.alignment.verdict}`
      : null,
    majorFixes >= 3 ? `${String(majorFixes)} major fixes planned` : null,
  ].filter((reason): reason is string => reason !== null);
}

/** Whether the latest round found a valid major or blocker problem. */
export function latestMajor(
  entries: readonly { readonly severity: string; readonly verdict: string }[],
): boolean {
  return entries.some(
    (t) =>
      ['major', 'blocker'].includes(t.severity) && ['valid', 'partly-valid'].includes(t.verdict),
  );
}

/**
 * Whether another Codex review may run: always under `maxCodexRounds`; past it only while the
 * latest round found a real major or blocker, up to the hard cap.
 */
export function underLimit(input: {
  readonly requests: number;
  readonly maxCodexRounds: number;
  readonly hardCap: number;
  readonly latestMajor: boolean;
}): boolean {
  return (
    input.requests < input.maxCodexRounds || (input.latestMajor && input.requests < input.hardCap)
  );
}

/** Whether a Dependabot title such as `Bump x from 1.2 to 2.0` crosses a major version. */
export function majorBump(title: string): boolean {
  const m = /from v?(\d+)\S* to v?(\d+)/i.exec(title);
  return m ? Number(m[2]) > Number(m[1]) : false;
}

/** Whether a pull request comes from Dependabot, by its head branch (pr.view has no author). */
export function isDependency(headRefName: string): boolean {
  return headRefName.startsWith('dependabot/');
}

/** An open pull request as the stack walk reads it. */
export interface OpenPull {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly baseRefName: string;
  readonly headRefName: string;
}

/** A later pull request in the stack. */
export interface StackEntry {
  readonly pr: number;
  readonly title: string;
  readonly issue: number | null;
}

/**
 * Open pull requests stacked above `headRef` (children, grandchildren, ...), bottom-up. Reviewers
 * use it to avoid fixing now what a later pull request in the stack already does.
 */
export function laterInStack(open: readonly OpenPull[], headRef: string): StackEntry[] {
  const chain: StackEntry[] = [];
  const seen = new Set<number>();
  const frontier = [headRef];
  while (frontier.length) {
    const base = frontier.shift();
    const children = open.filter((x) => x.baseRefName === base).sort((x, y) => x.number - y.number);
    for (const q of children) {
      if (seen.has(q.number)) continue;
      seen.add(q.number);
      const issue =
        /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\b:?\s+#(\d+)/i.exec(q.body)?.[1] ??
        /^[^/]+\/(\d+)-/.exec(q.headRefName)?.[1] ??
        null;
      chain.push({ pr: q.number, title: q.title, issue: issue === null ? null : Number(issue) });
      frontier.push(q.headRefName);
    }
  }
  return chain;
}

/** Remove ANSI escape sequences from captured output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/** The last `lines` lines of `text`. */
export function tail(text: string, lines: number): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

/** The last npm script a check log started (`> pkg script`), the one that failed; null if none. */
export function failedStep(log: string): string | null {
  const steps = [...log.matchAll(/^> \S+ ([\w:.-]+)$/gm)];
  return steps.at(-1)?.[1] ?? null;
}

/**
 * The log of a check refused because the worktree is dirty: `git status --porcelain` lists changes
 * the suite would test but HEAD does not hold. Null when it lists nothing.
 */
export function dirtyTreeLog(head: string, porcelain: string): string | null {
  const listed = porcelain.split('\n').filter((line) => line.trim() !== '');
  if (!listed.length) return null;
  return [
    `The worktree has uncommitted changes, so the suite would not test HEAD ${head}. Commit or discard them:`,
    ...listed,
    '',
  ].join('\n');
}

/** The facts the fallback headline reads when no scribe wrote one. */
export interface HeadlineFacts {
  readonly kind: 'change' | 'dependency';
  readonly fixes: readonly Pick<FixReport, 'status' | 'summary'>[];
  readonly threads: readonly { readonly round: number }[];
  readonly codexRequests: number;
  readonly lead: string;
}

/** The native ledger line for a merged PR without an issue summary. */
export function fallbackHeadline(facts: HeadlineFacts): string {
  const fixedCount = facts.fixes.filter((f) => f.status !== 'not-fixed').length;
  if (facts.kind === 'change') {
    const outcome = [
      fixedCount ? `${String(fixedCount)} fix(es) during merge-down` : 'no changes needed',
      facts.threads.length ? `${String(facts.threads.length)} review thread(s) triaged` : null,
      facts.codexRequests
        ? `Codex re-review ${facts.threads.some((t) => t.round > 0) ? 'raised findings that were handled' : 'clean'}`
        : null,
    ].filter(Boolean);
    const lead = facts.lead;
    return `${lead}${lead && !lead.endsWith('.') ? '.' : ''} Merged with ${outcome.join('; ')}.`.trim();
  }
  const triaged = facts.threads.length
    ? `; ${String(facts.threads.length)} review thread(s) triaged`
    : '';
  return `Merged${fixedCount ? ` after ${String(fixedCount)} fix(es)` : ' as-is'}${triaged}.`;
}

/** Whether a file path is test-only, the native rule for dismissing an alert as "used in tests". */
export function testOnlyPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]s$/.test(path);
}

/** The fork-point ref that records where a stacked pull request left its parent; shared with the native script. */
export function forkPointRef(pr: number): string {
  return `refs/merge-down/fork-point/${String(pr)}`;
}

/** The local branch the package rebases on: distinct from the native script's `merge-down/pr-N`. */
export function localBranch(pr: number): string {
  return `merge-down/package/pr-${String(pr)}`;
}

/** Codex model names and efforts reach `-c key="value"` TOML overrides, so only plain tokens pass. */
export function codexToken(value: string): boolean {
  return /^[\w.:-]+$/.test(value);
}

/** The line the workflow appends to every follow-up issue it files. */
export function followupFooter(epic: number, pr: number): string {
  return `\n\n_Part of #${String(epic)}. Found while merging down #${String(pr)}._\n`;
}

/** The comment that closes an issue GitHub did not close on merge. */
export function closedNote(pr: number, mergeCommit: string): string {
  return `Closed by #${String(pr)} (merged as ${mergeCommit.slice(0, 7)}).`;
}

/** The comment that reopens an issue the review kept open but a commit message closed. */
export function reopenNote(pr: number): string {
  return `Reopened: #${String(pr)} landed only part of this issue; the merge-down review kept it open for the remaining items.`;
}

/** The detail of a minor finding deferred to a follow-up because the fixer did not finish it. */
export function deferredDetail(input: {
  readonly item: WorkItem;
  readonly report: FixReport;
  readonly pr: number;
  readonly notes: readonly string[];
}): string {
  const how = input.report.status === 'partly' ? 'only partly addressed' : 'did not address';
  const commit = input.report.commit.trim() ? ` (${input.report.commit.trim()})` : '';
  const notes = input.notes.length ? `\nFixer notes: ${input.notes.join(' ')}` : '';
  return `${input.item.detail}\n\nThe fixer ${how} this in PR #${String(input.pr)}${commit}: ${input.report.summary}${notes}`;
}

/** Shell rules as the prose an allowlist sentence lists: `Bash(swift build:*)` is `swift build`. */
export function shellProse(rules: readonly string[]): string {
  const commands = rules.flatMap((rule) => {
    const match = /^Bash\((.+?)(?::\*)?\)$/u.exec(rule.trim());
    return match?.[1] === undefined ? [] : [`\`${match[1]}\``];
  });
  return [...new Set(commands)].join(', ');
}

/** What the Situation fragment says about a run's toolchain (#735), or null for the npm default. */
export function toolchainNote(
  toolchain:
    | {
        readonly read: readonly string[];
        readonly edit: readonly string[];
        readonly guidance: string;
      }
    | undefined,
): { read: string; edit: string; guidance: string } | null {
  if (toolchain === undefined) return null;
  return {
    read: shellProse(toolchain.read),
    edit: shellProse(toolchain.edit),
    guidance: toolchain.guidance,
  };
}
