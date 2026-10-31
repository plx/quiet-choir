// A run's toolchain in the merge-down and execute-epic-ticket packages (#735): the shell rules the
// bound roles get in place of npm's, and the prompt text that replaces the npm instructions.
import { describe, expect, it, vi } from 'vitest';

// The packages import `quiet-choir`, which resolves to dist/, and npm run check lints, typechecks
// and tests before it builds. So the imports map to src/ here, and the modules load by a computed
// specifier the root typecheck does not follow; the packages' own typecheck covers them.
vi.mock('quiet-choir', () => import('../src/index.js'));
vi.mock('quiet-choir/github', () => import('../src/integrations/github.js'));
vi.mock('quiet-choir/std', () => import('../src/std/index.js'));
const load = async <T>(path: string): Promise<T> => {
  const url = new URL(`../packages/${path}.ts`, import.meta.url);
  return (await import(url.href)) as T;
};

interface Toolchain {
  read: string[];
  edit: string[];
  guidance: string;
}
type Note = { read: string; edit: string; guidance: string } | null;
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
type Render = (params: Record<string, unknown>) => { text: string };
interface RosterModule {
  roster: Record<string, Bound>;
  toolchainAgents: (ctx: unknown, toolchain: Toolchain) => Record<string, Bound>;
}

const { Toolchain } = await load<{ Toolchain: { parse: (value: unknown) => Toolchain } }>(
  'merge-down.quiet-choir/contracts',
);
const { shellProse, toolchainNote } = await load<{
  shellProse: (rules: readonly string[]) => string;
  toolchainNote: (toolchain: Toolchain | undefined) => Note;
}>('merge-down.quiet-choir/lib/policy');
const mdRoster = await load<RosterModule>('merge-down.quiet-choir/roster');
const epicRoster = await load<RosterModule>('execute-epic-ticket.quiet-choir/roster');
const { prompts: mdPrompts } = await load<{ prompts: Record<string, Render> }>(
  'merge-down.quiet-choir/prompts',
);
const { prompts: epicPrompts } = await load<{ prompts: Record<string, Render> }>(
  'execute-epic-ticket.quiet-choir/prompts',
);

const swift = Toolchain.parse({
  read: ['Bash(swift package describe:*)'],
  edit: ['Bash(swift build:*)', 'Bash(swift test:*)', 'Bash(just reformat:*)'],
  guidance: 'Format with `just reformat`; run focused tests with `swift test --filter <Suite>`.',
});

/** A context whose claude.bind returns the options it was given. */
const binder = { claude: { bind: (options: unknown) => options } };
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
  ['merge-down', mdRoster, ['Reviewer', 'Judge', 'Scribe'], ['Mechanic', 'Surgeon']],
  ['execute-epic-ticket', epicRoster, ['Planner', 'Skeptic', 'Scribe'], ['Mechanic', 'Surgeon']],
] as const)('%s toolchainAgents', (_name, module, readers, editors) => {
  const staff = module.toolchainAgents(binder, swift);
  const entries = module.roster;

  it('keeps every role with its entry model, effort and limits', () => {
    expect(Object.keys(staff).sort()).toEqual(Object.keys(entries).sort());
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
    alsoCloses: [],
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
  const implement = (toolchain: Note) =>
    mdPrompts['Implement']?.({
      situation: { ...mdSituation, toolchain },
      standingNotes: [],
      items: [item],
      retry: false,
      repair: null,
    }).text ?? '';

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
    const text =
      epicPrompts['Implement']?.({
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
      }).text ?? '';
    expect(text).not.toMatch(/\bnpx\b|\bnpm\b|TypeDoc|CHANGELOG/);
    expect(text).toContain(swift.guidance);
    expect(text).toContain('(`just check`)');
  });
});
