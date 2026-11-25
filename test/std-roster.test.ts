// quiet-choir/std roster side: std.bash rules, the std.claude web and shell fragments, std.limits,
// std.personas, std.roles and std.rosters. Every entry is golden-tested through the capability
// manifest of a workflow that uses it (the access class the runtime derives, and the values it
// resolves), and the shell fragments reproduce the hand-written blocks of the bundled package
// rosters exactly. The type assertions are checked by `npm run typecheck`: a workflow body that
// never runs holds one `@ts-expect-error` per rejected entry.
import { createHash } from 'node:crypto';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  defineRoster,
  defineWorkflow,
  z,
  type Agent,
  type AnyRoster,
  type CapabilityManifest,
} from '../src/index.js';
import { digest } from '../src/workflow/runtime/json.js';
import { capabilityManifest } from '../src/workflow/runtime/profiles.js';
import * as bash from '../src/std/bash.js';
import * as claude from '../src/std/claude.js';
import * as codex from '../src/std/codex.js';
import * as limits from '../src/std/limits.js';
import * as personas from '../src/std/personas.js';
import * as roles from '../src/std/roles.js';
import * as rosters from '../src/std/rosters.js';
import * as tiers from '../src/std/tiers.js';

// The package rosters import `quiet-choir` and `quiet-choir/std`, which resolve to dist/; map them
// to src/ as the package suites do. They read only std.tiers.
vi.mock('quiet-choir', () => import('../src/index.js'));
vi.mock('quiet-choir/std', async () => ({ tiers: await import('../src/std/tiers.js') }));

const base = { version: '1', input: z.null(), output: z.null() } as const;

/** The capability manifest of a workflow with `roster`. */
function manifest(roster: AnyRoster, requireGrants = false): CapabilityManifest {
  const workflow = defineWorkflow({
    ...base,
    name: 'std-roster-golden',
    roster,
    run: () => Promise.resolve(null),
  });
  return capabilityManifest(workflow, { requireGrants });
}

/** The resolved `Entry` of a workflow with `roster`. */
function entryRow(roster: AnyRoster): CapabilityManifest['defaults'] {
  const resolved = manifest(roster).profiles['Entry'];
  if (resolved === undefined) throw new Error('missing manifest row');
  return resolved;
}

/** A package roster module, loaded through the mocks above. */
async function packageRoster(name: string): Promise<Readonly<Record<string, unknown>>> {
  const url = new URL(`../packages/${name}.quiet-choir/roster.ts`, import.meta.url);
  const module = (await import(url.href)) as { roster: Readonly<Record<string, unknown>> };
  return module.roster;
}

