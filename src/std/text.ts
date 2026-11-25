/**
 * Stable prompt and text formatting. Prompt text is part of an agent call's identity, so these
 * helpers are deterministic in their arguments: the same parts always render the same text, and a
 * completed call replays. {@link brief} gives every default std prompt one layout (task, then
 * `## Context`, `## Guidance` and `## Output` sections); the rest are small building blocks for
 * Markdown lists and fences, byte- and character-safe clipping, and cleaning command output.
 *
 * The report renderers {@link findings}, {@link checklist}, {@link gate}, {@link plan} and
 * {@link commits} turn std data and pattern results into Markdown for a pull request comment, a
 * log or the context of a later prompt. They are pure, and once their text is used in a prompt it
 * is part of that call's identity like any other prompt text, so their layout is fixed once
 * released.
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * const prompt = std.text.brief({
 *   task: 'Review the change for correctness bugs.',
 *   context: { files: ['src/a.ts'], base: 'main' },
 *   guidance: ['Report only defects you can demonstrate.', 'An empty list is a valid answer.'],
 *   output: 'The findings, most severe first.',
 * });
 * const { findings } = await ctx.roster.Reviewer.value('review', {
 *   prompt,
 *   schema: std.types.Findings,
 * });
 * ctx.log(std.text.findings(std.data.bySeverity(findings)));
 * ```
 *
 * @module
 */
import type { Prompt } from '../index.js';
import { json } from './exec.js';
import type {
  Assessment,
  Commit,
  Criterion,
  CriterionResult,
  Finding,
  Plan,
  Remediation,
} from './types.js';

/** The default marker {@link clip} appends to clipped text. */
const CLIP_MARKER = '\n… (clipped)';

/** Throw a `TypeError` unless `value` is a safe integer of at least `min`. */
function integer(name: string, value: number, min: number): number {
  if (!Number.isSafeInteger(value) || value < min) {
    const kind = min === 0 ? 'a nonnegative integer' : `an integer of at least ${String(min)}`;
    throw new TypeError(`${name} must be ${kind}; got ${String(value)}.`);
  }
  return value;
}

/** The parts of a {@link brief}; only `task` is required. */
export interface BriefParts {
  /** What to do, as the opening paragraph; it must contain non-whitespace text. */
  readonly task: string;
  /**
   * Material the task works on, under `## Context`: a string, inserted as written, or a JSON
   * value, shown as a fenced `json` block of its two-space indented form (`std.exec.json`). The
   * JSON value may be any plain data, such as a read-only array or a pattern result typed by an
   * interface; it is checked when the brief is rendered, and an `undefined` object member is
   * omitted, as `JSON.stringify` omits it.
   */
  readonly context?: unknown;
  /** Rules and hints, rendered as a bulleted list under `## Guidance`; omitted when empty. */
  readonly guidance?: readonly string[] | undefined;
  /** What to return, under `## Output`. */
  readonly output?: string | undefined;
}

/**
 * Throw a `TypeError` unless `value` is plain JSON, the data `JSON.stringify` renders without
 * changing its meaning: `null`, a string, a boolean, a finite number, an array without holes or
 * `undefined` elements, or a plain object (whose `undefined` members are omitted), with no cycle.
 */
function checkJson(value: unknown): void {
  const ancestors = new Set<object>();
  const fail = (path: string, reason: string): never => {
    throw new TypeError(`A brief's context is not JSON at ${path}: ${reason}.`);
  };
  const visit = (item: unknown, path: string): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail(path, `${String(item)} is not a finite number`);
      return;
    }
    if (typeof item !== 'object') return fail(path, `a ${typeof item} is not a JSON value`);
    if (ancestors.has(item)) fail(path, 'the value contains a cycle');
    ancestors.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        const at = `${path}[${String(index)}]`;
        if (!Object.hasOwn(item, index)) fail(at, 'an array cannot have holes');
        const element: unknown = item[index];
        if (element === undefined) fail(at, 'an array cannot contain undefined');
        visit(element, at);
      }
    } else {
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null)
        fail(path, 'only plain objects are JSON, not class instances');
      for (const [key, member] of Object.entries(item as Readonly<Record<string, unknown>>))
        if (member !== undefined) visit(member, `${path}.${key}`);
    }
    ancestors.delete(item);
  };
  visit(value, '$');
}

