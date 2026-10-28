// Pure rules: collecting the lenses' readings with their anchors checked, carrying anchors onto
// merged tickets, applying a repair patch, the merge accounting, dependency waves and the critical
// path, and the status verdict.
import type { MapStepError, Settled } from 'quiet-choir';
import type { Gap, Item, Lens, Repair, Ticket } from '../contracts.js';
import { anchored, plain } from './anchors.js';

type Reading = { items: Omit<Item, 'id' | 'lens'>[]; openQuestions: string[] };

/**
 * Number every anchored item `<lens>-<n>` in lens order, set aside the items whose quote is not in
 * the PRD, and pool the open questions, dropping repeats that differ only in case, quotes or spacing.
 */
export function collect(
  prd: string,
  lenses: readonly Lens[],
  readings: readonly (Settled<Reading, MapStepError> | undefined)[],
) {
  const items: Item[] = [];
  const unanchored: { lens: Lens; title: string; prdAnchor: string }[] = [];
  const questions = new Map<string, string>();
  lenses.forEach((lens, index) => {
    const reading = readings[index];
    if (!reading?.ok) return;
    for (const item of reading.value.items) {
      if (anchored(prd, item.prdAnchor))
        items.push({ ...item, lens, id: `${lens}-${String(items.length + 1)}` });
      else unanchored.push({ lens, title: item.title, prdAnchor: item.prdAnchor });
    }
    for (const question of reading.value.openQuestions)
      if (!questions.has(plain(question))) questions.set(plain(question), question);
  });
  return { items, unanchored, questions: [...questions.values()] };
}

/** Anchored items that no ticket cites as a source. */
export const unmerged = (items: readonly Item[], tickets: readonly Ticket[]) => {
  const cited = new Set(tickets.flatMap((ticket) => ticket.sources));
  return items
    .filter((item) => !cited.has(item.id))
    .map(({ id, lens, title }) => ({ id, lens, title }));
};

/** The merger's tickets with their PRD anchors: those of the source items, in order, once each. */
export function anchorTickets<T extends { sources: string[] }>(
  merged: readonly T[],
  items: readonly Item[],
): (T & { prdAnchors: string[] })[] {
  const anchorOf = new Map(items.map((item) => [item.id, item.prdAnchor]));
  return merged.map((ticket) => ({
    ...ticket,
    prdAnchors: [...new Set(ticket.sources.flatMap((id) => anchorOf.get(id) ?? []))],
  }));
}

/** The backlog after a repair: amended text replaced, added tickets appended, all else kept. */
export function applyRepair(tickets: readonly Ticket[], patch: Repair): Ticket[] {
  const amendments = new Map(patch.amended.map((amendment) => [amendment.id, amendment]));
  return [
    ...tickets.map((ticket) => ({ ...ticket, ...amendments.get(ticket.id) })),
    ...patch.added.map((ticket) => ({ ...ticket, sources: [] })),
  ];
}

/** Estimate days per ticket size, for the critical path. */
const days = { XS: 0.5, S: 1, M: 2.5, L: 5 } as const;

/**
 * Group tickets by dependency depth and find the longest chain by estimate. Tickets only depend on
 * earlier tickets (the schemas refuse anything else), so one pass in order suffices; ties keep the
 * earlier ticket.
 */
export function schedule(tickets: readonly Ticket[]) {
  const depth = new Map<string, number>();
  const finish = new Map<string, { days: number; path: string[] }>();
  for (const ticket of tickets) {
    depth.set(ticket.id, Math.max(-1, ...ticket.dependsOn.map((id) => depth.get(id) ?? -1)) + 1);
    const longest = ticket.dependsOn
      .map((id) => finish.get(id))
      .reduce<{ days: number; path: string[] } | undefined>(
        (best, chain) => (chain && (!best || chain.days > best.days) ? chain : best),
        undefined,
      );
    finish.set(ticket.id, {
      days: (longest?.days ?? 0) + days[ticket.estimate],
      path: [...(longest?.path ?? []), ticket.id],
    });
  }
  const waves: string[][] = [];
  for (const ticket of tickets) (waves[depth.get(ticket.id) ?? 0] ??= []).push(ticket.id);
  const critical = [...finish.values()].reduce<{ days: number; path: string[] } | null>(
    (best, chain) => (!best || chain.days > best.days ? chain : best),
    null,
  );
  return { waves, criticalPath: critical && { tickets: critical.path, days: critical.days } };
}

/** The coverage loop's record, as the output reports it. */
export interface CoverageRecord {
  audits: number;
  repairs: number;
  covered: boolean;
  gaps: Gap[];
  repaired: Gap[];
  failure: { stage: 'audit' | 'repair'; message: string } | null;
}

/**
 * The status. With no anchored item, a backlog is unread when every lens failed, degraded when some
 * did and empty only when all read the PRD. Otherwise a failed lens degrades the backlog even when
 * the critic found no gap, a backlog whose final version no audit read is unaudited, and only an
 * audit with no gap is covered.
 */
export function status(
  failedLenses: readonly Lens[],
  lenses: number,
  coverage: CoverageRecord | null,
) {
  if (!coverage) {
    if (failedLenses.length === lenses) return 'unread' as const;
    return failedLenses.length ? ('degraded' as const) : ('empty' as const);
  }
  if (failedLenses.length) return 'degraded' as const;
  if (coverage.covered) return 'covered' as const;
  return coverage.gaps.length ? ('gaps-remain' as const) : ('unaudited' as const);
}