/** The capability keys of a package roster entry, for comparison with a std fragment. */
function capabilityKeys(entry: unknown): unknown {
  const { tools, allowedTools, disallowedTools } = entry as Record<string, unknown>;
  return { tools, allowedTools, disallowedTools };
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('std.bash', () => {
  it('builds prefix rules from command words', () => {
    expect(bash.rule('git', 'log')).toBe('Bash(git log:*)');
    expect(bash.rule('ls')).toBe('Bash(ls:*)');
    expect(bash.rule('git', '-c', 'core.editor=true', 'rebase', '--continue')).toBe(
      'Bash(git -c core.editor=true rebase --continue:*)',
    );
    expect(bash.npmRun('build', 'packages:rehearse')).toEqual([
      'Bash(npm run build:*)',
      'Bash(npm run packages:rehearse:*)',
    ]);
    expect(Object.isFrozen(bash.npmRun('lint'))).toBe(true);
  });

  it.each([
    [''],
    [' git'],
    ['git '],
    ['  '],
    ['git)'],
    ['(git'],
    ['git\nlog'],
    ['git\u0000'],
    ['git\u0085'],
    ['git*'],
    ['*'],
  ])('refuses the command word %j', (word) => {
    expect(() => bash.rule(word)).toThrow(TypeError);
    expect(() => bash.rule('git', word)).toThrow(/std\.bash\.rule: .* must be a nonempty/u);
    expect(() => bash.npmRun(word)).toThrow(/std\.bash\.npmRun: /u);
  });

  it('refuses an empty word list from an untyped caller', () => {
    expect(() => {
      Reflect.apply(bash.rule, undefined, []);
    }).toThrow(TypeError);
    expect(() => {
      Reflect.apply(bash.npmRun, undefined, []);
    }).toThrow(TypeError);
  });

  it('has the documented rule sets', () => {
    expect(bash.gitRead).toEqual([
      'Bash(git log:*)',
      'Bash(git diff:*)',
      'Bash(git show:*)',
      'Bash(git status:*)',
      'Bash(git rev-parse:*)',
      'Bash(git blame:*)',
      'Bash(git ls-files:*)',
      'Bash(git grep:*)',
    ]);
    expect(bash.ghRead).toEqual([
      'Bash(gh issue view:*)',
      'Bash(gh issue list:*)',
      'Bash(gh pr view:*)',
      'Bash(gh pr list:*)',
      'Bash(gh pr checks:*)',
      'Bash(gh pr diff:*)',
      'Bash(gh run view:*)',
    ]);
    expect(bash.files).toEqual(['Bash(ls:*)', 'Bash(wc:*)']);
    expect(bash.nodeCheck).toEqual([
      'Bash(npx tsc:*)',
      'Bash(npx eslint:*)',
      'Bash(npx prettier:*)',
      'Bash(npx vitest:*)',
      'Bash(node --test:*)',
    ]);
    expect(bash.pythonCheck).toEqual([
      'Bash(pytest:*)',
      'Bash(python -m pytest:*)',
      'Bash(python3 -m pytest:*)',
      'Bash(ruff:*)',
      'Bash(mypy:*)',
    ]);
    expect(bash.cargoCheck).toEqual([
      'Bash(cargo check:*)',
      'Bash(cargo test:*)',
      'Bash(cargo clippy:*)',
      'Bash(cargo fmt:*)',
    ]);
    expect(bash.goCheck).toEqual([
      'Bash(go build:*)',
      'Bash(go test:*)',
      'Bash(go vet:*)',
      'Bash(gofmt:*)',
    ]);
    expect(bash.gitCommit).toEqual([
      'Bash(git add:*)',
      'Bash(git commit:*)',
      'Bash(git rm:*)',
      'Bash(git mv:*)',
    ]);
    expect(bash.gitRebase).toEqual([
      'Bash(git checkout --ours:*)',
      'Bash(git checkout --theirs:*)',
      'Bash(git -c core.editor=true rebase --continue:*)',
    ]);
    expect(bash.npmInstall).toEqual(['Bash(npm ci:*)', 'Bash(npm install:*)']);
    expect(bash.noPush).toEqual(['Bash(git push:*)']);
    expect(bash.noRewrite).toEqual([
      'Bash(git push:*)',
      'Bash(git reset:*)',
      'Bash(git rebase:*)',
      'Bash(git clean:*)',
      'Bash(git restore:*)',
      'Bash(git stash:*)',
      'Bash(git commit --amend:*)',
      'Bash(git branch -D:*)',
      'Bash(git branch -f:*)',
      'Bash(git filter-branch:*)',
      'Bash(git update-ref:*)',
    ]);
  });

  it('keeps every set duplicate-free, and noRewrite denies nothing the allow sets approve', () => {
    const allow = [
      bash.gitRead,
      bash.ghRead,
      bash.files,
      bash.nodeCheck,
      bash.pythonCheck,
      bash.cargoCheck,
      bash.goCheck,
      bash.gitCommit,
      bash.gitRebase,
      bash.npmInstall,
    ];
    for (const set of [...allow, bash.noPush, bash.noRewrite])
      expect(new Set(set).size).toBe(set.length);
    const command = (rule: string): string => rule.slice('Bash('.length, -':*)'.length);
    for (const denied of bash.noRewrite)
      for (const allowed of allow.flat())
        expect(command(allowed).startsWith(command(denied)), `${denied} denies ${allowed}`).toBe(
          false,
        );
    expect(bash.noRewrite).toEqual(expect.arrayContaining([...bash.noPush]));
  });
});

describe('std.claude shells and Web', () => {
  it('Web reads files and the web with the read-only limits, at read access', () => {
    const entry = entryRow(defineRoster({ Entry: claude.Web }));
    expect(entry.harness).toBe('claude');
    expect(entry.claude.tools).toEqual(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);
    expect([entry.maxTurns, entry.maxBudgetUsd, entry.timeoutMs]).toEqual([25, 2, 900_000]);
    expect(entry.access).toBe('read');
  });

  it('shell narrows Bash to its rules, denies git push by default and is exec access', () => {
    const fragment = claude.shell([...bash.gitRead, ...bash.files]);
    expect(fragment).toEqual({
      harness: 'claude',
      description: 'Reads files and runs allowlisted commands.',
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      allowedTools: ['Read', 'Grep', 'Glob', ...bash.gitRead, ...bash.files],
      disallowedTools: ['Bash(git push:*)'],
      maxTurns: 25,
      maxBudgetUsd: 2,
      timeoutMs: 900_000,
    });
    const entry = entryRow(defineRoster({ Entry: fragment }));
    expect(entry.access).toBe('exec');
    expect(entry.claude.allowedTools).toEqual(fragment.allowedTools);
    expect(entry.claude.disallowedTools).toEqual(['Bash(git push:*)']);
  });

  it('editShell adds Edit and Write with the edit limits, and takes a deny list', () => {
    const fragment = claude.editShell([...bash.nodeCheck, ...bash.gitCommit], bash.noRewrite);
    expect(fragment).toMatchObject({
      harness: 'claude',
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', ...bash.nodeCheck, ...bash.gitCommit],
      disallowedTools: [...bash.noRewrite],
      maxTurns: 40,
      maxBudgetUsd: 5,
      timeoutMs: 1_800_000,
    });
    const entry = entryRow(
      defineRoster({ Entry: { ...fragment, ...tiers.Mechanic, ...personas.Implementer } }),
    );
    expect(entry.access).toBe('exec');
    expect(entry.claude.model).toBe('sonnet');
    expect(entry.description).toBe(personas.Implementer.description);
  });

  it('freezes what the shells return and drops duplicate rules, keeping first positions', () => {
    const fragment = claude.editShell([...bash.gitRead, bash.rule('ls'), ...bash.gitRead], []);
    expect(fragment.allowedTools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Edit',
      'Write',
      ...bash.gitRead,
      'Bash(ls:*)',
    ]);
    expect(fragment.disallowedTools).toEqual([]);
    for (const value of [fragment, fragment.tools, fragment.allowedTools, fragment.disallowedTools])
      expect(Object.isFrozen(value)).toBe(true);
    const deny = ['Bash(rm:*)', 'Bash(rm:*)'];
    expect(claude.shell(bash.files, deny).disallowedTools).toEqual(['Bash(rm:*)']);
  });

  it('accepts a deny rule that only narrows an allowed rule, or shares a prefix but not a word', () => {
    // `git commit --amend` narrows `git commit`; `git pushes` is not the command `git push`; an
    // exact deny rule leaves the rest of a prefix rule approved.
    expect(claude.editShell(bash.gitCommit, bash.noRewrite).allowedTools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Edit',
      'Write',
      ...bash.gitCommit,
    ]);
    expect(claude.shell(['Bash(git pushes:*)']).disallowedTools).toEqual(bash.noPush);
    expect(claude.shell(['Bash(git log:*)'], ['Bash(git log)']).disallowedTools).toEqual([
      'Bash(git log)',
    ]);
  });

  it.each([
    ['no rules', [], undefined, /needs at least one Bash\(\.\.\.\) rule/u],
    ['a bare tool', ['Bash'], undefined, /rule "Bash" must be a Bash\(\.\.\.\) rule/u],
    ['another tool', ['WebFetch(domain:x.org)'], undefined, /must be a Bash\(\.\.\.\) rule/u],
    ['an empty pattern', ['Bash()'], undefined, /must be a Bash\(\.\.\.\) rule/u],
    ['a non-string rule', [3], undefined, /rule 3 must be a Bash/u],
    ['a denied rule', ['Bash(git push:*)'], undefined, /is both allowed and denied/u],
    [
      'a rule a prefix deny rule covers',
      ['Bash(git push --dry-run:*)'],
      undefined,
      /rule Bash\(git push --dry-run:\*\) is both allowed and denied \(by Bash\(git push:\*\)\)/u,
    ],
    [
      'an exact rule a prefix deny rule covers',
      [...bash.gitRead, 'Bash(git reset --hard)'],
      bash.noRewrite,
      /Bash\(git reset --hard\) is both allowed and denied \(by Bash\(git reset:\*\)\)/u,
    ],
    ['two rules in one string', ['Bash(ls:*), Bash(rm:*)'], undefined, /must be a Bash/u],
    ['a rule with a newline', ['Bash(git log\n:*)'], undefined, /must be a Bash/u],
    ['an empty deny rule', bash.files, [''], /deny rule "" must be a nonempty/u],
    ['a padded deny rule', bash.files, [' Bash(rm:*)'], /must be a nonempty permission rule/u],
    ['a deny string', bash.files, 'Bash(rm:*)', /deny must be an array/u],
  ])('refuses %s', (_label, rules, deny, message) => {
    // Called untyped: these are the values an untyped caller could pass.
    const call = (build: typeof claude.shell | typeof claude.editShell): unknown =>
      Reflect.apply(build, undefined, deny === undefined ? [rules] : [rules, deny]);
    expect(() => call(claude.shell)).toThrow(TypeError);
    expect(() => call(claude.shell)).toThrow(message);
    expect(() => call(claude.editShell)).toThrow(/^std\.claude\.editShell /u);
  });

  it('reproduces the reader and editor blocks of the bundled package rosters exactly', async () => {
    const epic = await packageRoster('execute-epic-ticket');
    const mergeDown = await packageRoster('merge-down');
    const gh = (commands: readonly string[]): string[] =>
      bash.ghRead.filter((rule) => commands.includes(rule.slice('Bash(gh '.length, -':*)'.length)));
    const epicInspect = [
      ...bash.gitRead,
      ...gh(['issue view', 'issue list', 'pr view', 'pr list', 'run view']),
      ...bash.files,
    ];
    const mergeInspect = [
      ...bash.gitRead,
      ...gh(['issue view', 'issue list', 'pr view', 'pr checks', 'run view']),
      ...bash.files,
    ];
    const reader = (inspect: readonly string[]): unknown =>
      capabilityKeys(claude.shell([...inspect, ...bash.nodeCheck]));
    const epicEditor = capabilityKeys(
      claude.editShell([
        ...epicInspect,
        ...bash.nodeCheck,
        ...bash.gitCommit,
        ...bash.npmInstall,
        ...bash.npmRun('build', 'typecheck', 'lint', 'packages:rehearse'),
      ]),
    );
    const mergeEditor = capabilityKeys(
      claude.editShell([
        ...mergeInspect,
        ...bash.nodeCheck,
        ...bash.gitCommit,
        ...bash.gitRebase,
        ...[...bash.npmInstall].reverse(),
      ]),
    );
    for (const name of ['Planner', 'Skeptic', 'Scribe'])
      expect(capabilityKeys(epic[name]), name).toEqual(reader(epicInspect));
    for (const name of ['Mechanic', 'Surgeon'])
      expect(capabilityKeys(epic[name]), name).toEqual(epicEditor);
    for (const name of ['Reviewer', 'Judge', 'Scribe'])
      expect(capabilityKeys(mergeDown[name]), name).toEqual(reader(mergeInspect));
    for (const name of ['Mechanic', 'Surgeon'])
      expect(capabilityKeys(mergeDown[name]), name).toEqual(mergeEditor);
    // Judge's local model and effort are std.tiers.Judge.
    expect(mergeDown['Judge']).toMatchObject({
      model: tiers.Judge.model,
      effort: tiers.Judge.effort,
    });
  });
});

