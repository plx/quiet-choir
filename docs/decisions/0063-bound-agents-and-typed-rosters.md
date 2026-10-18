# 0063: Bind agents as values and make the roster the one inventory

- Status: proposed
- Issue: to be filed (the packaged-workflows epic)
- Amends: [0010](0010-agent-profiles-and-grants.md) (profiles become an internal representation;
  strict call sites, grants, access classes and delegation ceilings move behind `requireGrants`) and
  [0026](0026-inline-children-and-definition-registry.md) (same-name child role delegation is no
  longer the default path)
- Builds on: [0011](0011-harness-controls-and-contracts.md) (typed harness controls),
  [0027](0027-typed-harness-registry-and-integration-helpers.md) (registered harnesses) and
  [0062](0062-type-call-site-adddirs-by-profile-roots.md) (literal inference in `defineWorkflow`)

## Context

The intended design has three layers.

1. **Bottom: complete, typed, per-harness interfaces with no cross-harness abstraction.** This
   exists. `ctx.claude` and `ctx.codex` expose every typed native control (ADR 0011), and
   `ctx.agent(name)` does the same for a registered harness (ADR 0027). The shared `AgentOptions`
   base is runtime plumbing: prompt, working directory, deadlines, retry, checkout and environment.
   Only `model` and `effort` share a name across harnesses, and `effort` is mapped per harness.
2. **Top: a fully encapsulated agent.** A value that is configured in every respect except what
   varies per invocation: the prompt, the output contract, and where it works. Nothing represents
   this today. `ctx.agent(name)` selects a harness and `ctx.within(prefix)` only prefixes step IDs.
3. **Middle: an inventory of named, concrete configurations**, which workflow code reaches by typed
   name rather than by string, which a standard library can ship, and which team structures
   (ADR 0067) are filled from.

What occupies the middle today is the profile system from ADR 0010, introduced by the #32 review
wave rather than by the original design issues. A profile is a **cross-harness role**: one name
carrying a `claude` block, a `codex` block, a block per registered harness and shared limits,
resolved against whichever harness the call site picks. Around it sit three built-in presets, an
access lattice (`none`, `read`, `write`, `exec`) that reads Claude tool names and the Codex sandbox
onto one scale, launch grants for write-capable roles, strict call sites that forbid 14 Claude and 8
Codex option keys unless they come from a profile, a redacted capability manifest, and child
delegation that matches a child's roles to parent roles by name and refuses any that exceed the
parent. Four runtime files hold 1,599 lines of this, and ADRs 0033, 0054 and 0062 exist to support
strict mode. ADR 0010 itself states that grants are operator policy and not a sandbox for the
workflow's own TypeScript, which is trusted code.

The role is the wrong unit for an inventory. An inventory entry is a concrete configuration, harness
included; the cross-harness role and the access lattice are exactly the abstractions the bottom
layer was meant to avoid. Two inventories, profiles beside a roster, would be one too many. The type
machinery needed is already present: `defineWorkflow` infers the profile-name union from a literal,
so a typed roster is an ergonomics change, not a type-system project.

## Decision

### 1. `Agent`: the encapsulated agent

```ts
/** Fixed in every respect except the prompt, the output contract and where it works. */
type BoundCallOptions = Pick<
  AgentOptions,
  'prompt' | 'cwd' | 'addDirs' | 'worktree' | 'onError' | 'retry' | 'timeoutMs' | 'idleTimeoutMs'
>;
type Agent = AgentClient<BoundCallOptions>; // value(), text(), object(), the existing overloads
```

- The prompt and the schema are the work. `cwd`, `addDirs` and `worktree` are placement: a fan-out
  over per-task directories, or a batch over an existing inventory of task directories, chooses them
  per call. `timeoutMs` and `idleTimeoutMs` are execution policy, never identity (ADR 0005).
- Nothing else is callable. Model, effort, tools, skills, plugins, system prompts, permissions,
  sandbox, isolation, environment and escape arguments are fixed by construction.
- `addDirs` keeps its harness meaning: Claude reads them, Codex may write to them. A call's entries
  are appended to the bound list so a call cannot drop a declared directory. Codex `images` are a
  per-call attachment and join the bound options for Codex-backed agents.

### 2. `bind`: partial application on every harness client

```ts
const reviewer = ctx.claude.bind({ model: 'opus', effort: 'high', tools: ['Read', 'Grep'] });
const verdict = await reviewer.value('review', { prompt, schema: Review });
```

`AgentClient` gains `bind(options): Agent` on `ctx.claude`, `ctx.codex` and `ctx.agent(name)`.
`options` is that client's full option type minus `prompt` and the per-call keys above. Binding is
pure: it closes over the options, and each call fingerprints exactly as if they had been spelled at
the call site.

### 3. The roster: the one inventory

```ts
// roster.ts: data only.
export const roster = defineRoster({
  Clerk: { harness: 'claude', model: 'haiku', effort: 'low', description: 'Copies and formats.' },
  Mechanic: {
    harness: 'codex',
    model: 'gpt-5-codex',
    effort: 'high',
    sandbox: 'workspace-write',
    timeoutMs: 1_800_000,
  },
  Reviewer: {
    harness: 'claude',
    model: 'opus',
    effort: 'high',
    tools: ['Read', 'Grep', 'Glob'],
    maxTurns: 40,
    maxBudgetUsd: 4,
    appendSystemPrompt: prompts.ReviewerStandingOrders({ repo: 'plx/quiet-choir' }),
  },
});

export default defineWorkflow({
  name: 'merge-down',
  version: '1',
  input,
  output,
  roster,
  async run(ctx, input) {
    const review = await ctx.roster.Reviewer.value('review', { prompt, schema: Review });
  },
});
```

