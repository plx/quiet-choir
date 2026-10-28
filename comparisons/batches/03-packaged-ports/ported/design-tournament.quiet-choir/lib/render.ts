// The tournament record that code appends to the synthesized document: the numbers, the graft
// decisions and the dissent come from the workflow's own records, never from the synthesizer.
import type { Dissent, Graft, Philosophy, Standing } from '../contracts.js';

interface TournamentRecord {
  readonly scoreboard: Standing[];
  readonly grafts: Graft[];
  readonly dissent: Dissent[];
  readonly failedProposals: Philosophy[];
  readonly failedJudges: number[];
}

const axes = (standing: Standing) =>
  Object.entries(standing.axes)
    .map(([name, value]) => `${name} ${value.toFixed(1)}`)
    .join(', ');

/** The synthesized markdown followed by the code-owned tournament record. */
export function render(design: string, record: TournamentRecord): string {
  const lines = [design.trimEnd(), '', '## Tournament record', '', 'Scoreboard:', ''];
  for (const [rank, standing] of record.scoreboard.entries())
    lines.push(
      `${String(rank + 1)}. ${standing.letter}, ${standing.title} (${standing.philosophy}): ` +
        `${standing.avg.toFixed(1)} of 40 from ${String(standing.votes)} judges; ${axes(standing)}`,
    );
  lines.push('', 'Losing ideas the judges named:', '');
  if (!record.grafts.length) lines.push('- None.');
  for (const graft of record.grafts)
    lines.push(
      `- ${graft.id} from ${graft.from}, named by judges ${graft.judges.join(', ')}: ${graft.idea} ` +
        (graft.decision
          ? `(${graft.decision}: ${graft.reason ?? ''})`
          : '(undecided: the synthesis gave no decision)'),
    );
  lines.push('', 'Dissent:', '');
  if (!record.dissent.length) lines.push('- None: the panel was aligned on the winner.');
  for (const entry of record.dissent)
    lines.push(
      `- Judge ${String(entry.judge)} scored the winner ${String(entry.total)} of 40 ` +
        `(panel average ${entry.avg.toFixed(1)}): ${entry.rationale}`,
    );
  if (record.failedProposals.length || record.failedJudges.length)
    lines.push(
      '',
      `Failed: proposers ${record.failedProposals.join(', ') || 'none'}; ` +
        `judges ${record.failedJudges.join(', ') || 'none'}.`,
    );
  return lines.join('\n');
}