describe('std.limits', () => {
  const expected = {
    Brief: [10, 0.5, 300_000],
    Standard: [25, 2, 900_000],
    Extended: [40, 5, 1_800_000],
    Hour: [100, 10, 3_600_000],
    Long: [200, 25, 7_200_000],
  } as const;

  it.each(Object.entries(expected))('%s resizes a Claude entry', (name, values) => {
    const fragment = limits[name as keyof typeof expected];
    expect(Object.keys(fragment).sort()).toEqual(['maxBudgetUsd', 'maxTurns', 'timeoutMs']);
    const entry = entryRow(defineRoster({ Entry: { ...roles.Planner, ...fragment } }));
    expect([entry.maxTurns, entry.maxBudgetUsd, entry.timeoutMs]).toEqual(values);
    expect(entry.access).toBe('read');
  });

  it('matches the text, read-only and edit limits', () => {
    const pick = ({ maxTurns, maxBudgetUsd, timeoutMs }: limits.Limits): limits.Limits => ({
      maxTurns,
      maxBudgetUsd,
      timeoutMs,
    });
    expect(limits.Brief).toEqual(pick(claude.Text));
    expect(limits.Standard).toEqual(pick(claude.ReadOnly));
    expect(limits.Extended).toEqual(pick(claude.Edit));
  });
});

