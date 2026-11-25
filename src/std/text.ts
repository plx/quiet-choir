/**
 * Stable prompt and text formatting. Prompt text is part of an agent call's identity, so these
 * helpers are deterministic in their arguments: the same parts always render the same text, and a
 * completed call replays. {@link brief} gives every default std prompt one layout (task, then
 * `## Context`, `## Guidance` and `## Output` sections); the rest are small building blocks for
 * Markdown lists and fences, byte- and character-safe clipping, and cleaning command output.
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
 * ```
 *
 * @module
 */
import type { JsonValue, Prompt } from '../index.js';
import { json } from './exec.js';

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
   * Material the task works on, under `## Context`. A string is inserted as written; any other JSON
   * value is shown as a fenced `json` block of its two-space indented form (`std.exec.json`).
   */
  readonly context?: JsonValue | string | undefined;
  /** Rules and hints, rendered as a bulleted list under `## Guidance`; omitted when empty. */
  readonly guidance?: readonly string[] | undefined;
  /** What to return, under `## Output`. */
  readonly output?: string | undefined;
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
 * @throws TypeError - When `task` is blank, or `context` is not JSON-serializable.
 */
export function brief(parts: BriefParts): string {
  if (parts.task.trim() === '') throw new TypeError('A brief needs a nonblank task.');
  const sections = [parts.task];
  const { context, guidance, output } = parts;
  if (context !== undefined) {
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
