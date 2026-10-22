# Roster and bound agents

The roster is a workflow's inventory of agents: named, concrete configurations, each pinned to one
harness, that workflow code reaches by typed name
([ADR 0063](decisions/0063-bound-agents-and-typed-rosters.md) §3–4). It can also hold deciders:
named decision providers and models ([decider entries](#decider-entries)). Keep it in its own
module, so several workflows can import it:

```ts
// roster.ts: data only.
import { defineRoster } from 'quiet-choir';

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
    appendSystemPrompt: 'Review for correctness first.',
  },
});
```

```ts
// review.workflow.ts
import { defineWorkflow, z } from 'quiet-choir';
import { roster } from './roster.js';

const Review = z.object({ verdict: z.enum(['approve', 'revise']), notes: z.string() });

export default defineWorkflow({
  name: 'review',
  version: '1',
  input: z.object({ diff: z.string() }),
  output: Review,
  roster,
  async run(ctx, input) {
    return ctx.roster.Reviewer.value('review', { prompt: input.diff, schema: Review });
  },
});
```

## The roster

An agent entry is `{ harness, description?, expectsToolUse? }` plus **that harness's own option
type** (`RosterEntry`; the other kind of entry is a [decider](#decider-entries)). `harness` is the
discriminant: `'claude'` takes `ClaudeOptions`, `'codex'` takes `CodexOptions`, and a registered
harness takes its declared option schema. Pass registered harness definitions to
`defineRoster(entries, { harnesses: [fake] })` to type their entries; the workflow must still list
each one in its own `harnesses`, or validation fails with
`Roster entry Scout uses harness fake, which workflow review does not declare`. A roster never
registers a harness by itself. An entry typed against the wrong harness fails typecheck: `sandbox`
or a `codex: { … }` block on a Claude entry, `tools` on a Codex entry, or a Claude key on a
registered one.

An entry cannot set the per-call-only keys (`prompt`, `schema`, `cwd`, `worktree`, `onError`,
`retry` and Codex `images`), nor `profile`, `extends`, `access`, `addDirRoots` or the cross-harness
`claude`, `codex` and `harnesses` blocks. The both-sides keys `addDirs`, `timeoutMs` and
`idleTimeoutMs` are defaults a call may extend or replace. There is no inheritance: spread a shared
entry, as in `{ ...Reviewer, model: 'sonnet' }`. A standing prompt is a plain string on the entry.

Names are identifiers (`/^[A-Za-z][A-Za-z0-9_]*$/`, at most 64 characters), PascalCase by
convention, so `ctx.roster.Name` dot access always works. The built-in preset names (`text`,
`readonly`, `edit`) and the reserved words `all`, `none`, `read`, `write`, `exec`, `constructor` and
`prototype` are refused. `defineRoster` checks the names, harnesses and forbidden keys when the
module loads and returns a deep-frozen copy. The option values themselves are checked against the
harness, like a profile's, when a workflow that uses the roster is validated or run.

`defineWorkflow` accepts only a `defineRoster` result as `roster` (an inline object literal fails
typecheck) and infers its entry names. An entry name equal to a `profiles` name fails validation
with `Roster entry Reviewer has the same name as a declared profile.`, and so does a
`defaults.profile` that names an entry or a profile that `extends` one: an entry belongs to one
harness, so it can be neither the default role nor a parent.

### How an entry resolves

Each entry compiles to a declared role under its own name, pinned to its harness. It has no
`extends`, so it starts from the runtime's text baseline and the workflow's `defaults`, exactly as a
declared profile without `extends` does: an entry that sets nothing gets no Claude tools, 10 turns,
0.50 USD and a 300,000 ms deadline, or a read-only Codex sandbox, plus whatever `defaults` sets
workflow-wide (limits, and per-harness model and effort under `defaults.claude` and
`defaults.codex`). The entry's own `timeoutMs`, `idleTimeoutMs`, `maxTurns` and `maxBudgetUsd` are
its limits; every other key is an option of its harness. Nested objects merge field by field over
the baseline and arrays replace, as for profiles. Only the pinned harness's block takes `defaults`:
the entry's other blocks stay at the text baseline (no Claude tools, a read-only Codex sandbox, no
registered harness options), so `defaults.codex.sandbox: 'workspace-write'` gives a Claude entry no
Codex authority to carry into a grant pin or a child. A roster call resolves, in order:

1. the text baseline,
2. workflow `defaults`,
3. the entry,
4. the call's own options (its deadlines win and its `addDirs` append),
5. ordered `--profile Name.limit=` overrides,
6. step-targeted `--policy` rules.

The request a roster call sends, and the step's fingerprint, are those of a raw call that spells the
entry's options at the call site, so moving a call onto a roster agent keeps its completed steps
reusable under an accepted code change. The attempt records the entry name as its role, and the
entry's limits with the source `profile:<Name>`. A registered harness's schema is checked with the
entry's limits filled in for the limit keys it declares, so a schema that requires `timeoutMs`
accepts a call that leaves it to the entry; the limit still reaches the request only as policy, so a
filled `maxTurns` or `maxBudgetUsd` stays out of the fingerprint.

## Standard library entries

`quiet-choir/std` ships roster entry fragments to spread into an entry, so a common configuration
has one spelling instead of a copied literal. They carry the values of the built-in presets, per
harness (ADR 0063 §3), as frozen data with a short `description` the spreading entry usually
replaces:

```ts
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Reviewer: { ...std.claude.ReadOnly, description: 'Reviews the diff.' },
  Checker: { ...std.codex.ReadOnly, effort: 'high' },
  Mechanic: { ...std.claude.Edit, ...std.tiers.Mechanic },
});
```

| Entry                 | Tools or sandbox              | `maxTurns` | `maxBudgetUsd` | `timeoutMs` |
| --------------------- | ----------------------------- | ---------- | -------------- | ----------- |
| `std.claude.Text`     | none                          | 10         | 0.5            | 300,000     |
| `std.claude.ReadOnly` | Read, Grep, Glob              | 25         | 2              | 900,000     |
| `std.claude.Edit`     | Read, Grep, Glob, Edit, Write | 40         | 5              | 1,800,000   |
| `std.codex.Text`      | `sandbox: 'read-only'`        | -          | -              | 300,000     |
| `std.codex.ReadOnly`  | `sandbox: 'read-only'`        | -          | -              | 900,000     |
| `std.codex.Edit`      | `sandbox: 'workspace-write'`  | -          | -              | 1,800,000   |

The Codex fragments carry no `maxTurns` or `maxBudgetUsd`: those are Claude-only limits that
`CodexOptions` does not have, so a Codex entry cannot set them (and a spread that adds one, or
`tools`, fails typecheck like any other Claude key on a Codex entry).

`std.tiers` holds the model tiers of the native epic scripts. Each fixes only a Claude model and
effort: `Clerk` (haiku, low), `Copyist` (sonnet, low), `Scribe` (sonnet, medium), `Mechanic`
(sonnet, high), `Planner` (opus, high), `Skeptic` (opus, medium) and `Surgeon` (opus, high).
Capability comes from the preset fragments, so the two axes compose by spread,
`{ ...std.claude.Edit, ...std.tiers.Mechanic }`, rather than as one entry per combination; a tier
spread last also supplies the description. A tier alone is a valid entry at the text baseline.

This is a seed sized for the dog-food ports, not the full library: a later decision record scopes
what else it holds once the ports show what recurs. `std.exec` (`json`, `git`, `committedArtifact`)
and `std.patterns` (see [teams](#teams)) sit in the same subpath, which imports only the public
`quiet-choir` entry point.

## ctx.roster

`ctx.roster.Name` is the entry's pinned harness client bound to the entry (for a decider entry, see
[below](#decider-entries)): `ctx.claude.bind(…)`, `ctx.codex.bind(…)` or `ctx.agent(name).bind(…)`.
Its type is `RosterAgents<typeof roster>`, one readonly agent per entry name (`RosterAgentOf`), so
`ctx.roster.Reviwer` fails typecheck. Each is typed as `bind` types the entry's options. Claude
entries give an `Agent`; Codex entries give an `Agent` that also takes per-call `images`; a
registered harness gives the agent its own `bind` gives, with `D`'s capabilities and the bound call
keys its option schema declares, so a text-only registration (`structuredOutput: 'none'`) gives a
text-only agent without `object` or a schema-bearing `value`, and a both-sides key that schema
requires (such as `addDirs`) stays required on each call unless the entry sets it. A call takes only
the prompt, the schema, placement (`cwd`, `addDirs`, `worktree`) and policy (`onError`, `retry`,
`timeoutMs`, `idleTimeoutMs`); everything else is fixed by the entry. See
[bound agents](#bound-agents) for the merge rules and errors.

- **Placement.** A call's `addDirs` are appended to the entry's, so a call cannot drop a declared
  directory; its `timeoutMs` and `idleTimeoutMs` replace the entry's.
- **The pin.** An entry runs only on its harness. A call that selects it on another one, such as an
  untyped `ctx.codex.text(id, { prompt, profile: 'Reviewer' })`, fails with
  `Roster entry Reviewer is pinned to harness claude; it cannot run on codex.`
- **Prefixes.** Each read of `ctx.roster` gives agents bound over that context, so
  `ctx.within('p').roster.Reviewer` keeps the `p/` prefix, and an agent called inside `ctx.scope` or
  `ctx.map` takes the IDs a raw call there would.
- **Children.** Inside an inline child, `ctx.roster` is the child's own roster. An agent resolves
  its entry by name against the definition whose body is running when it is called, so an agent read
  in a parent and called from a child body through shared closure state resolves against the child's
  roster; read `ctx.roster` where you call it.
- **Untyped access.** `ctx.roster` is a frozen object without a prototype: an untyped misspelling is
  `undefined`, never an `Object.prototype` member. A workflow without `roster` has no entries.
- **Helpers.** A helper typed with a bare `WorkflowContext` sees every name as a possibly text-only
  `Agent<HarnessCapabilities>`. Pass the agent instead (`reviewWith(ctx.roster.Reviewer)` with a
  parameter typed `Agent`), which is also how a [team](#teams) slot (ADR 0067) is filled.

## Decider entries

A decider entry names a decision provider and model instead of a harness
([ADR 0066](decisions/0066-decision-providers.md) §2): `{ decider, model?, description? }`
(`RosterDeciderEntry`). `ctx.roster.Name` is then a `RosterDecider`, whose only method is `decide`:
`ctx.decide` with the entry's provider and model preset. See
[decision providers](decision-providers.md) for providers, configuration and the
[decide-then-act recipe](decision-providers.md#walkthrough-decide-then-act).

```ts
import { defineRoster, defineWorkflow, z } from 'quiet-choir';
import { choice, jevCompatible } from 'quiet-choir/decision';

const jev = jevCompatible({
  name: 'jev',
  baseUrl: 'https://jev.example',
  apiKeyEnv: 'JEV_TOKEN',
  defaultModel: 'jev-latest',
});
const roster = defineRoster({
  Triage: { decider: 'jev', model: 'jev-1.13', description: 'Routes support tickets.' },
  Clerk: { harness: 'claude', model: 'haiku' },
});
const route = choice({ instructions: 'Which team?', options: { billing: null, support: null } });

export default defineWorkflow({
  name: 'triage',
  version: '1',
  input: z.object({ ticket: z.string() }),
  output: z.enum(['billing', 'support']),
  decisions: [jev],
  roster,
  async run(ctx, input) {
    const answers = await ctx.roster.Triage.decide('triage', {
      state: input,
      questions: { route },
    });
    return answers.route.choice; // 'billing' | 'support'
  },
});
```

- **The entry.** `decider` is a provider name (`/^[a-z][a-z0-9-]{0,31}$/`), `model` a nonempty
  string and `description` a string. An entry cannot set both `harness` and `decider`
  (`Roster entry Both cannot set both harness and decider; an entry is an agent or a decider.`), and
  a decider entry takes no other key: `tools`, `expectsToolUse`, a limit or any agent option fails
  typecheck and, untyped, `defineRoster` throws
  `Roster entry Triage is a decider; it cannot set tools (a decider entry takes only decider, model and description).`
  Names follow the rules of every entry, and the stored entry is deep-frozen JSON.
- **The load-time check.** When the workflow loads (validate, run, an inline child, a package), each
  decider entry must name one of the workflow's own `decisions`:
  `Roster entry Triage names decision provider jev, which workflow triage does not declare; add it to the workflow's decisions.`
  An inline child is checked against its own `decisions`, as its `ctx.decide` calls resolve.
- **The call.** `decide(id, { state, questions, onError?, retry?, timeoutMs? })` is typed like
  `ctx.decide`: answers are inferred from the questions, and `onError: 'return'` gives `Settled`.
  `provider` and `model` are fixed by the entry, so passing either fails typecheck; an untyped call
  that passes one with a defined value fails its step before any request with
  `ctx.roster.Triage.decide cannot set provider; roster entry Triage fixes it.` An entry without
  `model` leaves it to the operator configuration (`decisions.<name>.defaultModel`) and then the
  declaration's `defaultModel`, exactly as `ctx.decide({ provider })` does.
- **Identity.** The call records the step `ctx.decide(id, { provider, model, … })` records: the same
  `decision/2` identity over the provider name and revision, the requested model, the state and the
  questions, and the same fingerprint. Moving a call between `ctx.decide` and the roster reuses its
  completed step. The step's `meta` gains `roster: 'Triage'`, a label that is never identity, so
  renaming an entry strands no completed decision. A step first recorded by `ctx.decide` keeps its
  original `meta` (without `roster`) when a later execution reuses it through the roster.
- **Prefixes and children.** `ctx.within('p').roster.Triage.decide('t', …)` records `p/t`, and a
  call inside `ctx.scope` or `ctx.map` takes the IDs `ctx.decide` would. Inside an inline child,
  `ctx.roster` is the child's roster and resolves against the child's `decisions`.
- **Not a role.** A decider entry has no capability profile, grant, pin or `--profile` override (an
  override naming one fails with `Unknown override profile: Triage.`), needs no grant under
  `requireGrants`, and is not an `Agent`, so it cannot fill a [team](#teams) slot or be passed to a
  helper typed `Agent`.

## Manifest and validate output

`workflow validate --json` lists each agent entry in `workflow.capabilities.profiles` under its
name, as a resolved role with its `harness`, model, tools or sandbox, limits, `description`,
`expectsToolUse` and derived access label. The label is the pinned harness's access alone: a
tool-less Claude entry is `none`, where the cross-harness maximum of a profile would be `read`. The
unused harness blocks stay at the text baseline whatever `defaults` sets, since grant pins and child
delegation compare both. Free-form controls (settings, MCP servers, subagents, system prompts such
as `appendSystemPrompt`, Codex config and a registered harness's `sensitiveOptions`) appear only as
digests under `redacted`, as for any profile. The top-level `workflow.profiles` list names declared
profiles only. A run record's `capabilities` holds the same public manifest (record schema revision
19 added the `harness` field; see [storage](storage.md#record-schema-revision)).

Decider entries are not roles, so the capability manifest does not list them. `workflow.deciders`
lists them instead, beside `workflow.capabilities`, at every node of the child tree: each entry's
`provider`, `model` (null when calls use the configured or declared default) and `description` (or
null), and `{}` for a workflow without any. The list lives outside the capability manifest that run
records persist, so it adds no record schema revision.

```json
"deciders": {
  "Triage": { "provider": "jev", "model": "jev-1.13", "description": "Routes support tickets." }
}
```

```json
"Reviewer": {
  "name": "Reviewer",
  "harness": "claude",
  "access": "read",
  "maxTurns": 40,
  "claude": { "model": "opus", "effort": "high", "tools": ["Read", "Grep", "Glob"] },
  "redacted": { "claude": { "appendSystemPrompt": { "sha256": "…" } } }
}
```

The manifest bounds declared agent controls; it does not confine workflow JavaScript or arbitrary
working directories. Configuration isolation is a separate
[provider-specific boundary](harness-isolation.md).

## Bound agents

`bind` turns a harness client into an `Agent`: a value configured in every respect except the
prompt, the output contract and where it works
([ADR 0063](decisions/0063-bound-agents-and-typed-rosters.md) §1–2). It exists on `ctx.claude`,
`ctx.codex` and `ctx.agent(name)`.

```ts
const reviewer = ctx.claude.bind({ model: 'opus', effort: 'high', tools: ['Read', 'Grep'] });
const verdict = await reviewer.value('review', { prompt, schema: Review });
```

Keys fall into two groups. The per-call-only keys (`PerCallOnlyKey`) are `prompt`, `schema`, `cwd`,
`worktree`, `onError`, `retry` and Codex `images`; `bind` cannot set them, at typecheck or at
runtime, where it throws a `TypeError` naming the key. The both-sides keys are `addDirs`,
`timeoutMs` and `idleTimeoutMs`: `bind` may set a default and a call may set its own. Everything
else, such as the model, effort, tools, sandbox, environment and `profile`, is fixed by `bind`. A
call through the agent takes only `BoundCallOptions` (plus `images` for a Codex agent); any other
key fails typecheck, and an untyped call that passes one rejects before a step ID is claimed. These
`bind` and bound-call errors are authoring errors, like a raw call's invalid options: inside an
`onError: 'return'` map they fail the run instead of being saved as the item's result.

Each call merges its options over the bound ones. A call's `addDirs` are appended to the bound list,
not deduplicated, so a call cannot drop a bound directory. A call's deadline wins over the bound
default. A call value that is `undefined` counts as absent and keeps the default. The merged options
are what the runtime sees: the step fingerprints, resolves profiles and policy, and records its
attempts exactly as a raw call that spells them at the call site, so after moving a call to a bound
agent, an accepted code change still reuses its completed step.

Binding is pure. It takes a deep, frozen copy of the options, so later changes to the object passed
to `bind` do not reach the agent. The copy changes nothing: a nested getter, symbol key,
non-enumerable property or array hole, which a raw call's JSON boundary would reject, makes `bind`
throw a `TypeError` instead of being evaluated or dropped. The top-level options of `bind` and of
each bound call are read the same way: a getter, symbol key or non-enumerable option throws at
`bind`, or rejects the call before a step is claimed, and a call's `addDirs` is copied under the
same rules. Binding performs no effect, claims no step ID and reads no run state, so one agent can
be created early and reused. A call takes its step ID prefix where it is invoked: an agent bound
before `ctx.scope` or `ctx.map` and called inside gets the same qualified IDs as a raw call there,
and an agent bound from `ctx.within('w').claude` keeps the `w/` prefix. `bind` needs a harness
client, so it is called inside the body; declaring agents at module load is the
[roster's](#the-roster) job.

`Agent<C>` is generic over the harness's capabilities, like `RegisteredAgentClient`. The default is
`NativeHarnessCapabilities`, the built-in harnesses' capabilities (the ADR's `BuiltInCapabilities`).
A registered harness whose `structuredOutput` is `'none'` binds to a text-only agent without
`object` or a schema-bearing `value`, which a helper taking a structured `Agent` rejects at
typecheck; `Agent<{ structuredOutput: 'none' }>` accepts both kinds. A registered harness's agent
keeps only the both-sides keys its own option schema declares. When that schema requires one, `bind`
may leave it to each call, and once `bind` sets it to a value whose type is always defined (not an
optional property), the agent's calls and re-binds may omit it. An agent binds again over the
both-sides keys only: `reviewer.bind({ addDirs: ['docs'] })` appends to its directories, while
`reviewer.bind({ model: 'haiku' })` fails typecheck and, untyped, throws a `TypeError` naming the
key, which the first bind fixed.

`bind({ profile: 'scout' })` lifts a declared role into a value and resolves exactly as a raw
`{ profile: 'scout' }` call; a roster agent is exactly such a bind over its entry's name. Under
`strictProfiles: true`, `bind` accepts the same keys as a call site, so it cannot set strict-owned
controls such as `tools`. It also keeps a call's pairing of `profile` and `addDirs`: an agent bound
to a profile that declares `claude.addDirRoots` takes `addDirs` per call, while one bound to a
profile without roots (or to the unrooted default) does not, at typecheck as at runtime.

## Teams

A team is a typed record of named `Agent` slots
([ADR 0067](decisions/0067-teams-as-typed-slots.md)). A higher-order pattern such as review/revise
names the roles it needs independently of which configured agent fills them. `defineTeam` takes slot
names with one-line descriptions; `TeamOf` derives the record type, and `Team<K>` is that type over
slot names `K`.

```ts
export const ReviewTeam = defineTeam({
  actor: 'Produces the artifact under review.',
  critic: 'Judges the artifact against the brief and returns findings.',
});
export type ReviewTeam = TeamOf<typeof ReviewTeam>; // { readonly actor: Agent; readonly critic: Agent }
```

`ReviewTeam.slots` is plain, frozen data (a null-prototype copy, so later edits to the object you
passed change nothing) that documentation can read without running a workflow body. A slot holds a
structured, native-capability `Agent`: a text-only registered agent does not typecheck as a slot,
and nothing compares a slot's description to the agent that fills it, so expectations about
capability belong in the description.

Filling is explicit at the call site. A team value is a plain object of agents, and a pattern is an
ordinary function that takes the context and an options object holding the team (ADR 0067 §3). A
bound agent carries its own context and takes its step ID prefix where it is called, so calls
through a slot claim the same IDs, fingerprints and records as calls through the agent that fills
it; the pattern's context is for scoping and fan-out. `quiet-choir/std` ships two such patterns:

```ts
import * as std from 'quiet-choir/std';

const { approved, draft: final } = await std.patterns.reviewRevise(ctx, {
  team: { actor: ctx.roster.Writer, critic: ctx.roster.Reviewer },
  draft,
  rounds,
});
```

`std.patterns.reviewRevise` (team `std.patterns.ReviewTeam`) reviews up to `rounds` times as
`review/<n>` and revises after each rejection as `revise/<n>`, without an unreviewed revision after
the last round, and returns `{ approved, draft }`. `id` runs the loop under `ctx.scope(id, ...)`, so
two loops in one workflow do not collide, and `prompts` replaces the default review and revise
prompts. `std.patterns.tolerantPanel` (team `std.patterns.PanelTeam`, one `panelist` slot) asks the
panelist about each item under `ctx.map(id, items, { concurrency, onError: 'return' })` as
`<id>/<index>/answer`, optionally with a `schema`, and returns `{ quorum, answers, failed }`: a
failed vote is journaled, so a resume does not retry it into a different quorum. Its optional
`version` is the map's `version`, a revision for the `prompt` function and `schema`, which the
settled map's fingerprint does not show.

`ReviewTeam.from(record)` is the one convenience. It picks the slot keys from any record that has
them, so `ReviewTeam.from(ctx.roster)` fills a team whose roster entries use the slot names, and
`ReviewTeam.from({ ...ctx.roster, critic: ctx.roster.Skeptic })` overrides one slot. A record that
lacks a slot, or fills one with a non-agent, fails typecheck; entries other than the slots are
dropped from the returned frozen team. An untyped or JavaScript caller that leaves a slot empty gets
`TypeError: Team slot critic is not filled.`, a presence check and not a capability check. The
helper neither inspects nor wraps the agents.

A team is not registered with the runtime, is not part of `defineWorkflow`, and does not appear in
`workflow validate` or the manifest, and it adds no grant or delegation behavior: the roster entries
that fill it are what the manifest and `--require-grants` see. Teams serve in-process patterns only.
Child workflows that take a team are deferred (ADR 0067 §3). The
[review/revise recipe](../plugins/agents/quiet-choir/skills/quiet-choir/references/patterns.md#bounded-reviewrevise)
and the
[failure-tolerant panel](../plugins/agents/quiet-choir/skills/quiet-choir/references/patterns.md#failure-tolerant-panel)
are the reference usage.

## Recovery and diagnostics

```sh
quiet-choir workflow execute review.workflow.ts --run-id review-1 --resume \
  --profile Reviewer.maxTurns=60 --profile '*.timeoutMs=1800000'
```

The four overridable limits are `maxTurns`, `maxBudgetUsd`, `timeoutMs` and `idleTimeoutMs` (for
example `--profile Reviewer.idleTimeoutMs=120000`). The selector is an exact roster entry name,
profile name or `*`; semantic overrides and unknown names fail before effects. Rules are sticky on
resume, later values win, and `--policy-reset` clears both saved step rules and profile rules.
Embedded callers pass `profileOverrides: [{ profile: 'Reviewer', maxTurns: 60 }]`. Attempts record
their role (the entry name for a roster call, in `attemptHistory[].profile`), effective limits,
model/effort and value sources. Profile names and limits are outside step identity; resolved models,
tools, sandbox, effort and permission-failure behavior are identity. Changing workflow source still
requires the usual explicit code acceptance or fork.

Turn/budget errors report the configured cap, role, reported turns and cost (or `unknown`), and a
suggested resume override. If a matching step `--policy` rule also sets the cap, update or reset
that rule: it takes precedence over `--profile`. Inspect `steps[id].warnings` for permission-denial
counts. A role can set `onPermissionDenied: 'fail'` to reject an otherwise successful response with
kind `permission`; usage/session metadata remains available. Only reported denials are diagnosed,
and the runtime does not save their tool-input payloads.

`expectsToolUse` defaults to true when a role grants more than the text baseline: any Claude tool,
or a Codex sandbox beyond `read-only`. A roster entry looks at its pinned harness only, and an entry
on a registered harness expects tools when that harness's access is above `none`. So `text` is
false, `readonly` and `edit` are true, and a role that only adds Codex `workspace-write` is true;
set it explicitly to override. When it is true and a completed attempt reports zero tool calls, the
step gets the warning
`no-tool-use: Profile <name> expects tool use, but the <harness> attempt completed without a tool call.`
The count comes from the attempt's stream (`attemptHistory[].diagnostics.toolUses`); a Claude call
with an empty tool list, or an adapter that reports no count, never warns. The warning never fails
the attempt.

`idleTimeoutMs` (a profile, `defaults` or call limit, off by default) ends an agent attempt whose
CLI writes nothing to stdout or stderr for that long, with error kind `idle-timeout`. Like
`timeoutMs` it is policy outside identity, so raise it on resume with
`--profile name.idleTimeoutMs=N`. Size it above the longest silent tool run or reasoning stretch;
see
[idle deadline and tool-use diagnostics](harness-controls.md#idle-deadline-and-tool-use-diagnostics).
These profiles are not the hermetic harness isolation proposed in #60, and there is no total run
spending cap.

## Appendix: requireGrants and legacy profiles

`profiles`, the call-site `profile:` option and the built-in presets are the representation roster
entries compile to. They stay functional during the packaged-workflows epic, so existing workflows
and the comparison ports keep running while they migrate, but new code should use a roster. The
preset values are also available per harness as
[standard library entries](#standard-library-entries) (`std.claude.ReadOnly` and the rest) to spread
into roster entries. This appendix also documents the opt-in authorization layer (`requireGrants`),
which treats roster entries as declared roles.

### Declaring profiles

Declare roles on the workflow instead of passing a shared tools/budget object through input:

```ts
export default defineWorkflow({
  name: 'review',
  version: '1',
  input,
  output,
  defaults: {
    profile: 'text',
    claude: { model: 'sonnet' },
    codex: { effort: 'medium' },
  },
  profiles: {
    scout: { extends: 'readonly', maxTurns: 30, description: 'Maps the repository' },
    skeptic: { extends: 'readonly', maxBudgetUsd: 1 },
    fixer: {
      extends: 'edit',
      access: 'exec',
      claude: {
        tools: ['Read', 'Grep', 'Glob', 'Edit', 'Bash'],
        allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Bash(npm test:*)'],
      },
    },
  },
  async run(ctx, input) {
    const result = await ctx.claude.object('map', {
      profile: 'scout',
      prompt: input.request,
      schema: output,
    });
    return result.output;
  },
});
```

`profile` is a union of declared names and `text | readonly | edit`; a misspelling fails typecheck,
including through `ctx.within` and `ctx.agent(name)` for Claude, Codex and registered harnesses.
Helpers accepting an unparameterized `WorkflowContext` accept any string name, which is still
checked at runtime. Use `WorkflowContext<'scout'>` to retain a narrow helper contract. Names may
contain letters, digits, underscores and hyphens, start with a letter, and have at most 64
characters. Built-in names and grant class names cannot be redeclared.

Strict call sites are opt-in: `strictProfiles` defaults to `false`, so by default a call may pass
any capability control, such as `ctx.claude.text('t', { prompt, tools: ['Read'] })`
([ADR 0063](decisions/0063-bound-agents-and-typed-rosters.md) §5). With `strictProfiles: true`,
call-site option types follow it. `defineWorkflow` infers its literal: only `true` removes the
capability keys that strict profiles own from `ctx.claude`, `ctx.codex` and `ctx.agent(name)`
options, so that call fails typecheck and `workflow validate` with `load.typecheck` instead of
failing when the call runs. Claude's keys are tools, allowedTools, disallowedTools, permissionMode,
agent, agents, plugins, mcpServers, strictMcpConfig, settings, addDirs, extraArgs, env and
isolation; Codex's are sandbox, networkAccess, config, harnessProfile, addDirs, extraArgs, env and
isolation. The same exported lists (`claudeCapabilityKeys`, `codexCapabilityKeys`) drive the runtime
check. `isolation` stays available as `'restricted'` only, since strict profiles own `'inherit'`;
`worktree` is not a capability key, so every checkout selection still compiles. Claude's `addDirs`
stays typed only together with a profile that accepts
[root-bounded call-site directories](#bounded-call-site-directories): one that declares
`claude.addDirRoots`, inherits it through `extends`, or gets it from `defaults.claude`, and, for a
call that omits `profile`, a rooted `defaults.profile`. Under any other profile, including the
implicit `text`, `addDirs` fails typecheck like the other keys, while every profile still compiles
without it. `defineWorkflow` reads this from the literal `profiles` and `defaults`; when it cannot
see their shape (a profiles object typed `Record<string, AgentProfile>`, a non-literal `extends`, or
a generic `P extends AgentProfile` or `D extends AgentDefaults<never>` value that a factory
forwards, which takes a fallback overload reading every profile as rooted) the type stays permissive
and the runtime check decides
([ADR 0062](decisions/0062-type-call-site-adddirs-by-profile-roots.md)). Codex `addDirs` stay
removed. A registered harness's literal `capabilityKeys` are removed the same way. The removed keys
are typed as optional `never` properties, so a pre-built options variable or an explicit `undefined`
is rejected too, not only a fresh object literal. An omitted `strictProfiles` or a literal `false`
types the raw keys; a non-literal `boolean` also stays permissive and leaves the decision to the
runtime. A helper typed with a bare `WorkflowContext` stays permissive (the runtime check still
applies), while `WorkflowContext<'scout', BuiltInHarnesses, true>` is a strict helper contract that
accepts the workflow's strict context. Explicit `defineWorkflow` type arguments are all-or-nothing:
with a shorter prefix such as `defineWorkflow<Input, Output>`, the rest take the permissive,
childless defaults, so `strictProfiles: true` or a nonempty `children` list fails typecheck; drop
the type arguments (preferred) or spell all seven. Explicit type arguments also leave the `profiles`
and `defaults` shapes uninferred: declared roles then accept call-site Claude `addDirs` at type
level, while built-ins and an omitted `profile` reject them even when `defaults` roots them, so such
a workflow must drop the type arguments.

| Preset            | Claude tools                  | Codex sandbox   | Claude turns | Claude USD | Deadline     |
| ----------------- | ----------------------------- | --------------- | ------------ | ---------- | ------------ |
| `text` (implicit) | none                          | read-only       | 10           | 0.50       | 300,000 ms   |
| `readonly`        | Read, Grep, Glob              | read-only       | 25           | 2          | 900,000 ms   |
| `edit`            | Read, Grep, Glob, Edit, Write | workspace-write | 40           | 5          | 1,800,000 ms |

Resolution is the root built-in preset, workflow defaults, the custom `extends` chain, the selected
role, per-call options, ordered `--profile` overrides, then existing step-targeted `--policy` rules.
Nested provider objects merge field by field; arrays replace. A custom role without `extends` starts
from `text`. Configuration mode defaults to `restricted`; shared `isolation` on defaults/profiles
can be overridden in provider-specific options. Model and effort omissions use that mode’s native
defaults; set them explicitly in defaults or profiles to avoid that dependency. Codex ignores
profile turn/budget limits because its adapter has no corresponding enforcement flags. Custom
harnesses receive the resolved options and are responsible for enforcing them.

`tools` implies `allowedTools`. An explicit allowed list may select exposed tools or narrow a bare
tool to a rule such as `Bash(npm test:*)`. Replacing the tool list without a new allowed list
re-infers permissions from that replacement, rather than retaining the parent's permissions. The
exposure list determines the access class conservatively, even when the allowed list narrows it.
Read/Grep/Glob/WebSearch/WebFetch imply `read`; Edit/Write/NotebookEdit imply `write`; Bash and
unknown/MCP tools imply `exec`. Codex read-only implies `read`, workspace-write implies `write`. The
manifest shows both provider classes and their maximum; thus even `text` has aggregate access `read`
(Claude alone is `none`). An explicit `access` must equal the role's inferred aggregate class.

### Profiles in the capability manifest

```sh
quiet-choir workflow validate review.workflow.ts --json
quiet-choir workflow execute review.workflow.ts --run-id review-1
```

Validation emits `workflow.capabilities`: the `defaultProfile` name, all named and built-in
profiles, provider access, models, tool gates, limits, descriptions, and `requiredGrants`, which
lists the elevated roles only [under `requireGrants`](#requiregrants-launch-grants-and-pins) and is
empty otherwise. Access classes are always computed, as labels for the audit trail. Explicit
environment values are omitted; per-provider environment names and digests remain available, as a
shared `capabilities.environment` plus each profile's differences (`--harness-schemas` prints the
complete, uncompacted manifest). It imports trusted source but does not evaluate the workflow body.
With `strictProfiles: true`, raw capability controls are rejected at call sites: tools,
allowed/disallowed rules, permission modes, sandbox, MCP/settings, native agents/profiles/config,
dirs, environment, escape args and network access. Native configuration/agent/escape/env controls,
explicit inherited mode, plugins, and enabled network access are classified as exec access, and
Codex additional directories as write access; under `requireGrants` those classes need grants. Role
prompts, model, effort, fallbacks and image attachments remain available per call. See
[harness controls](harness-controls.md). The manifest bounds declared agent controls; it does not
confine workflow JavaScript or arbitrary working directories. Printed and checkpointed manifests
show settings, MCP servers, subagents, system prompts, Codex config, environment values and the
registered harness options a declaration lists in `sensitiveOptions` (under `redacted.harnesses`)
only as names and digests under `redacted`/`environment`; grant pins and step identity use the raw
declaration. Configuration isolation is a separate
[provider-specific boundary](harness-isolation.md).

### requireGrants: launch grants and pins

Launch grants are opt-in ([ADR 0063](decisions/0063-bound-agents-and-typed-rosters.md) §5, amending
[ADR 0010](decisions/0010-agent-profiles-and-grants.md)). By default no role needs a grant: a write
or exec role runs as declared, and the workflow's TypeScript is trusted code either way. Turn the
layer on with `requireGrants: true` on the root definition, or for one run with `--require-grants`
on `workflow execute`, `execute --resume`, `execute --fork-from`, `workflow start` and
`workflow resume` (`RunOptions.requireGrants` for embedders). A child's own `requireGrants` is
ignored; children inherit the root's setting. The run-level flag is sticky: it is saved with the run
(`requireGrants: true` in the record), so every later resume, `workflow tick` and the emitted grant
command keep it without repeating it, and it cannot be turned off. A resume that first gives it and
is refused for a missing grant before the body still saves it (and nothing else), so the printed
`--resume --grant` retry enforces; if that save fails, the refusal says to repeat
`--require-grants`. A fork is a new run and does not inherit it. Removing the definition field under
`--accept-code-change` turns the layer off unless the run-level flag was given.

```sh
quiet-choir workflow execute review.workflow.ts --run-id review-1 --require-grants --grant fixer
```

Under `requireGrants`, every declared or default role with write/exec access requires authorization
before the body starts, even if a branch never uses it. Roster entries are declared roles here: a
write- or exec-capable entry, such as a `workspace-write` Codex mechanic, is listed in
`requiredGrants` and needs `--grant Mechanic` (or a class grant), and its named grant pins its
capabilities like a profile's. An entry's access is its pinned harness's alone. `--grant fixer`
authorizes that role; `--grant write` authorizes write roles; `--grant exec` authorizes both write
and exec; `--grant all` authorizes every role. Multiple `--grant` flags accumulate. Undeclared
built-ins are listed in the manifest but an elevated built-in is disabled until granted; invoking
`edit` without a grant fails before that agent call. Declaring an elevated named role makes this
check happen before **any** workflow effects, and `--grant` hints and `next` commands name the
missing grant.

Grants persist on resume. Named grants are pinned to exact tools, allowed rules, sandbox, the other
declared capability controls, a roster entry's pinned harness and, when declared,
`claude.addDirRoots`; after those change (including repinning an entry to another harness), supply
the grant again, even with `--accept-code-change`. Class/all grants deliberately cover roles within
that class. Forks require fresh grants. Embedded callers use `RunOptions.grants`. Without
`requireGrants`, `--grant` is still validated (an unknown name is an error), saved and pinned, so a
later `--require-grants` resume honours it. A run created before schema revision 18 resumes with the
layer off unless its definition opts in.

#### Bounded call-site directories

Under `strictProfiles: true`, a directory known only at runtime, such as a per-PR state directory an
earlier step created, can be made readable to one Claude agent without widening its `cwd`. Declare
roots on the profile and pass `addDirs` at the call:

```ts
profiles: { reader: { extends: 'readonly', claude: { addDirRoots: ['.state/runs'] } } },
// ...
await ctx.claude.text('review', { profile: 'reader', prompt, addDirs: [`.state/runs/${pr}`] });
```

- **Typecheck.** In a strict workflow, `addDirs` on a profile without roots (including the implicit
  `text`) fails typecheck and `workflow validate` (`load.typecheck`); the runtime check below still
  covers what the types cannot see.
- **Claude only.** Codex `addDirs` are writable sandbox roots, so Codex cannot take a bounded
  call-site directory; `codex.addDirRoots` (on a profile or on `defaults`) fails validation with
  that reason. List Codex directories statically in `codex.addDirs`.
- **Path policy.** `addDirRoots` is profile-only (never a call option) and is published verbatim in
  `workflow.capabilities`. Roots resolve against the run's working directory; call entries resolve
  against the call's `cwd`. An entry containing a `..` segment is refused before resolution. Both
  sides are canonicalized: the real path of the deepest existing ancestor (symlinks followed) plus
  any not-yet-created segments, so a directory a later step creates can still be named, while a
  symlink that leaves a root, or a dangling symlink, is refused. An entry must equal or sit inside a
  root. Errors name the entry, its canonical path, the profile and the canonical roots.
- **Append.** Accepted entries are appended, as canonical absolute paths, to the profile's own
  `addDirs` (exact duplicates dropped), so a call cannot drop a declared directory. Those canonical
  paths reach `--add-dir`, step identity and the attempt's request summary (`request.addDirs`). A
  profile without roots, a Codex call, or any other raw key keeps the existing
  `strictProfiles forbids call-site …` error.
- **Grants.** Access classification is unchanged: a Claude directory is `read`, so a call-site
  directory never raises a role above what its tools give, and under `requireGrants` a write-capable
  role still needs its grant. A tool-less rooted role is `read`. Roots are part of the named grant
  pin.
- **Children.** Under `requireGrants`, a child's `addDirRoots` must lie inside the parent role's
  roots, and a child call's canonical directories inside the parent's roots; otherwise delegation
  fails with `Child profile … exceeds parent profile …: claude.addDirRoots` (or `claude.addDirs`). A
  grandchild or deeper descendant is also checked, at delegation and at every call, against every
  ancestor role's roots, each canonicalized when checked, so a symlink root an intermediate child
  narrowed to and later retargeted cannot reach outside the top-level root; that fails with
  `Child profile … exceeds ancestor profile …: claude.addDirs` (or `claude.addDirRoots`).
- **Limits.** The check runs when the call is resolved, not when the CLI opens the directory, so a
  concurrent writer that swaps a path component for a symlink in between is not caught. Resolution
  also runs on replay: a completed step whose directory is now outside its roots (a retargeted
  symlink) fails to resolve on resume. Restricted mode is unchanged; only `--add-dir` is added, and
  restricted Claude loads no instructions or skills from those directories (see
  [harness isolation](harness-isolation.md#native-boundary)). See
  [ADR 0054](decisions/0054-bounded-call-site-adddirs.md).

Without strict profiles (the default, or `strictProfiles: false`), a call's `addDirs` replace the
profile's list without canonicalization, and roots are not enforced; a roster call's `addDirs`
append to its entry's instead. Roster entries cannot declare `addDirRoots`, so under an explicit
`strictProfiles: true` a roster call that passes `addDirs` is refused, like a raw call's.

Without strict profiles (the default), raw capabilities at call sites are accepted. Under
`requireGrants` they still require class/all grants; a named grant cannot authorize arbitrary
call-site replacements. The manifest then reports that it cannot bound those replacements. The
historical direct-port experiments set `strictProfiles: false` explicitly to preserve their
input-based API.
