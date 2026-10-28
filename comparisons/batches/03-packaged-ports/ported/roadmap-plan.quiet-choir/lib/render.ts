// The roadmap document, rendered by code from the final plan: the strategy statement, a milestone
// table, the critical path, the risk register, the stress-test accounting and the tournament.
import type { Capability, RoadmapOutput } from '../contracts.js';

const cell = (text: string) => text.replace(/\s+/gu, ' ').replace(/\|/gu, '\\|');
/** Agent text as a sentence: one line, ending in a full stop unless it ends in punctuation. */
const sentence = (text: string) => {
  const line = cell(text).trim();
  return /[.!?]$/u.test(line) ? line : `${line}.`;
};
const count = (n: number, noun: string) => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/** The markdown roadmap, with one trailing newline. */
export function render(output: Omit<RoadmapOutput, 'roadmap' | 'written'>): string {
  const named = new Map<string, Capability>(output.capabilities.map((c) => [c.id, c]));
  const label = (id: string) => `${id} ${named.get(id)?.name ?? ''}`.trim();
  const milestoneOf = (id: string) => {
    const index = output.milestones.findIndex((m) => m.capabilities.includes(id));
    return index < 0 ? 'deferred' : `milestone ${String(index + 1)}`;
  };
  const source = output.spec.path ?? 'inline spec text';
  const pick = output.pick;
  const stress = output.stress;
  const applied = stress?.problems.filter((problem) => problem.action === 'applied').length ?? 0;
  const lines = [
    '# Roadmap',
    '',
    `Planned from ${source} (sha256 ${output.spec.sha256.slice(0, 12)}); status: ${output.status}. Strategy: ${output.strategy ?? 'none'}${pick ? ', picked by the panel' : ', the only plan that competed'}.`,
    '',
    output.statement ?? 'No strategy statement.',
    '',
    '| Milestone | Goal | Capabilities | Exit gate | Key risks |',
    '| --- | --- | --- | --- | --- |',
    ...output.milestones.map(
      (m, index) =>
        `| ${String(index + 1)}. ${cell(m.name)} | ${cell(m.goal)} | ${cell(m.capabilities.map(label).join(', '))} | ${cell(m.gate)} | ${cell(m.keyRisks.join('; ') || 'none named')} |`,
    ),
    '',
    output.deferred.length
      ? `Deferred beyond the horizon: ${output.deferred.map(label).join(', ')}.`
      : 'Nothing is deferred beyond the horizon.',
    ...(output.criticalPath
      ? [
          '',
          '## Critical path',
          '',
          `${output.criticalPath.capabilities.map((id) => `${label(id)} (${milestoneOf(id)})`).join(' -> ')}: ${String(output.criticalPath.points)} points by size (S 1, M 2, L 3, XL 5).`,
        ]
      : []),
    '',
    '## Risk register',
    '',
    ...(output.risks.length
      ? [
          '| Capability | De-risked in |',
          '| --- | --- |',
          ...output.risks.map(
            (risk) => `| ${cell(label(risk.capability))} | ${cell(risk.milestone ?? 'deferred')} |`,
          ),
        ]
      : ['No capability is rated high-risk.']),
    '',
    '## Stress test',
    '',
    stress && stress.problems.length
      ? `The critic found ${count(stress.problems.length, 'problem')} in the ${output.strategy ?? ''} plan; ${String(applied)} applied, ${String(stress.problems.length - applied)} declined. The revised plan was not stress-tested again.`
      : 'The critic found no problems in the winning plan.',
    ...(stress?.problems.length
      ? [
          '',
          ...stress.problems.map(
            (problem, index) =>
              `${String(index + 1)}. ${problem.kind} (${problem.action}): ${sentence(problem.detail)} Fix: ${sentence(problem.fix)} Resolution: ${sentence(problem.note)}`,
          ),
        ]
      : []),
    ...(output.graft
      ? [
          '',
          `Graft from ${output.graft.from} (${output.graft.action}): ${sentence(output.graft.idea)} Resolution: ${sentence(output.graft.note)}`,
        ]
      : []),
    '',
    '## Tournament',
    '',
    ...(pick
      ? pick.scores.map(
          (score) =>
            `- ${score.strategy}: ${String(score.score)}/10${score.strategy === pick.winner ? ' (winner)' : ''}. ${sentence(score.why)}`,
        )
      : [`- ${output.strategy ?? 'none'}: unscored; no other strategy competed.`]),
    ...output.failedStrategies.map(
      (failure) => `- ${failure.strategy}: failed (${failure.kind}); it did not compete.`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