/**
 * Render a prompt in the std layout:
 *
 * ```text
 * <task>
 *
 * ## Context
 *
 * <context>
 *
 * ## Guidance
 *
 * - <guidance>
 *
 * ## Output
 *
 * <output>
 * ```
 *
 * Absent sections (and an empty guidance list) are omitted; nothing else is added or trimmed.
 *
 * @param parts - The task and optional context, guidance and output description.
 * @returns The prompt text.
 * @throws TypeError - When `task` is blank, or `context` is neither a string nor a JSON value: it
 * holds a number that is not finite, a function, a symbol, a BigInt, a class instance such as a
 * `Date` or a `Map`, an array hole or `undefined` element, or a cycle. The message names the path,
 * as in `A brief's context is not JSON at $.files[1]: ...`.
 */
export function brief(parts: BriefParts): string {
  if (parts.task.trim() === '') throw new TypeError('A brief needs a nonblank task.');
  const sections = [parts.task];
  const { context, guidance, output } = parts;
  if (context !== undefined) {
    if (typeof context !== 'string') checkJson(context);
    sections.push(
      section('Context', typeof context === 'string' ? context : fence(json(context), 'json')),
    );
  }
  if (guidance !== undefined && guidance.length > 0)
    sections.push(section('Guidance', bullets(guidance)));
  if (output !== undefined) sections.push(section('Output', output));
  return sections.join('\n\n');
}

/**
 * A level-two Markdown section: `## <title>`, a blank line, then `body`.
 *
 * @param title - The heading text, on one line.
 * @param body - The section body, as written.
 * @returns The section text.
 * @throws TypeError - When `title` contains a line break.
 */
export function section(title: string, body: string): string {
  if (/[\r\n]/u.test(title)) throw new TypeError('A section title must be one line.');
  return `## ${title}\n\n${body}`;
}

/** Prefix the first line of `text` with `marker` and indent later nonblank lines to match it. */
function listItem(marker: string, text: string): string {
  const pad = ' '.repeat(marker.length);
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? marker + line : line === '' ? line : pad + line))
    .join('\n');
}

/**
 * A Markdown bulleted list, one `- ` item per entry. Later lines of a multi-line entry are indented
 * two spaces so they stay inside the item.
 *
 * @param items - The entries.
 * @param empty - The text for an empty list; defaults to `(none)`.
 * @returns The list text.
 */
export function bullets(items: readonly string[], empty = '(none)'): string {
  if (items.length === 0) return empty;
  return items.map((item) => listItem('- ', item)).join('\n');
}

/**
 * A Markdown numbered list (`1. `, `2. `, ...). Later lines of a multi-line entry are indented to
 * the width of their marker.
 *
 * @param items - The entries.
 * @param empty - The text for an empty list; defaults to `(none)`.
 * @returns The list text.
 */
export function numbered(items: readonly string[], empty = '(none)'): string {
  if (items.length === 0) return empty;
  return items.map((item, index) => listItem(`${String(index + 1)}. `, item)).join('\n');
}

/**
 * A fenced code block around `body`. The fence is one backtick longer than the longest backtick run
 * in `body` (at least three), so embedded fences cannot close it early.
 *
 * @param body - The block content, as written.
 * @param lang - The info string, such as `json` or `diff`; defaults to none.
 * @returns The fenced block.
 * @throws TypeError - When `lang` contains a backtick or a line break.
 */