/** Every persona, by name. */
const allPersonas = {
  Clerk: personas.Clerk,
  Scout: personas.Scout,
  Researcher: personas.Researcher,
  Reviewer: personas.Reviewer,
  Skeptic: personas.Skeptic,
  Critic: personas.Critic,
  Judge: personas.Judge,
  Planner: personas.Planner,
  Implementer: personas.Implementer,
  Surgeon: personas.Surgeon,
  Tester: personas.Tester,
  Scribe: personas.Scribe,
};

describe('std.personas', () => {
  it('has a Claude standing prompt for each role, and nothing else but join and ShellEtiquette', () => {
    expect(Object.keys(personas).sort()).toEqual(
      [...Object.keys(allPersonas), 'ShellEtiquette', 'join'].sort(),
    );
    for (const [name, persona] of Object.entries(allPersonas)) {
      expect(Object.keys(persona).sort(), name).toEqual([
        'appendSystemPrompt',
        'description',
        'harness',
      ]);
      expect(persona.harness).toBe('claude');
      expect(persona.description, name).not.toBe('');
      expect(persona.appendSystemPrompt, name).toMatch(/^You are an? /u);
      expect(persona.appendSystemPrompt, name).toBe(persona.appendSystemPrompt.trim());
      expect(persona.appendSystemPrompt, name).not.toMatch(/ {2}|\n/u);
    }
  });

  it('tells every role that should not change files never to edit them', () => {
    const readOnly = [
      'Clerk',
      'Scout',
      'Researcher',
      'Reviewer',
      'Skeptic',
      'Critic',
      'Judge',
      'Planner',
      'Tester',
      'Scribe',
    ] as const;
    for (const name of readOnly)
      expect(allPersonas[name].appendSystemPrompt, name).toMatch(/Never edit files\.$/u);
    for (const name of ['Implementer', 'Surgeon'] as const)
      expect(allPersonas[name].appendSystemPrompt, name).not.toMatch(/edit files/u);
  });

  it('tells the skeptical roles to return the safe default the prompt names', () => {
    for (const name of ['Skeptic', 'Critic', 'Judge'] as const)
      expect(allPersonas[name].appendSystemPrompt, name).toContain(
        'return the safe default the prompt names',
      );
  });

  // Persona text is part of the identity of every call that uses it: a change here must be a
  // deliberate, versioned decision, so the texts are pinned by digest.
  it('keeps the released persona texts byte-for-byte', () => {
    const digests = Object.fromEntries(
      Object.entries({
        ...allPersonas,
        ShellEtiquette: { appendSystemPrompt: personas.ShellEtiquette },
      }).map(([name, persona]) => [name, sha256(persona.appendSystemPrompt).slice(0, 16)]),
    );
    expect(digests).toEqual({
      Clerk: '52d30e2009848ee2',
      Scout: '239d6f282565a74d',
      Researcher: 'e23dda334d61bfe6',
      Reviewer: 'c5926a152d7b1081',
      Skeptic: 'c23578bf5e531b0d',
      Critic: '4169475ca82e404f',
      Judge: '3761920e2f6c3ed5',
      Planner: 'b2bebf3f8410d589',
      Implementer: 'db5ab09fc5512caf',
      Surgeon: '63d7bd0cdd3dae7e',
      Tester: '2a5c06da167c6929',
      Scribe: '1d9d35cc4c1bcd6a',
      ShellEtiquette: 'e8216f830aeac01b',
    });
  });

  it('joins texts with a blank line, trimming them and dropping empty ones', () => {
    expect(personas.join('A.', ' B. ', '', '  ', 'C.')).toBe('A.\n\nB.\n\nC.');
    expect(personas.join()).toBe('');
    expect(personas.join(personas.Tester.appendSystemPrompt, personas.ShellEtiquette)).toBe(
      `${personas.Tester.appendSystemPrompt}\n\n${personas.ShellEtiquette}`,
    );
  });

  it('composes a shell tester from a fragment, a tier, a persona and the shell etiquette', () => {
    const entry = entryRow(
      defineRoster({
        Entry: {
          ...claude.shell([...bash.gitRead, ...bash.nodeCheck]),
          ...tiers.Mechanic,
          ...personas.Tester,
          appendSystemPrompt: personas.join(
            personas.Tester.appendSystemPrompt,
            personas.ShellEtiquette,
          ),
        },
      }),
    );
    expect(entry.access).toBe('exec');
    expect(entry.description).toBe(personas.Tester.description);
    expect(entry.redacted?.claude?.appendSystemPrompt).toEqual({
      sha256: digest(`${personas.Tester.appendSystemPrompt}\n\n${personas.ShellEtiquette}`),
    });
  });
});

