// The backlog document, rendered by code from the final backlog: a summary table, each ticket
// with its description and acceptance criteria, sequencing, coverage and open questions.
import type { PrdDecomposeOutput } from '../contracts.js';

const cell = (text: string) => text.replace(/\s+/gu, ' ').replace(/\|/gu, '\\|');
const list = (ids: readonly string[]) => (ids.length ? ids.join(', ') : 'none');

/** The markdown backlog; one trailing newline. */
export function render(output: Omit<PrdDecomposeOutput, 'written'>): string {
  const source = output.prd.path ?? 'inline PRD text';
  const coverage = output.coverage;
  const lines = [
    '# Backlog',
    '',
    `Decomposed from ${source} (sha256 ${output.prd.sha256.slice(0, 12)}); status: ${output.status}.`,
    '',
    '| ID | Title | Lane | Estimate | Depends on |',
    '| --- | --- | --- | --- | --- |',
    ...output.tickets.map(
      (ticket) =>
        `| ${ticket.id} | ${cell(ticket.title)} | ${ticket.lane} | ${ticket.estimate} | ${list(ticket.dependsOn)} |`,
    ),
    ...output.tickets.flatMap((ticket) => [
      '',
      `## ${ticket.id}: ${ticket.title}`,
      '',
      `Lane ${ticket.lane}, estimate ${ticket.estimate}, depends on ${list(ticket.dependsOn)}.`,
      '',
      ticket.description,
      '',
      'Acceptance criteria:',
      '',
      ...ticket.acceptanceCriteria.map((criterion) => `- ${criterion}`),
      '',
      `PRD anchors: ${ticket.prdAnchors.map((anchor) => `"${anchor}"`).join('; ')}`,
    ]),
    '',
    '## Sequencing',
    '',
    output.sequencing ?? 'No sequencing.',
    '',
    `Dependency waves: ${output.waves.map((wave, index) => `${String(index + 1)}) ${wave.join(', ')}`).join('; ')}.`,
    ...(output.criticalPath
      ? [
          '',
          `Critical path: ${output.criticalPath.tickets.join(' -> ')} (${String(output.criticalPath.days)} days by estimate).`,
        ]
      : []),
    '',
    '## Coverage',
    '',
    coverage
      ? `${String(coverage.audits)} audit(s), ${String(coverage.repairs)} repair(s); ${coverage.covered ? 'the final backlog passed the coverage audit.' : 'the final backlog did not pass a coverage audit.'}`
      : 'Not audited.',
    ...(coverage?.failure
      ? [
          '',
          coverage.failure.stage === 'audit'
            ? 'The coverage audit failed, so no audit read the final backlog.'
            : 'The repair failed, so the gaps below remain.',
        ]
      : []),
    ...(coverage?.gaps.length
      ? [
          '',
          'Open gaps:',
          '',
          ...coverage.gaps.map(
            (gap) =>
              `- ${gap.problem}${gap.ticket ? ` (${gap.ticket})` : ''}: "${gap.prdRequirement}"`,
          ),
        ]
      : []),
    ...(output.failedLenses.length
      ? ['', `Failed lenses: ${output.failedLenses.join(', ')}.`]
      : []),
    '',
    '## Open questions',
    '',
    ...(output.openQuestions.length
      ? output.openQuestions.map((question) => `- ${question}`)
      : ['None.']),
  ];
  return `${lines.join('\n')}\n`;
}
