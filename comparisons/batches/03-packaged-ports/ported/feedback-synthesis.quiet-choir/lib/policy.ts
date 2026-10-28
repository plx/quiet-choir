// Pure rules: the settled vocabulary, aggregation of the taggers' per-item tags into counts and
// severity, verbatim quote checks, the severity-weighted ranking, what each diver reads, and the
// accounting, coverage line, status and gaps. Counting is arithmetic, not a judgment call.
import type { MapStepError, Settled } from 'quiet-choir';
import {
  SEVERE,
  type Dive,
  type Quote,
  type RankedTheme,
  type Severity,
  type Tagged,
  type Theme,
} from '../contracts.js';
import { CUT, squash, truncated, type Item, type Source } from './corpus.js';

type Result<T> = Settled<T, MapStepError> | undefined;
type Kind = (typeof SEVERE)[number];

/** Quotes a tagger may give per theme, and starter quotes a diver receives. */
const SHARD_QUOTES = 3;
const STARTER_QUOTES = 8;

/** The calibrator's themes, first spelling of each key kept, with an `other` catch-all ensured. */
export function settleVocabulary(themes: readonly Theme[]): Theme[] {
  const kept = themes.filter(
    (theme, index) => themes.findIndex((other) => other.key === theme.key) === index,
  );
  return kept.some((theme) => theme.key === 'other')
    ? kept
    : [...kept, { key: 'other', definition: 'Feedback that fits no other theme.' }];
}

/** `1 item`, `2 items`: a count with its noun. */
export const counted = (count: number, noun: string) =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

/** The vocabulary's keys, typed for a `z.enum` that only admits them. */
export function keysOf(vocabulary: readonly Theme[]): [string, ...string[]] {
  const [first, ...rest] = vocabulary.map((theme) => theme.key);
  if (first === undefined) throw new Error('The vocabulary has no theme');
  return [first, ...rest];
}

/**
 * The excerpt when it is a verbatim run of the item's words. Outer quote marks and the cut marker
 * of an item shown truncated are ignored.
 */