/** Each role's access class, harness, model and effort as the capability manifest resolves them. */
const roleTable = {
  Clerk: ['none', 'claude', 'haiku', 'low'],
  Writer: ['none', 'claude', 'sonnet', 'medium'],
  Scout: ['read', 'claude', 'sonnet', 'low'],
  Reader: ['read', 'claude', undefined, undefined],
  Researcher: ['read', 'claude', 'sonnet', 'medium'],
  Reviewer: ['read', 'claude', 'opus', 'high'],
  Skeptic: ['read', 'claude', 'opus', 'medium'],
  Critic: ['read', 'claude', 'opus', 'medium'],
  Judge: ['read', 'claude', 'opus', 'xhigh'],
  Planner: ['read', 'claude', 'opus', 'high'],
  Scribe: ['read', 'claude', 'sonnet', 'medium'],
  Editor: ['write', 'claude', undefined, undefined],
  Mechanic: ['write', 'claude', 'sonnet', 'high'],
  Surgeon: ['write', 'claude', 'opus', 'high'],
  CodexReader: ['read', 'codex', undefined, undefined],
  CodexReviewer: ['read', 'codex', undefined, 'high'],
  CodexEditor: ['write', 'codex', undefined, undefined],
  CodexMechanic: ['write', 'codex', undefined, 'high'],
} as const;
type RoleName = keyof typeof roleTable;

