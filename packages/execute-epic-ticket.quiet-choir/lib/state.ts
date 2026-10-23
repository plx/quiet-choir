// Renderers for the state files agents read in state/epic-E/issue-N/: issue.md (merge-down's
// renderer, the native layout) and epic.md, the epic body plus a table of every item with its
// status. They are pure; the workflow writes their output with ctx.writeFile.
import { renderIssue } from '../../merge-down.quiet-choir/lib/state.js';
import { homeItems, type EpicItem } from './policy.js';

export { renderIssue };

/**
 * An item table row's cell: backslashes doubled before pipes are escaped, so a title's own `\|`
 * cannot turn an escaped pipe back into a column break, and newlines become spaces.
 */
const cell = (text: string): string =>
  text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * The native item table: number, title, status, whether its checklist line is checked (`-` when
 * no line names it), its dependencies (open ones marked) and its open pull request. A dependency's
 * state comes from the epic repository's own items (`repository`) and the `outside` states the
 * survey read; another repository's item shares numbers with them, so it answers only through its
 * own blockers.
 */
export function renderItemsTable(
  items: readonly EpicItem[],
  statuses: ReadonlyMap<number, string>,
  repository: string,
  outside: readonly { readonly number: number; readonly state: string }[],
): string {
  const known = new Map([
    ...outside.map((x): [number, string] => [x.number, x.state]),
    ...homeItems(items, repository).map((x): [number, string] => [x.number, x.state]),
  ]);
  const rows = items.map((i) => {
    const open = i.state === 'OPEN';
    const status = open ? (statuses.get(i.number) ?? 'open') : 'closed';
    const checked = i.checked === null ? '-' : i.checked ? 'x' : ' ';
    const deps = [...new Set([...i.dependsOn, ...i.blockedBy.map((b) => b.number)])];
    const home = i.repository.toLowerCase() === repository.toLowerCase();
    // A known state, else the blocker's, else unknown, which counts as open.
    const stateOf = (d: number): string =>
      (home ? known.get(d) : undefined) ?? i.blockedBy.find((b) => b.number === d)?.state ?? 'OPEN';
    const depText =
      deps.map((d) => `#${String(d)}${stateOf(d) === 'CLOSED' ? '' : ' (open)'}`).join(', ') || '-';
    const pr = i.pullRequests.find((p) => p.state === 'OPEN');
    return `| #${String(i.number)} | ${cell(i.title)} | ${status} | ${checked} | ${depText} | ${pr ? `#${String(pr.number)}` : '-'} |`;
  });
  return `| # | Title | Status | Checked | Deps | PR |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`;
}

/** epic.md: the epic's title, state and body, then the item table as of the survey. */
export function renderEpic(
  epic: {
    readonly number: number;
    readonly title: string;
    readonly state: string;
    readonly url: string;
    readonly body: string;
  },
  items: readonly EpicItem[],
  statuses: ReadonlyMap<number, string>,
  surveyedAt: string,
  repository: string,
  outside: readonly { readonly number: number; readonly state: string }[],
): string {
  return `# #${String(epic.number)} ${epic.title}\n\nState: ${epic.state} · ${epic.url}\n\n${epic.body}\n\n## Items as of the last survey (${surveyedAt})\n\n${renderItemsTable(items, statuses, repository, outside)}`;
}
