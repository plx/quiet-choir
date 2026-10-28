// The report, assembled in code around the reporter's prose: the coverage line, the theme table
// and every quote come from code, so a count cannot be miscopied and a user cannot be paraphrased.
import type { Narrative, Quote, RankedTheme } from '../contracts.js';
import { squash } from './corpus.js';
import { counted, type Dived } from './policy.js';

export interface ReportParts {
  readonly coverage: string;
  readonly weight: number;
  readonly ranked: readonly RankedTheme[];
  readonly dives: readonly Dived[];
  readonly narrative: Narrative;
  readonly emergent: readonly string[];
  readonly gaps: readonly string[];
}

/** A verbatim quote as a blockquote, attributed to its item on its own line. */
const quote = (entry: Quote) => `> ${entry.text}\n> — ${entry.id}, \`${entry.ref}\``;

function dive(entry: Dived, theme: RankedTheme | undefined, index: number): string {
  const head = `## ${String(index + 1)}. ${entry.theme}`;
  const about = theme
    ? `_${counted(theme.count, 'item')}, ${String(theme.severe)} severe: ${squash(theme.definition)}_`
    : '';
  if (entry.outcome === 'failed') return [head, about, 'The deep dive failed.'].join('\n\n');
  const parts = [head, about, (entry.storyline ?? '').trim()];
  if (entry.segments) parts.push(`**Segments:** ${squash(entry.segments)}`);
  parts.push(`**Recommendation:** ${squash(entry.recommendation ?? '')}`);
  parts.push(...entry.quotes.map(quote));
  if (entry.itemsOmitted)
    parts.push(
      `_The diver read ${String(entry.itemsShown)} of ${counted(entry.itemsShown + entry.itemsOmitted, 'item')}, severe first._`,
    );
  return parts.join('\n\n');
}

/** Render the whole report, ending with one newline. */
export function render(parts: ReportParts): string {
  const dived = new Map(parts.dives.map((entry) => [entry.theme, entry.outcome]));
  const table = [
    '| # | Theme | Items | Severe | Score | Deep dive |',
    '| -: | --- | -: | -: | -: | --- |',
    ...parts.ranked.map(
      (theme, index) =>
        `| ${String(index + 1)} | \`${theme.theme}\` | ${String(theme.count)} | ${String(theme.severe)} | ${String(theme.score)} | ${dived.get(theme.theme) ?? 'no'} |`,
    ),
  ].join('\n');
  const { narrative } = parts;
  const blocks = [
    '# Feedback synthesis',
    `Coverage: ${parts.coverage}.`,
    '## Executive summary',
    narrative.summary.map((bullet) => `- ${squash(bullet)}`).join('\n'),
    '## Themes',
    `Ranked by items plus ${String(parts.weight)} times severe items (churn threat, data loss, blocked workflow, safety).`,
    table,
    ...parts.dives.map((entry, index) =>
      dive(
        entry,
        parts.ranked.find((theme) => theme.theme === entry.theme),
        index,
      ),
    ),
  ];
  if (narrative.longTail) blocks.push('## Long tail', narrative.longTail.trim());
  if (parts.emergent.length || narrative.emergent) {
    blocks.push('## Emergent patterns');
    if (narrative.emergent) blocks.push(narrative.emergent.trim());
    if (parts.emergent.length)
      blocks.push(parts.emergent.map((pattern) => `- ${squash(pattern)}`).join('\n'));
  }
  if (parts.gaps.length)
    blocks.push('## Not covered', parts.gaps.map((gap) => `- ${gap}`).join('\n'));
  return `${blocks.filter(Boolean).join('\n\n')}\n`;
}
