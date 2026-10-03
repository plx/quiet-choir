/**
 * Pure parts of the `quiet-choir/github` epic snapshot and next-ticket selector
 * ([ADR 0048](../../docs/decisions/0048-epic-snapshot-and-next-ticket-selector.md)): the query, its
 * response schema with the completeness checks, the text parsers (checklist, dependencies, split
 * markers), the mapper to a compact snapshot, and the selector `nextTicket`. No I/O, clock or
 * process access; an ESLint block enforces it.
 *
 * The rules follow the burn-down survey this selector was written for: the epic body's checklist
 * orders the items, "Depends on #N" lines and GitHub's blocked-by relations hold an item back, hold
 * labels park it, a split marker posted by the viewer replaces it with its slices, and work that is
 * already under way is finished before new work starts.
 */
import { z } from '../index.js';
import {
  compact,
  connection,
  count,
  graphqlArgv,
  incomplete,
  INCOMPLETE_COLLECTION_PARAM,
  issueNumber,
  positiveInteger,
  type GithubReadSpec,
  type GithubRepo,
  type RawConnection,
} from './github-model.js';

// ---------------------------------------------------------------------------------------------
// Query

/**
 * One epic with up to 100 sub-issues and, for each, up to 100 labels, assignees, blocked-by
 * relations, linked pull requests and comments. One page of each; the schema fails the read when
 * any of them reports more. @internal
 */
export const EPIC_SNAPSHOT_QUERY: string = compact(`
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number title state url body
      subIssuesSummary { total completed }
      subIssues(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          number title state stateReason url body
          repository { nameWithOwner }
          labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
          assignees(first: 100) { pageInfo { hasNextPage } nodes { login } }
          blockedBy(first: 100) {
            pageInfo { hasNextPage }
            nodes { number state repository { nameWithOwner } }
          }
          closedByPullRequestsReferences(first: 100, includeClosedPrs: true) {
            pageInfo { hasNextPage }
            nodes { number state isDraft url headRefName }
          }
          comments(first: 100) { pageInfo { hasNextPage } nodes { author { login } body } }
        }
      }
    }
  }
}`);

/**
 * Retained stdout bytes of the snapshot read unless the caller's policy says otherwise: 8 MiB.
 * Epic #99's snapshot with 80 sub-issues and their comments measured 687 KB.
 */
const EPIC_SNAPSHOT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Raw response

/** A repository reference in the epic snapshot response. */
export interface RawEpicRepositoryRef {
  /** `OWNER/REPO`. */
  readonly nameWithOwner: string;
}

/** An issue that blocks a sub-issue (GitHub's issue dependencies). */
export interface RawEpicBlocker {
  /** Issue number. */
  readonly number: number;
  /** `OPEN` or `CLOSED`. */
  readonly state: string;
  /** The blocking issue's repository. */
  readonly repository: RawEpicRepositoryRef;
}

/** A pull request linked to a sub-issue: one whose merge would close it. */
export interface RawEpicPullRequestRef {
  /** Pull request number. */
  readonly number: number;
  /** `OPEN`, `CLOSED` or `MERGED`. */
  readonly state: string;
  /** Whether the pull request is a draft. */
  readonly isDraft: boolean;
  /** Web URL. */
  readonly url: string;
  /** Head branch. */
  readonly headRefName: string;
}

/** A sub-issue comment: only its author and body are read. */
export interface RawEpicComment {
  /** Author, or null for a deleted account. */
  readonly author: {
    /** Login. */
    readonly login: string;
  } | null;
  /** Markdown body. */
  readonly body: string;
}

/** One sub-issue of the epic. */
export interface RawEpicSubIssue {
  /** Issue number. */
  readonly number: number;
  /** Title. */
  readonly title: string;
  /** `OPEN` or `CLOSED`. */
  readonly state: string;
  /** Why it closed (`COMPLETED`, `NOT_PLANNED`, `DUPLICATE`), or null. */
  readonly stateReason: string | null;
  /** Web URL. */
  readonly url: string;
  /** Markdown body. */
  readonly body: string;
  /** The sub-issue's repository, which can differ from the epic's. */
  readonly repository: RawEpicRepositoryRef;
  /** Labels. */
  readonly labels: RawConnection<{
    /** Label name. */
    readonly name: string;
  }>;
  /** Assignees. */
  readonly assignees: RawConnection<{
    /** Login. */
    readonly login: string;
  }>;
  /** Issues that block this one. */
  readonly blockedBy: RawConnection<RawEpicBlocker>;
  /** Pull requests that close this issue on merge. */
  readonly closedByPullRequestsReferences: RawConnection<RawEpicPullRequestRef>;
  /** Comments, oldest first. */
  readonly comments: RawConnection<RawEpicComment>;
}

