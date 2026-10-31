// Pure rules: ranking and capping the listed docs, anchoring claims in the doc text, fencing
// evidence for prompts, pairing the checker's results, judging receipts and a fixer's text,
// collating the settled pipelines, the run and fix statuses, and the patch digest and its preview.
import { createHash } from 'node:crypto';
import type { MapStepError, Settled, WorktreeChange } from 'quiet-choir';
import type {
  Audited,
  Checked,
  Chosen,
  Claim,
  Classified,
  DocFix,
  DriftOutput,
  Failed,
  FixStatus,
  Omitted,
  Pipeline,
  Result,
  Skipped,
} from '../contracts.js';

const rankOf = { high: 0, medium: 1, low: 2 } as const;

/**
 * The docs the librarian classifies: those within the size cap, in path order, up to
 * `maxInventory`. Every doc left out is reported with its reason.
 */
export function inventory(
  found: { path: string; bytes: number }[],
  unsupported: string[],
  limits: { maxInventory: number; maxDocBytes: number },
) {
  const fits = found.filter((doc) => doc.bytes <= limits.maxDocBytes);
  const skipped: Skipped[] = [
    ...unsupported.map((doc) => ({ doc, reason: 'unsupported-path' as const })),
    ...found
      .filter((doc) => doc.bytes > limits.maxDocBytes)
      .map((doc) => ({ doc: doc.path, reason: 'too-large' as const })),
    ...fits
      .slice(limits.maxInventory)
      .map((doc) => ({ doc: doc.path, reason: 'inventory-cap' as const })),
  ];
  return { listed: fits.slice(0, limits.maxInventory), skipped };
}

/**
 * Order the listed docs by the librarian's priority (path order within one), unclassified last,
 * drop the ones it skipped, then take `maxDocs`. Every doc left out is reported with its reason.
 */
export function rank(
  listed: { path: string; bytes: number }[],
  classified: Classified[],
  maxDocs: number,
) {
  const byPath = new Map<string, Classified>();
  for (const entry of classified) if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
  const skipped: Skipped[] = [];
  const eligible: (Chosen & { bytes: number })[] = [];
  for (const { path, bytes } of listed) {
    const entry = byPath.get(path);
    if (entry?.priority === 'skip') skipped.push({ doc: path, reason: 'classified-skip' });
    else
      eligible.push({
        path,
        bytes,
        audience: entry?.audience ?? null,
        priority: entry ? entry.priority : null,
      });
  }
  const ordered = eligible
    .map((doc, index) => ({ doc, index }))
    .sort(
      (a, b) =>
        (a.doc.priority === null ? 3 : rankOf[a.doc.priority]) -
          (b.doc.priority === null ? 3 : rankOf[b.doc.priority]) || a.index - b.index,
    )
    .map(({ doc }) => doc);
  return {
    chosen: ordered.slice(0, maxDocs),
    skipped: [
      ...skipped,
      ...ordered.slice(maxDocs).map((doc) => ({ doc: doc.path, reason: 'max-docs' as const })),
    ],
    unclassified: listed.filter(({ path }) => !byPath.has(path)).map(({ path }) => path),
  };
}

/**
 * Text without Markdown code and emphasis marks and with whitespace collapsed, so a quote that
 * wraps differently or drops the backticks around a command still anchors.
 */
