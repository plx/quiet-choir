// Pure decision rules of execute-epic-ticket, ported from the native script and its helper CLI.
// Nothing here imports quiet-choir or touches I/O, so test/execute-epic-ticket-package.test.ts
// checks it directly. The types below are the structural parts of quiet-choir/github's epic
// snapshot and nextTicket result that these rules read.
import { plain } from '../../merge-down.quiet-choir/lib/policy.js';

export { plain };

/** Labels that hold a ticket back, as natively. */
export const HOLD_LABELS = ['blocked', 'needs-decision', 'on-hold'] as const;

/** The label a needs-decision question gets, and a decision removes. */
export const DECISION_LABEL = 'needs-decision';

/** An item of an epic snapshot, as these rules read it. */
export interface EpicItem {
  readonly number: number;
  /** The item's `OWNER/REPO`, which can differ from the epic's. */
  readonly repository: string;
  readonly title: string;
  readonly state: string;
  readonly labels: readonly string[];
  readonly checked: boolean | null;
  readonly dependsOn: readonly number[];
  readonly blockedBy: readonly { readonly number: number; readonly state: string }[];
  readonly pullRequests: readonly {
    readonly number: number;
    readonly state: string;
    readonly url?: string;
  }[];
  readonly split: readonly number[] | null;
}

/**
 * The items that are issues of `repository` (the snapshot's `OWNER/REPO`, compared without case):
 * a sub-issue of another repository can share a number with a ticket here, and `candidates`,
 * `pickFor` and the linked-pull-request lookup find an item by number alone.
 */
export function homeItems<T extends Pick<EpicItem, 'repository'>>(
  items: readonly T[],
  repository: string,
): T[] {
  return items.filter((i) => i.repository.toLowerCase() === repository.toLowerCase());
}

/**
 * Whether `url` is a pull request of `repo` (`OWNER/REPO`, or `HOST/OWNER/REPO`): a closing
 * reference can link an item to another repository's pull request, whose number means nothing here.
 */
export function isRepoPull(url: string, repo: string): boolean {
  const parts = repo.split('/');
  const host = parts.length > 2 ? parts[0] : 'github.com';
  const prefix = `https://${String(host)}/${parts.slice(-2).join('/')}/pull/`;
  return url.toLowerCase().startsWith(prefix.toLowerCase());
}

/** The pick of `nextTicket`. */
export interface TicketPick {
  readonly number: number;
  readonly title: string;
  readonly status: 'in-flight' | 'close-split' | 'ready';
  readonly pullRequests: readonly number[];
  readonly openSlices: readonly number[];
}

/** An open item `nextTicket` skipped. */
export interface Skip {
  readonly number: number;
  readonly title: string;
  readonly reason: string;
  readonly waitingOn?: readonly number[];
  readonly openSlices?: readonly number[];
  readonly pullRequests?: readonly number[];
}

/** What `nextTicket` decided. */
export interface Selection {
  readonly pick: TicketPick | null;
  readonly skipped: readonly Skip[];
  readonly done: boolean;
}

/** A candidate's status: the selector's, or `closed` for a named ticket that is already closed. */
export type CandidateStatus =
  'ready' | 'in-flight' | 'close-split' | 'split' | 'held' | 'waiting' | 'closed';

/** A ticket this run may work on, with what its dispatch reads. */
export interface Candidate {
  readonly number: number;
  readonly title: string;
  readonly status: CandidateStatus;
  readonly labels: readonly string[];
  /** Open or unknown dependencies (for `waiting`). */
  readonly waitingOn: readonly number[];
  /** Open slices (for `split`). */
  readonly openSlices: readonly number[];
  /** Every slice (for `close-split`). */
  readonly split: readonly number[];
  /** The first open linked pull request (for `in-flight`). */
  readonly pr: number | null;
}

