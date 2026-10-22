// Renderers for the state files agents read in state/pr-N/: body.md, issue.md, threads.md (with
// the open code-scanning alerts) and stack.md. They are pure; the workflow writes their output with
// ctx.writeFile. The git-derived files (own.diff, own.stat, commits.txt, upstream-delta.*) are
// written by the sync and snapshot steps in lib/git.ts, which produce them.
import type {
  GithubCodeScanningAlert,
  GithubIssueWithComments,
  GithubReviewThread,
} from 'quiet-choir/github';
import type { StackEntry } from './policy.js';

/** GraphQL spells bot logins without the `[bot]` suffix that REST adds. */
const CODEX_AUTHORS = new Set(['chatgpt-codex-connector', 'chatgpt-codex-connector[bot]']);

/** Whether a thread was opened by Codex's GitHub reviewer. */
export function isCodexThread(thread: Pick<GithubReviewThread, 'author'>): boolean {
  return CODEX_AUTHORS.has(thread.author);
}

/** Codex's badge markup reduced to `**[P1] title**`, without its "Useful?" footer. */
export function cleanCommentBody(body: string): string {
  return body
    .replace(/\*\*<sub><sub>!\[(P\d) Badge\]\([^)]*\)<\/sub><\/sub>\s*(.*?)\*\*/, '**[$1] $2**')
    .replace(/^Useful\? React with .*$/m, '')
    .trim();
}

/** body.md: the PR's title and description. */
export function renderBody(pr: { number: number; title: string; body: string }): string {
  return `# #${String(pr.number)} ${pr.title}\n\n${pr.body}\n`;
}

/** issue.md: the linked issue and its comments, or a note that there is none. */
export function renderIssue(issue: GithubIssueWithComments | null): string {
  if (issue === null) return 'No linked issue.\n';
  const comments = issue.comments
    .map((c) => `\n---\n\n**${c.author}** (${c.createdAt}):\n\n${c.body}\n`)
    .join('');
  return `# #${String(issue.number)} ${issue.title}\n\nState: ${issue.state} · ${issue.url}\n\n${issue.body}\n${comments}`;
}

/**
 * threads.md: every unresolved thread with its comments, then every open code-scanning alert. An
 * alert without a review thread is decided under the id `alert:N`.
 */
export function renderThreads(
  threads: readonly GithubReviewThread[],
  alerts: readonly GithubCodeScanningAlert[],
): string {
  const open = threads.filter((t) => !t.isResolved);
  const blocks = open.map((t) => {
    const where = `${t.path}${t.line === null ? '' : `:${String(t.line)}`}`;
    const by = `by ${t.author}${isCodexThread(t) ? ' (Codex)' : t.isBot ? ' (bot)' : ''}`;
    const meta = [
      t.priority,
      where,
      t.isOutdated ? 'outdated (code changed since)' : null,
      by,
      t.alert === null ? null : `code-scanning alert #${String(t.alert)}`,
    ]
      .filter(Boolean)
      .join(' · ');
    const body = t.comments
      .map((c, i) => `${i ? `**Reply from ${c.author}:** ` : ''}${cleanCommentBody(c.body)}`)
      .join('\n\n');
    return `## Thread ${t.id}\n\n${meta}\n\n${body}\n`;
  });
  const listing = open.length
    ? `# Unresolved review threads (${String(open.length)})\n\n${blocks.join('\n')}`
    : 'No unresolved review threads.\n';
  if (!alerts.length) return listing;
  const threadFor = (n: number): string | undefined => open.find((t) => t.alert === n)?.id;
  const lines = alerts.map((x) => {
    const thread = threadFor(x.number);
    const where = thread === undefined ? `id alert:${String(x.number)}` : `thread ${thread}`;
    const at = `${x.path ?? '?'}:${x.line === null ? '?' : String(x.line)}`;
    return `- #${String(x.number)} ${x.rule ?? '?'} (${x.severity ?? '?'}) ${at}: ${x.message} [${where}]`;
  });
  return `${listing}\n# Open code-scanning alerts on this PR (${String(alerts.length)})\n\nAn alert without a review thread is decided under the id alert:N.\n\n${lines.join('\n')}\n`;
}

/** stack.md: the open PRs stacked above this one, bottom-up. */
export function renderStack(later: readonly StackEntry[]): string {
  if (!later.length) return 'No open PRs are stacked above this one.\n';
  const lines = later.map(
    (l) =>
      `- #${String(l.pr)}${l.issue === null ? '' : ` (issue #${String(l.issue)})`}: ${l.title}`,
  );
  return `# Later PRs in this stack (${String(later.length)}), landing after this one, bottom-up\n\n${lines.join('\n')}\n`;
}