/** The epic issue with its sub-issues. */
export interface RawEpicIssue {
  /** Issue number. */
  readonly number: number;
  /** Title. */
  readonly title: string;
  /** `OPEN` or `CLOSED`. */
  readonly state: string;
  /** Web URL. */
  readonly url: string;
  /** Markdown body, whose checklist orders the items. */
  readonly body: string;
  /** GitHub's own count of the sub-issues. */
  readonly subIssuesSummary: {
    /** Every sub-issue. */
    readonly total: number;
    /** Closed sub-issues. */
    readonly completed: number;
  };
  /** The sub-issues, in GitHub's sub-issue order. */
  readonly subIssues: RawConnection<RawEpicSubIssue>;
}

/** `epic.snapshot` response. */
export interface RawEpicSnapshotResponse {
  /** GraphQL data. */
  readonly data: {
    /** The authenticated user. */
    readonly viewer: {
      /** The authenticated login. */
      readonly login: string;
    };
    /** The repository. */
    readonly repository: {
      /** The epic. */
      readonly issue: RawEpicIssue;
    };
  };
}

// ---------------------------------------------------------------------------------------------
// Schema

const repositoryRef = z.object({ nameWithOwner: z.string() });

const subIssue = z.object({
  number: issueNumber,
  title: z.string(),
  state: z.string(),
  stateReason: z.string().nullable(),
  url: z.string(),
  body: z.string(),
  repository: repositoryRef,
  labels: connection(z.object({ name: z.string() })),
  assignees: connection(z.object({ login: z.string() })),
  blockedBy: connection(
    z.object({ number: issueNumber, state: z.string(), repository: repositoryRef }),
  ),
  closedByPullRequestsReferences: connection(
    z.object({
      number: issueNumber,
      state: z.string(),
      isDraft: z.boolean(),
      url: z.string(),
      headRefName: z.string(),
    }),
  ),
  comments: connection(
    z.object({ author: z.object({ login: z.string() }).nullable(), body: z.string() }),
  ),
});

const nestedConnections = [
  'labels',
  'assignees',
  'blockedBy',
  'closedByPullRequestsReferences',
  'comments',
] as const;

/**
 * Schema of the `epic.snapshot` response. It fails, and the read throws
 * `IncompleteCollectionError`, when the sub-issue page or any sub-issue's labels, assignees,
 * blocked-by relations, linked pull requests or comments report another page, or when fewer
 * sub-issues are listed than `subIssuesSummary.total` counts.
 */
export const epicSnapshotResponseSchema: z.ZodType<RawEpicSnapshotResponse> = z
  .object({
    data: z.object({
      viewer: z.object({ login: z.string() }),
      repository: z.object({
        issue: z.object({
          number: issueNumber,
          title: z.string(),
          state: z.string(),
          url: z.string(),
          body: z.string(),
          subIssuesSummary: z.object({ total: count, completed: count }),
          subIssues: connection(subIssue),
        }),
      }),
    }),
  })
  .superRefine((response, ctx) => {
    const epic = response.data.repository.issue;
    const at = ['data', 'repository', 'issue', 'subIssues'];
    if (epic.subIssues.pageInfo.hasNextPage) incomplete(ctx, 'epic.subIssues', at);
    epic.subIssues.nodes.forEach((node, index) => {
      for (const name of nestedConnections)
        if (node[name].pageInfo.hasNextPage)
          incomplete(ctx, `epic.subIssues[${String(node.number)}].${name}`, [
            ...at,
            'nodes',
            index,
            name,
          ]);
    });
    // Only a shortfall can hide an item. A dry run synthesizes one node with a total of 0, which
    // must pass.
    const listed = epic.subIssues.nodes.length;
    const total = epic.subIssuesSummary.total;
    if (listed < total)
      ctx.addIssue({
        code: 'custom',
        message: `epic.subIssues lists ${String(listed)} sub-issues but subIssuesSummary.total is ${String(total)}.`,
        path: [...at, 'nodes'],
        params: { [INCOMPLETE_COLLECTION_PARAM]: 'epic.subIssues' },
      });
  });

// ---------------------------------------------------------------------------------------------
// Text parsers

