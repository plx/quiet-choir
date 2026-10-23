# Agent calls

Declare the agents a workflow uses in a [roster](#roster) and call them as `ctx.roster.Name`; reach
for `ctx.claude` or `ctx.codex` directly when a call needs raw options. `value(id, options)` returns
just the answer: text without `schema`, or a locally validated value with `schema`. `text` and
`object` return `{ output, sessionId, usage, diagnostics }`. All three checkpoint the same full
result and effect identity. Use `onError: 'return'` for a durable `Settled` outcome; cancellation,
checkpoint, and pre-launch configuration failures still reject. See
[failure handling](workflow-authoring.md#failure-handling).

## Shared options and enforcement

These are quiet-choir options. The core resolves roster-entry and workflow defaults and validates
requests; `CliHarness` translates them to native flags and enforces process limits. A custom harness
must honor the resolved request itself. Native binaries/configuration still determine model support.

| Option                   | Claude                                   | Codex                            | Default                                      | Enforced by                                                    |
| ------------------------ | ---------------------------------------- | -------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| `prompt`                 | stdin                                    | stdin                            | Required                                     | Core validates; adapter supplies without a shell               |
| `schema`                 | Object root                              | Compat accepts common Zod shapes | No schema for text                           | Core validates output; provider adapter prepares wire schema   |
| roster entry             | `ctx.roster.Name`, see [Roster](#roster) | Same                             | Text baseline                                | Core resolves capabilities and grants                          |
| `model`                  | Name/alias                               | Name/alias                       | Inherited native model                       | Adapter passes; native CLI selects                             |
| `effort`                 | low/medium/high/xhigh/max                | Same, plus none/minimal          | Inherited                                    | Core validates; native CLI applies                             |
| `cwd`                    | Relative to run cwd or absolute          | Same                             | Run cwd                                      | Core resolves absolute path; adapter must use `request.cwd`    |
| `timeoutMs`              | Wall-clock                               | Wall-clock                       | Text 300,000 ms                              | Entry or baseline supplies; adapter times and terminates       |
| `maxTurns`               | Positive integer                         | Unsupported                      | Text 10                                      | Entry or baseline supplies; Claude enforces                    |
| `maxBudgetUsd`           | Positive finite USD                      | Unsupported                      | Text $0.50                                   | Entry or baseline supplies; Claude enforces                    |
| `tools` / `allowedTools` | Exposed / permitted tools                | Unsupported                      | Text empty; allowed copies tools             | Core grants; Claude enforces                                   |
| `sandbox`                | Unsupported                              | read-only/workspace-write        | read-only                                    | Core grants; Codex enforces                                    |
| `addDirs`                | Extra dirs                               | Extra writable directories       | None                                         | Core resolves/bounds/grants; native CLI enforces               |
| `extraArgs`              | `--flag` or `--flag=value`               | Same                             | None                                         | Adapter rejects owned flags/aliases; core fingerprints strings |
| `env`                    | Environment overlay                      | Same                             | Inherit parent environment                   | Adapter overlays; core fingerprints explicit values            |
| `retry`                  | Safe-to-repeat calls only                | Same                             | One attempt; opted-in delay starts at 100 ms | Core owns retry, removes it from adapter request               |
| `onError`                | throw/return                             | Same                             | throw                                        | Core journals final outcomes                                   |

`prompt`, and Claude's `systemPrompt` and `appendSystemPrompt`, also accept a `Prompt` rendered by
`definePrompts`; the runtime sends and fingerprints its text exactly as the equal string (see
[prompt templates](prompts.md)). See [Claude controls/protocol](claude.md) and
[Codex controls/protocol](codex.md) for native-specific fields. Keep rotating secrets in the
inherited environment; explicit `env` values affect replay. Escape-argument paths fingerprint their
strings, not file contents.

## Roster

A roster is the workflow's inventory of agents: named, concrete configurations, each pinned to one
harness. Keep it in a data-only `roster.ts` module that workflows import, so typos in a name fail
typecheck. The complete example below inlines it; see the `pattern-roster` module in
[patterns](patterns.md#roster-and-bound-agents) for the shape to copy.

```ts
import { defineRoster, defineWorkflow, z } from 'quiet-choir';

const roster = defineRoster({
  Reviewer: {
    harness: 'claude',
    model: 'opus',
    effort: 'high',
    tools: ['Read', 'Grep', 'Glob'],
    maxTurns: 40,
    maxBudgetUsd: 4,
    appendSystemPrompt: 'Review for correctness first.',
  },
  Mechanic: { harness: 'codex', sandbox: 'workspace-write', timeoutMs: 1_800_000 },
});
const Review = z.object({ verdict: z.enum(['approve', 'revise']), notes: z.string() });

export default defineWorkflow({
  name: 'review',
  version: '1',
  input: z.object({ diff: z.string() }),
  output: Review,
  roster,
  run: (ctx, input) => ctx.roster.Reviewer.value('review', { prompt: input.diff, schema: Review }),
});
```

- An entry is `{ harness, description?, expectsToolUse? }` plus that harness's own options.
  `harness` is the discriminant: `'claude'` takes `ClaudeOptions`, `'codex'` takes `CodexOptions`,
  and a registered harness takes its declared schema. A Codex key on a Claude entry fails typecheck:
  there are no cross-harness `claude:` and `codex:` blocks, so a role that serves both harnesses
  becomes one entry per harness (`Reader`, `CodexReader`).
- There is no `extends`: spread a shared entry (`{ ...Reviewer, model: 'sonnet' }`). An entry sets
  no per-call keys (`prompt`, `schema`, `cwd`, `worktree`, `onError`, `retry`); a standing prompt is
  a string or a rendered [`Prompt`](prompts.md) in `appendSystemPrompt`. Names are PascalCase
  identifiers; `text`, `readonly` and `edit` are refused.
- `ctx.roster.Name` is the entry's harness client bound to it, so a call takes the prompt, the
  schema, placement (`cwd`, `addDirs`, `worktree`) and policy (`onError`, `retry`, deadlines), and
  `ctx.roster.Reviwer` fails typecheck. A call's `addDirs` append to the entry's. Pass an agent to a
  helper typed `Agent` (`review(ctx.roster.Reviewer, diff)`); a bare `WorkflowContext` helper sees
  every name as a possibly text-only agent.
- A call resolves in order: the text baseline, workflow `defaults`, the entry, the call's own
  options, `--profile Name.limit=` overrides, then `--policy` rules. The request and fingerprint are
  those of a raw call that spells the entry's options, so moving a call onto a roster keeps its
  completed steps reusable under `--accept-code-change`.
- An attempt records the entry name as its role. `workflow validate --json` lists each entry under
  `workflow.capabilities.profiles` with its `harness`, model, tools or sandbox, limits and derived
  access (a tool-less Claude entry is `none`).
- An entry runs only on its own harness: an untyped call that selects it on the other one fails with
  `Roster entry Reviewer is pinned to harness claude; it cannot run on codex.`
- Inside an inline child, `ctx.roster` is the child's own roster, so read it where you call it
  rather than carrying a parent's agent through shared state.
- A [package](packages.md#roster) keeps one `roster.ts` at its root, which its workflows import.
  Each workflow's `roster` field lists only the entries it calls, and `workflow validate --json`
  reports each workflow's roster in the `package` section.

A decider entry, `{ decider, model?, description? }`, names one of the workflow's `decisions`
instead of a harness (checked when the workflow loads). `ctx.roster.Name` is then `{ decide }`:
`ctx.decide` with the entry's provider and model fixed, so a call takes only `state`, `questions`,
`onError`, `retry` and `timeoutMs`, and passing `provider` or `model` fails typecheck. The step's
identity and fingerprint equal those of `ctx.decide(id, { provider, model, ... })`, and its
`meta.roster` names the entry (a label, never identity). A decider takes no agent keys, is not a
role (no grant or `--profile` override) and cannot fill a team slot; `workflow validate --json`
lists it under `workflow.deciders` with its provider and model.

<!-- skills-check: fragment; reason: A roster module and one call in a body; the workflow declares decisions: [jev] and has ctx, input and choice in scope. -->

```ts
const roster = defineRoster({
  Triage: { decider: 'jev', model: 'jev-1.13', description: 'Routes support tickets.' },
});
// In the body of a workflow with decisions: [jev] and this roster:
const route = choice({ instructions: 'Which team?', options: { billing: null, support: null } });
const answers = await ctx.roster.Triage.decide('triage', { state: input, questions: { route } });
// answers.route.choice is 'billing' | 'support'
```

### Teams

A team names the roles a helper needs, independent of which entry fills them. Declare it with
`defineTeam({ slot: 'description' })` and derive its record type with `TeamOf`; fill it where the
workflow calls the helper, from `ctx.roster` entries, and pass it in. `Team.from(ctx.roster)` picks
the slot keys, and `Team.from({ ...ctx.roster, critic: ctx.roster.Skeptic })` overrides one slot. A
team registers nothing and checks no capability, and a call through a slot is identical to a call
through the entry that fills it. See [packages](packages.md#teams) for `lib/teams.ts` and
[bounded review/revise](patterns.md#bounded-reviewrevise) for a loop that takes a team.

## Bound agents

`ctx.claude.bind(options)` (also `ctx.codex` and `ctx.agent(name)`) returns an `Agent` that fixes
everything except the prompt, the schema, placement and policy. Each roster entry is such an agent;
bind directly when one call site needs a configuration no entry names:

```ts
import { defineWorkflow, z, type Agent } from 'quiet-choir';

const Review = z.object({ verdict: z.enum(['approve', 'revise']) });

async function review(agent: Agent, diff: string) {
  return agent.value('review', { prompt: `Review this diff:\n${diff}`, schema: Review });
}

export default defineWorkflow({
  name: 'bound-review',
  version: '1',
  input: z.object({ diff: z.string() }),
  output: Review,
  run: (ctx, input) =>
    review(ctx.claude.bind({ model: 'opus', effort: 'high', tools: ['Read', 'Grep'] }), input.diff),
});
```

- `bind` cannot set `prompt`, `schema`, `cwd`, `worktree`, `onError`, `retry` or Codex `images`
  (typecheck, and a runtime `TypeError`). A bound call takes only those plus `addDirs`, `timeoutMs`
  and `idleTimeoutMs` (and `images` for Codex); any other key fails typecheck and an untyped one
  rejects before a step ID is claimed.
- `addDirs`, `timeoutMs` and `idleTimeoutMs` may be bound as defaults and set per call. Call
  `addDirs` append to the bound list; the call's deadline wins; an `undefined` call value keeps the
  default. When a registered harness's schema requires one of them, `bind` may leave it to each
  call; once bound to a value its type says is always set (not an optional property), calls and
  re-binds may omit it.
- Identity is the raw call's: the merged options fingerprint, resolve the entry and policy, and
  record exactly as if spelled at the call site, so after moving a call to a bound agent,
  `--accept-code-change` still reuses its completed step.
- Binding performs no effect. The step ID prefix comes from where the agent is called, so bind once
  and reuse it inside `ctx.scope`, `ctx.map` items or helpers; an agent bound from
  `ctx.within('w').claude` keeps `w/`.
- A registered harness with `structuredOutput: 'none'` binds to a text-only agent (no `object`, no
  schema on `value`), which a parameter typed `Agent` rejects; use
  `Agent<{ structuredOutput: 'none' }>` for helpers that only need text. `Agent` defaults to
  `NativeHarnessCapabilities`.
- A bound agent binds again over `addDirs`, `timeoutMs` and `idleTimeoutMs` only; any other key
  fails typecheck and throws a `TypeError` at runtime, since the first bind fixed it.
- Under `strictProfiles: true`, `bind` takes the same keys as a raw call site, so strict-owned
  controls such as `tools` belong on a roster entry (see [strict call sites](#strict-call-sites)).

## Raw-call defaults

A raw `ctx.claude` or `ctx.codex` call that names no roster entry runs on the text baseline:
tool-less for Claude and read-only for Codex (300s, 10 Claude turns, $0.50). Codex text still has
read access; Claude turn and USD limits do not apply to Codex. A call that needs tools, a sandbox
beyond read-only or other limits uses a roster entry or a bound agent, or spells them at the call
site. Workflow `defaults` (per-harness model and effort, and limits) apply to every call; replacing
Claude `tools` re-infers `allowedTools` unless supplied explicitly. `workflow validate FILE --json`
lists the resolved `workflow.capabilities` without running the body, compactly (each fact once,
harness option schemas omitted); `--harness-schemas` prints the complete document, and
`requiredGrants` there is empty unless `requireGrants` is on. Unknown tools and native config
controls are conservatively classified as exec access. Configuration loading defaults to restricted
mode; [harness isolation](harness-isolation.md) explains inherited roles, environment edits and
provider boundaries.

### requireGrants: launch grants

Launch grants are opt-in: by default a write or exec role runs without one. Set
`requireGrants: true` on the root definition, or pass `--require-grants` to `workflow execute`,
`execute --resume`, `execute --fork-from`, `workflow start` or `workflow resume`
(`RunOptions.requireGrants` when embedding). The run-level flag is saved with the run, even by a
resume refused for a missing grant before the body: later resumes, `tick` and emitted commands keep
it, and a fork does not inherit it. Under it, every declared/default write or exec roster entry
needs a launch grant: `--grant Fixer` (the entry's name), `--grant write`, `--grant exec` (includes
write), or `--grant all`. A write or exec entry is listed in `requiredGrants` and preflights before
effects, even when no branch uses it; an entry's access is its pinned harness's alone. Grants
persist on resume. Named grants pin the entry's capability declarations and its harness, and must be
renewed if those change. Elevated raw call-site controls need class/all grants. Without the layer,
`--grant` is still validated and saved, so a later `--require-grants` resume honours it.

### Strict call sites

`strictProfiles` is opt-in (default `false`). Under `true`, raw capability controls (tools,
permissions, MCP, native config and agents, dirs, escape args, environment, and
`isolation: 'inherit'`) are rejected at raw call sites and in `bind`, by type and by
`workflow validate`; declare them on a roster entry. That includes call-site `addDirs`: list
directories in the entry's `addDirs`. `addDirRoots` was removed in #707, and a roster entry or
`defaults.claude` that declares it is refused when the definition loads (ADRs 0054 and 0062 record
the historical rooted form). Explicit `defineWorkflow` type arguments are all-or-nothing: with a
shorter prefix such as `defineWorkflow<Input, Output>`, the rest take the permissive, childless
defaults and leave `roster` uninferred; drop the type arguments (preferred) or spell all six.

### Limit overrides and diagnostics

Raise execution limits without source edits using
`--resume --run-id ID --profile Reviewer.maxTurns=60` or `--profile '*.timeoutMs=1800000'`;
`--profile` names a roster entry or `*` (every role, raw calls included). Override fields are
maxTurns, maxBudgetUsd, timeoutMs and idleTimeoutMs. Rules persist; `--policy-reset` clears override
and step rules. Matching step `--policy` rules win. Embedders use `profileOverrides` and `grants` in
`RunOptions`. Permission denials are warnings unless `onPermissionDenied: 'fail'` makes them
permission-kind failures while retaining usage.

`idleTimeoutMs` (off by default; set on `defaults`, a roster entry, a call, `--profile` or an agent
`--policy` rule) ends an attempt whose CLI writes no stdout/stderr for that long, with kind
`idle-timeout`; streaming output never trips it. It is policy outside identity, so raise it on
resume as the error suggests (`--profile Name.idleTimeoutMs=N`). Size it above the longest silent
tool run or reasoning stretch: a too-small deadline fails the same way on every retry, including
`'transient'` ones. Each attempt counts its tool calls in `diagnostics.toolUses` (Claude `tool_use`
blocks without the `StructuredOutput` carrier, Codex command/file/MCP/web-search items). When the
entry's `expectsToolUse` is true (default: any Claude tool or a Codex sandbox beyond read-only) and
a completed attempt used none, the step gets a warning
`no-tool-use: Profile <name> expects tool use, ...`, shown on `agent.finished` and in `inspect`; it
never fails the call. Custom adapters opt in by passing `idleTimeoutMs` to `runProcess` and
reporting `toolUses`.

## Replay, retry, and usage

Prompts, schemas, resolved models/effort, cwd, and capabilities must match completed effects. Entry
names, execution limits, retry policy, and run concurrency stay outside identity. `attemptHistory`
records resolved limits, provenance, requested model/effort (or inherited), timing, and outcome.
Model/effort policy replacements require `--allow-model-override` and affect unfinished attempts
only. Source edits require [acceptance or a fork](durability.md#choose-a-recovery-path). Default
retry is one attempt; an explicit `retry.on` filters error categories. Earlier attempts may already
have mutated files. A saved `settled-failed` outcome replays without retrying.

Each native effect creates a fresh session. Its `sessionId` is diagnostic, not a workflow resume
token. Pass earlier answers explicitly in later prompts. `HarnessRequest.call` supplies `runId`,
full `stepId`, cumulative `attempt`, and stable `idempotencyKey` (`runId/stepId`) outside identity.
Native CLIs do not use that key to deduplicate edits.

Unknown usage and native IDs are `null`. Success stores usage with the full result; failed protocol
attempts can save available usage/session metadata in `failedAttempts`. Attempt histories also
retain response usage when local schema validation fails. Dashboard totals exclude copied fork
history and mark incomplete coverage. Replay is not a new charge. Provider token counters differ;
read their references before comparing them. Missing/abandoned work makes this an incomplete
spending ledger, and per-call limits do not impose a run-wide spend cap.

## Process lifecycle

`CliHarness` independently caps retained protocol state/lines at 8 MiB, combined raw output at 1
GiB, and private attempt transcripts at 64 MiB. CLI flags `--max-retained-bytes`,
`--max-stream-bytes`, `--max-transcript-bytes`, and `--transcripts` are sticky execution policy.
`maxOutputBytes` is now a legacy alias for agent retention, not the whole trace. See
[streaming and attempt evidence](agent-streaming.md). The per-call timeout starts on agent
admission, not while queued. `--max-agents` and `--harness-limit` share slots across nested maps;
each map's mapper concurrency remains a separate local limit.

Every leader exit reaps owned process groups on macOS/Linux; Windows cleanup reaches the immediate
child only. First SIGINT/SIGTERM/SIGHUP cancels, drains, and exits 130. A second signal force-kills
tracked groups; SIGKILL/crashes can leave survivors and older checkpoints. Default TERM-to-KILL
grace is 3000 ms (`--kill-grace-ms`). Use the
[ownership/recovery procedure](operating-runs.md#stalls-and-orphan-recovery) before replacement
work. Unknown identities are never signaled. Escaped groups and the spawn-to-record crash gap
require separate investigation; stopped calls may already have edited files.

## Usage and run caps

Current native usage includes token categories, requested/effective model evidence and raw usage.
Use [usage and budgets](usage-budgets.md) to interpret nulls, count failures once, inspect totals,
and set sticky run-wide cost/attempt gates. These are operator stops outside effect identity;
per-call retries or settled error handling cannot bypass a latched run gate.

## Child rosters and delegation

A child has its own roster: nothing is compared to the parent's entries, and `ctx.workflow`'s
`profiles` option is accepted and ignored; the parent's `--profile` limit rules still match by name.
Parent-child ceilings apply only under `requireGrants`: inline child roles map to parent roles of
the same name (or the `ctx.workflow` `options.profiles` remap maps them explicitly), and missing or
insufficient grants fail before child effects. Child tool exposure cannot grow; mapped parent model
and effort defaults and limit overrides pass down, and limits are bounded by the parent. A parent
`onPermissionDenied: 'fail'` passes down too; a child cannot weaken it to `warn`. Root concurrency
and budgets span every frame. See [child workflows](child-workflows.md).