export function verbatim(text: string, item: Item | undefined): string | null {
  const squashed = squash(text);
  const excerpt = (squashed.endsWith(CUT) ? squashed.slice(0, -CUT.length) : squashed)
    .trim()
    .replace(/^["'\u201C\u201D\u2018\u2019]+|["'\u201C\u201D\u2018\u2019]+$/gu, '')
    .trim();
  return item && excerpt && squash(item.text).includes(excerpt) ? excerpt : null;
}

const zero = (): Record<Kind, number> => ({
  'churn-threat': 0,
  'data-loss': 0,
  'blocked-workflow': 0,
  safety: 0,
});
interface Bucket {
  count: number;
  severe: number;
  severity: Record<Kind, number>;
  items: { item: Item; severity: Severity }[];
  quotes: Quote[];
}

/**
 * Fold every shard's answer into per-theme buckets. Each item lands in exactly one class: tagged,
 * off-focus (only when a focus is set), or untagged (a failed shard, or an answer that left it out
 * or gave it no theme). A tagger quote counts only when it is verbatim from an item the same
 * answer tagged with that theme; the rest are rejected and counted.
 */
export function aggregate(
  vocabulary: readonly Theme[],
  shards: readonly Item[][],
  results: readonly Result<Tagged>[],
  focused: boolean,
) {
  const buckets = new Map<string, Bucket>(
    vocabulary.map((theme) => [
      theme.key,
      { count: 0, severe: 0, severity: zero(), items: [], quotes: [] },
    ]),
  );
  const emergent: string[] = [];
  let tagged = 0;
  let offFocus = 0;
  let untagged = 0;
  let rejectedQuotes = 0;
  const rows = shards.map((items, index) => {
    const result = results[index];
    const range = { first: items[0]?.id ?? '', last: items.at(-1)?.id ?? '', items: items.length };
    if (!result?.ok) {
      untagged += items.length;
      return { ...range, outcome: 'failed' as const, missing: [], duplicates: 0 };
    }
    const answer = result.value;
    const tags = new Map<string, Tagged['items'][number]>();
    let duplicates = 0;
    for (const tag of answer.items) {
      if (tags.has(tag.id)) duplicates++;
      else tags.set(tag.id, tag);
    }
    const missing: string[] = [];
    const themesOf = new Map<string, Set<string>>();
    for (const item of items) {
      const tag = tags.get(item.id);
      if (tag && focused && tag.offFocus) {
        offFocus++;
        continue;
      }
      const themes = new Set(tag?.themes ?? []);
      if (!tag || !themes.size) {
        missing.push(item.id);
        untagged++;
        continue;
      }
      tagged++;
      themesOf.set(item.id, themes);
      for (const key of themes) {
        const bucket = buckets.get(key);
        if (!bucket) continue;
        bucket.count++;
        bucket.items.push({ item, severity: tag.severity });
        if (tag.severity === 'none') continue;
        bucket.severe++;
        bucket.severity[tag.severity]++;
      }
    }
    const byId = new Map(items.map((item) => [item.id, item]));
    const quoted = new Map<string, number>();
    for (const quote of answer.quotes) {
      const text = themesOf.get(quote.id)?.has(quote.theme)
        ? verbatim(quote.text, byId.get(quote.id))
        : null;
      if (text === null) {
        rejectedQuotes++;
        continue;
      }
      const taken = quoted.get(quote.theme) ?? 0;
      const item = byId.get(quote.id);
      if (taken >= SHARD_QUOTES || !item) continue;
      quoted.set(quote.theme, taken + 1);
      buckets.get(quote.theme)?.quotes.push({ id: item.id, ref: item.ref, text });
    }
    emergent.push(...answer.emergent);
    return { ...range, outcome: 'tagged' as const, missing, duplicates };
  });
  return { buckets, rows, emergent: unique(emergent), tagged, offFocus, untagged, rejectedQuotes };
}
export type Tally = ReturnType<typeof aggregate>;

/** First spelling of each pattern, compared trimmed and case-insensitively. */
function unique(patterns: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const pattern of patterns) {
    const key = squash(pattern).toLowerCase();
    if (key && !seen.has(key)) seen.set(key, squash(pattern));
  }
  return [...seen.values()];
}

/**
 * The upstream rank: items plus `weight` times severe items, so twenty data-loss reports outrank
 * sixty mild gripes. A stable sort keeps vocabulary order between equal scores.
 */
export function rank(vocabulary: readonly Theme[], tally: Tally, weight: number): RankedTheme[] {
  return vocabulary
    .flatMap((theme) => {
      const bucket = tally.buckets.get(theme.key);
      if (!bucket?.count) return [];
      const { count, severe, severity } = bucket;
      return [
        {
          theme: theme.key,
          definition: theme.definition,
          count,
          severe,
          score: count + weight * severe,
          severity,
        },
      ];
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * The head of the ranking gets dives, skipping the `other` catch-all, whose patterns are the
 * emergent list. Each diver reads the theme's items severe first, then in corpus order, up to
 * `limit`; the rest are counted.
 */
export function divePlans(
  ranked: readonly RankedTheme[],
  tally: Tally,
  dives: number,
  limit: number,
) {
  return ranked
    .filter((theme) => theme.theme !== 'other')
    .slice(0, dives)
    .map((theme) => {
      const bucket = tally.buckets.get(theme.theme);
      const all = bucket?.items ?? [];
      const ordered = [
        ...all.filter((entry) => entry.severity !== 'none'),
        ...all.filter((entry) => entry.severity === 'none'),
      ];
      return {
        theme,
        items: ordered.slice(0, limit).map((entry) => entry.item),
        omitted: Math.max(0, ordered.length - limit),
        starters: (bucket?.quotes ?? []).slice(0, STARTER_QUOTES),
      };
    });
}
export type DivePlan = ReturnType<typeof divePlans>[number];

/** Each dive aligned with its theme; a diver quote counts only when verbatim from its list. */
export function settleDives(plans: readonly DivePlan[], results: readonly Result<Dive>[]) {
  let rejected = 0;
  const dives = plans.map((plan, index) => {
    const result = results[index];
    const shape = {
      theme: plan.theme.theme,
      itemsShown: plan.items.length,
      itemsOmitted: plan.omitted,
    };
    if (!result?.ok)
      return {
        ...shape,
        outcome: 'failed' as const,
        storyline: null,
        segments: null,
        recommendation: null,
        quotes: [],
      };
    const byId = new Map(plan.items.map((item) => [item.id, item]));
    const quotes = result.value.quotes.flatMap((quote) => {
      const item = byId.get(quote.id);
      const text = verbatim(quote.text, item);
      if (text === null || !item) {
        rejected++;
        return [];
      }
      return [{ id: item.id, ref: item.ref, text }];
    });
    const { storyline, segments, recommendation } = result.value;
    return { ...shape, outcome: 'dived' as const, storyline, segments, recommendation, quotes };
  });
  return { dives, rejected };
}
export type Dived = ReturnType<typeof settleDives>['dives'][number];

/** The upstream coverage line, with every item that was not tagged accounted for. */
function coverage(accounting: Accounting, shards: number, failed: number, focus: string | null) {
  if (!accounting.items) return 'No feedback items found in the sources';
  const parts = [
    `${String(accounting.tagged)}/${counted(accounting.items, 'item')} tagged across ${String(shards - failed)}/${counted(shards, 'shard')}`,
  ];
  if (accounting.offFocus) parts.push(`${String(accounting.offFocus)} off-focus`);
  if (accounting.untagged) parts.push(`${String(accounting.untagged)} untagged`);
  if (accounting.unsharded) parts.push(`${String(accounting.unsharded)} past the shard cap`);
  return `${parts.join('; ')}${focus === null ? '' : ` (focus: ${squash(focus)})`}`;
}

interface Accounting {
  readonly items: number;
  readonly tagged: number;
  readonly offFocus: number;
  readonly untagged: number;
  readonly unsharded: number;
  readonly truncated: number;
  readonly rejectedQuotes: number;
}

/**
 * The run's output summary (status, coverage line, accounting) and the report's not-covered lines. Every item is tagged,
 * off-focus, untagged or unsharded. The status is degraded when a source, record, shard or dive
 * failed; limited when a cap left items untagged or cut; empty when no theme has items; complete
 * otherwise.
 */
export function summarize(run: {
  readonly sources: readonly Source[];
  readonly items: number;
  readonly focus: string | null;
  readonly unsharded?: readonly Item[];
  readonly seen?: readonly Item[];
  readonly tally?: Tally;
  readonly dives?: readonly Dived[];
  readonly rejected?: number;
  readonly ranked?: number;
}) {
  const { sources, unsharded = [], seen = [], tally, dives = [], rejected = 0 } = run;
  const rows = tally?.rows ?? [];
  const accounting: Accounting = {
    items: run.items,
    tagged: tally?.tagged ?? 0,
    offFocus: tally?.offFocus ?? 0,
    untagged: tally?.untagged ?? 0,
    unsharded: unsharded.length,
    truncated: new Set(seen.filter(truncated).map((item) => item.id)).size,
    rejectedQuotes: (tally?.rejectedQuotes ?? 0) + rejected,
  };
  const failedShards = rows.filter((row) => row.outcome === 'failed').length;
  const failed =
    sources.some((source) => source.failure !== null || source.unparsed > 0) ||
    accounting.untagged > 0 ||
    dives.some((entry) => entry.outcome === 'failed');
  const status = failed
    ? ('degraded' as const)
    : !run.ranked
      ? ('empty' as const)
      : accounting.unsharded || accounting.truncated
        ? ('limited' as const)
        : ('complete' as const);
  return {
    summary: {
      status,
      coverage: coverage(accounting, rows.length, failedShards, run.focus),
      accounting,
    },
    gaps: gaps({ sources, rows, unsharded, dives, accounting }),
  };
}

/** What the report did not cover, one line each, for its closing section. */
function gaps(facts: {
  sources: readonly Source[];
  rows: Tally['rows'];
  unsharded: readonly Item[];
  dives: readonly Dived[];
  accounting: Accounting;
}): string[] {
  const lines: string[] = [];
  for (const source of facts.sources) {
    if (source.failure) lines.push(`\`${source.path}\` was not parsed: ${squash(source.failure)}.`);
    if (source.unparsed)
      lines.push(`${counted(source.unparsed, 'record')} in \`${source.path}\` did not parse.`);
  }
  for (const row of facts.rows) {
    if (row.outcome === 'failed')
      lines.push(`${counted(row.items, 'item')} in a failed shard (${row.first} to ${row.last}).`);
    else if (row.missing.length)
      lines.push(
        `${counted(row.missing.length, 'item')} the tagger left untagged: ${row.missing.slice(0, 10).join(', ')}${row.missing.length > 10 ? ', …' : ''}.`,
      );
  }
  const [first] = facts.unsharded;
  if (first)
    lines.push(`${counted(facts.unsharded.length, 'item')} past the shard cap, from ${first.id}.`);
  for (const entry of facts.dives)
    if (entry.outcome === 'failed') lines.push(`The deep dive into \`${entry.theme}\` failed.`);
  const { truncated: cut, rejectedQuotes } = facts.accounting;
  if (cut) lines.push(`${counted(cut, 'item')} shown to agents cut at the character cap.`);
  if (rejectedQuotes) lines.push(`${counted(rejectedQuotes, 'quote')} dropped as not verbatim.`);
  return lines;
}