/**
 * An issue reference: bare (`#12`) or repository-qualified (`owner/name#12`). The lookbehind keeps
 * `owner/name#12` from also matching as a bare `#12` and skips anchors such as `page#12`.
 */
const REF = String.raw`(?<![\w./-])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b`;
// One whitespace after the box: the title is trimmed, and `\s+(.*)` would backtrack polynomially.
const CHECKLIST = /^\s*[-*+]\s+\[( |x|X)\]\s(.*)$/u;
const DEP_REF = String.raw`(?:[\w.-]+\/[\w.-]+)?#\d+`;
const DEP_SEP = String.raw`(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s+)`;
const DEP_PHRASE = new RegExp(
  String.raw`\b(?:depends\s+on|blocked\s+by|requires)\b\s*(?::\s*)?(${DEP_REF}(?:${DEP_SEP}${DEP_REF})*)`,
  'giu',
);
// Markers must list at least one number: a template such as <!-- epic:split a,b --> is not one.
const NUMBER_LIST = String.raw`(\d+(?:\s*,\s*\d+)*)`;
const DEP_MARKER = new RegExp(String.raw`<!--\s*epic:depends-on\s+${NUMBER_LIST}\s*-->`, 'giu');
const SPLIT_MARKER = new RegExp(String.raw`<!--\s*epic:split\s+${NUMBER_LIST}\s*-->`, 'giu');

/** Whether `number` can be an issue number: a positive safe integer, as GitHub reads require. */
const isIssueNumber = (number: number): boolean => Number.isSafeInteger(number) && number > 0;
/** The issue numbers in a marker's list; `0` and numbers beyond the safe range are dropped. */
const numbersIn = (text: string): number[] =>
  (text.match(/\d+/gu) ?? []).map(Number).filter(isIssueNumber);
const sameRepository = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const lines = (text: string): string[] => text.split(/\r?\n/u);

/**
 * `repo`'s issue numbers referenced in `text`, in order; other repositories are skipped, and so are
 * `#0` and numbers beyond the safe range, which name no issue.
 */
function ownRefs(text: string, repo: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(new RegExp(REF, 'gu'))) {
    const qualifier = match[1];
    const number = Number(match[2]);
    if ((qualifier === undefined || sameRepository(qualifier, repo)) && isIssueNumber(number))
      found.push(number);
  }
  return found;
}

/**
 * For each line, whether it belongs to a fenced code block (fence lines included). A fence is three
 * or more backticks or tildes; it closes on a line of the same character at least as long, and an
 * unclosed fence runs to the end, as in CommonMark.
 */
function fenceMask(text: readonly string[]): boolean[] {
  let fence: string | null = null;
  return text.map((line) => {
    if (fence !== null) {
      const close = /^\s*(`{3,}|~{3,})\s*$/u.exec(line)?.[1];
      if (close?.startsWith(fence.charAt(0)) && close.length >= fence.length) fence = null;
      return true;
    }
    // The run is taken whole and the info string sliced off, so no regex splits the run.
    const open = /^\s*(`{3,}|~{3,})/u.exec(line);
    // A backtick fence's info string cannot contain a backtick (that line is inline code).
    if (
      open?.[1] !== undefined &&
      !(open[1].startsWith('`') && line.slice(open[0].length).includes('`'))
    ) {
      fence = open[1];
      return true;
    }
    return false;
  });
}

/**
 * `text` without inline code spans, in linear time. As in CommonMark, a span opens at a backtick
 * run and closes at the next run of exactly the same length; a run with no such closer stays as
 * literal text, and scanning resumes after it. Backslash escapes are not interpreted.
 */
function stripInlineCode(text: string): string {
  const starts: number[] = [];
  const lengths: number[] = [];
  for (let index = text.indexOf('`'); index !== -1;) {
    let end = index + 1;
    while (text.charAt(end) === '`') end += 1;
    starts.push(index);
    lengths.push(end - index);
    index = text.indexOf('`', end);
  }
  // closer[i]: the next run with the same length as run i, or -1.
  const closer = new Array<number>(starts.length).fill(-1);
  const nextOfLength = new Map<number, number>();
  for (let run = starts.length - 1; run >= 0; run -= 1) {
    const length = lengths[run] ?? 0;
    closer[run] = nextOfLength.get(length) ?? -1;
    nextOfLength.set(length, run);
  }
  const kept: string[] = [];
  let from = 0;
  let run = 0;
  while (run < starts.length) {
    const close = closer[run] ?? -1;
    if (close === -1) {
      run += 1;
      continue;
    }
    // Runs between the opener and its closer are inside the span.
    kept.push(text.slice(from, starts[run]));
    from = (starts[close] ?? 0) + (lengths[close] ?? 0);
    run = close + 1;
  }
  kept.push(text.slice(from));
  return kept.join('');
}

/**
 * `text` without fenced blocks and inline code spans, so quoted examples are never read. A span may
 * cross a line ending but not a blank line or a fence, which end its paragraph.
 */
function stripCode(text: string): string {
  const all = lines(text);
  const fenced = fenceMask(all);
  const kept: string[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length) kept.push(stripInlineCode(paragraph.join('\n')));
    paragraph = [];
  };
  all.forEach((line, index) => {
    if (fenced[index] === true) flush();
    else if (/^[ \t]*$/u.test(line)) {
      flush();
      kept.push(line);
    } else paragraph.push(line);
  });
  flush();
  return kept.join('\n');
}