/** Each role's capability fragment and persona. */
const composition: Record<RoleName, readonly [object, personas.Persona | undefined]> = {
  Clerk: [claude.Text, personas.Clerk],
  Writer: [claude.Text, personas.Scribe],
  Scout: [claude.ReadOnly, personas.Scout],
  Reader: [claude.ReadOnly, undefined],
  Researcher: [claude.Web, personas.Researcher],
  Reviewer: [claude.ReadOnly, personas.Reviewer],
  Skeptic: [claude.ReadOnly, personas.Skeptic],
  Critic: [claude.ReadOnly, personas.Critic],
  Judge: [claude.ReadOnly, personas.Judge],
  Planner: [claude.ReadOnly, personas.Planner],
  Scribe: [claude.ReadOnly, personas.Scribe],
  Editor: [claude.Edit, undefined],
  Mechanic: [claude.Edit, personas.Implementer],
  Surgeon: [claude.Edit, personas.Surgeon],
  CodexReader: [codex.ReadOnly, undefined],
  CodexReviewer: [codex.ReadOnly, undefined],
  CodexEditor: [codex.Edit, undefined],
  CodexMechanic: [codex.Edit, undefined],
};

const claudeOnlyKeys = [
  'tools',
  'allowedTools',
  'disallowedTools',
  'maxTurns',
  'maxBudgetUsd',
  'appendSystemPrompt',
  'systemPrompt',
  'permissionMode',
];