export function fence(body: string, lang = ''): string {
  if (/[`\r\n]/u.test(lang)) throw new TypeError('A fence language cannot contain ` or a newline.');
  let longest = 0;
  for (const run of body.match(/`+/gu) ?? []) longest = Math.max(longest, run.length);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

/**
 * The text an agent receives for `prompt`: the string itself, or a rendered {@link Prompt}'s
 * `text`. Use it to put a prompt into plain JSON, such as a settled map's items.
 *
 * @param prompt - A prompt string or a `definePrompts` rendering.
 * @returns The prompt text.
 */
export function promptText(prompt: string | Prompt): string {
  return typeof prompt === 'string' ? prompt : prompt.text;
}

/** The UTF-8 length of the code point at the start of `char` (a lone surrogate encodes as U+FFFD). */
function utf8Length(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

/**
 * Keep the head of `text` within `maxBytes` UTF-8 bytes. Text that fits is returned unchanged;
 * otherwise the longest prefix of whole code points that fits together with `marker` is returned,
 * followed by `marker`. The cut never splits a character, so the result is valid text.
 *
 * @param text - The text to clip.
 * @param maxBytes - The largest UTF-8 byte length of the result.
 * @param marker - Appended to clipped text; defaults to a line `… (clipped)`.
 * @returns `text`, or a clipped prefix plus `marker`.
 * @throws TypeError - When `maxBytes` is not a nonnegative integer, or text must be clipped and
 * `marker` alone exceeds `maxBytes`.
 */
export function clip(text: string, maxBytes: number, marker: string = CLIP_MARKER): string {
  integer('maxBytes', maxBytes, 0);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (markerBytes > maxBytes) {
    throw new TypeError(
      `The clip marker needs ${String(markerBytes)} bytes, more than maxBytes (${String(maxBytes)}).`,
    );
  }
  const budget = maxBytes - markerBytes;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = utf8Length(char);
    if (bytes + size > budget) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end) + marker;
}

/**
 * The last `maxChars` UTF-16 code units of `text`, one fewer when the cut would split a surrogate
 * pair, so the result never starts with half a character.
 *
 * @param text - The text, such as command output.
 * @param maxChars - The most code units to keep.
 * @returns `text` when it fits, else its tail.
 * @throws TypeError - When `maxChars` is not a nonnegative integer.
 */
export function tail(text: string, maxChars: number): string {
  integer('maxChars', maxChars, 0);
  if (text.length <= maxChars) return text;
  let start = text.length - maxChars;
  const low = text.charCodeAt(start);
  const high = text.charCodeAt(start - 1);
  if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) start += 1;
  return text.slice(start);
}

/**
 * ANSI escape sequences: OSC strings (terminated by BEL or ST), CSI sequences (7-bit `ESC [` or
 * 8-bit `0x9B`), and the remaining two-or-more-byte `ESC` sequences.
 */
const ANSI =
  // eslint-disable-next-line no-control-regex -- ANSI escape sequences are control characters.
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]/gu;

/**
 * Remove ANSI escape sequences (colors, cursor movement, hyperlinks) from terminal output.
 *
 * @param text - Terminal output.
 * @returns The text without escape sequences.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * A lowercase, hyphen-separated ASCII slug, for branch names, file names and labels (use `ctx.id`
 * for step IDs). Accents are removed, every run of other characters becomes one hyphen, and the
 * result is cut to `max` characters without a leading or trailing hyphen.
 *
 * @param text - The text to slug.
 * @param max - The longest slug; defaults to 50.
 * @returns The slug; empty when `text` has no ASCII letters or digits after removing accents.
 * @throws TypeError - When `max` is not a positive integer.
 */
export function slug(text: string, max = 50): string {
  integer('max', max, 1);
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+/u, '')
    .slice(0, max)
    .replace(/-+$/u, '');
}

/**
 * The first sentence of `text`: its first paragraph with whitespace runs collapsed, up to and
 * including the first `.`, `!` or `?` that is followed by whitespace or ends the paragraph. A
 * paragraph without such a terminator is returned whole.
 *
 * @param text - Prose, such as a description or a commit message.
 * @returns The first sentence; empty for blank text.
 */
export function firstSentence(text: string): string {
  const paragraph = (text.trim().split(/\n[ \t]*\r?\n/u)[0] ?? '').replace(/\s+/gu, ' ').trim();
  return /^.*?[.!?](?=\s|$)/u.exec(paragraph)?.[0] ?? paragraph;
}

// ---------------------------------------------------------------------------------------------
// Report renderers
// ---------------------------------------------------------------------------------------------

/** An inline Markdown code span around `text`, delimited by more backticks than any run inside. */
function code(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/gu) ?? []) longest = Math.max(longest, run.length);
  const ticks = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/**
 * Findings as a Markdown numbered list, in the order given (sort them with `std.data.bySeverity`
 * first): each item is the severity in bold, the title and the location as code, then bullets for
 * the evidence, the failure scenario and, for a `std.types.Remediation`, the fix.
 *
 * ```markdown
 * 1. **high**: Off-by-one in the pager (`src/pager.ts:12`)
 *    - Evidence: src/pager.ts:12 compares with <=.
 *    - Failure scenario: A page size of 10 returns 11 items.
 *    - Fix: Compare with < in src/pager.ts:12.
 * ```
 *
 * @param list - Findings or remediations, such as the `findings` of a `std.types.Findings` reply.
 * @returns The Markdown list; `No findings.` for an empty list.
 */
export function findings(list: readonly (Finding | Remediation)[]): string {
  if (list.length === 0) return 'No findings.';
  return numbered(
    list.map((item) => {
      const where = item.line === null ? item.file : `${item.file}:${String(item.line)}`;
      const details = [`Evidence: ${item.evidence}`, `Failure scenario: ${item.failureScenario}`];
      if ('fix' in item) details.push(`Fix: ${item.fix}`);
      return `**${item.severity}**: ${item.title} (${code(where)})\n${bullets(details)}`;
    }),
  );
}

/** One criterion of a {@link ChecklistReport}, as a `std.patterns.ChecklistEntry` holds it. */
export interface ChecklistReportEntry {
  /** The criterion, with its ID. */
  readonly criterion: Criterion;
  /** The checker's status and evidence, or null when its call failed. */
  readonly result: CriterionResult | null;
}

/** What {@link checklist} renders: the parts of a `std.patterns.ChecklistResult` it shows. */
export interface ChecklistReport {
  /** The verdict, such as `done`, `not-done` or `unverified`. */
  readonly verdict: string;
  /** Every criterion with its result, in order. */
  readonly results: readonly ChecklistReportEntry[];
}

/**
 * A checklist result, such as `std.patterns.checklist` returns, as Markdown: the verdict and how
 * many criteria passed, then one bullet per criterion in order with its ID, status and text, and
 * its evidence (or that its checker call failed) below.
 *
 * ```markdown
 * Verdict: **not-done** (1 of 2 criteria passed)
 *
 * - **C1** (pass): Invalid input is rejected with a message.
 *   Evidence: test/cli.test.ts:40 expects the message.
 * - **C2** (fail): The new flag is documented.
 *   Evidence: README.md does not mention --flag.
 * ```
 *
 * @param result - The verdict and every criterion with its result.
 * @returns The Markdown text; a criterion whose call failed shows `(no result)`.
 */
export function checklist(result: ChecklistReport): string {
  const total = result.results.length;
  const passed = result.results.filter((entry) => entry.result?.status === 'pass').length;
  const noun = total === 1 ? 'criterion' : 'criteria';
  const head = `Verdict: **${result.verdict}** (${String(passed)} of ${String(total)} ${noun} passed)`;
  const items = result.results.map(({ criterion, result: checked }) => {
    const status = checked?.status ?? 'no result';
    const detail = checked === null ? 'The checker call failed.' : `Evidence: ${checked.evidence}`;
    return `**${criterion.id}** (${status}): ${criterion.criterion}\n${detail}`;
  });
  return `${head}\n\n${bullets(items, 'No criteria.')}`;
}

/** One dimension of a {@link GateReport}, as a `std.patterns.GateDimension` holds it. */
export interface GateReportDimension {
  /** The dimension's key. */
  readonly key: string;
  /** What the dimension contributes to the decision, such as `pass`, `blocker` or `downgraded`. */
  readonly disposition: string;
  /** The assessor's status, summary and evidence, or null when its call failed. */
  readonly assessment: Assessment | null;
}

/** What {@link gate} renders: the parts of a `std.patterns.GateResult` it shows. */
export interface GateReport {
  /** The decision, such as `go`, `conditional-go` or `no-go`. */
  readonly decision: string;
  /** Every dimension with its assessment and disposition, in order. */
  readonly assessments: readonly GateReportDimension[];
}

/**
 * A gate result, such as `std.patterns.gate` returns, as Markdown: the decision, then one bullet
 * per dimension in order with its key, disposition and the assessor's summary, and the evidence
 * as nested bullets (or that the assessor call failed).
 *
 * ```markdown
 * Decision: **conditional-go**
 *
 * - **tests** (pass): The suite passes and covers the new flag.
 *   - test/cli.test.ts:40 checks the flag.
 * - **docs** (concern): The changelog does not mention the flag.
 *   - CHANGELOG.md has no entry for --flag.
 * - **security** (failed): The assessor call failed.
 * ```
 *
 * @param result - The decision and every dimension.
 * @returns The Markdown text.
 */
export function gate(result: GateReport): string {
  const items = result.assessments.map(({ key, disposition, assessment }) => {
    const head = `**${key}** (${disposition}): ${assessment?.summary ?? 'The assessor call failed.'}`;
    if (assessment === null || assessment.evidence.length === 0) return head;
    return `${head}\n${bullets(assessment.evidence)}`;
  });
  return `Decision: **${result.decision}**\n\n${bullets(items, 'No dimensions.')}`;
}

/**
 * A plan as Markdown: its summary, the numbered steps with their IDs and files, then the risks and
 * the checks as bulleted lists, each under a bold label.
 *
 * ```markdown
 * Add a pager to the list endpoint.
 *
 * **Steps**
 *
 * 1. **S1**: Accept page and size parameters.
 *    Files: `src/list.ts`, `test/list.test.ts`
 *
 * **Risks**
 *
 * - Clients that expect every item get one page.
 *
 * **Checks**
 *
 * - npm test
 * ```
 *
 * @param value - A `std.types.Plan`.
 * @returns The Markdown text; an empty list of risks or checks shows `(none)`.
 */
export function plan(value: Plan): string {
  const steps = value.steps.map((step) => {
    const head = `**${step.id}**: ${step.description}`;
    if (step.files.length === 0) return head;
    return `${head}\nFiles: ${step.files.map((file) => code(file)).join(', ')}`;
  });
  return [
    value.summary,
    '**Steps**',
    numbered(steps),
    '**Risks**',
    bullets(value.risks),
    '**Checks**',
    bullets(value.checks),
  ].join('\n\n');
}

/**
 * Commits as a Markdown bulleted list, in the order given (`std.exec.log` lists them oldest
 * first): each the abbreviated ID as code, the subject, then the author and the day of the author
 * date.
 *
 * ```markdown
 * - `3f2a91c` Add the pager (Ada Lovelace, 2026-01-31)
 * ```
 *
 * @param list - `std.types.Commit` entries, such as `std.exec.log` returns.
 * @returns The Markdown list; `No commits.` for an empty list. An empty subject shows as
 * `(no subject)`.
 */
export function commits(list: readonly Commit[]): string {
  if (list.length === 0) return 'No commits.';
  return bullets(
    list.map((commit) => {
      const subject = commit.subject === '' ? '(no subject)' : commit.subject;
      const day = /^\d{4}-\d{2}-\d{2}/u.exec(commit.date)?.[0] ?? commit.date;
      return `${code(commit.shortSha)} ${subject} (${commit.author}, ${day})`;
    }),
  );
}