/** One checklist line of an epic body that names an issue of the epic's repository. */
export interface GithubEpicChecklistLine {
  /** The first issue of the epic's repository the line names. */
  readonly number: number;
  /** `[x]` or `[X]`. */
  readonly checked: boolean;
  /** The line's text after the checkbox, without inline code, trimmed. */
  readonly title: string;
}

/**
 * The checklist lines of an epic body (`- [ ] #12 title`, with `-`, `*` or `+`) outside fenced code,
 * in body order. Inline code is removed before the line is read, each line counts for the first
 * reference to `repo` (bare `#N`, or `OWNER/REPO#N` compared case-insensitively), lines naming only
 * other repositories or no issue are skipped, `self` (the epic) is skipped, and the first line wins
 * for a number listed twice.
 */
export function parseEpicChecklist(
  body: string,
  repo: string,
  self: number | null = null,
): GithubEpicChecklistLine[] {
  const all = lines(body);
  const fenced = fenceMask(all);
  const found: GithubEpicChecklistLine[] = [];
  const seen = new Set<number>();
  all.forEach((line, index) => {
    if (fenced[index] === true) return;
    const match = CHECKLIST.exec(line);
    if (!match) return;
    const title = stripInlineCode(match[2] ?? '').trim();
    const number = ownRefs(title, repo)[0];
    if (number === undefined || number === self || seen.has(number)) return;
    seen.add(number);
    found.push({ number, checked: match[1] !== ' ', title });
  });
  return found;
}

/**
 * Dependencies declared across `texts` (an issue's body and comments, by any author): the phrases
 * "depends on", "blocked by" and "requires" followed by a list such as `#4, #5 and #6`, and the
 * marker `<!-- epic:depends-on 3,4 -->`. Code (fenced or inline) is ignored, only `repo`'s issues
 * count, and the result is unique, in order, and never `self`. A misread dependency only delays an
 * item, so every author counts.
 */
export function parseDependencies(texts: readonly string[], repo: string, self: number): number[] {
  const found: number[] = [];
  for (const raw of texts) {
    const text = stripCode(raw);
    for (const match of text.matchAll(DEP_PHRASE)) found.push(...ownRefs(match[1] ?? '', repo));
    for (const match of text.matchAll(DEP_MARKER)) found.push(...numbersIn(match[1] ?? ''));
  }
  return [...new Set(found)].filter((number) => number !== self);
}

/**
 * The slices of a split item: the numbers of the last `<!-- epic:split a,b -->` marker outside code
 * in a comment whose author is `viewer` (compared case-insensitively), unique and never `self`;
 * null when there is none or it names only `self`. A split closes an item once its slices close, so
 * only the viewer's markers count: anyone else quoting the syntax must not close an unfinished
 * issue.
 */
export function parseSplit(
  comments: readonly { readonly author: string | null; readonly body: string }[],
  viewer: string,
  self: number,
): number[] | null {
  let split: number[] | null = null;
  for (const comment of comments) {
    if (viewer === '' || comment.author === null || !sameRepository(comment.author, viewer))
      continue;
    for (const match of stripCode(comment.body).matchAll(SPLIT_MARKER))
      split = [...new Set(numbersIn(match[1] ?? ''))].filter((number) => number !== self);
  }
  return split?.length ? split : null;
}

// ---------------------------------------------------------------------------------------------
// Snapshot

/** Where a snapshot's items come from. */
export type GithubEpicSource = 'sub-issues' | 'task-list';

