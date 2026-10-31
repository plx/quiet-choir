// Pure admission: which transcribed tickets are faithful to the backlog. Code splits the backlog
// into whole units (Markdown list items without their marker or checkbox, other lines, JSON
// strings), each owned by the ticket whose heading, title line or JSON object it sits under. A
// criterion must equal a unit of its own ticket (or, for a ticket that owns no text, a unit no
// ticket owns), and a list item that no criterion copied, under a checked or skipped ticket or
// under none, is reported as unclaimed rather than silently left unchecked.
import type { Skipped, Ticket } from '../contracts.js';

type Unit = { text: string; owner: string | null; item: boolean };
export type Unclaimed = { ticket: string | null; item: string };

const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const token = (id: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}_-])${escape(id)}(?![\\p{L}\\p{N}_-])`, 'u');
const HEADING = /^ {0,3}(#{1,6})\s+/u;
const ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/u;
const CRITERIA = /criteri|acceptance/iu;

/** An ID the ingester made up for a ticket the backlog gives none (T1, T2 and so on). */
const synthetic = (id: string) => /^T\d+$/u.test(id);

/** The shape of a ticket ID with its digits generalized, so QA-12 also recognizes QA-13. */
const shape = (id: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}_-])${escape(id).replace(/\d+/gu, '\\d+')}(?![\\p{L}\\p{N}_-])`,
    'u',
  );

/** What may follow the ID of a list item that titles a ticket: emphasis, a bracket, a dash. */
const SEPARATOR = /^(?:[*_]+|\s*[\]):|\u2013\u2014-]|\s*$)/u;

/**
 * The ticket a heading names (the first ID in it) or a title line starts with: a reported ID, null
 * for an ID of a reported ID's shape that nobody transcribed, undefined when there is none. A list
 * item titles a ticket only when a separator follows the ID ("- QA-2: Export"), so a criterion that
 * starts with another ticket's ID ("- QA-2 imports still work") stays a criterion.
 */
function ticketIn(
  text: string,
  ids: string[],
  where: 'heading' | 'line' | 'item',
): string | null | undefined {
  const at = (pattern: RegExp) => {
    const match = pattern.exec(text);
    if (!match) return undefined;
    if (where === 'heading') return match.index;
    if (match.index !== 0) return undefined;
    return where === 'line' || SEPARATOR.test(text.slice(match[0].length)) ? 0 : undefined;
  };
  let first: { id: string; index: number } | undefined;
  for (const id of ids) {
    const index = at(token(id));
    if (index !== undefined && (first === undefined || index < first.index)) first = { id, index };
  }
  if (first) return first.id;
  return ids.some((id) => /\d/u.test(id) && at(shape(id)) !== undefined) ? null : undefined;
}

/** A line without its list marker, checkbox, emphasis or brackets. */
const lead = (line: string) => line.replace(ITEM, '').replace(/^[^\p{L}\p{N}]+/u, '');

/**
 * Markdown or plain text. A heading naming a ticket opens its section until a heading at the same
 * depth or above; a line that starts with a ticket ID opens one until the next heading. A list item
 * runs until a blank line, a heading, a title line or the next item.
 */
function parseText(text: string, ids: string[], start: string | null, items: boolean): Unit[] {
  const units: Unit[] = [];
  let owner = start;
  let depth = 7;
  let open: { parts: string[]; owner: string | null } | null = null;
  const close = () => {
    if (open) units.push({ text: normalize(open.parts.join(' ')), owner: open.owner, item: items });
    open = null;
  };
  for (const line of text.split(/\r?\n/u)) {
    const heading = HEADING.exec(line);
    const marker = ITEM.exec(line);
    const ticket = heading
      ? ticketIn(line, ids, 'heading')
      : ticketIn(lead(line), ids, marker ? 'item' : 'line');
    if (!line.trim() || heading || ticket !== undefined || marker) close();
    if (heading) {
      const level = heading[1]?.length ?? 1;
      if (ticket !== undefined) [owner, depth] = [ticket, level];
      else if (level <= depth) [owner, depth] = [start, 7];
    } else if (ticket !== undefined) [owner, depth] = [ticket, 7];
    else if (marker) open = { parts: [line.slice(marker[0].length)], owner };
    else if (open && line.trim()) open.parts.push(line);
    else if (line.trim()) units.push({ text: normalize(line), owner, item: false });
  }
  close();
  return units;
}

