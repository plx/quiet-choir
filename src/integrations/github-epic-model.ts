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

const isBlank = (char: string): boolean => char === ' ' || char === '\t';
const isDigit = (char: string): boolean => char >= '0' && char <= '9';

/**
 * The block-quote markers that open `line`: how many (`depth`, at most `limit`) and where the rest
 * of the line starts (`end`, after the last marker and one optional space). Whitespace before each
 * marker is skipped. A character loop, so no input can make it backtrack.
 */
function quotePrefix(
  line: string,
  limit = Number.POSITIVE_INFINITY,
): { depth: number; end: number } {
  let depth = 0;
  let end = 0;
  let index = 0;
  while (depth < limit) {
    while (isBlank(line.charAt(index))) index += 1;
    if (line.charAt(index) !== '>') break;
    depth += 1;
    index += 1;
    if (isBlank(line.charAt(index))) index += 1;
    end = index;
  }
  return { depth, end };
}

/**
 * Where the list marker at `index` of `line` ends, after the space or tab that must follow it, or
 * -1 when there is none: a bullet (`-`, `*` or `+`) or an ordered marker (one to nine digits and
 * `.` or `)`).
 */
function listMarkerEnd(line: string, index: number): number {
  const char = line.charAt(index);
  let end = index;
  if (char === '-' || char === '*' || char === '+') end += 1;
  else {
    while (end - index < 10 && isDigit(line.charAt(end))) end += 1;
    const digits = end - index;
    if (digits === 0 || digits > 9 || (line.charAt(end) !== '.' && line.charAt(end) !== ')'))
      return -1;
    end += 1;
  }
  return isBlank(line.charAt(end)) ? end + 1 : -1;
}

/**
 * The width of the blanks that open `text`, in columns: a tab advances to the next multiple of
 * four.
 */
function indentation(text: string): number {
  let column = 0;
  for (let index = 0; isBlank(text.charAt(index)); index += 1)
    column = text.charAt(index) === '\t' ? column + 4 - (column % 4) : column + 1;
  return column;
}

/** The width of `text` in columns, as {@link indentation} counts them. */
function width(text: string): number {
  let column = 0;
  for (const char of text) column = char === '\t' ? column + 4 - (column % 4) : column + 1;
  return column;
}

/**
 * The Markdown container markers that open `line`, block quotes (`>`) and list items (`-`, `1.`)
 * in any nesting: the number of block quotes among them, where the rest of the line starts, and,
 * when list markers follow the last block quote, the column where the innermost item's content
 * starts, counted from the end of that quote's markers as {@link quotePrefix} reads them (0 when
 * no list marker follows it). As in CommonMark, the content column includes up to three more
 * spaces after a marker's own.
 */
function containerPrefix(line: string): { depth: number; end: number; item: number } {
  let depth = 0;
  let end = 0;
  // Where the last block quote's markers end, and whether a list marker follows them.
  let quoteEnd = 0;
  let inItem = false;
  for (;;) {
    let index = end;
    while (isBlank(line.charAt(index))) index += 1;
    if (line.charAt(index) === '>') {
      depth += 1;
      end = index + 1;
      quoteEnd = isBlank(line.charAt(end)) ? end + 1 : end;
      inItem = false;
      continue;
    }
    const marker = listMarkerEnd(line, index);
    if (marker === -1) {
      if (!inItem) return { depth, end, item: 0 };
      const extra = indentation(line.slice(end));
      return { depth, end, item: end - quoteEnd + (extra <= 3 ? extra : 0) };
    }
    end = marker;
    inItem = true;
  }
}

/**
 * For each line, whether it belongs to a fenced code block (fence lines included). A fence is three
 * or more backticks or tildes; it closes on a line of the same character at least as long, and an
 * unclosed fence runs to the end of its container, as in CommonMark. A fence may open inside block
 * quotes and list items (`> ~~~`, `- ~~~`, `> 1. ~~~`): the container markers are read first. It
 * ends with the block quotes it opened in: a later line with fewer `>` markers is outside it, and
 * its own markers are read before its closer. A fence that opens after a list marker also ends with
 * that item: a later non-blank line indented less than the item's content column is outside it
 * (fenced code has no lazy continuation), and blank lines stay inside. A fence that opens on a
 * later line of an item, with no marker of its own, runs until its closer or its block quote ends.
 *
 * A closer may be indented at most three columns past its container's content column, as in
 * CommonMark: past the list item's content column when the fence opened after a list marker, and
 * otherwise past the block quote's markers, or as far as the opening run when that is deeper (a fence
 * on a later line of an item, whose content column is unknown, may be indented that far). A more
 * deeply indented fence line is code inside the fence, so the fence never closes before CommonMark's
 * would. The opener accepts any indentation: telling a fence on an item's later line from indented
 * code needs full list tracking, and a wrong guess there only hides text from the parsers
 * ({@link parseSplit} already ignores markers indented four or more columns).
 */