/** One checklist line of the epic body, as the snapshot records it. */
export interface GithubEpicChecklistEntry extends GithubEpicChecklistLine {
  /** Whether the line's issue is one of the snapshot's items (always true for `task-list`). */
  readonly isItem: boolean;
}

/** A blocked-by relation of an item. */
export interface GithubEpicBlocker {
  /** Issue number. */
  readonly number: number;
  /** The blocking issue's `OWNER/REPO`. */
  readonly repository: string;
  /** `OPEN` or `CLOSED`. */
  readonly state: string;
}

/** A pull request linked to an item: one whose merge would close it. */
export interface GithubEpicPullRequest {
  /** Pull request number. */
  readonly number: number;
  /** `OPEN`, `CLOSED` or `MERGED`. */
  readonly state: string;
  /** Whether the pull request is a draft. */
  readonly isDraft: boolean;
  /** Web URL. */
  readonly url: string;
  /** Head branch. */
  readonly headRefName: string;
}

/** One item of an epic. */
export interface GithubEpicItem {
  /** Issue number. */
  readonly number: number;
  /** Title; for a `task-list` item, the checklist line's text. */
  readonly title: string;
  /** `OPEN` or `CLOSED`; for a `task-list` item, `CLOSED` when checked. */
  readonly state: string;
  /** Why it closed, or null (always null for a `task-list` item). */
  readonly stateReason: string | null;
  /** Web URL, or null for a `task-list` item. */
  readonly url: string | null;
  /** The item's `OWNER/REPO`. */
  readonly repository: string;
  /** Label names. */
  readonly labels: readonly string[];
  /** Assignee logins; recorded, not used by the selector. */
  readonly assignees: readonly string[];
  /** Whether the epic's checklist line is checked, or null when no line names the item. */
  readonly checked: boolean | null;
  /** Dependencies declared in the body and comments; see {@link parseDependencies}. */
  readonly dependsOn: readonly number[];
  /** GitHub's blocked-by relations, with their states. */
  readonly blockedBy: readonly GithubEpicBlocker[];
  /** Linked pull requests in any state. */
  readonly pullRequests: readonly GithubEpicPullRequest[];
  /** The slices of a split item, or null; see {@link parseSplit}. */
  readonly split: readonly number[] | null;
}

/**
 * A compact, replay-stable view of an epic: no bodies or comments, only what the selector needs.
 * Read it with `gh.epic.snapshot` and pass it to {@link nextTicket}.
 */
export interface GithubEpicSnapshot {
  /** The client's `OWNER/REPO`. */
  readonly repository: string;
  /** The authenticated login; only its split markers count. */
  readonly viewer: string;
  /** The epic issue. */
  readonly epic: {
    /** Issue number. */
    readonly number: number;
    /** Title. */
    readonly title: string;
    /** `OPEN` or `CLOSED`. */
    readonly state: string;
    /** Web URL. */
    readonly url: string;
  };
  /** `sub-issues` when the epic has native sub-issues, else `task-list` (its body's checklist). */
  readonly source: GithubEpicSource;
  /** Items the epic has: `subIssuesSummary.total`, or the checklist length for `task-list`. */
  readonly total: number;
  /** The body's checklist lines that name an issue of the repository, in body order. */
  readonly checklist: readonly GithubEpicChecklistEntry[];
  /**
   * The items in listing order: sub-issues the checklist names in checklist order, then the other
   * sub-issues in GitHub's order; or the checklist entries for `task-list`.
   */
  readonly items: readonly GithubEpicItem[];
}

function mapSubIssue(
  node: RawEpicSubIssue,
  repo: string,
  viewer: string,
  checked: boolean | null,
): GithubEpicItem {
  const comments = node.comments.nodes;
  return {
    number: node.number,
    title: node.title,
    state: node.state,
    stateReason: node.stateReason,
    url: node.url,
    repository: node.repository.nameWithOwner,
    labels: node.labels.nodes.map((label) => label.name),
    assignees: node.assignees.nodes.map((assignee) => assignee.login),
    checked,
    dependsOn: parseDependencies(
      [node.body, ...comments.map((comment) => comment.body)],
      repo,
      node.number,
    ),
    blockedBy: node.blockedBy.nodes.map((blocker) => ({
      number: blocker.number,
      repository: blocker.repository.nameWithOwner,
      state: blocker.state,
    })),
    pullRequests: node.closedByPullRequestsReferences.nodes.map((pr) => ({
      number: pr.number,
      state: pr.state,
      isDraft: pr.isDraft,
      url: pr.url,
      headRefName: pr.headRefName,
    })),
    split: parseSplit(
      comments.map((comment) => ({ author: comment.author?.login ?? null, body: comment.body })),
      viewer,
      node.number,
    ),
  };
}