/** Statuses a skip reason can carry for a ticket of this repository. */
const SKIP_STATUSES = new Set<string>([
  'in-flight',
  'close-split',
  'split',
  'held',
  'waiting',
  'ready',
]);

function candidate(
  entry: TicketPick | Skip,
  status: CandidateStatus,
  items: readonly EpicItem[],
): Candidate {
  const item = items.find((i) => i.number === entry.number);
  const prs = entry.pullRequests ?? [];
  return {
    number: entry.number,
    title: entry.title,
    status,
    labels: item?.labels ?? [],
    waitingOn: 'waitingOn' in entry ? (entry.waitingOn ?? []) : [],
    openSlices: entry.openSlices ?? [],
    split: item?.split ?? [],
    pr: prs[0] ?? null,
  };
}

/**
 * The ticket a run works on first: the selector's pick, or with `ticket` (the native `--prefer`)
 * that ticket, whatever its status. A named ticket that is a closed item of the epic is `closed`;
 * one the epic does not hold (or holds only as another repository's issue or a checklist line that
 * is not a sub-issue) is null, which the workflow blocks at survey.
 */
export function pickFor(
  selection: Selection,
  items: readonly EpicItem[],
  ticket: number | null,
): Candidate | null {
  const { pick } = selection;
  if (ticket === null) return pick ? candidate(pick, pick.status, items) : null;
  if (pick?.number === ticket) return candidate(pick, pick.status, items);
  const skip = selection.skipped.find((s) => s.number === ticket && SKIP_STATUSES.has(s.reason));
  if (skip) return candidate(skip, skip.reason as CandidateStatus, items);
  const closed = items.find((i) => i.number === ticket && i.state !== 'OPEN');
  if (closed)
    return {
      number: closed.number,
      title: closed.title,
      status: 'closed',
      labels: closed.labels,
      waitingOn: [],
      openSlices: [],
      split: closed.split ?? [],
      pr: null,
    };
  return null;
}

/**
 * The candidates for this run: the first ticket, then later ready tickets in epic order (tried
 * only when an earlier one turns out to be blocked by a dependency nobody had declared), at most
 * `maxCandidates`; only the named ticket when `ticket` is given.
 */
export function candidates(
  selection: Selection,
  items: readonly EpicItem[],
  ticket: number | null,
  maxCandidates: number,
): Candidate[] {
  const first = pickFor(selection, items, ticket);
  if (first === null) return [];
  if (ticket !== null) return [first];
  const ready = selection.skipped
    .filter((s) => s.reason === 'ready' && s.number !== first.number)
    .map((s) => candidate(s, 'ready', items));
  return [first, ...ready].slice(0, Math.max(1, maxCandidates));
}

/**
 * Whether a held candidate stays held: it does unless it waits on a maintainer decision (the
 * `needs-decision` label) and the run brings one.
 */
export function stillHeld(
  c: Pick<Candidate, 'status' | 'labels'>,
  decision: string | null,
): boolean {
  return c.status === 'held' && !(c.labels.includes(DECISION_LABEL) && decision !== null);
}

/** Item counts of a survey, in the native shape. */
export interface SurveyCounts {
  readonly total: number;
  readonly open: number;
  readonly closed: number;
  readonly ready: number;
  readonly inFlight: number;
  readonly waiting: number;
  readonly held: number;
  readonly split: number;
}

/** Count the epic's items by state and status. */
export function counts(items: readonly EpicItem[], selection: Selection): SurveyCounts {
  const statuses = [
    ...(selection.pick ? [selection.pick.status as string] : []),
    ...selection.skipped.map((s) => s.reason),
  ];
  const by = (...names: string[]): number => statuses.filter((s) => names.includes(s)).length;
  const open = items.filter((i) => i.state === 'OPEN').length;
  return {
    total: items.length,
    open,
    closed: items.length - open,
    ready: by('ready'),
    inFlight: by('in-flight'),
    waiting: by('waiting'),
    held: by('held'),
    split: by('split', 'close-split'),
  };
}