const flat = (text: string) => text.replace(/[`*]/gu, '').replace(/\s+/gu, ' ').trim();
/** Whether `quote` is in `text`; a quote of nothing but marks and spaces anchors nowhere. */
export const quotedIn = (text: string, quote: string) =>
  flat(quote) !== '' && flat(text).includes(flat(quote));

/**
 * Text for a `<tag>...</tag>` block in a prompt, with any closing tag inside it neutralized so the
 * block ends only where the template closes it.
 */
export const fenced = (text: string, tag: string) => text.replaceAll(`</${tag}`, `<\\/${tag}`);

/** Keep the claims whose quote is in the doc, once each; report the rest by their claim text. */
export function anchor(text: string, claims: Claim[]) {
  const seen = new Set<string>();
  const anchored: Claim[] = [];
  const unanchored: string[] = [];
  for (const claim of claims) {
    const key = `${flat(claim.quote)}\0${flat(claim.claim)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (quotedIn(text, claim.quote)) anchored.push(claim);
    else unanchored.push(claim.claim);
  }
  return { anchored, unanchored };
}

/** Pair each claim with the checker's result at the same position; the schema fixes the count. */
export const pair = (claims: Claim[], results: Result[]): Checked[] =>
  claims.map((claim, index) => {
    const result = results[index];
    if (!result) throw new Error(`Checker answered ${results.length} of ${claims.length} claims`);
    return { ...claim, ...result };
  });

/** A read-only call's output; a checker that changed its snapshot fails its doc's pipeline. */
export function readOnly<T>(result: { output: T; worktree?: WorktreeChange }): T {
  if (!result.worktree) throw new Error('A snapshot call returned no receipt');
  if (result.worktree.files.length)
    throw new Error(
      `A read-only role changed its snapshot: ${JSON.stringify(result.worktree.files)}`,
    );
  return result.output;
}

/**
 * Judge a fixer's receipt. Only an in-place modification of its own doc is accepted; anything
 * else is refused and never integrated.
 */
export function judgeReceipt(
  change: WorktreeChange | undefined,
  path: string,
): Pick<DocFix, 'status' | 'commit' | 'unexpected'> {
  if (!change) throw new Error('Fixer did not produce an isolated receipt');
  const unexpected = change.files.filter(
    (file) => file.path !== path || file.status !== 'modified',
  );
  if (unexpected.length) return { status: 'refused', commit: null, unexpected };
  if (!change.commit || !change.files.length)
    return { status: 'unchanged', commit: null, unexpected: [] };
  return { status: 'changed', commit: change.commit, unexpected: [] };
}

const untouched = { resolved: 0, unresolved: [], collateral: [] };

/** A fixer call that failed: the doc keeps its audit and gets no change. */
export const failedFix = (failure: string): DocFix => ({
  ...untouched,
  status: 'failed',
  commit: null,
  edits: [],
  unexpected: [],
  failure,
});

/**
 * The fix record. An accepted change is measured against the doc's new `text`: a drifted claim is
 * resolved when its quote is gone, and a true claim whose quote is gone is collateral, which the
 * human sees on approval. `text` is null for a refused or unchanged receipt.
 */
export function fixOf(
  receipt: Pick<DocFix, 'status' | 'commit' | 'unexpected'>,
  edits: string[],
  text: string | null,
  results: Checked[],
): DocFix {
  if (text === null) return { ...untouched, ...receipt, edits, failure: null };
  const gone = (result: Checked) => !quotedIn(text, result.quote);
  const drifted = results.filter((result) => result.status === 'drifted');
  return {
    ...receipt,
    edits,
    failure: null,
    resolved: drifted.filter(gone).length,
    unresolved: drifted.filter((result) => !gone(result)).map((result) => result.claim),
    collateral: results
      .filter((result) => result.status === 'true' && gone(result))
      .map((result) => result.claim),
  };
}

/** What the approval subject lists for each changed doc. */
export const approvalList = (docs: Audited[]) =>
  docs.flatMap(({ path, fix }) =>
    fix?.status === 'changed'
      ? [
          {
            doc: path,
            edits: fix.edits,
            resolved: fix.resolved,
            unresolved: fix.unresolved,
            collateral: fix.collateral,
          },
        ]
      : [],
  );

/**
 * Pair every chosen doc with its settled pipeline: an audited doc keeps its accepted change for
 * integration, and a failed pipeline is reported with the step that failed.
 */
export function collect(
  chosen: (Chosen & { bytes: number })[],
  settled: Settled<Pipeline, MapStepError>[],
) {
  const docs: Audited[] = [];
  const failed: Failed[] = [];
  const changes: WorktreeChange[] = [];
  for (const [index, doc] of chosen.entries()) {
    const outcome = settled[index];
    if (outcome?.ok) {
      const { change, ...audited } = outcome.value;
      docs.push({ ...doc, ...audited });
      if (change) changes.push(change);
    } else
      failed.push({
        doc: doc.path,
        step: outcome?.error.stepId ?? null,
        error: outcome?.error.message ?? 'No outcome was recorded',
      });
  }
  return { docs, failed, changes };
}

/**
 * Degraded beats limited: a failure loses evidence, claims or a fix, a cap only defers a doc. A
 * dropped claim may be one the doc really makes, and a drifted doc whose fix is not in the patch
 * stays wrong, so both degrade.
 */
export function statusOf(report: {
  docs: Audited[];
  skipped: Skipped[];
  failed: Failed[];
  unclassified: string[];
  evidence: { ok: boolean }[];
}): DriftOutput['status'] {
  if (
    report.failed.length ||
    report.unclassified.length ||
    report.evidence.some((check) => !check.ok) ||
    report.docs.some(
      (doc) =>
        doc.capped ||
        doc.unanchored.length > 0 ||
        (doc.fix !== null && doc.fix.status !== 'changed'),
    )
  )
    return 'degraded';
  return capped(report.skipped) ? 'limited' : 'complete';
}

/** A doc left out for any reason but the librarian's skip may hold drift the audit never read. */
const capped = (skipped: Skipped[]) => skipped.some((entry) => entry.reason !== 'classified-skip');

/** Nothing reached the pipelines: limited when a cap or a path rule left docs out. */
export const emptyStatus = (skipped: Skipped[]): DriftOutput['status'] =>
  capped(skipped) ? 'limited' : 'no-docs';

/** The drifted docs whose fixer ran but whose change the patch leaves out. */
export const omittedOf = (docs: Audited[]): Omitted[] =>
  docs.flatMap(({ path, fix }) =>
    fix && fix.status !== 'changed' ? [{ doc: path, status: fix.status }] : [],
  );

/** No change was accepted: say whether a fixer failed or overreached, not just that none changed. */
export const unfixedStatus = (omitted: Omitted[]): FixStatus =>
  omitted.some((entry) => entry.status === 'failed')
    ? 'failed'
    : omitted.some((entry) => entry.status === 'refused')
      ? 'refused'
      : 'no-change';

export function totals(docs: Audited[], published: boolean) {
  const count = (status: Checked['status']) =>
    docs.reduce((sum, doc) => sum + doc.results.filter((r) => r.status === status).length, 0);
  return {
    docs: docs.length,
    claims: docs.reduce((sum, doc) => sum + doc.results.length, 0),
    drifted: count('drifted'),
    unverifiable: count('unverifiable'),
    fixed: published
      ? docs.reduce((sum, doc) => sum + (doc.fix?.status === 'changed' ? doc.fix.resolved : 0), 0)
      : 0,
  };
}

/** The SHA-256 of the approved patch, exactly as `git diff` printed it. */
export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Room for the patch in the approval's details, which hold at most 16 KiB of UTF-8. */
const PREVIEW_BYTES = 15_000;

/**
 * The approval's details: the whole patch when it fits, else its head cut on a character boundary
 * with an explicit marker. The subject carries the digest, the size and whether it was cut.
 */
export function preview(text: string) {
  const bytes = Buffer.from(text);
  if (bytes.length <= PREVIEW_BYTES)
    return { details: text, bytes: bytes.length, truncated: false };
  let cut = PREVIEW_BYTES;
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  const rest = bytes.length - cut;
  return {
    details: `${bytes.subarray(0, cut).toString('utf8')}\n[... ${String(rest)} more bytes; the digest covers the whole patch]`,
    bytes: bytes.length,
    truncated: true,
  };
}
