// Pure rules over the spec markdown: the required level-2 structure, the decision IDs the
// Decisions section must name, and the open questions read back from the final document. Lines
// inside fenced code blocks are never headings or questions.

/** The spec's level-2 headings, once each and in this order (the upstream's structure). */
export const HEADINGS = [
  'Overview',
  'Decisions',
  'Data model',
  'API contracts',
  'Architecture',
  'Behavior & edge semantics',
  'Operations',
  'Out of scope',
  'Open questions',
] as const;

const normal = (text: string) => text.trim().replace(/\s+/gu, ' ').toLowerCase();
const required = new Set(HEADINGS.map(normal));

/** The lines outside fenced code blocks, each with its level-2 heading name when it is one. */
function prose(spec: string): { line: string; heading: string | null }[] {
  const lines: { line: string; heading: string | null }[] = [];
  let fence: string | null = null;
  for (const line of spec.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence !== null) {
      if (marker?.startsWith(fence)) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const heading = /^ {0,3}## +(.*?)(?: +#+)? *$/u.exec(line)?.[1];
    lines.push({ line, heading: heading === undefined ? null : normal(heading) });
  }
  return lines;
}

/** The prose lines of one required section, empty when the heading is absent. */
function section(spec: string, name: (typeof HEADINGS)[number]): string[] {
  const lines = prose(spec);
  const start = lines.findIndex((entry) => entry.heading === normal(name));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((entry) => entry.heading !== null);
  return (end < 0 ? rest : rest.slice(0, end)).map((entry) => entry.line);
}

/**
 * Why a spec does not have the required structure: the nine headings once each in order (other
 * level-2 headings may sit between them), and every contested decision ID in the Decisions section.
 */
export function structureProblems(spec: string, ids: readonly string[]): string[] {
  const found = prose(spec)
    .map((entry) => entry.heading)
    .filter((heading): heading is string => heading !== null && required.has(heading));
  const problems =
    found.join('\n') === HEADINGS.map(normal).join('\n')
      ? []
      : [`Use these level-2 headings once each, in this order: ${HEADINGS.join(' / ')}`];
  const decisions = section(spec, 'Decisions').join('\n');
  const missing = ids.filter((id) => !new RegExp(`\\b${id}\\b`, 'u').test(decisions));
  if (missing.length)
    problems.push(
      `Name every contested decision in the Decisions section; missing ${missing.join(', ')}`,
    );
  return problems;
}

/** The bullets of the Open questions section, as plain text; a sentence there is not a question. */
export const openQuestions = (spec: string): string[] =>
  section(spec, 'Open questions').flatMap((line) => {
    const item = /^ {0,3}(?:[-*+]|\d+[.)]) +(.+)$/u.exec(line)?.[1]?.trim();
    return item ? [item] : [];
  });