/** Map a validated response to the snapshot. @internal */
export function mapEpicSnapshot(
  repo: GithubRepo,
  raw: RawEpicSnapshotResponse,
): GithubEpicSnapshot {
  const viewer = raw.data.viewer.login;
  const epic = raw.data.repository.issue;
  const own = repo.nameWithOwner;
  const checklist = parseEpicChecklist(epic.body, own, epic.number);
  const nodes = epic.subIssues.nodes;
  const header = {
    repository: own,
    viewer,
    epic: { number: epic.number, title: epic.title, state: epic.state, url: epic.url },
  };
  if (epic.subIssuesSummary.total === 0 && nodes.length === 0)
    return {
      ...header,
      source: 'task-list',
      total: checklist.length,
      checklist: checklist.map((line) => ({ ...line, isItem: true })),
      items: checklist.map((line) => ({
        number: line.number,
        title: line.title,
        state: line.checked ? 'CLOSED' : 'OPEN',
        stateReason: null,
        url: null,
        repository: own,
        labels: [],
        assignees: [],
        checked: line.checked,
        dependsOn: [],
        blockedBy: [],
        pullRequests: [],
        split: null,
      })),
    };
  const isOwnNode = (node: RawEpicSubIssue): boolean =>
    sameRepository(node.repository.nameWithOwner, own);
  const byNumber = new Map(nodes.filter(isOwnNode).map((node) => [node.number, node]));
  const listed = checklist.flatMap((line) => {
    const node = byNumber.get(line.number);
    return node ? [{ node, checked: line.checked }] : [];
  });
  const inChecklist = new Set(listed.map(({ node }) => node));
  const ordered = [
    ...listed,
    ...nodes.filter((node) => !inChecklist.has(node)).map((node) => ({ node, checked: null })),
  ];
  return {
    ...header,
    source: 'sub-issues',
    total: epic.subIssuesSummary.total,
    checklist: checklist.map((line) => ({ ...line, isItem: byNumber.has(line.number) })),
    items: ordered.map(({ node, checked }) => mapSubIssue(node, own, viewer, checked)),
  };
}

/**
 * The `epic.snapshot` read: one `gh api graphql` with the epic number as `-F number=N`, no
 * pagination, and an 8 MiB default output cap. @internal
 */
export function epicSnapshotRead(
  repo: GithubRepo,
  number: unknown,
): GithubReadSpec<RawEpicSnapshotResponse, GithubEpicSnapshot> {
  return {
    op: 'epic.snapshot',
    argv: graphqlArgv(
      repo,
      EPIC_SNAPSHOT_QUERY,
      false,
      {},
      { number: positiveInteger(number, 'epic.snapshot number') },
    ),
    schema: epicSnapshotResponseSchema,
    maxOutputBytes: EPIC_SNAPSHOT_MAX_OUTPUT_BYTES,
    map: (raw) => mapEpicSnapshot(repo, raw),
  };
}

// ---------------------------------------------------------------------------------------------
// Selector

/**
 * An item's status, in precedence order for an open item: `in-flight` (a linked pull request is
 * open, drafts included), `close-split` (split, and every slice is closed), `split` (a slice is
 * open), `held` (a hold label), `waiting` (an open or unknown dependency), `ready`. A closed item
 * is `done`.
 */
export type GithubEpicItemStatus =
  'done' | 'in-flight' | 'close-split' | 'split' | 'held' | 'waiting' | 'ready';

/**
 * Why `nextTicket` did not pick an open item: its status (`in-flight`, `close-split` and `ready`
 * when it ranks after the pick), `other-repository` for a sub-issue of another repository (the
 * client reads one repository, so it is never picked), or `not-a-sub-issue` for an unchecked
 * checklist line naming an issue that is not a sub-issue.
 */
export type NextTicketSkipReason =
  | 'in-flight'
  | 'close-split'
  | 'split'
  | 'held'
  | 'waiting'
  | 'ready'
  | 'other-repository'
  | 'not-a-sub-issue';

/** The state of an issue outside the snapshot, such as a `gh.issue.view` result. */
export interface NextTicketOutsideIssue {
  /** Issue number in the snapshot's repository. */
  readonly number: number;
  /** `OPEN` or `CLOSED`; only `CLOSED` resolves a dependency or slice. */
  readonly state: string;
}

