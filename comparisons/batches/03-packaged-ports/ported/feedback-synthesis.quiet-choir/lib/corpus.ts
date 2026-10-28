// The corpus as code-owned facts: each source is a durable snapshot parsed into items with stable
// IDs, the calibration sample is spread evenly, and shards are disjoint consecutive ranges, so
// "every item read exactly once" is arithmetic rather than a tagger's claim.
import type { WorkflowContext } from 'quiet-choir';
import type { FeedbackInput, Format, PromptItem } from '../contracts.js';

/** Item text an agent sees is cut here; quotes are still checked against the whole text. */
export const ITEM_CHARS = 1_500;
/** A shard closes at shardSize items or this many prompt characters, whichever comes first. */
export const SHARD_CHARS = 60_000;
/** The largest source file read; a larger one fails its read and is reported. */
export const SOURCE_BYTES = 4 * 1024 * 1024;
const FIELD_CHARS = 80;
/** The marker that ends an item shown cut at ITEM_CHARS. */
export const CUT = '[cut]';

/** One feedback item: `F<n>` in corpus order, its `path:line`, its whole text and fields. */
export interface Item {
  readonly id: string;
  readonly ref: string;
  readonly text: string;
  readonly fields: string | null;
}
/** One source's accounting: its snapshot digest, items, unparsed records and read failure. */
export interface Source {
  readonly path: string;
  readonly sha256: string | null;
  readonly items: number;
  readonly unparsed: number;
  readonly failure: string | null;
}
interface Parsed {
  readonly records: { line: number; text: string; fields: string | null }[];
  readonly unparsed: number;
  readonly failure: string | null;
}

/** Collapse runs of whitespace, so one item is one prompt line and quotes compare by words. */
export const squash = (text: string) => text.replace(/\s+/gu, ' ').trim();

const fieldsOf = (pick: readonly string[], value: (name: string) => unknown) => {
  const shown = pick.flatMap((name) => {
    const raw = value(name);
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return [];
    const text = squash(String(raw)).slice(0, FIELD_CHARS);
    return text ? [`${name}: ${text}`] : [];
  });
  return shown.length ? shown.join('; ') : null;
};

/** RFC 4180 records with the line each starts on; `broken` marks an unterminated quote. */
function csvRecords(content: string) {
  const records: { line: number; cells: string[]; broken: boolean }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let open = false;
  let line = 1;
  let start = 1;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else {
        if (char === '\n') line++;
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === '') {
      quoted = true;
      open = true;
    } else if (char === ',') {
      cells.push(cell);
      cell = '';
      open = true;
    } else if (char === '\n' || (char === '\r' && content[index + 1] === '\n')) {
      if (char === '\r') index++;
      records.push({ line: start, cells: [...cells, cell], broken: false });
      cells = [];
      cell = '';
      open = false;
      start = ++line;
    } else {
      cell += char;
      open = true;
    }
  }
  if (open || cell !== '') records.push({ line: start, cells: [...cells, cell], broken: quoted });
  return records;
}

function parseCsv(content: string, textField: string, pick: readonly string[]): Parsed {
  const [header, ...rows] = csvRecords(content);
  if (!header) return { records: [], unparsed: 0, failure: null };
  const columns = header.cells.map((cell) => cell.trim());
  const at = columns.indexOf(textField);
  if (at < 0) return { records: [], unparsed: rows.length, failure: `No ${textField} column` };
  const records: Parsed['records'] = [];
  let unparsed = 0;
  for (const row of rows) {
    if (!row.broken && row.cells.length === 1 && row.cells[0]?.trim() === '') continue;
    const text = row.cells[at]?.trim() ?? '';
    if (row.broken || row.cells.length !== columns.length || !text) {
      unparsed++;
      continue;
    }
    const fields = fieldsOf(pick, (name) => row.cells[columns.indexOf(name)]);
    records.push({ line: row.line, text, fields });
  }
  return { records, unparsed, failure: null };
}

function parseJsonl(lines: string[], textField: string, pick: readonly string[]): Parsed {
  const records: Parsed['records'] = [];
  let unparsed = 0;
  for (const [index, raw] of lines.entries()) {
    if (!raw.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      unparsed++;
      continue;
    }
    const object =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const text = object?.[textField];
    if (!object || typeof text !== 'string' || !text.trim()) {
      unparsed++;
      continue;
    }
    records.push({ line: index + 1, text: text.trim(), fields: fieldsOf(pick, (k) => object[k]) });
  }
  return { records, unparsed, failure: null };
}