function fenceMask(text: readonly string[]): boolean[] {
  // The open fence's run, its block-quote depth, its list item's content column (0 for none), and
  // the opening run's column after the block-quote markers.
  let fence: { run: string; depth: number; item: number; column: number } | null = null;
  return text.map((line) => {
    if (fence !== null) {
      const quote = quotePrefix(line, fence.depth);
      const rest = line.slice(quote.end);
      const itemEnded = fence.item > 0 && !/^[ \t]*$/u.test(rest) && indentation(rest) < fence.item;
      if (quote.depth === fence.depth && !itemEnded) {
        const close =
          indentation(rest) <= Math.max(fence.item + 3, fence.column)
            ? /^[ \t]*(`{3,}|~{3,})\s*$/u.exec(rest)?.[1]
            : undefined;
        if (close?.startsWith(fence.run.charAt(0)) && close.length >= fence.run.length)
          fence = null;
        return true;
      }
      // The block quote or list item that held the fence ended, and the fence with it.
      fence = null;
    }
    const prefix = containerPrefix(line);
    const rest = line.slice(prefix.end);
    // The run is taken whole and the info string sliced off, so no regex splits the run.
    const open = /^\s*(`{3,}|~{3,})/u.exec(rest);
    // A backtick fence's info string cannot contain a backtick (that line is inline code).
    if (
      open?.[1] !== undefined &&
      !(open[1].startsWith('`') && rest.slice(open[0].length).includes('`'))
    ) {
      const runStart = prefix.end + open[0].length - open[1].length;
      const column = width(line.slice(quotePrefix(line, prefix.depth).end, runStart));
      fence = { run: open[1], depth: prefix.depth, item: prefix.item, column };
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
 * How `rest`, a line after its block-quote markers, starts a block that ends a paragraph, as in
 * CommonMark: `line` for a one-line block (an ATX heading or a thematic break), `item` for a list
 * item with content, or null for paragraph text. Up to three spaces of indentation are allowed. An
 * ordered item ends a paragraph only when it is numbered 1, unless the paragraph is itself in a
 * list item (`inItem`), whose next sibling may have any number. A character loop, so no input can
 * make it backtrack.
 */
function blockStart(rest: string, inItem: boolean): 'line' | 'item' | null {
  let index = 0;
  while (index < 3 && rest.charAt(index) === ' ') index += 1;
  const char = rest.charAt(index);
  if (char === '#') {
    let end = index;
    while (end - index < 7 && rest.charAt(end) === '#') end += 1;
    return end - index <= 6 && (end === rest.length || isBlank(rest.charAt(end))) ? 'line' : null;
  }
  if (char === '-' || char === '*' || char === '_') {
    let count = 0;
    let end = index;
    for (; end < rest.length; end += 1) {
      if (rest.charAt(end) === char) count += 1;
      else if (!isBlank(rest.charAt(end))) break;
    }
    if (end === rest.length && count >= 3) return 'line';
  }
  const marker = listMarkerEnd(rest, index);
  if (marker === -1 || /^[ \t]*$/u.test(rest.slice(marker))) return null;
  // The marker's digits end before its `.` or `)` and the space after it.
  if (inItem || !isDigit(char) || Number(rest.slice(index, marker - 2)) === 1) return 'item';
  return null;
}

/**
 * Whether `rest`, a line after its block-quote markers, is a setext heading's `=` underline: up to
 * three spaces of indentation, one or more `=`, then only spaces or tabs. A character loop, so no
 * input can make it backtrack.
 */
function isSetextUnderline(rest: string): boolean {
  let index = 0;
  while (index < 3 && rest.charAt(index) === ' ') index += 1;
  const start = index;
  while (rest.charAt(index) === '=') index += 1;
  if (index === start) return false;
  while (isBlank(rest.charAt(index))) index += 1;
  return index === rest.length;
}

/**
 * `text` without fenced blocks and inline code spans, so quoted examples are never read. A span may
 * cross a line ending within a paragraph, including a lazy continuation line of a block quote, but
 * never a block boundary: a blank line, a fence, a deeper block quote, a list item, an ATX heading
 * or a thematic break ends the paragraph, and a heading or break is a block of one line. A `=`
 * underline at the paragraph's block-quote depth makes it a setext heading and ends it there; a
 * `-` underline is a thematic break, which ends the paragraph just the same. With no paragraph
 * open, a `=` line is paragraph text.
 */
function stripCode(text: string): string {
  const all = lines(text);
  const fenced = fenceMask(all);
  const kept: string[] = [];
  let paragraph: string[] = [];
  // The paragraph's block-quote depth, and whether it opens a list item.
  let depth = 0;
  let inItem = false;
  const flush = (): void => {
    if (paragraph.length) kept.push(stripInlineCode(paragraph.join('\n')));
    paragraph = [];
  };
  all.forEach((line, index) => {
    if (fenced[index] === true) {
      flush();
      return;
    }
    const quote = quotePrefix(line);
    const rest = line.slice(quote.end);
    if (/^[ \t]*$/u.test(rest)) {
      flush();
      kept.push(line);
      return;
    }
    if (paragraph.length && quote.depth === depth && isSetextUnderline(rest)) {
      paragraph.push(line);
      flush();
      return;
    }
    const block = blockStart(rest, inItem);
    if (block === 'line') {
      flush();
      kept.push(stripInlineCode(line));
      return;
    }
    if (block === 'item' || quote.depth > depth) flush();
    if (!paragraph.length) {
      depth = quote.depth;
      inItem = blockStart(rest, true) === 'item';
    }
    paragraph.push(line);
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
 * item, so every author counts, and indented code is read: telling an indented code block from an
 * indented continuation of a list item needs full list tracking, and a wrong guess there would hide
 * a real blocker.
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
 * issue. For the same reason a marker on a line indented four or more columns after its block-quote
 * markers (a tab counts to the next multiple of four) is ignored, as indented code would be: the
 * workflow writes its markers at column 0, and a missed split only leaves the parent open.
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
    const text = stripCode(comment.body);
    for (const match of text.matchAll(SPLIT_MARKER)) {
      const start = text.lastIndexOf('\n', match.index - 1) + 1;
      const line = text.slice(start, match.index);
      if (indentation(line.slice(quotePrefix(line).end)) >= 4) continue;
      split = [...new Set(numbersIn(match[1] ?? ''))].filter((number) => number !== self);
    }
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