/** Options of {@link nextTicket}. */
export interface NextTicketPolicy {
  /** `listing` (default): the snapshot's item order. `number`: ascending issue number. */
  readonly order?: 'listing' | 'number';
  /** Labels that hold an item back, compared case-insensitively; default `blocked`, `needs-decision`, `on-hold`. */
  readonly holdLabels?: readonly string[];
  /**
   * States of dependencies and slices outside the snapshot, such as `gh.issue.view` results for
   * the numbers {@link outsideReferences} returns. A reference neither the snapshot nor this list
   * knows counts as open.
   */
  readonly outside?: readonly NextTicketOutsideIssue[];
}

/** The item `nextTicket` picked. */
export interface NextTicketPick {
  /** Issue number. */
  readonly number: number;
  /** Title. */
  readonly title: string;
  /** Web URL, or null for a `task-list` item. */
  readonly url: string | null;
  /** `in-flight`, `close-split` or `ready`. */
  readonly status: 'in-flight' | 'close-split' | 'ready';
  /** Numbers of its open linked pull requests (for `in-flight`). */
  readonly pullRequests: readonly number[];
  /** Its open slices: always empty, since a split item with open slices is never picked. */
  readonly openSlices: readonly number[];
}

/** An open item `nextTicket` did not pick, and why. */
export interface NextTicketSkip {
  /** Issue number. */
  readonly number: number;
  /** Title, or the checklist line's text for `not-a-sub-issue`. */
  readonly title: string;
  /** Why it was not picked. */
  readonly reason: NextTicketSkipReason;
  /** Its open or unknown dependencies, for `waiting`. */
  readonly waitingOn?: readonly number[];
  /** Its open or unknown slices, for `split`. */
  readonly openSlices?: readonly number[];
  /** Its open linked pull requests, for `in-flight`. */
  readonly pullRequests?: readonly number[];
}

/** What {@link nextTicket} decided. */
export interface NextTicketResult {
  /** The next item to work on, or null. */
  readonly pick: NextTicketPick | null;
  /** Every other open item, in the chosen order, then unchecked checklist lines that are not items. */
  readonly skipped: readonly NextTicketSkip[];
  /** True when there is no pick and nothing is skipped: every item is closed. */
  readonly done: boolean;
}

const DEFAULT_HOLD_LABELS = ['blocked', 'needs-decision', 'on-hold'] as const;
const isClosedState = (state: string): boolean => state.toUpperCase() === 'CLOSED';

interface Assessed {
  readonly item: GithubEpicItem;
  readonly status: Exclude<GithubEpicItemStatus, 'done'> | 'other-repository';
  readonly waitingOn: readonly number[];
  readonly openSlices: readonly number[];
  readonly pullRequests: readonly number[];
}

function validPolicy(policy: NextTicketPolicy): {
  readonly order: 'listing' | 'number';
  readonly hold: ReadonlySet<string>;
  readonly outside: readonly NextTicketOutsideIssue[];
} {
  const order: unknown = policy.order ?? 'listing';
  if (order !== 'listing' && order !== 'number')
    throw new Error('nextTicket order must be listing or number.');
  const holdLabels: unknown = policy.holdLabels ?? DEFAULT_HOLD_LABELS;
  if (!Array.isArray(holdLabels) || !holdLabels.every((label) => typeof label === 'string'))
    throw new Error('nextTicket holdLabels must be an array of strings.');
  const outside: unknown = policy.outside ?? [];
  if (
    !Array.isArray(outside) ||
    !outside.every(
      (issue: unknown) =>
        typeof issue === 'object' &&
        issue !== null &&
        typeof Reflect.get(issue, 'number') === 'number' &&
        typeof Reflect.get(issue, 'state') === 'string',
    )
  )
    throw new Error('nextTicket outside must be an array of { number, state }.');
  return {
    order,
    hold: new Set(holdLabels.map((label: string) => label.toLowerCase())),
    outside: outside as NextTicketOutsideIssue[],
  };
}

/** The snapshot's own-repository items by number. */
function ownItems(snapshot: GithubEpicSnapshot): Map<number, GithubEpicItem> {
  return new Map(
    snapshot.items
      .filter((item) => sameRepository(item.repository, snapshot.repository))
      .map((item) => [item.number, item]),
  );
}