const refs = (numbers: readonly number[]): string => numbers.map((n) => `#${String(n)}`).join(', ');

/** The native `stalled` headline: every open item with its status and open dependencies. */
export function waitingHeadline(epic: number, selection: Selection): string {
  const listed = selection.skipped.map(
    (s) =>
      `#${String(s.number)} ${s.reason}${s.waitingOn?.length ? ` on ${refs(s.waitingOn)}` : ''}`,
  );
  return `Nothing in #${String(epic)} is ready: ${listed.join('; ')}.`;
}

/** Each item's status for the epic table: the selector's, or `closed`. */
export function itemStatuses(selection: Selection): Map<number, string> {
  const statuses = new Map<number, string>();
  if (selection.pick) statuses.set(selection.pick.number, selection.pick.status);
  for (const s of selection.skipped) if (!statuses.has(s.number)) statuses.set(s.number, s.reason);
  return statuses;
}

/** Branch-name slug, the native algorithm: lowercase, non-alphanumeric runs to "-", at most `max` characters, cut at a dash. */
export function slugify(title: string, max = 40): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length <= max) return s || 'issue';
  if (s[max] === '-') return s.slice(0, max);
  const cut = s.slice(0, max);
  const dash = cut.lastIndexOf('-');
  return dash > 0 ? cut.slice(0, dash) : cut;
}

/** The ticket's branch prefix: every branch of epic E is `epic-E/<N>-<slug>`, by either tool. */
export function branchPrefix(epic: number): string {
  return `epic-${String(epic)}`;
}

/** The branch a new ticket gets: `epic-E/N-<slug of its title>`, as the native helper names it. */
export function branchName(epic: number, number: number, title: string): string {
  return `${branchPrefix(epic)}/${String(number)}-${slugify(title)}`;
}

/** Which implementer slot a plan gets: the override, else the surgeon for subtle or large work. */
export function implementerSlot(
  plan: { readonly complexity: string; readonly size: string },
  override: 'auto' | 'mechanic' | 'surgeon',
): 'mechanic' | 'surgeon' {
  if (override !== 'auto') return override;
  return plan.complexity === 'subtle' || plan.size === 'large' ? 'surgeon' : 'mechanic';
}

/**
 * Criterion statuses that let a ticket publish. `verify-on-pr` is done locally but checkable only
 * once the PR exists (CI timings, alerts), and `deviation` is met in substance: the landing review
 * judges both.
 */
export const SETTLED: ReadonlySet<string> = new Set(['done', 'verify-on-pr', 'deviation']);

/** One criterion of an implementer's report. */
export interface CriterionReport {
  readonly id: string;
  readonly status: string;
  readonly commit: string;
  readonly evidence: string;
}

/** The plan's criteria that the report leaves unsettled: unreported, partial or not done. */
export function unsettled(
  ids: readonly string[],
  criteria: readonly CriterionReport[],
): { id: string; status: string; evidence: string }[] {
  return ids.flatMap((id) => {
    const found = criteria.find((c) => c.id === id);
    if (found === undefined) return [{ id, status: 'not reported', evidence: '' }];
    return SETTLED.has(found.status)
      ? []
      : [{ id, status: found.status, evidence: found.evidence }];
  });
}

/**
 * The commits a report names, unique, commit-shaped only: a criterion already met on main has no
 * commit of its own, and implementers sometimes say so in the field ("already on main (#138)").
 */
export function shaCommits(criteria: readonly CriterionReport[]): string[] {
  return [
    ...new Set(
      criteria.map((c) => c.commit.trim()).filter((commit) => /^[0-9a-f]{7,40}$/i.test(commit)),
    ),
  ];
}

/**
 * The PR body with `section` (the rendered FollowupsSection: the filed follow-ups) placed before
 * `footer` (the PR writer ran beside the filing, so it could not list them), or appended when the
 * body does not contain the footer. An empty section leaves the body as it is.
 */