describe('std.roles', () => {
  it('has exactly the documented roles', () => {
    expect(Object.keys(roles).sort()).toEqual(Object.keys(roleTable).sort());
  });

  it.each(Object.entries(roleTable))(
    '%s validates in a workflow at %s access',
    (name, [access, harness, model, effort]) => {
      const role = roles[name as RoleName];
      const entry = entryRow(defineRoster({ Entry: role }));
      expect(entry.access).toBe(access);
      expect(entry.harness).toBe(harness);
      const block = harness === 'claude' ? entry.claude : entry.codex;
      expect(block.model).toBe(model);
      expect(block.effort).toBe(effort);
      expect(entry.description).toBe(role.description);
      expect(role.description).not.toBe('');
    },
  );

  it.each(Object.entries(composition))(
    '%s spreads its capability and persona',
    (name, [capability, persona]) => {
      const role: object = roles[name as RoleName];
      const capabilityValues = Object.fromEntries(
        Object.entries(capability).filter(([key]) => key !== 'description'),
      );
      expect(role).toMatchObject(capabilityValues);
      if (persona === undefined) expect(role).not.toHaveProperty('appendSystemPrompt');
      else expect(role).toMatchObject({ ...persona });
      const entry = entryRow(defineRoster({ Entry: roles[name as RoleName] }));
      expect(entry.redacted?.claude?.appendSystemPrompt).toEqual(
        persona === undefined ? undefined : { sha256: digest(persona.appendSystemPrompt) },
      );
    },
  );

  it('carries no Claude keys on a Codex role', () => {
    for (const name of ['CodexReader', 'CodexReviewer', 'CodexEditor', 'CodexMechanic'] as const)
      for (const key of claudeOnlyKeys)
        expect(roles[name], `${name}.${key}`).not.toHaveProperty(key);
  });

  it('marks the writing roles as not expecting tool use', () => {
    expect(entryRow(defineRoster({ Entry: roles.Writer })).expectsToolUse).toBe(false);
    expect(entryRow(defineRoster({ Entry: roles.Scribe })).expectsToolUse).toBe(false);
    expect(entryRow(defineRoster({ Entry: roles.Planner })).expectsToolUse).toBe(true);
  });

  it('composes with limits and overrides by spread, and keeps the per-harness typing', () => {
    const roster = defineRoster({
      Planner: { ...roles.Planner, ...limits.Hour },
      Fixer: { ...roles.Mechanic, ...limits.Long, maxBudgetUsd: 15 },
      Checker: { ...roles.CodexReviewer, timeoutMs: 1_800_000 },
    });
    expect(roster.Planner).toMatchObject({ model: 'opus', maxTurns: 100, timeoutMs: 3_600_000 });
    expect(roster.Fixer).toMatchObject({ maxTurns: 200, maxBudgetUsd: 15 });
    defineWorkflow({
      ...base,
      name: 'std-roles-types',
      roster,
      async run(ctx) {
        expectTypeOf(ctx.roster.Planner).toExtend<Agent>();
        expectTypeOf(ctx.roster.Fixer).toExtend<Agent>();
        expectTypeOf(ctx.roster.Checker).toExtend<Agent>();
        // The body never runs: these rejected entries are typecheck assertions only.
        defineRoster({
          // @ts-expect-error -- maxTurns is a Claude-only limit.
          Turns: { ...roles.CodexReader, ...limits.Hour },
        });
        defineRoster({
          // @ts-expect-error -- a Codex entry has no standing system prompt.
          Persona: { ...roles.CodexReader, appendSystemPrompt: 'x' },
        });
        defineRoster({
          // @ts-expect-error -- a persona flips the harness to claude, leaving a Codex sandbox.
          Mixed: { ...codex.ReadOnly, ...personas.Skeptic },
        });
        await Promise.resolve();
        return null;
      },
    });
  });
});

