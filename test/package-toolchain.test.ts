// A run's toolchain in the merge-down and execute-epic-ticket packages (#735): the shell rules the
// bound roles get in place of npm's, and the prompt text that replaces the npm instructions.
import { describe, expect, it } from 'vitest';
import {
  roster as epicRoster,
  toolchainAgents as epicAgents,
} from '../packages/execute-epic-ticket.quiet-choir/roster.js';
import { prompts as epicPrompts } from '../packages/execute-epic-ticket.quiet-choir/prompts.js';
import { Toolchain } from '../packages/merge-down.quiet-choir/contracts.js';
import { shellProse, toolchainNote } from '../packages/merge-down.quiet-choir/lib/policy.js';
import { prompts as mdPrompts } from '../packages/merge-down.quiet-choir/prompts.js';
import {
  roster as mdRoster,
  toolchainAgents as mdAgents,
} from '../packages/merge-down.quiet-choir/roster.js';

const swift = Toolchain.parse({
  read: ['Bash(swift package describe:*)'],
  edit: ['Bash(swift build:*)', 'Bash(swift test:*)', 'Bash(just reformat:*)'],
  guidance: 'Format with `just reformat`; run focused tests with `swift test --filter <Suite>`.',
});

/** A context whose claude.bind returns the options it was given. */
const binder = { claude: { bind: (options: unknown) => options } } as never;
interface Bound {
  model: string;
  effort: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
}
const npm = (rules: readonly string[]) => rules.filter((r) => /\b(npm|npx|node)\b/.test(r));

describe('shellProse and toolchainNote', () => {
  it('lists the commands of Bash rules and drops other tools and duplicates', () => {
    expect(
      shellProse(['Read', 'Bash(swift build:*)', 'Bash(just reformat)', 'Bash(swift build:*)']),
    ).toBe('`swift build`, `just reformat`');
  });

  it('is null without a toolchain and prose with one', () => {
    expect(toolchainNote(undefined)).toBeNull();
    expect(toolchainNote(swift)).toEqual({
      read: '`swift package describe`',
      edit: '`swift build`, `swift test`, `just reformat`',
      guidance: swift.guidance,
    });
  });
});

describe.each([
  ['merge-down', mdRoster, mdAgents, ['Reviewer', 'Judge', 'Scribe'], ['Mechanic', 'Surgeon']],
  [
    'execute-epic-ticket',
    epicRoster,
    epicAgents,
    ['Planner', 'Skeptic', 'Scribe'],
    ['Mechanic', 'Surgeon'],
  ],
] as const)('%s toolchainAgents', (_name, roster, agents, readers, editors) => {
  const staff = agents(binder, swift) as unknown as Record<string, Bound>;
  const entries = roster as unknown as Record<string, Bound>;

  it('keeps every role with its entry model, effort and limits', () => {
    expect(Object.keys(staff).sort()).toEqual(Object.keys(roster).sort());
    for (const [name, bound] of Object.entries(staff)) {
      const entry = entries[name];
      expect(entry).toBeDefined();
      expect(bound).toMatchObject({
        model: entry?.model,
        effort: entry?.effort,
        maxTurns: entry?.maxTurns,
        maxBudgetUsd: entry?.maxBudgetUsd,
        timeoutMs: entry?.timeoutMs,
        disallowedTools: entry?.disallowedTools,
      });
    }
  });

  it("replaces the npm rules with the toolchain's and keeps the git and gh rules", () => {
    for (const name of [...readers, ...editors]) {
      const bound = staff[name];
      const entry = entries[name];
      expect(npm(entry?.allowedTools ?? []).length).toBeGreaterThan(0);
      expect(npm(bound?.allowedTools ?? [])).toEqual([]);
      expect(bound?.allowedTools).toEqual(
        expect.arrayContaining([...swift.read, 'Bash(git log:*)']),
      );
      expect(bound?.allowedTools.some((r) => r.startsWith('Bash(gh '))).toBe(true);
    }
    for (const name of readers) {
      expect(staff[name]?.allowedTools).not.toContain('Bash(swift build:*)');
      expect(staff[name]?.allowedTools).not.toContain('Edit');
    }
    for (const name of editors)
      expect(staff[name]?.allowedTools).toEqual(
        expect.arrayContaining([...swift.edit, 'Edit', 'Bash(git commit:*)']),
      );
  });
});

describe('toolchain prompts', () => {
  const mdSituation = {
    repo: 'acme/widgets',
    pr: 7,
    title: 'T',
    url: 'https://github.com/acme/widgets/pull/7',
    issue: null,
    base: 'main',
    worktree: '/w',
    branch: 'b',
    dir: '/d',
    upstreamDelta: false,
  };
  const item = {
    key: 'k',
    severity: 'major',
    source: 's',
    title: 't',
    plan: 'p',
    detail: '',
    files: [],
  };
  const implement = (toolchain: ReturnType<typeof toolchainNote>) =>
    mdPrompts.Implement({
      situation: { ...mdSituation, toolchain },
      standingNotes: [],
      items: [item],
      retry: false,
      repair: null,
    }).text;

  it('keeps the npm instructions without a toolchain', () => {
    const text = implement(null);
    expect(text).toContain('`npx eslint --fix <files> && npx prettier --write <files>`');
    expect(text).not.toContain("This repository's toolchain");
  });

  it("renders the toolchain's allowlist and guidance instead of npm's", () => {
    const text = implement(toolchainNote(swift));
    expect(text).not.toMatch(/\bnpx\b|\bnpm\b/);
    expect(text).toContain('`swift package describe`');
    expect(text).toContain('`swift build`, `swift test`, `just reformat`');
    expect(text).toContain(swift.guidance);
  });

  it('does the same for the epic implementer, and drops this repository-specific guidance', () => {
    const text = epicPrompts.Implement({
      situation: {
        repo: 'acme/widgets',
        epic: { number: 4, title: 'E' },
        ticket: { number: 5, title: 'T' },
        branch: 'b',
        worktree: '/w',
        base: 'main',
        dir: '/d',
        planFile: '/d/plan.json',
        toolchain: toolchainNote(swift),
      },
      standingNotes: [],
      plan: '{}',
      planFile: '/d/plan.json',
      commitTrailer: '',
      checkCommand: 'just check',
      retry: false,
      followup: null,
    }).text;
    expect(text).not.toMatch(/\bnpx\b|\bnpm\b|TypeDoc|CHANGELOG/);
    expect(text).toContain(swift.guidance);
    expect(text).toContain('(`just check`)');
  });
});