export function withFollowups(body: string, followups: string, footer: string): string {
  const section = followups.trim();
  if (!section) return body;
  const end = footer.trim();
  const at = end ? body.lastIndexOf(end) : -1;
  return at >= 0
    ? `${body.slice(0, at).trimEnd()}\n\n${section}\n\n${body.slice(at)}`
    : `${body.trimEnd()}\n\n${section}`;
}

// The native helper's closing forms: a closing keyword, then an issue reference (REF, below: bare
// #12 or qualified owner/name#12) or a full issue URL, which GitHub also honours. Groups of
// `closingRe`: 1 keyword, 2 separator, 3-4 qualifier and number of a #ref, 5-6 repository and
// number of an issue URL.
const URL_REF = String.raw`https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\b`;
const CLOSING = String.raw`\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b`;
const closingRe = (): RegExp =>
  new RegExp(String.raw`${CLOSING}(:?\s+)(?:${REF.source}|${URL_REF})`, 'gi');
const isOwn = (qualifier: string | undefined, repo: string): boolean =>
  !qualifier || qualifier.toLowerCase() === repo.toLowerCase();

/** Whether a `closingRe` match closes `issue` of `repo`. */
function closesOwn(m: readonly (string | undefined)[], repo: string, issue: number): boolean {
  const [qualifier, number] = m[4] !== undefined ? [m[3], m[4]] : [m[5], m[6]];
  return isOwn(qualifier, repo) && Number(number) === issue;
}

/**
 * Make a PR body close exactly `issue` of `repo`, as the native `normalizePrBody` did: a closing
 * keyword aimed at anything else (another `#N`, `owner/repo#N` or an issue URL, here or elsewhere)
 * becomes `Refs` with the rest of the reference kept (GitHub would close it on merge, and
 * merge-down refuses a PR that closes several issues), `Closes #issue.` is appended unless one of
 * the three forms already closes it, and `Part of #epic.` when the epic is not mentioned.
 */
export function prBody(body: string, issue: number, epic: number, repo: string): string {
  const rewritten = body.replace(closingRe(), (...m: (string | undefined)[]) => {
    const [match = '', keyword = '', gap = ''] = m;
    return closesOwn(m, repo, issue)
      ? match
      : `Refs${gap}${match.slice(keyword.length + gap.length)}`;
  });
  const closes = [...rewritten.matchAll(closingRe())].some((m) => closesOwn(m, repo, issue));
  const closing = closes ? rewritten : `${rewritten.trimEnd()}\n\nCloses #${String(issue)}.\n`;
  const mentions = [...closing.matchAll(REF)].some(
    (m) => isOwn(m[1], repo) && Number(m[2]) === epic,
  );
  return mentions ? closing : `${closing.trimEnd()}\n\nPart of #${String(epic)}.\n`;
}

/** A slice body that depends on the slice filed before it, as the native helper wrote it. */
export function withDependency(body: string, previous: number | undefined): string {
  return previous === undefined ? body : `${body.trim()}\n\nDepends on #${String(previous)}.`;
}

/** The line the workflow appends to every follow-up issue it files. */
export function followupFooter(epic: number, ticket: number): string {
  return `\n\n_Part of #${String(epic)}. Found while implementing #${String(ticket)}._\n`;
}

/** How an obsolete ticket closes: completed when it is already done, else not planned. */
export function closeReason(kind: string): 'completed' | 'not_planned' {
  return kind === 'already-done' ? 'completed' : 'not_planned';
}

/** The first sentence of a rationale, for a headline. */
export function firstSentence(text: string): string {
  return (text.split('. ')[0] ?? '').trim().replace(/\.$/, '');
}

// ── Epic body edits ──────────────────────────────────────────────────────────────────────────