describe('std.rosters', () => {
  it('readers holds every none and read role, and needs no grant', () => {
    const names = Object.keys(roleTable).filter(
      (name) =>
        roleTable[name as RoleName][0] === 'none' || roleTable[name as RoleName][0] === 'read',
    );
    expect(Object.keys(rosters.readers).sort()).toEqual(names.sort());
    const resolved = manifest(rosters.readers, true);
    for (const name of names) expect(['none', 'read']).toContain(resolved.profiles[name]?.access);
    expect(resolved.requiredGrants).toEqual([]);
    for (const name of names)
      expect(rosters.readers[name as keyof typeof rosters.readers]).toEqual(
        roles[name as RoleName],
      );
  });

  it('standard holds every role, and needs grants for the editing ones', () => {
    expect(Object.keys(rosters.standard).sort()).toEqual(Object.keys(roles).sort());
    const resolved = manifest(rosters.standard, true);
    for (const [name, [access]] of Object.entries(roleTable))
      expect(resolved.profiles[name]?.access, name).toBe(access);
    expect([...resolved.requiredGrants].sort()).toEqual([
      'CodexEditor',
      'CodexMechanic',
      'Editor',
      'Mechanic',
      'Surgeon',
    ]);
  });

  it('types each entry as an agent of the workflow that uses the roster', () => {
    defineWorkflow({
      ...base,
      name: 'std-rosters-types',
      roster: rosters.readers,
      async run(ctx) {
        expectTypeOf(ctx.roster.Skeptic).toExtend<Agent>();
        expectTypeOf(ctx.roster.CodexReviewer).toExtend<Agent>();
        // @ts-expect-error -- readers holds no editing role.
        expect(ctx.roster.Mechanic).toBeUndefined();
        await Promise.resolve();
        return null;
      },
    });
    defineWorkflow({
      ...base,
      name: 'std-rosters-standard-types',
      roster: rosters.standard,
      async run(ctx) {
        expectTypeOf(ctx.roster.Mechanic).toExtend<Agent>();
        expectTypeOf(ctx.roster.CodexMechanic).toExtend<Agent>();
        await Promise.resolve();
        return null;
      },
    });
  });
});