/** JSON: an object holding a ticket ID owns every string under it; criteria keys hold items. */
function parseJson(value: unknown, ids: string[], owner: string | null, items: boolean): Unit[] {
  if (typeof value === 'string')
    return value.includes('\n')
      ? [{ text: normalize(value), owner, item: false }, ...parseText(value, ids, owner, items)]
      : [{ text: normalize(value), owner, item: items }];
  if (Array.isArray(value)) return value.flatMap((entry) => parseJson(entry, ids, owner, items));
  if (value === null || typeof value !== 'object') return [];
  const entries = Object.entries(value);
  const own = entries.find(([, entry]) => typeof entry === 'string' && ids.includes(entry));
  const here = typeof own?.[1] === 'string' ? own[1] : owner;
  return entries.flatMap(([key, entry]) =>
    parseJson(entry, ids, here, items || CRITERIA.test(key)),
  );
}

function parse(content: string, ids: string[]): Unit[] {
  try {
    const value: unknown = JSON.parse(content);
    if (value !== null && typeof value === 'object') return parseJson(value, ids, null, false);
  } catch {
    // Markdown or plain text.
  }
  return parseText(content, ids, null, true);
}

/**
 * Admit, first ID wins, the tickets whose ID the backlog names (unless the ingester numbered it)
 * and whose every criterion is a whole unit under that ticket, or under no ticket when the
 * backlog ties no text to it. Then list the items under an admitted or skipped ticket that it did
 * not copy, and the items under no named ticket that nothing copied; the items under a rejected
 * ticket are reported by its rejection.
 */
export function admit(tickets: Ticket[], skipped: Skipped[], content: string) {
  const named = [...tickets, ...skipped].map((ticket) => ticket.id);
  const ids = [...new Set(named)].filter((id) => token(id).test(content));
  const units = parse(content, ids);
  const owners = new Set(units.map((unit) => unit.owner));
  const unfaithful = (ticket: Ticket): string | null => {
    if (!synthetic(ticket.id) && !ids.includes(ticket.id)) return 'Ticket ID not in the backlog';
    const owner = owners.has(ticket.id) ? ticket.id : null;
    for (const criterion of ticket.acceptanceCriteria) {
      const matches = units.filter((unit) => unit.text === normalize(criterion));
      if (!matches.length) return `Criterion is not a whole backlog item or line: ${criterion}`;
      if (!matches.some((unit) => unit.owner === owner))
        return owner === null
          ? `Criterion belongs to another ticket in the backlog: ${criterion}`
          : `Criterion is not under ${ticket.id} in the backlog: ${criterion}`;
    }
    return null;
  };
  const seen = new Set<string>();
  const admitted: Ticket[] = [];
  const rejected: Skipped[] = [];
  for (const ticket of tickets) {
    const reason = seen.has(ticket.id)
      ? 'Duplicate ticket ID; the first is checked'
      : unfaithful(ticket);
    if (reason === null) admitted.push(ticket);
    else rejected.push({ id: ticket.id, reason });
    seen.add(ticket.id);
  }
  const copied = (list: Ticket[]) =>
    new Set(list.flatMap((ticket) => ticket.acceptanceCriteria.map(normalize)));
  const anywhere = copied(tickets);
  // A skipped ticket copied nothing, so code cannot check the ingester's reason for skipping it.
  const passed = new Set(skipped.map((ticket) => ticket.id).filter((id) => !seen.has(id)));
  const unclaimed = units.flatMap((unit): Unclaimed[] => {
    if (!unit.item) return [];
    if (unit.owner === null)
      return anywhere.has(unit.text) ? [] : [{ ticket: null, item: unit.text }];
    if (passed.has(unit.owner)) return [{ ticket: unit.owner, item: unit.text }];
    const own = admitted.find((ticket) => ticket.id === unit.owner);
    return own && !copied([own]).has(unit.text) ? [{ ticket: own.id, item: unit.text }] : [];
  });
  return { admitted, rejected, unclaimed };
}