const CHECKLIST = /^(\s*[-*+]\s+)\[( |x|X)\](\s+)(.*)$/;
// An issue reference: bare (#12) or repository-qualified (owner/name#12). The lookbehind keeps
// "owner/name#12" from also matching as a bare "#12", and skips anchors such as "page#12".
const REF = /(?<![\w./-])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g;

/**
 * For each line, whether it belongs to a fenced code block (``` or ~~~, fence lines included). A
 * closing fence uses the opening fence's character and is at least as long; an unclosed fence runs
 * to the end. Examples in fences are never checklist items.
 */
export function fenceMask(lines: readonly string[]): boolean[] {
  let fence: string | null = null;
  return lines.map((line) => {
    if (fence !== null) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close?.[1]?.startsWith(fence.charAt(0)) && close[1].length >= fence.length) fence = null;
      return true;
    }
    const open = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (open?.[1] && !(open[1].startsWith('`') && (open[2] ?? '').includes('`'))) {
      fence = open[1];
      return true;
    }
    return false;
  });
}

/** The first issue of `repo` a checklist line's text names, ignoring inline code. */
function firstOwnRef(text: string, repo: string): number | null {
  const code = text.replace(/(`+)[^\n]*?\1/g, '');
  for (const m of code.matchAll(REF))
    if (m[1] === undefined || m[1].toLowerCase() === repo.toLowerCase()) return Number(m[2]);
  return null;
}

interface ChecklistLine {
  readonly index: number;
  readonly bullet: string;
  readonly checked: boolean;
  readonly ref: number | null;
  readonly indent: number;
}

function checklistLines(lines: readonly string[], repo: string): ChecklistLine[] {
  const fenced = fenceMask(lines);
  return lines.flatMap((line, index) => {
    if (fenced[index]) return [];
    const m = CHECKLIST.exec(line);
    if (!m) return [];
    return [
      {
        index,
        bullet: m[1] ?? '- ',
        checked: m[2] !== ' ',
        ref: firstOwnRef(m[4] ?? '', repo),
        indent: (/^\s*/.exec(line)?.[0] ?? '').length,
      },
    ];
  });
}

const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

/**
 * The epic body with the first unchecked checklist line (outside fenced code) whose first own
 * reference is `#number` ticked; null when there is nothing to change (already ticked, or not
 * listed), so a retry or resume never edits the body again.
 */
export function tickBody(body: string, number: number, repo: string): string | null {
  const lines = body.split(/\r?\n/);
  const line = checklistLines(lines, repo).find((l) => l.ref === number);
  if (line === undefined || line.checked) return null;
  lines[line.index] = (lines[line.index] ?? '').replace(/\[ \]/, '[x]');
  return lines.join(eolOf(body));
}

/** The last line of the list item at `at`: its nested items and continuation lines are deeper. */
function endOfItem(lines: readonly string[], at: number, indent: number): number {
  let end = at;
  for (let k = at + 1; k < lines.length; k++) {
    const line = lines[k] ?? '';
    if (!line.trim()) continue;
    if ((/^\s*/.exec(line)?.[0] ?? '').length <= indent) break;
    end = k;
  }
  return end;
}

/**
 * The epic body with `- [ ] #n title` lines for `entries`, in order, right after the checklist
 * item for `#parent` (and its nested items); else after the last outermost item; else under the
 * `## Items` heading, or a new one. Entries already listed are skipped, so a retry is a no-op;
 * null when nothing changes.
 */
export function insertAfter(
  body: string,
  parent: number,
  entries: readonly { readonly number: number; readonly title: string }[],
  repo: string,
): string | null {
  const eol = eolOf(body);
  const lines = body.split(/\r?\n/);
  const parsed = checklistLines(lines, repo);
  const listed = new Set(parsed.map((l) => l.ref));
  const fresh = entries.filter((e) => !listed.has(e.number));
  if (!fresh.length) return null;
  const text = (e: { number: number; title: string }): string =>
    `[ ] #${String(e.number)} ${e.title.replace(/\s*\r?\n\s*/g, ' ').trim()}`;
  // After the last slice already listed, so a partial earlier insert keeps the order.
  const anchors = [parent, ...entries.map((e) => e.number)].filter((n) => listed.has(n));
  const anchorNumber = anchors.at(-1);
  let at = parsed.find((l) => l.ref === anchorNumber);
  if (at === undefined && parsed.length) {
    const outer = Math.min(...parsed.map((l) => l.indent));
    at = parsed.filter((l) => l.indent === outer).at(-1);
  }
  if (at === undefined) {
    const heading = lines.findIndex((l) => /^##\s+Items\s*$/i.test(l));
    const added = fresh.map((e) => `- ${text(e)}`);
    if (heading >= 0) {
      lines.splice(heading + 1, 0, '', ...added);
      return lines.join(eol);
    }
    const base = body.replace(/\s+$/, '');
    return `${base}${base ? eol + eol : ''}## Items${eol}${eol}${added.join(eol)}${eol}`;
  }
  const bullet = at.bullet;
  lines.splice(endOfItem(lines, at.index, at.indent) + 1, 0, ...fresh.map((e) => bullet + text(e)));
  return lines.join(eol);
}

// ── Landing ──────────────────────────────────────────────────────────────────────────────────

/** What the landing review is told, beyond the run's standing notes. */
export interface LandingFacts {
  readonly standingNotes: readonly string[];
  readonly ticket: number;
  readonly epic: number;
  readonly planFile: string | null;
  readonly verifyOnPr: readonly { readonly id: string; readonly check: string }[];
  readonly deviations: readonly { readonly id: string; readonly reason: string }[];
}

/**
 * The merge-down child's standing notes: the run's own, then the native landing notes, each one
 * line: what the PR implements, the verify-on-pr checks and the deviations to judge (only when
 * there are any).
 */
export function landingNotes(facts: LandingFacts): string[] {
  const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, ' ').trim();
  const plan = facts.planFile ? ` from the plan in ${facts.planFile}` : '';
  return [
    ...facts.standingNotes,
    `This PR implements #${String(facts.ticket)} of epic #${String(facts.epic)} and was written by the execute-epic-ticket workflow${plan}. Judge it against the ticket's acceptance criteria; work the epic's other tickets own is out of scope (see the epic's checklist).`,
    ...(facts.verifyOnPr.length
      ? [
          `These acceptance criteria could only be checked once the PR existed; CI has run on it, so check each one now (e.g. \`gh run view\` timings, code-scanning alerts) and treat an unmet one as a fix: ${facts.verifyOnPr.map((c) => `[${c.id}] ${oneLine(c.check)}`).join(' ')}`,
        ]
      : []),
    ...(facts.deviations.length
      ? [
          `The implementer reported these acceptance criteria as deliberate deviations (met in substance, literal target out of this ticket's scope). Judge each one: accept it and record it in the issue summary, or treat it as a fix if the deviation is not justified: ${facts.deviations.map((c) => `[${c.id}] ${oneLine(c.reason)}`).join(' ')}`,
        ]
      : []),
  ];
}

/** One line of the epic's ledger: what landed, as natively, with the time it was recorded. */
export function ledgerLine(entry: {
  readonly ticket: number;
  readonly title: string;
  readonly pr: number;
  readonly mergeCommit: string | null;
  readonly implementer: string | null;
  readonly landing: { readonly threads: number; readonly fixes: number };
  readonly followups: readonly number[];
  readonly at: string;
}): string {
  return JSON.stringify({
    ticket: entry.ticket,
    title: entry.title,
    pr: entry.pr,
    mergeCommit: entry.mergeCommit,
    implementer: entry.implementer,
    landing: entry.landing,
    followups: entry.followups,
    at: entry.at,
  });
}