- An entry is `{ harness, description?, expectsToolUse? }` plus **that harness's own option type**
  minus `prompt` and the per-call keys of §1. The `harness` discriminant selects the type:
  `ClaudeOptions` for `'claude'`, `CodexOptions` for `'codex'`, and a registered harness's declared
  schema for its name (pass the harness list to `defineRoster` to type those entries). There is no
  cross-harness block and no `extends`; TypeScript object spread is the inheritance, and the
  standard library ships entries to spread into.
- Entries hold concrete values only. A standing prompt comes from a template (ADR 0064) rendered
  with literal parameters when the module loads, so `defineRoster` sees a string.
- `defineWorkflow` gains a `roster` field and infers its keys. `ctx.roster` is
  `{ readonly [K in keyof TRoster]: Agent }`, with `ctx.roster.X` equal to
  `ctx.<harness>.bind(entry)`. Keys are identifiers (`/^[A-Za-z][A-Za-z0-9_]*$/`), PascalCase by
  convention, so dot access always works and a misspelling fails typecheck.
- **The roster is the only author-facing inventory.** Built-in presets stop being an authoring
  concept; the standard library offers per-harness entries such as a read-only Claude reviewer or a
  workspace-write Codex mechanic. `defaults` remains for workflow-wide limits and per-harness model
  and effort, without `defaults.profile`. A raw call that sets nothing keeps today's text baseline
  as plain runtime defaults: no tools, 10 turns, 0.50 USD and a 300,000 ms deadline for Claude, a
  read-only sandbox for Codex.

### 4. Profiles become an internal representation

- Roster entries compile to the runtime's existing resolved-role record, so resolution, launch
  overrides, attempt records and the manifest reuse the code without exposing the role concept.
  `--profile X.maxTurns=60` keeps working with roster names, attempts keep recording the name in
  `profile`, and the manifest lists each entry with its harness, model, tools or sandbox, limits and
  a derived access label.
- `profiles` and the call-site `profile:` option are not documented for new code. They stay
  functional through this epic so the comparison ports and examples can migrate to rosters, and are
  removed in a ticket at the end of it, in keeping with one spelling per concept at 0.0.0.

### 5. The authorization layer moves behind `requireGrants`

- A definition may set `requireGrants: true`, or a run may pass `--require-grants`
  (`RunOptions.requireGrants`). Then write- and exec-capable entries need `--grant` before the body
  runs, named grants pin as today, and child delegation ceilings are enforced.
- Without it, which is the default, no grant is needed, no role is compared to a parent's, and a
  child package's roster is simply its own. `--grant` is still accepted and recorded. The manifest
  and `validate --json` are unchanged, so the audit trail stays.
- `strictProfiles` becomes an opt-in flag with default `false`; an explicit `true` keeps the ADR
  0054 and 0062 typing. Access classes are computed only to label the manifest.
- Same-name role mapping between parent and child, and the `options.profiles` remap on
  `ctx.workflow`, are no longer how a child is parameterized. Teams (ADR 0067) are. Both remain for
  `requireGrants` runs that want ceilings.

## Alternatives

- **Add a harness pin to profiles and call that the inventory.** Rejected: the cross-harness role
  stays the unit, and the lattice comes with it.
- **Keep roster entries as profiles underneath permanently** (the first draft of this record).
  Rejected: it reuses the machinery but drags the lattice and grants into every entry. Reuse is kept
  as an implementation detail only.
- **Roster in YAML with generated types.** Rejected for this revision: the prose lives in template
  files, so a roster module is small, typed by inference with no generation step, and still plain
  data that `validate` reads without running the body.
- **Generalize `ctx.agent(name)` to roster names.** Rejected: it selects harnesses, and overloading
  it makes name resolution depend on declaration order.
- **Fill team slots from the roster by name inside the runtime.** Rejected here and deferred to ADR
  0067, which keeps matching a one-line helper at the call site.

## Consequences

- `src/workflow/runtime/model.ts` gains `Agent`, `BoundCallOptions`, `AgentClient.bind`,
  `WorkflowDefinition.roster`, `WorkflowDefinition.requireGrants` and `WorkflowContext.roster`;
  `strictProfiles` defaults to `false`; `defineRoster` and `RosterEntry` are public. The Workflow
  Lab `apiSnapshot` hash is bumped in the same change.
- Batch 02 ports migrate from `profiles` to rosters; a role used with both harnesses becomes two
  entries. Batch 01 ports keep raw calls and need no grant. Tests and docs that assert the strict
  default or a required grant move to explicit opt-in.
- `docs/agent-profiles.md` is rewritten as the roster reference; delegation ceilings move to the
  `requireGrants` section of the child-workflow docs.
- A cross-harness role can no longer be written. A workflow that wants the same persona on both
  harnesses declares two entries and spreads their shared limits.
- ADR 0066 adds a second entry kind, `decider`; the `harness` discriminant stays reserved for
  agents. ADR 0067 defines teams over `Agent`.
