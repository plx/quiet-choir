// The atlas document, assembled in code from the cards: the system map's edges are exactly the
// cards' dependsOn, every section renders its gotchas first, and what was not covered is listed.
import type { Synthesis } from '../contracts.js';
import { same, type Section } from './policy.js';

/** One line of agent text, safe inside a list item or a blockquote. */
const line = (text: string) => text.replace(/\s+/gu, ' ').trim();
/** A Mermaid label in double quotes. */
const label = (text: string) => `"${line(text).replace(/"/gu, '#quot;')}"`;

/**
 * A Mermaid flowchart of the sections and their dependsOn edges. A dependency naming a section is
 * an edge between sections; one naming a surveyed subsystem without a card is a dashed node marked
 * not deep-read, and any other is an external node, once per name.
 */
export function systemMap(sections: readonly Section[], uncarded: readonly string[] = []): string {
  const nodes = sections.map((section, index) => `  s${String(index)}[${label(section.name)}]`);
  const externals: string[] = [];
  const edges = new Set<string>();
  for (const [from, section] of sections.entries())
    for (const dependency of section.card.dependsOn) {
      const internal = sections.findIndex((other) => same(other.name, dependency));
      if (internal === from) continue;
      let target = `s${String(internal)}`;
      if (internal < 0) {
        let external = externals.findIndex((name) => same(name, dependency));
        if (external < 0) external = externals.push(line(dependency)) - 1;
        target = `x${String(external)}`;
      }
      edges.add(`  s${String(from)} --> ${target}`);
    }
  const outside = externals.map((name, index) => {
    const known = uncarded.find((other) => same(other, name));
    return known
      ? `  x${String(index)}[${label(`${known} (not deep-read)`)}]:::uncarded`
      : `  x${String(index)}([${label(name)}])`;
  });
  const styles = outside.some((node) => node.endsWith(':::uncarded'))
    ? ['  classDef uncarded stroke-dasharray: 4 4']
    : [];
  return ['```mermaid', 'flowchart LR', ...nodes, ...outside, ...edges, ...styles, '```'].join(
    '\n',
  );
}

const origins = {
  read: '',
  repaired: ', corrected by the completeness review',
  added: ', added by the completeness review',
};
function section(entry: Section): string {
  const { card } = entry;
  const kind = entry.importance ? `${entry.importance} subsystem` : 'section';
  const parts = [
    `### ${line(entry.name)}`,
    `_${kind[0]?.toUpperCase()}${kind.slice(1)}${origins[entry.origin]}._`,
  ];
  parts.push(card.purpose.trim());
  parts.push(
    card.gotchas.length
      ? ['> **Gotchas**', '>', ...card.gotchas.map((gotcha) => `> - ${line(gotcha)}`)].join('\n')
      : '> **Gotchas:** none recorded.',
  );
  if (card.keyFiles.length)
    parts.push(
      [
        '**Key files**',
        '',
        ...card.keyFiles.map((file) => `- \`${file.path}\`: ${line(file.role)}`),
      ].join('\n'),
    );
  if (card.entryPoints.length)
    parts.push(
      ['**Entry points**', '', ...card.entryPoints.map((entry) => `- ${line(entry)}`)].join('\n'),
    );
  parts.push(
    `**Depends on:** ${card.dependsOn.length ? card.dependsOn.map(line).join(', ') : 'nothing else listed'}`,
  );
  if (card.dataFlows?.trim()) parts.push(`**Data flow:** ${card.dataFlows.trim()}`);
  return parts.join('\n\n');
}

export interface AtlasDocument {
  readonly commit: string;
  readonly dirty: boolean;
  readonly synthesis: Synthesis;
  readonly sections: readonly Section[];
  /** Names the document lists as not covered; those that gained a section are left out. */
  readonly skipped: readonly string[];
  readonly unread: readonly string[];
  readonly unmatched: readonly string[];
}

/** Render the whole atlas, ending with one newline. */
export function render(atlas: AtlasDocument): string {
  const has = (name: string) => atlas.sections.some((entry) => same(entry.name, name));
  const missing = [
    ['Skipped by the deep-read cap', atlas.skipped.filter((name) => !has(name))],
    ['Not deep-read because the reader failed', atlas.unread.filter((name) => !has(name))],
    ['Surveyed, but matching no tracked file', atlas.unmatched.filter((name) => !has(name))],
  ] as const;
  const notCovered = missing
    .filter(([, names]) => names.length)
    .map(([why, names]) => `- ${why}: ${names.map(line).join(', ')}.`);
  const provenance = `This atlas describes commit \`${atlas.commit}\`.${atlas.dirty ? ' The checkout had uncommitted changes to tracked files, which the readers may have seen.' : ''}`;
  const blocks = [
    '# Codebase atlas',
    provenance,
    '## What this is',
    atlas.synthesis.overview.trim(),
    '## System map',
    systemMap(atlas.sections, [...atlas.skipped, ...atlas.unread]),
    '## Subsystems',
    ...atlas.sections.map(section),
    '## Start here',
    atlas.synthesis.startHere.length
      ? atlas.synthesis.startHere
          .map((entry, index) => `${String(index + 1)}. \`${entry.path}\`: ${line(entry.why)}`)
          .join('\n')
      : 'No verified key file to start from.',
    ...(notCovered.length ? ['## Not covered', notCovered.join('\n')] : []),
  ];
  return `${blocks.join('\n\n')}\n`;
}