/**
 * Pick the next item of an epic, pure and explainable. Each open item gets a status (see
 * {@link GithubEpicItemStatus}); the pick is the first `in-flight` item in order, else the first
 * `close-split`, else the first `ready`, so work under way finishes before new work starts. Every
 * other open item is listed in `skipped` with its reason. Dependencies and slices resolve from the
 * snapshot's items, then from `policy.outside`; an unknown one counts as open. Assignees are
 * ignored. Throws when the snapshot holds fewer items than its `total`, rather than reporting an
 * incomplete epic as done.
 */
export function nextTicket(
  snapshot: GithubEpicSnapshot,
  policy: NextTicketPolicy = {},
): NextTicketResult {
  if (snapshot.items.length < snapshot.total)
    throw new Error(
      `The epic snapshot of #${String(snapshot.epic.number)} holds ${String(snapshot.items.length)} items but counts ${String(snapshot.total)}; it is incomplete, so no ticket is picked.`,
    );
  const { order, hold, outside } = validPolicy(policy);
  const own = ownItems(snapshot);
  const outsideStates = new Map(outside.map((issue) => [issue.number, issue.state]));
  const isOpen = (number: number): boolean => {
    const state = own.get(number)?.state ?? outsideStates.get(number);
    return state === undefined || !isClosedState(state);
  };
  const items =
    order === 'number'
      ? [...snapshot.items].sort((a, b) => a.number - b.number)
      : [...snapshot.items];
  const assessed: Assessed[] = items
    .filter((item) => item.state === 'OPEN')
    .map((item) => {
      const pullRequests = item.pullRequests
        .filter((pr) => pr.state === 'OPEN')
        .map((pr) => pr.number);
      const openSlices = (item.split ?? []).filter(isOpen);
      const waitingOn = [
        ...new Set([
          ...item.dependsOn.filter(isOpen),
          ...item.blockedBy
            .filter((blocker) => !isClosedState(blocker.state))
            .map((blocker) => blocker.number),
        ]),
      ];
      const status: Assessed['status'] = !sameRepository(item.repository, snapshot.repository)
        ? 'other-repository'
        : pullRequests.length
          ? 'in-flight'
          : item.split?.length
            ? openSlices.length
              ? 'split'
              : 'close-split'
            : item.labels.some((label) => hold.has(label.toLowerCase()))
              ? 'held'
              : waitingOn.length
                ? 'waiting'
                : 'ready';
      return { item, status, waitingOn, openSlices, pullRequests };
    });
  const chosen =
    assessed.find((entry) => entry.status === 'in-flight') ??
    assessed.find((entry) => entry.status === 'close-split') ??
    assessed.find((entry) => entry.status === 'ready');
  const skipped: NextTicketSkip[] = assessed
    .filter((entry) => entry !== chosen)
    .map(({ item, status, waitingOn, openSlices, pullRequests }) => ({
      number: item.number,
      title: item.title,
      reason: status,
      ...(status === 'waiting' ? { waitingOn } : {}),
      ...(status === 'split' ? { openSlices } : {}),
      ...(status === 'in-flight' ? { pullRequests } : {}),
    }));
  if (snapshot.source === 'sub-issues')
    for (const line of snapshot.checklist)
      if (!line.isItem && !line.checked)
        skipped.push({ number: line.number, title: line.title, reason: 'not-a-sub-issue' });
  const pick: NextTicketPick | null =
    chosen === undefined
      ? null
      : {
          number: chosen.item.number,
          title: chosen.item.title,
          url: chosen.item.url,
          status: chosen.status as NextTicketPick['status'],
          pullRequests: chosen.pullRequests,
          openSlices: chosen.openSlices,
        };
  return { pick, skipped, done: pick === null && skipped.length === 0 };
}

/**
 * The dependencies and slices of the snapshot's open items that are not themselves items, sorted
 * and unique: read their states (for example with `gh.issue.view`) and pass them to
 * {@link nextTicket} as `policy.outside`, so the snapshot stays one command and the selector pure.
 * Sub-issues of other repositories are never picked, so their references are left out.
 */
export function outsideReferences(snapshot: GithubEpicSnapshot): number[] {
  const own = ownItems(snapshot);
  const found = new Set<number>();
  for (const item of snapshot.items) {
    if (item.state !== 'OPEN' || !sameRepository(item.repository, snapshot.repository)) continue;
    for (const number of [...item.dependsOn, ...(item.split ?? [])])
      if (!own.has(number)) found.add(number);
  }
  return [...found].sort((a, b) => a - b);
}