function parseBlocks(lines: string[]): Parsed {
  const records: Parsed['records'] = [];
  let block: string[] = [];
  let start = 0;
  for (const [index, raw] of [...lines, ''].entries()) {
    if (raw.trim()) {
      if (!block.length) start = index + 1;
      block.push(raw.trim());
    } else if (block.length) {
      records.push({ line: start, text: block.join('\n'), fields: null });
      block = [];
    }
  }
  return { records, unparsed: 0, failure: null };
}

/** Split one source's content into records by the input format. */
export function parse(content: string, format: Format, textField: string, pick: readonly string[]) {
  const text = content.replace(/^\uFEFF/u, '');
  if (format === 'csv') return parseCsv(text, textField, pick);
  const lines = text.split(/\r?\n/u);
  if (format === 'jsonl') return parseJsonl(lines, textField, pick);
  if (format === 'blocks') return parseBlocks(lines);
  return {
    records: lines.flatMap((raw, index) =>
      raw.trim() ? [{ line: index + 1, text: raw.trim(), fields: null }] : [],
    ),
    unparsed: 0,
    failure: null,
  };
}

/**
 * Read every source as a durable snapshot (`source/<i>`) and number its items F1, F2, … in
 * source order. An unreadable source is reported with its failure, never skipped silently.
 */
export async function readCorpus(ctx: WorkflowContext, input: FeedbackInput) {
  const items: Item[] = [];
  const sources: Source[] = [];
  for (const [index, path] of input.sources.entries()) {
    const read = await ctx.readFile(ctx.id('source', index), path, {
      maxBytes: SOURCE_BYTES,
      onError: 'return',
    });
    if (!read.ok) {
      // The message names the absolute path; the output keeps it relative to the checkout.
      const message = read.error.message.replaceAll(`${ctx.cwd}/`, '');
      const failure = `${read.error.kind}: ${message}`.slice(0, 300);
      sources.push({ path, sha256: null, items: 0, unparsed: 0, failure });
      continue;
    }
    const parsed = parse(read.value.content, input.format, input.textField, input.fields);
    for (const record of parsed.records)
      items.push({
        id: `F${String(items.length + 1)}`,
        ref: `${path}:${String(record.line)}`,
        text: record.text,
        fields: record.fields,
      });
    sources.push({
      path,
      sha256: read.value.sha256,
      items: parsed.records.length,
      unparsed: parsed.unparsed,
      failure: parsed.failure,
    });
  }
  return { items, sources };
}

/** Whether an agent sees this item cut at ITEM_CHARS. */
export const truncated = (item: Item) => squash(item.text).length > ITEM_CHARS;

/** The item as a prompt line: whitespace squashed and cut at ITEM_CHARS. */
export function promptItem(item: Item): PromptItem {
  const text = squash(item.text);
  return {
    id: item.id,
    fields: item.fields,
    text: text.length > ITEM_CHARS ? `${text.slice(0, ITEM_CHARS)} ${CUT}` : text,
  };
}
export const promptItems = (items: readonly Item[]): PromptItem[] => items.map(promptItem);

/** `size` items spread evenly from the beginning to the end of the corpus, or all of them. */
export function sample(items: readonly Item[], size: number): Item[] {
  if (items.length <= size) return [...items];
  return Array.from(
    { length: size },
    (_, k) => items[Math.floor((k * items.length) / size)],
  ).filter((item): item is Item => item !== undefined);
}

/**
 * Disjoint consecutive shards of at most `size` items and SHARD_CHARS prompt characters. Shards
 * past `max` are not tagged; their items are returned as `unsharded`, to be reported.
 */
export function shard(items: readonly Item[], size: number, max: number) {
  const all: Item[][] = [];
  let current: Item[] = [];
  let chars = 0;
  for (const item of items) {
    const length = promptItem(item).text.length + 16;
    if (current.length && (current.length >= size || chars + length > SHARD_CHARS)) {
      all.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += length;
  }
  if (current.length) all.push(current);
  return { shards: all.slice(0, max), unsharded: all.slice(max).flat() };
}

/** The item IDs of a list, typed for a `z.enum` that only admits them. */
export function idsOf(items: readonly Item[]): [string, ...string[]] {
  const [first, ...rest] = items.map((item) => item.id);
  if (first === undefined) throw new Error('An agent list needs at least one item');
  return [first, ...rest];
}
