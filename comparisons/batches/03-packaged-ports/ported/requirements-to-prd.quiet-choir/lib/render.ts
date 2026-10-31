// The PRD document, rendered by code from the writer's structured reply in the upstream's section
// order, with requirements numbered and traced to the findings listed in a traceability appendix;
// and the bounded details of a question round.
import type { Finding, OpenQuestion, Prd } from '../contracts.js';

const traced = (ids: readonly string[]) => (ids.length ? ` (${ids.join(', ')})` : '');
const bullets = (items: readonly string[]) =>
  items.length ? items.map((i) => `- ${i}`) : ['None.'];

/** The markdown PRD; `provenance` is a closing note for the published document. One final newline. */
export function render(prd: Prd, findings: readonly Finding[], provenance: string | null = null) {
  const must = prd.requirements.filter((requirement) => requirement.priority === 'must');
  const should = prd.requirements.filter((requirement) => requirement.priority === 'should');
  const numbered = (list: typeof must, from: number) =>
    list.map((r, index) => `- R${String(from + index)}. ${r.text}${traced(r.findings)}`);
  const lines = [
    `# ${prd.title}`,
    '',
    '## Problem and context',
    '',
    prd.problem,
    '',
    '## Goals and success metrics',
    '',
    ...bullets(prd.goals.map((g) => `${g.goal} (metric: ${g.metric ?? 'none stated yet'})`)),
    '',
    '## Users and jobs',
    '',
    ...bullets(prd.users.map((u) => `${u.user}: ${u.job}`)),
    '',
    '## Requirements',
    '',
    '### Must',
    '',
    ...(must.length ? numbered(must, 1) : ['None.']),
    '',
    '### Should',
    '',
    ...(should.length ? numbered(should, must.length + 1) : ['None.']),
    '',
    '## Non-functional requirements',
    '',
    ...bullets(
      prd.nonFunctional.map((n, index) => `N${String(index + 1)}. ${n.text}${traced(n.findings)}`),
    ),
    '',
    '## Explicitly out of scope',
    '',
    ...bullets(prd.outOfScope),
    '',
    '## Open questions',
    '',
    ...(prd.openQuestions.length
      ? prd.openQuestions.map(
          (q, index) => `${String(index + 1)}. ${q.question} Consequences: ${q.consequences}`,
        )
      : ['None.']),
    '',
    '## Assumptions',
    '',
    ...bullets(prd.assumptions.map((a) => `${a.text}${traced(a.findings)}`)),
    '',
    '## Traceability',
    '',
    ...bullets(
      findings.map(
        (f) =>
          `${f.id} [${f.lens}, ${f.confidence}${f.source ? `, ${f.source}` : ''}]: ${f.point}${f.quote ? ` ("${f.quote}")` : ''}`,
      ),
    ),
    ...(provenance ? ['', provenance] : []),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The numbered open questions with their consequences (an unknown has none), cut at a line to fit
 * a question's 16 KiB details; the subject has them all.
 */
export function questionDetails(questions: readonly OpenQuestion[]): string {
  const lines: string[] = [];
  let bytes = 0;
  for (const [index, q] of questions.entries()) {
    const consequences = q.consequences === null ? '' : ` Consequences: ${q.consequences}`;
    const line = `${String(index + 1)}. ${q.question}${consequences}`;
    if (bytes + Buffer.byteLength(line) + 1 > 15_000) {
      lines.push(
        `...and ${String(questions.length - index)} more; the question's subject lists them all.`,
      );
      break;
    }
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
  }
  return lines.join('\n');
}
