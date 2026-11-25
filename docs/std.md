# The standard library

`quiet-choir/std` is the opt-in standard library: roster entries, typed data, helpers, team-free
control flow and team-typed patterns, built only on the public `quiet-choir` entry point
([ADR 0068](decisions/0068-standard-library-scope.md)). A workflow that uses it spends its lines on
what is specific to it. This page is the reference for every export; the one-screen
[recipes](#recipes) show the patterns in complete workflows.

- [Import and principles](#import-and-principles)
- [Roster inventory](#roster-inventory)
- [Types](#types)
- [Lenses](#lenses)
- [Helpers](#helpers): [std.data](#stddata), [std.text](#stdtext), [std.exec](#stdexec)
- [Flow](#flow): [untilDry](#untildry), [waves](#waves), [each](#each)
- [The pattern contract](#the-pattern-contract): [status and failures](#status-and-failures),
  [result schemas](#result-schemas)
- [Patterns](#patterns)
- [Recipes](#recipes)
- [Writing a pattern of your own](#writing-a-pattern-of-your-own)

## Import and principles

```ts
import * as std from 'quiet-choir/std';
```

The recipes in this checkout import `../../src/std/index.js` instead, as they import
`../../src/index.js` for `quiet-choir`. The library has fifteen namespaces:

| Namespace      | Holds                                                                                |
| -------------- | ------------------------------------------------------------------------------------ |
| `std.claude`   | Claude capability fragments: `Text`, `ReadOnly`, `Web`, `Edit`, `shell`, `editShell` |
| `std.codex`    | Codex capability fragments: `Text`, `ReadOnly`, `Edit`                               |
| `std.tiers`    | Claude model and effort tiers                                                        |
| `std.limits`   | Claude turn, spend and time limits                                                   |
| `std.personas` | Standing Claude system prompts, `join` and `ShellEtiquette`                          |
| `std.roles`    | Complete roster entries that combine the four axes above, and shell factories        |
| `std.rosters`  | `readers` and `standard`, rosters of the roles                                       |
| `std.bash`     | `Bash(...)` allowlist and deny rules for shell entries                               |
| `std.types`    | Zod schemas for agent outputs and workflow data                                      |
| `std.lenses`   | Catalogs of named lenses, `designRubric` and `LensSchema`                            |
| `std.data`     | Pure helpers: settled results, health, voting, deduplication, ranking, hashing       |
| `std.text`     | Stable prompt text and Markdown reports                                              |
| `std.exec`     | Durable command, Git and publication helpers                                         |
| `std.flow`     | Team-free control flow: `untilDry`, `waves`, `each`                                  |
| `std.patterns` | Team-typed patterns, their teams, option types and result schemas, `CallDefaults`    |

The library follows these principles:

- **Nothing is registered.** Every piece is an ordinary composition of public context methods
  (`ctx.scope`, `ctx.map`, `ctx.exec`, `ctx.step`, `ctx.worktree`, `ctx.merge`, `ctx.approve`,
  `ctx.log` and bound agent calls). A pattern records the same steps your own code would, and the
  runtime's replay, resume and rehearsal rules apply unchanged. Every module imports only the public
  entry point, its siblings and Node built-ins.
- **Released text is step identity.** Default prompts, schemas and their descriptions, persona and
  lens text, and a role's tools, model and effort are part of the identity of the calls that use
  them (its limits are not). They change only by adding a new name; changing one would refuse to
  replay completed calls that sent it, as any prompt change does. The tests pin by digest the
  persona texts, the released lens charters and the JSON Schema of every `std.types` schema and
  pattern result schema, and they pin the lens keys.
- **Patterns stay in-process.** A pattern is a function, not a child workflow, so a workflow needs
  no `children` entry to call one. Deciders cannot fill a team slot. The library ships no runnable
  package; the [recipes](#recipes) under `examples/patterns` show the patterns in complete workflows
  instead.

## Roster inventory

The roster inventory gives each common configuration one spelling. It composes by spread along four
axes, in this order so each later `description` wins: a capability fragment (`std.claude`,
`std.codex`), a model tier (`std.tiers`), limits (`std.limits`) and a persona (`std.personas`).
Every value is frozen data. The fragments, tiers, limits, personas and `std.bash` rule sets are
described in [standard library entries](roster.md#standard-library-entries); in short:

- `std.claude`: `Text` (no tools, `none`), `ReadOnly` and `Web` (`read`), `Edit` (`write`), and
  `shell(rules, deny?)` and `editShell(rules, deny?)`, which narrow `Bash` to an allowlist and deny
  `std.bash.noPush` by default (`exec`). The types `ShellEntry` and `EditShellEntry` describe the
  two shells.
- `std.codex`: `Text` and `ReadOnly` (`sandbox: 'read-only'`) and `Edit` (`workspace-write`), with
  no turn or spend limits.
- `std.tiers` (type `Tier`): `Clerk`, `Copyist`, `Scribe`, `Mechanic`, `Planner`, `Skeptic`,
  `Surgeon` and `Judge`.
- `std.limits` (type `Limits`): `Brief`, `Standard`, `Extended`, `Hour` and `Long`.
- `std.personas` (type `Persona`): `Clerk`, `Scout`, `Researcher`, `Reviewer`, `Skeptic`, `Critic`,
  `Judge`, `Planner`, `Implementer`, `Surgeon`, `Tester` and `Scribe`; `join(...texts)` and the
  `ShellEtiquette` text for shell entries.
- `std.bash`: `rule(...words)`, `npmRun(...scripts)`, the sets `gitRead`, `ghRead`, `files`,
  `nodeCheck`, `pythonCheck`, `cargoCheck`, `goCheck`, `gitCommit`, `gitRebase` and `npmInstall`,
  and the deny sets `noPush` and `noRewrite`.

`std.roles` names the useful combinations as complete entries. A role is a plain frozen object, so
spread it to adjust it: `{ ...std.roles.Mechanic, ...std.limits.Long }`. Under `requireGrants`,
every `write` or `exec` entry in a roster needs a grant before the body runs, even one the body
never calls.

| Role            | Composition                                               | Use                                                         | Access  | Grant |
| --------------- | --------------------------------------------------------- | ----------------------------------------------------------- | ------- | ----- |
| `Clerk`         | `claude.Text` + `tiers.Clerk` + `personas.Clerk`          | Mechanical text work: copy, extract, format                 | `none`  | no    |
| `Writer`        | `claude.Text` + `tiers.Scribe` + `personas.Scribe`        | Prose from the prompt alone; `expectsToolUse: false`        | `none`  | no    |
| `Scout`         | `claude.ReadOnly` + `tiers.Copyist` + `personas.Scout`    | A quick, broad survey that returns leads                    | `read`  | no    |
| `Reader`        | `claude.ReadOnly`                                         | Reads files; the workflow's defaults pick model and effort  | `read`  | no    |
| `Researcher`    | `claude.Web` + `tiers.Scribe` + `personas.Researcher`     | Web and file research that cites primary sources            | `read`  | no    |
| `Reviewer`      | `claude.ReadOnly` + opus, high + `personas.Reviewer`      | Code review, correctness first                              | `read`  | no    |
| `Skeptic`       | `claude.ReadOnly` + `tiers.Skeptic` + `personas.Skeptic`  | Refutes a claim; falls back to the prompt's safe default    | `read`  | no    |
| `Critic`        | `claude.ReadOnly` + `tiers.Skeptic` + `personas.Critic`   | Critiques a draft against its brief with concrete fixes     | `read`  | no    |
| `Judge`         | `claude.ReadOnly` + `tiers.Judge` + `personas.Judge`      | The final, escalated judgement (opus, xhigh)                | `read`  | no    |
| `Planner`       | `claude.ReadOnly` + `tiers.Planner` + `personas.Planner`  | Grounded implementation plans                               | `read`  | no    |
| `Scribe`        | `claude.ReadOnly` + `tiers.Scribe` + `personas.Scribe`    | Prose from given facts; `expectsToolUse: false`             | `read`  | no    |
| `Editor`        | `claude.Edit`                                             | Edits files; the workflow's defaults pick model and effort  | `write` | yes   |
| `Mechanic`      | `claude.Edit` + `tiers.Mechanic` + `personas.Implementer` | Mechanical implementation of a plan                         | `write` | yes   |
| `Surgeon`       | `claude.Edit` + `tiers.Surgeon` + `personas.Surgeon`      | Subtle changes; takes over when a mechanic fails            | `write` | yes   |
| `CodexReader`   | `codex.ReadOnly`                                          | A Codex reader                                              | `read`  | no    |
| `CodexReviewer` | `codex.ReadOnly` + `effort: 'high'`                       | A Codex reviewer; prepend `personas.Reviewer` to the prompt | `read`  | no    |
| `CodexEditor`   | `codex.Edit`                                              | A Codex editor                                              | `write` | yes   |
| `CodexMechanic` | `codex.Edit` + `effort: 'high'`                           | A Codex implementer; prepend `personas.Implementer`         | `write` | yes   |

No role in the table has a shell, since an allowlist is project-specific. Three factories in
`std.roles` give one from `std.bash` rules; `deny` defaults to `std.bash.noPush`:

| Factory                         | Composition                                                                                        | Type                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------- |
| `withShell(role, rules, deny?)` | The role with `claude.editShell` if its tools include Edit or Write, else `claude.shell`           | `ShellRole<R>`               |
| `tester(rules, deny?)`          | `claude.shell` + `tiers.Mechanic` + `personas.Tester`                                              | `TesterRole`                 |
| `fixer(rules, deny?)`           | `withShell(Mechanic, rules, deny)`: `claude.editShell` + `tiers.Mechanic` + `personas.Implementer` | `ShellRole<typeof Mechanic>` |

Each joins `std.personas.ShellEtiquette` to the persona's `appendSystemPrompt` and returns a frozen
entry equal to the hand-spelled spread; like any shell it is `exec`, so it needs a grant under
`requireGrants`. `withShell` replaces the role's capability (tools, `allowedTools`,
`disallowedTools` and the turn, spend and time limits) and keeps every other key, such as the tier,
the persona and `expectsToolUse`; a description inherited from `claude.Text`, `ReadOnly` or `Edit`
(as on `Reader` and `Editor`) becomes the shell's. It throws a `TypeError` for a Codex role (a Codex
sandbox has no command allowlist), a role that already has `Bash`, or one with a tool outside Read,
Grep, Glob, Edit and Write, such as `Researcher`'s web tools. `ShellableRole` is the type it accepts
and `ShellFragment<T>` the shell a tools list gets. Codex has no standing system prompt, so a Codex
role carries no persona; prepend the persona's `appendSystemPrompt` to the prompt with
`std.personas.join`.

`std.rosters.readers` declares the thirteen `none` and `read` roles (`Clerk`, `Writer`, `Scout`,
`Reader`, `Researcher`, `Reviewer`, `Skeptic`, `Critic`, `Judge`, `Planner`, `Scribe`, `CodexReader`
and `CodexReviewer`; type `ReaderRole`), so it needs no grant. `std.rosters.standard` declares the
eighteen roles of the table (type `StandardRole`; not the factories) and needs grants for `Editor`,
`Mechanic`, `Surgeon`, `CodexEditor` and `CodexMechanic`. A `defineRoster` result cannot be spread
into another roster; to add an entry, build your own roster from `std.roles`.

```ts
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Reviewer: std.roles.Reviewer,
  Skeptic: std.roles.Skeptic,
  Fixer: { ...std.roles.Mechanic, ...std.limits.Long },
  Checker: std.roles.tester([...std.bash.gitRead, ...std.bash.nodeCheck]),
  Auditor: std.roles.withShell(std.roles.Reviewer, std.bash.gitRead),
});
```

## Types

`std.types` holds Zod schemas for recurring agent outputs and workflow data. Each schema exports its
inferred type under the same name (`std.types.Finding` is both). Every record is a plain `z.object`,
so `.shape`, `.extend()` and `.pick()` work; `Receipt` is the exception, typed as
`z.ZodType<WriteFileResult>`.

```ts
const { findings } = await ctx.roster.Reviewer.value('review', {
  prompt: 'Find defects in src/parser.ts.',
  schema: std.types.Findings,
});
const Ticket = std.types.Task.extend({ owner: z.string().min(1) });
const Input = z.object({ rounds: std.types.limit(3, 10) });
```

The agent-output schemas follow rules that both harnesses' structured output accepts:

- The root is an object; wrap a list with `listOf`.
- Every property is required. Absence is `.nullable()`, as in `Finding.line` or `Citation.quote`.
- No record, tuple, discriminated union or loose object, so every one passes the Codex strict check
  (`checkCodexSchema`).
- No regex or format validator, so `--dry-run` rehearsal can synthesize a reply. `RepoPath` uses a
  refinement, which JSON Schema omits, so it is safe in agent output and still validated.
- Text is non-empty unless the tables below say it may be empty, and lists carry the bounds the
  tables give. A list without a bound in the tables is unbounded.
- Each field's `.describe()` text is what the agent reads, and it is part of call identity.

The input-side `Sha`, `ShortSha`, `Sha256`, `Key`, `Argv`, `Receipt`, `Commit` and `Criteria` use
patterns, formats, tuples, unions or an array root: validate data with them, but do not request them
from an agent.

### Primitives and input helpers

| Export                          | What it is                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `isRepoPath(path)`              | Whether `path` is a repository-relative path (see below)                                          |
| `RepoPath`                      | A string that satisfies `isRepoPath`; safe in agent output                                        |
| `Sha`                           | Input-side: a full Git object ID, 40 or 64 lowercase hex characters                               |
| `ShortSha`                      | Input-side: 7 to 64 lowercase hex characters                                                      |
| `Sha256`                        | Input-side: a SHA-256 digest, 64 lowercase hex characters                                         |
| `Key`                           | Input-side: a letter or digit, then up to 63 of `A-Za-z0-9._:-`; `ctx.id` leaves it unchanged     |
| `Argv`                          | Input-side: `[program, ...args]`, a `Command` for `ctx.exec`                                      |
| `limit(defaultValue, max, min)` | A bounded integer input with a default (see below)                                                |
| `Receipt`                       | Input-side: the `WriteFileResult` of `ctx.writeFile` or `std.exec.committedArtifact`              |
| `Commit`                        | Input-side: one commit as `std.exec.log` returns it (see below)                                   |
| `Criteria`                      | Input-side: a non-empty list of nonblank strings or `Criterion`s, as `checklist` takes them       |
| `CheckOutcome`                  | What `std.exec.check` returns: `passed`, the exit `code`, `output` (may be empty) and `truncated` |
| `Rationale`                     | Non-empty text: why, citing the evidence that decided it                                          |
| `Evidence`                      | Non-empty text: file:line references, command output or quotes                                    |
| `Summary`                       | Non-empty summary text                                                                            |
| `Score`                         | An integer from 1 (poor) to 10 (excellent)                                                        |

`isRepoPath` accepts 1 to 500 characters that are not absolute on POSIX or Windows, with no drive
letter (`C:/x`, `C:x`), backslash or NUL, and no `.`, `..`, empty or `.git` segment;
`std.exec.committedArtifact` refuses any other path. `limit(defaultValue, max, min = 1)` is
`z.int().min(min).max(max).default(defaultValue)`, so an input object declares a limit in one line.
It throws a `TypeError` unless every argument is a safe integer, and a `RangeError` unless
`min <= defaultValue <= max`.

A `Commit` is `sha` (a `Sha`), `shortSha` (a `ShortSha`), `author` (the name as recorded), `date`
(the author date in strict ISO 8601 with its UTC offset) and `subject` (the message's first
paragraph on one line; empty when the message is). `Criteria` refuses an empty list and a blank
string criterion.

### Enums

Each enum lists its values in this order.

| Export                 | Values                                                                         |
| ---------------------- | ------------------------------------------------------------------------------ |
| `Severity`             | `critical`, `high`, `medium`, `low`                                            |
| `Level`                | `high`, `medium`, `low` (no description: describe the field that uses it)      |
| `Size`                 | `XS`, `S`, `M`, `L`, `XL`                                                      |
| `Complexity`           | `mechanical`, `subtle`                                                         |
| `WorkStatus`           | `done`, `partial`, `blocked`, `skipped`                                        |
| `CheckStatus`          | `pass`, `fail`, `partial`, `unverifiable`                                      |
| `GateStatus`           | `pass`, `concern`, `blocker`, `cannot-check`                                   |
| `GateDecision`         | `go`, `conditional-go`, `no-go`                                                |
| `Outcome`              | `confirmed`, `refuted`, `undecided`                                            |
| `ChangeKind`           | `feature`, `fix`, `breaking`, `performance`, `deprecation`, `docs`, `internal` |
| `FalsificationVerdict` | `falsified`, `survives`, `untestable`                                          |

### Records

| Export            | Fields                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Finding`         | `title` (at most 200), `file` (`RepoPath`), `line` (integer from 1, or null), `severity`, `evidence`, `failureScenario`   |
| `Findings`        | `findings`: at most 20 `Finding`s; may be empty                                                                           |
| `Remediation`     | The `Finding` fields and `fix`, the concrete change that resolves the defect                                              |
| `Remediations`    | `remediations`: at most 20 `Remediation`s, most severe first; may be empty                                                |
| `Refutation`      | `refuted` (true unless the evidence shows the claim holds), `reasoning`                                                   |
| `Ballot`          | `yes`, `reasoning`                                                                                                        |
| `Approval`        | `approved`, `feedback` (may be empty); no descriptions, exactly the schema `reviewRevise` sends                           |
| `Issue`           | `where`, `problem`, `fix`                                                                                                 |
| `Critique`        | `issues`: at most 20 `Issue`s; an empty list approves                                                                     |
| `WorkReport`      | `status` (`WorkStatus`), `summary`, `files` (at most 100), `blockers`, `notes`                                            |
| `Verification`    | `passed`, `summary`, `failures`: `{ description, files }`                                                                 |
| `Step`            | `id` (at most 64), `description`, `files`                                                                                 |
| `Plan`            | `summary`, `steps` (1 to 20 `Step`s), `risks`, `checks`                                                                   |
| `Task`            | `id` (at most 64), `title` (at most 120), `description`, `acceptance` (at least 1), `dependsOn`, `size` (`Size`)          |
| `TaskList`        | `tasks`: 1 to 30 `Task`s                                                                                                  |
| `Criterion`       | `id` (at most 64), `criterion`, `how` (may be empty, to leave the method to the checker)                                  |
| `CriterionResult` | `status` (`CheckStatus`), `evidence`                                                                                      |
| `Citation`        | `claim`, `source`, `quote` (or null)                                                                                      |
| `Claims`          | `claims`: at most 20 `Citation`s; may be empty                                                                            |
| `Lead`            | `ref` (a URL, path, package or identifier), `why`                                                                         |
| `Leads`           | `leads`: at most 10 `Lead`s, best first                                                                                   |
| `Question`        | `question`, `why` (what depends on the answer), `answerFrom` (who can answer it or where to look), `blocking`             |
| `Questions`       | `questions`: at most 20 `Question`s, blocking ones first; may be empty                                                    |
| `Hypothesis`      | `id` (at most 64), `cause`, `mechanism`, `predictions` (1 to 5)                                                           |
| `Hypotheses`      | `hypotheses`: 1 to 8 `Hypothesis` entries                                                                                 |
| `Falsification`   | `verdict` (`FalsificationVerdict`), `reasoning`, `checked`                                                                |
| `Assessment`      | `status` (`GateStatus`), `summary`, `evidence`                                                                            |
| `Change`          | `kind` (`ChangeKind`), `summary`, `shas` (at least 1), `userVisible`, `migration` (or null)                               |
| `Changes`         | `changes`: one `Change` per distinct change                                                                               |
| `Proposal`        | `title`, `summary`, `design` (Markdown), `tradeoffs`, `risks`                                                             |
| `IssueDraft`      | `title` (at most 120), `body`, `label` (`bug`, `enhancement` or `documentation`), `duplicateOf` (integer from 1, or null) |
| `ReviewReply`     | `decision` (`continue`, `redo` or `stop`), `answer` (may be empty)                                                        |

`WorkReport` is an agent's claim about its work: trust a command, not the report, for success.

### Builders

| Export                            | What it builds                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `oneOf(keys)`                     | `z.enum(keys)` typed by the keys, such as item keys known only at run time       |
| `listOf(item, max, description?)` | `z.object({ items: z.array(item).max(max) })`, an object-rooted list             |
| `rubric(criteria)`                | `z.object({ scores, rationale })`: one `Score` per criterion, then a `Rationale` |

Each throws a `TypeError` for an invalid argument: an empty or repeated key list, a `max` that is
not a positive integer, or an empty criteria record. `listOf` sets `description` on `items` when
given. `rubric` describes each score with its criterion's text and keeps the record's order.

```ts
const Scores = std.types.rubric({
  fitness: 'How well it solves the problem.',
  simplicity: 'How little it adds.',
});
// { scores: { fitness: number; simplicity: number }; rationale: string }
```

## Lenses

A lens (type `Lens`) is `{ key, charter }`: a short key and the prompt text that tells one agent of
a panel what to examine. A key is a clean step-ID segment (`stepId(key) === key`), so a pattern uses
it unchanged in step IDs. `std.lenses.lens(key, charter)` makes a frozen lens and throws `TypeError`
for a key that is not a clean segment or a blank charter. Charters are prompt text and so call
identity; every catalog and lens is frozen, and keys are unique within each catalog.

| Catalog        | Keys                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `bugs`         | `error-handling`, `boundaries`, `concurrency`, `resource-lifecycle`, `state-machines`, `contracts`, `time-and-ordering`, `input-validation` |
| `review`       | `correctness`, `security`, `performance`, `maintainability`, `tests`                                                                        |
| `security`     | `injection`, `access-control`, `secrets`, `data-exposure`, `untrusted-input`, `supply-chain`, `cryptography`                                |
| `design`       | `ship-simplest`, `evolvability`, `data-first`, `operability-first`                                                                          |
| `research`     | `official-docs`, `source-code`, `issues-and-discussions`, `independent-analysis`, `alternatives`                                            |
| `release`      | `tests`, `compatibility`, `security`, `performance`, `docs`, `operability`                                                                  |
| `writing`      | `accuracy`, `completeness`, `clarity`, `structure`                                                                                          |
| `evidence`     | `diffs`, `logs`, `config`, `dependencies`, `recent-changes`                                                                                 |
| `requirements` | `stories`, `edge-cases`, `non-functional`, `foundations`, `instrumentation`                                                                 |
| `spec`         | `data-model`, `api-contracts`, `architecture`, `edge-semantics`, `operations`                                                               |
| `critique`     | `ambiguity`, `scope`, `feasibility`, `testability`                                                                                          |

Four catalogs are pattern defaults: `bugs` is the lens pool of `hunt`, `design` the entrants of
`tournament` (each charter is a designer's stance, written to the proposer), `research` the angles
of `research`, and `release` the dimensions of `gate`. `review`, `security` and `writing` suit
`lensPanel` and `critiqueRevise`. `evidence` names where to look when investigating a failure, as
the lenses of a `lensPanel` or the `angles` of a repository `research`; `requirements`, `spec` and
`critique` suit `critiqueRevise` or `lensPanel` over requirements, a technical specification or a
plan before work starts.

`std.lenses.designRubric` is the default `rubric` of `tournament`: a frozen record of the criteria
`fitness`, `simplicity`, `evolvability` and `operability`, each mapped to what a 1 to 10 score on it
measures. Pass it to `std.types.rubric` for a score sheet.

`std.lenses.LensSchema` (`z.ZodType<Lens>`) is the schema of a lens in workflow data and in the
pattern result schemas. It checks the shape only, two strings, and strips any other member, so every
lens a pattern accepts parses; `lens` is what checks a key and a charter.

```ts
const lenses = [
  ...std.lenses.review,
  std.lenses.lens('migrations', 'Schema and data migrations: order, reversibility, locks.'),
];
```

## Helpers

### std.data

Pure, deterministic functions: none takes a context or records an effect, so a body may call them
freely between effects and replay computes the same values. Invalid arguments throw a `TypeError`
that names the argument; the checks `assertUnique`, `assertDisjoint` and `topoWaves` throw an
`Error`.

| Export                                | What it does                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `oks(results)`                        | The values of the `ok` settled results, in order                                                                 |
| `failures(results)`                   | The errors of the failed settled results, in order                                                               |
| `health(...parts)`                    | `'degraded'` when any part is degraded or a positive failure count, else `'complete'` (see below)                |
| `majority(seats)`                     | `floor(seats / 2) + 1`: 2 of 3, 3 of 4, 3 of 5                                                                   |
| `threshold(rule, seats)`              | The upholding seats a `Rule` needs: `'majority'`, `'unanimous'` (all) or `{ atLeast: n }` with `1 <= n <= seats` |
| `tally(counts, rule = 'majority')`    | `{ outcome, upheld, against, missing, seats }` from `{ upheld, against, seats }`; see below                      |
| `dedupeBy(items, key, merge?)`        | Keeps the first item per key in place; `merge(kept, duplicate)` folds a duplicate into the kept item             |
| `fresh(items, seen, key)`             | The items whose keys are not in the `seen` set, deduplicated; adds their keys to `seen`                          |
| `corroborate(lists, key)`             | One `{ key, item, count }` per key, where `count` is how many lists name it; most corroborated first             |
| `chunk(items, size)`                  | Consecutive chunks of `size`; the last may be shorter                                                            |
| `rotate(pool, round, count)`          | `pool[(round * count + i) % pool.length]` for `i < min(count, pool.length)`: a window that walks the pool        |
| `rankBy(items, get, order)`           | A stable sort by the position of `get(item)` in `order`; values outside `order` sort last                        |
| `bySeverity(items)`                   | `rankBy` on `severity`: `critical`, `high`, `medium`, `low`, then anything else                                  |
| `rankCap(items, { cap, by? })`        | `{ chosen, deferred }`: the first `cap` items after a stable sort by `by`, and the rest                          |
| `uniqueKeys(labels)`                  | One clean, unique `ctx.id` segment per label (`stepId(label)`; repeats get `.2`, `.3`, ...)                      |
| `assertUnique(values, what)`          | Throws `Duplicate <what>: "a", "b".` when a value repeats                                                        |
| `assertDisjoint(items, files, label)` | Throws `Overlapping files: ...` when items claim overlapping paths (see below)                                   |
| `coverage(all, seen)`                 | `{ covered, missing }` over `all`, in its order, computed in code                                                |
| `canonicalJson(value)`                | JSON with object keys sorted and no whitespace; throws `TypeError` for anything that is not plain JSON           |
| `sha256(text)`                        | The SHA-256 of the UTF-8 text, as 64 lowercase hex characters                                                    |
| `digest(value)`                       | `sha256(canonicalJson(value))`: equal values give equal digests whatever their key order                         |
| `normalizeTitle(title)`               | NFKC, lowercase, every run of other than letters, marks and digits as one space, trimmed                         |
| `findingKey(finding)`                 | `<file>::<normalizeTitle(title)>`, the deduplication key of a located finding                                    |
| `topoWaves(items, key, dependsOn)`    | Dependency waves, input order within a wave (see below)                                                          |

`health` combines the health of several steps, such as the patterns a workflow ran and the failures
it tolerated itself. Each part is a failure count, a `Health` (`'complete'` or `'degraded'`) or a
result with such a `status`, as every pattern result has; no part gives `'complete'`. It throws a
`TypeError` naming `parts[i]` (or `parts[i].status`) for a count that is not a nonnegative integer
or a status that is neither value. `canonicalJson` and `digest` take any JSON value, read-only
arrays and interface-typed results included (the parameter is `unknown`), and check it at run time.

`tally` decides with `need = threshold(rule, seats)`: `confirmed` when `upheld >= need`, `refuted`
when `upheld + missing < need`, else `undecided`, where `missing = seats - upheld - against`. A
missing seat, such as a failed agent call, never counts for either side. The types `Health`,
`HealthPart`, `Rule`, `Outcome`, `TallyCounts`, `Tally`, `Corroborated`, `RankCapOptions`,
`RankCapResult` and `Coverage` describe the arguments and results. `Health` and `Coverage` are also
schemas (`z.enum(['complete', 'degraded'])` and a strict `{ covered, missing }`), which the pattern
result schemas use.

`assertDisjoint` throws when two items claim the same path, or one claims a directory that contains
another's path (`src` and `src/a.ts`); trailing slashes are ignored, and the empty path is the root,
which contains every path. Use it to check that parallel editors own disjoint files. `topoWaves`
puts the items without dependencies in wave 0 and each later item in the wave after its last
dependency. It reports every duplicate key and unknown dependency together, or else one cycle (a
self-dependency is a cycle), as `Invalid dependencies: ...`, so the message can go back to a planner
as it is.

```ts
const votes = await ctx.map(
  'seats',
  ['s1', 's2', 's3'],
  { concurrency: 3, onError: 'return' },
  ask,
);
const ballots = std.data.oks(votes);
const upheld = ballots.filter((ballot) => ballot.yes).length;
const verdict = std.data.tally({ upheld, against: ballots.length - upheld, seats: 3 });
// verdict.outcome is 'confirmed', 'refuted' or 'undecided'; verdict.missing counts failed seats.
// With `review`, an earlier pattern result: 'degraded' when it was or a seat failed.
const status = std.data.health(review, verdict.missing);
```

### std.text

Deterministic text helpers: the same arguments always render the same text, so a prompt built with
them replays.

| Export                                          | What it does                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `brief({ task, context?, guidance?, output? })` | The std prompt layout (see below)                                                                    |
| `section(title, body)`                          | `## <title>`, a blank line, then `body`; throws for a multi-line title                               |
| `bullets(items, empty = '(none)')`              | A `- ` list, later lines of an entry indented to stay inside it; `empty` for no items                |
| `numbered(items, empty = '(none)')`             | A `1. ` list, indented the same way                                                                  |
| `fence(body, lang = '')`                        | A code fence one backtick longer than the longest run in `body` (at least three)                     |
| `promptText(prompt)`                            | The text an agent receives for a string or a rendered `Prompt`, to put a prompt into plain JSON      |
| `clip(text, maxBytes, marker?)`                 | The head of `text` within `maxBytes` UTF-8 bytes, `marker` included, when it does not fit            |
| `tail(text, maxChars)`                          | The last `maxChars` UTF-16 code units, one fewer rather than split a surrogate pair                  |
| `stripAnsi(text)`                               | `text` without ANSI escape sequences                                                                 |
| `slug(text, max = 50)`                          | A lowercase, hyphen-separated ASCII slug for branch, file or label names (use `ctx.id` for step IDs) |
| `firstSentence(text)`                           | The first sentence of the first paragraph, whitespace collapsed                                      |
| `findings(list)`                                | `Finding`s or `Remediation`s as a numbered list: severity, title, location, evidence, scenario, fix  |
| `checklist(result)`                             | A checklist result: the verdict, how many passed, one bullet per criterion with status and evidence  |
| `gate(result)`                                  | A gate result: the decision, one bullet per dimension with disposition, summary and evidence         |
| `plan(value)`                                   | A `Plan`: the summary, the numbered steps with their files, then the risks and the checks            |
| `commits(list)`                                 | `Commit`s as bullets: the short ID, the subject, the author and the day, in the order given          |

`brief` renders `task`, then `## Context`, `## Guidance` (a bulleted list) and `## Output`, each
section separated by a blank line. Absent sections and an empty guidance list are omitted, and
nothing else is added or trimmed. A string `context` is inserted as written, and any other JSON
value, such as a read-only array or a pattern result typed by an interface, as a fenced `json` block
of its two-space indented form (`std.exec.json`); an `undefined` object member is omitted. It throws
a `TypeError` for a blank task, and for a context that is not JSON (a non-finite number, a function,
a symbol, a BigInt, a class instance such as a `Date`, an array hole or `undefined` element, or a
cycle) with the path, as in `A brief's context is not JSON at $.files[1]: ...`. The type
`BriefParts` describes its argument; every default std prompt uses it.

The report renderers turn std data and pattern results into Markdown for a pull request comment, a
log or a later prompt. They are pure, and once a rendering is used in a prompt it is part of that
call's identity, so their layouts are fixed once released. `findings` prints `No findings.` and
`commits` `No commits.` for an empty list; `checklist` shows `(no result)` and `gate` says the
assessor call failed for a failed call. `checklist` and `gate` take the structural `ChecklistReport`
(`verdict`, `results` of `ChecklistReportEntry`) and `GateReport` (`decision`, `assessments` of
`GateReportDimension`), so a `ChecklistResult` or `GateResult` passes as it is.

`clip` keeps the longest prefix of whole code points that fits with `marker` (default
`\n… (clipped)`), so the result is valid text. It throws a `TypeError` when text must be clipped and
`marker` alone exceeds `maxBytes`. The other helpers throw a `TypeError` for a count that is not a
nonnegative integer (`max` of `slug` must be positive), a multi-line section title, or a fence
language with a backtick or line break.

```ts
const prompt = std.text.brief({
  task: 'Review the change for correctness bugs.',
  context: { files: ['src/a.ts'], base: 'main' },
  guidance: ['Report only defects you can demonstrate.', 'An empty list is a valid answer.'],
  output: 'The findings, most severe first.',
});
```

### std.exec

Each command helper records one `ctx.exec` step under the `id` you give it, scoped like any
`ctx.exec` call, so a resume returns the saved result instead of running the command again. The
`options` argument is `ctx.exec` options without `onError` (such as `cwd`, `worktree`, `env` or
`maxOutputBytes`); a forwarded `onError` is overridden.

Every helper that takes a revision range (`diff`, `diffStat`, `changedFiles`, `commits` and `log`)
follows one rule: a range that is empty, starts with `-` or contains NUL throws
`TypeError: Expected a Git revision or range such as main..HEAD, got ...` before any effect, since
Git would read it as an option, so text from data cannot change the command. `git branch` and
`git tag` refuse names that start with `-`; name any other such ref in full, as in `refs/heads/-x`.
`diffStat` and `log` also pass the range after `--end-of-options`.

- `json(value)` records nothing. It returns two-space indented JSON, the form prompts embed, and
  throws `Value is not JSON-serializable` for `undefined`, a function or a symbol.
- `git(ctx, id, args, options?)` records `git <args>` as `id` and returns its complete stdout. It
  throws `Incomplete Git output: <id>` when stdout or stderr was truncated, since a partial listing
  cannot prove coverage, and the `ExecError` of a failed command.
- `check(ctx, id, command, options?)` records `command` as `id`, accepting every exit code, and
  returns a `CheckOutcome`, so a failing exit is data and a resume returns the same outcome. A
  command that cannot start, times out or is ended by a signal throws its `ExecError` and fails the
  run; it is not recorded as completed, so a resume runs it again.
- `head(ctx, id, options?)` records `git rev-parse HEAD` and returns the full commit ID. It throws
  as `git` does (a repository without a commit, for example) or when the output is not a full object
  ID.
- `status(ctx, id, options?)` records
  `git --no-optional-locks status --porcelain=v1 --untracked-files=all` and returns the status lines
  (`XY path`, or `XY orig -> path` for a staged rename), without ignored files; empty when the tree
  is clean.
- `assertClean(ctx, id, options?)` records the `status` command and throws
  `Expected a clean working tree (<id>): ...`, listing up to ten changed paths, unless the tree is
  clean.
- `diff(ctx, id, range?, options?)` records
  `git diff --no-color --no-ext-diff --no-relative [range] --` and returns the diff, with paths
  relative to the repository root. Output past `maxOutputBytes` (default 1 MiB) throws instead of
  returning part of it.
- `changedFiles(ctx, id, range?, options?)` records
  `git diff --name-only -z --no-renames --no-relative [range] --` and returns the paths exactly as
  stored; rename detection is off, so a rename lists both paths.
- `diffStat(ctx, id, range?, options?)` records
  `git -c core.quotePath=false diff --stat=10000,10000 --stat-graph-width=40 --no-color --no-ext-diff --no-relative --end-of-options [range] --`
  and returns the summary: one line per file with its changed-line count and graph, then a total
  line; empty when nothing differs. The fixed widths ignore `COLUMNS` and `diff.statNameWidth`, so
  no path is abbreviated, and non-ASCII paths are not quoted.
- `commits(ctx, id, range, options?)` records `git rev-list --reverse <range> --` and returns full
  commit IDs, oldest first. It throws when a line is not a full object ID.
- `log(ctx, id, range, options?)` records
  `git -c core.abbrev=auto log -z --reverse --no-color --no-show-signature --encoding=UTF-8 --format=%H%x00%h%x00%an%x00%aI%x00%s --end-of-options <range> --`
  and returns a `std.types.Commit` per commit, oldest first as `commits` lists them: the full ID and
  its abbreviation at Git's default length (at least 7 characters, whatever `core.abbrev` the
  repository sets), the author name as recorded (no mailmap), the strict ISO 8601 author date and
  the subject. The fields are NUL-separated, so any name or subject parses exactly. It throws
  `Unexpected git log output (<id>)` for a record that does not parse.
- `committedArtifact(ctx, path, content)` records the fixed IDs `document`, `write` and `publish`
  (below) and returns a `Receipt`: the absolute target under `ctx.cwd`, the content's SHA-256 and
  byte length, and `previousSha256: null`.

`check` passes when the exit code is in `okExitCodes` (default `[0]`; `'any'` passes every exit).
Its `output` is the end of stdout followed by stderr from the whole capture, at most 4000
characters. `truncated` reports that `output` may leave something out. A missing tool or a hung
suite is not a verdict, so no fixer is asked to fix it: install the tool or raise `timeoutMs`
(default 300000), then resume.

`diff`, `diffStat` and `changedFiles` without a range cover the unstaged changes; pass `HEAD` for
every uncommitted change to tracked files, or a range such as `main...HEAD`. Untracked files are
never included. `status` shows a path with unusual characters quoted as Git quotes it; use
`changedFiles` for exact paths. `assertClean` records the status, so a resume decides the same way
even after the tree changes. Under `--dry-run`, a command's stdout is empty, so `head` throws unless
an exec fixture answers its `id`.

`committedArtifact` publishes a new file through a managed checkout: it creates the worktree
`document`, writes `content` to `path` in the local step `write` (identified by the constant
`committed-artifact/1`, the path and the content, not the callback text), and merges it into the
workflow checkout as `publish` (`target: 'checkout'`, `onConflict: 'fail'`). It throws before any
effect for a path that is not repository-relative; the step refuses a parent that resolves outside
the checkout and a file that exists; the merge throws on a conflict. The IDs are fixed, so wrap a
second call in `ctx.scope` or call it on `ctx.within(prefix)`.

```ts
await std.exec.assertClean(ctx, 'clean');
const base = await std.exec.head(ctx, 'base');
const tests = await std.exec.check(ctx, 'tests', ['npm', 'test']);
if (!tests.passed) ctx.log(`Tests failed:\n${tests.output}`);
const touched = await std.exec.changedFiles(ctx, 'touched', `${base}..HEAD`);
const made = await std.exec.log(ctx, 'made', `${base}..HEAD`); // std.types.Commit[]
ctx.log(std.text.commits(made));
```

## Flow

`std.flow` holds control flow that takes no team. Each helper records its effects under the `id` it
is given and runs your callbacks in deterministic scopes, so a resume replays the same steps.
`waves` and `each` pass your function itself to `ctx.map` as the mapper, so the settled map's
fingerprint covers its source; their items must be plain lossless JSON.

### untilDry

`std.flow.untilDry(ctx, { id, rounds, patience?, key, round })` repeats a discovery round until it
stops finding anything new. Options `UntilDryOptions<T, K>`; a round returns an `UntilDryRound<T>`.
`T`, the item type, is inferred from what `round` returns; `K`, the type `key` reads and `round`'s
`known` items have, defaults to `T` and may be wider, so a `key` such as `std.data.findingKey`,
which reads only a file and a title, does not narrow the items. Write `untilDry<Finding>(...)` to
type `known` fully.

| Option     | Default  | Meaning                                                                                     |
| ---------- | -------- | ------------------------------------------------------------------------------------------- |
| `id`       | required | The scope of every step the rounds record                                                   |
| `rounds`   | required | The most rounds, a positive integer                                                         |
| `patience` | 2        | How many consecutive dry rounds end the loop                                                |
| `key`      | required | An item's identity across rounds, such as `std.data.findingKey`                             |
| `round`    | required | `(n, known) => Promise<{ found, failed? }>`, round `n` from 0 given every item found so far |

Round `n` runs under `ctx.scope(id)` and `ctx.scope(ctx.id('round', n))`, so its effects record as
`<id>/round/<n>/<leaf>`. Its `found` items are deduplicated by `key` against every earlier item. A
round is dry when it adds nothing and reports no failure (`failed`, default 0), so a failed source
never ends the loop early. The loop stops after `patience` consecutive dry rounds or `rounds`
rounds.

The result (`UntilDryResult`) is `found` (every distinct item, in discovery order), `rounds`,
`dryRounds`, `failedRounds` and `ended`: `'dry'` when `patience` dry rounds ended it, else
`'round-limit'`. It throws `TypeError` for an invalid `rounds` or `patience`, or a round that
returns no `found` array or an invalid `failed`.

```ts
const hunt = await std.flow.untilDry(ctx, {
  id: 'hunt',
  rounds: 4,
  key: std.data.findingKey,
  round: async (n, known) => {
    const report = await ctx.roster.Finder.value('find', {
      prompt: `Find bugs not in this list:\n${std.exec.json(known)}`,
      schema: std.types.Findings,
    });
    return { found: report.findings };
  },
});
```

### waves

`std.flow.waves(ctx, { id, items, key, dependsOn, concurrency?, version?, run })` runs items in
dependency order. Options `WavesOptions<T, U>`.

| Option        | Default  | Meaning                                                                           |
| ------------- | -------- | --------------------------------------------------------------------------------- |
| `id`          | required | The scope of every wave's settled map                                             |
| `items`       | required | The items, each plain lossless JSON                                               |
| `key`         | required | An item's unique key, which `dependsOn` refers to                                 |
| `dependsOn`   | required | The keys of the items that must succeed first                                     |
| `concurrency` | 4        | Each wave's mapper bound                                                          |
| `version`     | none     | The map's `version`, for what the items, keys and `run` source do not show        |
| `run`         | required | `(item, index) => Promise<U>`, the mapper; `index` counts the items its wave runs |

The waves are planned with `std.data.topoWaves` before anything runs, so a duplicate key, an unknown
dependency or a cycle throws `Invalid dependencies: ...`, and an invalid `concurrency` a
`TypeError`, before any effect. Wave `n` is the settled map `<id>/wave/<n>`, keyed by
`std.data.uniqueKeys` of the item keys, so an item's effects record as `<id>/wave/<n>/<key>/<leaf>`.
An item runs only when every dependency is done; a dependent of a failed or skipped item is skipped
without running, and a wave with nothing left to run records no map. The result (`WavesResult`) is
`results` (one `WaveItem` per item, in input order: `key`, `item`, `status` of `'done'`, `'failed'`
or `'skipped'`, `value` and `error`), `waves` (the planned keys) and `status` (`'complete'` when
every item is done, else `'degraded'`).

`version` covers what an item does not show, such as the configuration of an agent `run` calls: a
completed item is reused after a role changes, so change `version` when you change the agent. `each`
takes `version` the same way.

`run` decides what counts as done: to skip the dependents of an agent's partial work, throw from
`run` when its report is not done, as the [plan-and-build recipe](#recipes) does.

### each

`std.flow.each(ctx, id, items, options, mapper)` is a settled fan-out:
`ctx.map(id, items, { ...options, onError: 'return' }, mapper)` with your `mapper` passed as is. The
options (`EachOptions<T>`, required even when empty) are `key` (`(item, index) => label`, made
unique and ID-safe with `std.data.uniqueKeys`; omitted, the index), `concurrency` (default 4; an
invalid one throws a `TypeError` before any effect) and `version`. Item `i` records under
`<id>/<key>/`. The result (`EachResult`) splits the outcomes into `done` (`EachDone`:
`{ key, item, index, value }`) and `failed` (`EachFailure`: `{ key, item, index, error }`), both in
input order, with `status` `'complete'` or `'degraded'`. A resume neither reruns a done item nor
retries a failed one.

## The pattern contract

Every pattern in `std.patterns` is a function `pattern(ctx, options)` and keeps the same contract.
`reviewRevise` and `tolerantPanel` predate it and differ where their sections say.

- **`id` and scope.** `id` is required and the pattern runs under `ctx.scope(id, ...)`, so two calls
  with different IDs never collide. Each section below lists the exact step IDs the pattern records
  under `<id>/`.
- **The team check.** Each pattern exports its team (such as `std.patterns.HuntTeam`, made with
  `defineTeam`) and the team's record type under the same name. It fills the team with
  `XTeam.from(options.team)` before any effect, so an unfilled slot throws
  `TypeError: Team slot <name> is not filled.` instead of being journaled as a failed call.
  `XTeam.from(ctx.roster)` fills a team whose roster entries use the slot names.
- **Validation before effects.** Counts, lists and the text options each section lists under "Fails
  the run" (a blank `brief`, `task` or `question`, for example) are checked before any effect; an
  invalid one throws a `TypeError` that names it. Other text, such as `vote`'s `question` or a
  `subject` that a section does not list, is used as given. Item keys that must be distinct, such as
  `rank`'s or `classify`'s item keys or `checklist`'s criterion IDs, throw an `Error` that lists the
  repeats (`Duplicate item key: ...`); keys that only name steps, such as lens keys, are made unique
  instead.
- **Settled failures.** Where a pattern tolerates a failed agent (a seat, a lens, a chunk, a critic,
  a fixer), the call runs in a settled map or with `onError: 'return'`, so the failure is journaled
  and a resume makes the same decision instead of retrying it into another. The result counts it in
  `failures` and reports a [health `status`](#status-and-failures) instead of a silently shorter
  list. A call the pattern cannot do without (an author, a planner, a reducer, a synthesizer)
  throws, and a resume retries it.
- **Fingerprints and `version`.** A settled map's items carry the rendered prompt
  (`std.text.promptText`) and the calls' placement (`cwd`, `addDirs` and `worktree`), and where a
  pattern builds the reply schema from data, the data it is built from. Changing a prompt, an input
  a prompt shows or the placement therefore refuses to replay the completed map. `version` is the
  map's `version`: change it when something the items do not show, such as a replacement `schema`,
  should not reuse completed calls. The agent's configuration (model, effort, tools, persona and
  bound `addDirs`) is not part of an item either, so a completed item is reused after a role
  changes, where a direct call to the changed agent would refuse to replay: change `version` when
  you change the agent that fills a slot. A single call's prompt, schema, placement and agent
  configuration are part of its own step identity.
- **`calls`.** `calls` (type `std.patterns.CallDefaults`, the bound call options without `prompt`
  and `onError`: `cwd`, `addDirs`, `worktree`, `retry`, `timeoutMs` and `idleTimeoutMs`) is spread
  into every agent call the pattern makes, before the pattern's own prompt, schema and error mode.
  `retry` and the deadlines are policy and may change between runs.
- **`prompts`.** `prompts.<stage>` replaces one stage's default prompt. It receives that stage's
  inputs and returns a string or a rendered `Prompt` (`definePrompts`). The defaults are
  `std.text.brief`s, and the prompt of a skeptical slot names its safe default (refute, vote no,
  `unverifiable`, `untestable`, not approved), which the `Skeptic`, `Critic` and `Judge` personas
  fall back to.
- **`concurrency`.** Each fan-out's mapper bound, default 4. A pattern with two fan-outs applies it
  to each separately, and a nested seat panel runs all seats of one item at once.
- **Logging.** A pattern logs with `ctx.log` what a cap leaves out (lenses, findings, leads,
  hypotheses, deferred items) and the failures it tolerates, so nothing is dropped silently; where
  the left-out items are results, it also returns them (`hunt`'s `unverified`, `rank`'s and
  `research`'s `deferred`). Logs are observations, not identity.
- **The context.** Call a pattern with the context its team was bound from. An agent read from
  `ctx.within(p).roster` keeps the `p/` prefix wherever it is called, so pass `ctx.within(p)` to the
  pattern too.

A team is a typed record of `Agent` slots ([teams](roster.md#teams), ADR 0067). Calls through a slot
claim the same IDs, fingerprints and records as calls through the agent that fills it.

```ts
const hunt = await std.patterns.hunt(ctx, {
  id: 'hunt',
  team: { finder: ctx.roster.Reviewer, skeptic: ctx.roster.Skeptic },
  subject: 'The parser in src/parser/.',
});
for (const item of hunt.findings) ctx.log(`${item.severity}: ${item.file}: ${item.title}`);
```

### Status and failures

Every pattern result reports its health, not its outcome, in `status`: `'complete'` when every call
the pattern tolerates answered, and `'degraded'` exactly when at least one failed. `failures` counts
those failed calls, beside the specific counters such as `failedVotes` or `failedChunks`. What the
pattern decided is in named fields, such as `outcome` (`vote`, `fixUntilGreen`, `escalate`,
`tournament`, `approvedPlan`), `verdict` (`checklist`), `decision` (`gate`), `approved`
(`critiqueRevise`), `confidence` (`falsify`), `answered` (`research`), `ranked` (`rank`), `repaired`
(`decompose`), `fallback` (`route`), `ended` (`hunt`) and the `confirmed`, `refuted` and `undecided`
lists (`verify`, `hunt`). A degraded result can still hold a decision, and a complete one can say
no.

- A pattern whose calls are all required (`rank`, `decompose` and `approvedPlan`) always reports
  `'complete'` and `failures: 0`.
- `route` is degraded, with `failures: 1`, when its router call failed and it took the fallback.
- `isolatedEdits` is also degraded by a change outside its owned paths or a merge conflict;
  `failures` counts only the failed edit calls.
- `std.flow.waves` and `std.flow.each` report `'degraded'` when an item failed (or, in `waves`, was
  skipped); `untilDry` has no `status` and reports why it stopped in `ended`.
- `reviewRevise` and `tolerantPanel` keep their older results, without `status` or `failures`.

`std.data.health(...parts)` combines the status of several results with failure counts of your own,
as the [code review recipe](#recipes) does: `std.data.health(panel, verdicts)`.

### Result schemas

Every pattern result interface `XResult` has a Zod schema exported from `std.patterns` under the
same name and typed `z.ZodType<XResult>`, so the compiler proves the schema matches the interface.
Declare one as a workflow's `output` to return a pattern's result as it is, or parse a saved result
with it. A generic result's schema is a factory that takes the schema of what varies:

| Schema                                                   | What the argument is                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `LensPanelResult(value)`                                 | Each answer's schema: the panel's `schema`                                            |
| `VerifyResult(item)`, `RankResult(item)`                 | The items' schema, such as `std.types.Finding`                                        |
| `EscalateResult(value?)`                                 | The attempts' `schema`; omitted, `std.types.WorkReport`                               |
| `RouteResult(routes?)`                                   | The `routes` option or a list of its keys, so `route` is checked; omitted, any string |
| `ClassifyResult(item, labels?)`                          | The items' schema and the `labels` option or its names; omitted, any label            |
| `MapReduceResult(part?)`, `TolerantPanelResult(answer?)` | Each chunk's or answer's `schema`; omitted, text                                      |

The others are plain schemas: `VoteResult`, `HuntResult`, `CritiqueReviseResult`,
`FixUntilGreenResult`, `TournamentResult`, `DecomposeResult`, `ChecklistResult`, `GateResult`,
`FalsifyResult`, `ResearchResult`, `IsolatedEditsResult`, `ApprovedPlanResult` and
`ReviewReviseResult`. `TournamentResult` checks each standing's `criteria` as a record of numbers,
so a result over any rubric parses. The parts have schemas too: `LensAnswer(value)`,
`Verified(item)`, `EscalationSlot`, `FixRound`, `TournamentEntry`, `Standing`,
`Assignment(item, labels?)`, `LabelCount(labels?)`, `MapReducePart(part?)`, `ChecklistEntry`,
`ChecklistCounts`, `GateDisposition`, `GateChallenge`, `GateDimension`, `TestedHypothesis`,
`FalsifyConfidence`, `EditChange`, `EditViolation` and `MergeResult` (the runtime's `ctx.merge`
result), with `std.lenses.LensSchema`, `std.data.Health` and `std.data.Coverage`. The `std.flow`
results have none.

Each result root is a strict object: every property is required and an extra one is refused, counts
are nonnegative integers, and `status` is `std.data.Health`. No schema uses a transform, so each
converts to JSON Schema. A workflow's output schema is part of a run's compatibility check, so a
changed result schema would make a resume report `output schema` as changed; the tests pin each
schema's JSON Schema by digest. `RouteResult`, `ClassifyResult`, `Assignment` and `LabelCount` throw
a `TypeError` for empty `routes` or `labels`.

```ts
import { defineRoster, defineWorkflow, z } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export default defineWorkflow({
  name: 'fix-tests',
  version: '1',
  roster: defineRoster({ Mechanic: std.roles.Mechanic, Surgeon: std.roles.Surgeon }),
  input: z.object({ check: std.types.Argv }),
  output: std.patterns.FixUntilGreenResult, // outcome, fixedBy, checks, fixes, failures, status
  run: (ctx, { check }) =>
    std.patterns.fixUntilGreen(ctx, {
      id: 'fix',
      team: { mechanic: ctx.roster.Mechanic, surgeon: ctx.roster.Surgeon },
      check,
    }),
});
```

A factory's result goes wherever a schema does, as in
`output: z.object({ review: std.patterns.VerifyResult(std.types.Finding), notes: z.string() })`.

## Patterns

| Pattern                             | Team (slots)                                          | Step IDs under `<id>/`                                                                |
| ----------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`lensPanel`](#lenspanel)           | `LensTeam` (`reader`)                                 | `lens/<lens>/read`                                                                    |
| [`vote`](#vote)                     | `VoteTeam` (`voter`)                                  | `seat/<n>/ballot`                                                                     |
| [`verify`](#verify)                 | `VerifyTeam` (`skeptic`)                              | `item/<key>/seat/<n>/verdict`                                                         |
| [`hunt`](#hunt)                     | `HuntTeam` (`finder`, `skeptic`)                      | `round/<n>/lens/<lens>/find`, `round/<n>/item/<key>/seat/<s>/verdict`                 |
| [`critiqueRevise`](#critiquerevise) | `CritiqueTeam` (`critic`, `author`)                   | `draft`, `round/<n>/critique` or `round/<n>/lens/<lens>/critique`, `round/<n>/revise` |
| [`fixUntilGreen`](#fixuntilgreen)   | `RepairTeam` (`mechanic`, `surgeon`)                  | `check/<n>`, `fix/<n>`                                                                |
| [`escalate`](#escalate)             | `EscalationTeam` (`mechanic`, `surgeon`)              | `attempt/<n>/work`                                                                    |
| [`tournament`](#tournament)         | `TournamentTeam` (`proposer`, `judge`, `synthesizer`) | `propose/<entrant>/proposal`, `judge/<n>/scores`, `synthesize`                        |
| [`rank`](#rank)                     | `RankTeam` (`ranker`)                                 | `rank`                                                                                |
| [`route`](#route)                   | `RouteTeam` (`router`)                                | `route`                                                                               |
| [`classify`](#classify)             | `ClassifyTeam` (`tagger`)                             | `chunk/<n>/tag`                                                                       |
| [`mapReduce`](#mapreduce)           | `MapReduceTeam` (`mapper`, `reducer`)                 | `map/<k>/part`, `reduce`                                                              |
| [`decompose`](#decompose)           | `PlanTeam` (`planner`)                                | `plan`, `repair`                                                                      |
| [`checklist`](#checklist)           | `ChecklistTeam` (`checker`)                           | `criterion/<criterion>/check`                                                         |
| [`gate`](#gate)                     | `GateTeam` (`assessor`, `skeptic`)                    | `dimension/<key>/assess`, `blocker/<key>/seat/<n>/verdict`                            |
| [`falsify`](#falsify)               | `FalsifyTeam` (`theorist`, `falsifier`)               | `theorize`, `hypothesis/<key>/falsify`                                                |
| [`research`](#research)             | `ResearchTeam` (`scout`, `reader`, `synthesizer`)     | `scout/<angle>/leads`, `read/<lead>/claims`, `synthesize`                             |
| [`isolatedEdits`](#isolatededits)   | `EditTeam` (`editor`)                                 | `item/<key>/edit`, `item/<key>/paths`, `merge`                                        |
| [`approvedPlan`](#approvedplan)     | `PlanApprovalTeam` (`planner`)                        | `round/<n>/plan`, `round/<n>/approve`                                                 |
| [`reviewRevise`](#reviewrevise)     | `ReviewTeam` (`actor`, `critic`)                      | `review/<n>`, `revise/<n>` (under `<id>/` only with `id`)                             |
| [`tolerantPanel`](#tolerantpanel)   | `PanelTeam` (`panelist`)                              | `<index>/answer`                                                                      |

`taskCall` and `planCall` are not patterns: they return call options and record nothing. A key in a
step ID is made unique and ID-safe with `std.data.uniqueKeys`, so a clean unique key stays as it is
and a repeated one gets `.2`, `.3`, ... Unless a section says otherwise, every pattern takes the
common options `id`, `team`, `prompts`, `concurrency` (default 4), `version` and `calls` described
in [the pattern contract](#the-pattern-contract); the tables list the rest. Each result has a
[schema](#result-schemas) of its name, and its `failures` and `status` follow
[the status rule](#status-and-failures).

### lensPanel

Asks one reader per lens about the same subject and collects the answers by lens. Options
`LensPanelOptions<O>`, prompts `LensPanelPrompts`, result `LensPanelResult<O>`.

Team `LensTeam`: `reader`, a read-only entry such as `std.roles.Reviewer` for code, or
`std.roles.Reader`.

| Option         | Default                      | Meaning                                               |
| -------------- | ---------------------------- | ----------------------------------------------------- |
| `lenses`       | required, non-empty          | One reader call per lens, such as `std.lenses.review` |
| `subject`      | required                     | What to examine, such as a fenced diff or a document  |
| `schema`       | required                     | Each answer's schema, such as `std.types.Findings`    |
| `task`         | `Examine the subject below.` | The default prompt's opening sentence                 |
| `prompts.read` | default prompt               | `(lens, subject) => prompt`; `task` is then unused    |

Result: `results` (`LensAnswer<O>`: `{ lens, value }` for each lens that answered, in lens order),
`failed` (the lenses whose call failed), `quorum` (more than half answered), `failures` (the failed
lenses) and `status`. Schema: `LensPanelResult(value)`.

Steps: the settled map `<id>/lens`, keyed by lens key, so lens `k` records `<id>/lens/<k>/read`.

Fails the run: an unfilled slot, empty `lenses` or an invalid `concurrency`, before any effect.
Journaled as data: a failed reader call, reported in `failed`.

Recipe: [std-code-review](../examples/patterns/std-code-review.workflow.ts), which verifies the
panel's findings with `verify`.

### vote

Puts one yes-or-no question to several independent seats and decides it by a rule. Options
`VoteOptions`, prompts `VotePrompts`, result `VoteResult`.

Team `VoteTeam`: `voter`, a read-only judging entry such as `std.roles.Judge` or
`std.roles.Skeptic`; every seat calls it.

| Option           | Default        | Meaning                                                                  |
| ---------------- | -------------- | ------------------------------------------------------------------------ |
| `question`       | required       | Phrased so that no is the safe answer: `Is this change safe to merge?`   |
| `context`        | none           | Material the question is about, shown under it in the default prompt     |
| `seats`          | 3              | How many seats vote                                                      |
| `rule`           | `'majority'`   | How many yes votes carry it (`std.data.Rule`)                            |
| `prompts.ballot` | default prompt | `(question, seat, seats) => prompt`; close over `context` if it needs it |

Result: `outcome` (`'yes'` when the yes votes reach the threshold, `'no'` when they cannot reach it
even if every missing seat voted yes, else `'undecided'`), `yes`, `no`, `missing`, `seats`,
`reasons` (each answering seat's reasoning prefixed `yes: ` or `no: `), `failures` (the same as
`missing`) and `status`. The decision is `std.data.tally`. The default prompt names no as the safe
default. Schema: `VoteResult`.

Steps: the settled map `<id>/seat`, so seat `n` records `<id>/seat/<n>/ballot` (schema
`std.types.Ballot`).

Fails the run: an unfilled slot, an invalid `seats` or `concurrency`, or a rule invalid for `seats`,
before any effect. Journaled as data: a failed seat, counted as missing and never as a vote.

Recipe: [std-vote](../examples/patterns/std-vote.workflow.ts), a unanimous merge-safety vote over a
range's diff.

### verify

Tries to refute each item with its own panel of skeptics and sorts the items into confirmed, refuted
and undecided. Options `VerifyOptions<T>`, prompts `VerifyPrompts`, result `VerifyResult<T>`.

Team `VerifyTeam`: `skeptic`, a high-effort read-only entry such as `std.roles.Skeptic`.

| Option           | Default                                | Meaning                                                                  |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `items`          | required                               | The claims, such as findings; each gets its own panel                    |
| `key`            | the index                              | `(item, index) => label` for the step IDs, such as `std.data.findingKey` |
| `describe`       | a string item itself, else fenced JSON | `(item) => text`, the claim a skeptic judges                             |
| `context`        | none                                   | What the claims are about, shown under each claim                        |
| `seats`          | 3                                      | Skeptics per item, or `(item) => number`, called once per item           |
| `rule`           | `'majority'`                           | How many upholding seats confirm an item                                 |
| `prompts.verify` | default prompt                         | `(claim, seat, seats) => prompt`; close over `context` if it needs it    |
| `concurrency`    | 4                                      | How many items run at once; each item's seats run together               |

Result: `confirmed`, `refuted` and `undecided`, each a list of `Verified<T>` in input order (`key`,
`item`, `outcome`, `upheld`, `against`, `missing`, `seats` and `reasons` prefixed `upheld: ` or
`refuted: `), `failedVotes`, `failures` (the same) and `status`. A seat upholds with
`refuted: false`; the default prompt names `refuted: true` as the safe default when the evidence is
inconclusive. Schema: `VerifyResult(item)`.

Steps: the settled map `<id>/item`, keyed by item key; each item is the settled map
`<id>/item/<key>/seat`, so seat `n` records `<id>/item/<key>/seat/<n>/verdict` (schema
`std.types.Refutation`). No items, no map.

Fails the run: an unfilled slot, an invalid seat count or `concurrency`, or a rule invalid for an
item's seat count, before any effect. Journaled as data: a failed seat, counted as missing for its
item.

Recipe: [std-code-review](../examples/patterns/std-code-review.workflow.ts).

### hunt

A bug hunt: each round runs a lens panel over a rotating window of bug lenses, verifies the round's
new findings, and the hunt ends when rounds stop finding anything new. Options `HuntOptions`,
prompts `HuntPrompts` (which extends `VerifyPrompts`), result `HuntResult`.

Team `HuntTeam`: `finder`, a read-only reviewer such as `std.roles.Reviewer`; `skeptic`, a
high-effort read-only entry such as `std.roles.Skeptic`.

| Option           | Default           | Meaning                                                                                               |
| ---------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| `subject`        | required          | Where to hunt: finders get it as context, and skeptics see it under each finding                      |
| `task`           | none              | The find prompt's opening sentence, such as `Hunt for defects in the diff below.`                     |
| `lenses`         | `std.lenses.bugs` | The lens pool                                                                                         |
| `perRound`       | 3                 | Lenses per round: round `n` runs `std.data.rotate(lenses, n, perRound)`                               |
| `rounds`         | 4                 | The most rounds                                                                                       |
| `patience`       | 2                 | Consecutive dry rounds that end the hunt once every lens has run                                      |
| `seats`          | 3                 | Skeptics per finding, or `(finding) => number`                                                        |
| `rule`           | `'majority'`      | How many upholding seats confirm a finding                                                            |
| `maxCalls`       | unlimited         | The most agent calls, finders and seats together                                                      |
| `prompts.find`   | default prompt    | `(lens, subject, known) => prompt`; `known` is every finding of earlier rounds; `task` is then unused |
| `prompts.verify` | default prompt    | As for `verify`                                                                                       |
| `concurrency`    | 4                 | How many finders, and separately how many findings' panels, run at once                               |

Round `n` asks `team.finder` for `std.types.Findings` through each lens of its window. With `task`,
the find prompt opens `<task> Work through one lens only, <key>: <charter>`; without it, it opens
`Hunt for defects in the subject below through one lens, <key>: <charter>`. The round's new
findings, deduplicated by `std.data.findingKey` against every earlier finding, are verified most
severe first, as `verify` does with the subject as its `context`. Later finders see the earlier
findings in their prompt. A round is dry when it adds no finding and no finder failed. The hunt
stops after `patience` consecutive dry rounds, but never before every lens of the pool has run once;
after `rounds` rounds; or when `maxCalls` cannot admit the next round's lenses or a new finding's
seats. A round that `maxCalls` cuts short runs the lenses that fit, leaves the findings whose seats
do not fit unverified, logs both, and ends the hunt.

Result: `findings` (the confirmed findings themselves, most severe first), `confirmed`, `refuted`
and `undecided` (`Verified<Finding>` lists, most severe first), `unverified` (findings the cap left
out), `rounds`, `dryRounds`, `failedFinders`, `failedVotes`, `callsAdmitted`, `ended` (`'dry'`,
`'round-limit'`, or `'call-limit'` when `maxCalls` left work out), `failures`
(`failedFinders + failedVotes`) and `status`, which a call cap does not degrade. Schema:
`HuntResult`.

Steps: `<id>/round/<n>/lens/<lens>/find` in the settled map `<id>/round/<n>/lens`, and
`<id>/round/<n>/item/<key>/seat/<s>/verdict` in the settled maps `<id>/round/<n>/item` and
`<id>/round/<n>/item/<key>/seat`, where `<key>` is the finding's `findingKey` made ID-safe.

Fails the run: an unfilled slot, empty `lenses`, an invalid count option or a rule invalid for a
numeric `seats`, before any effect; a `seats` function that returns an invalid count, during the
hunt. Journaled as data: failed finders and seats.

Recipe: [std-bug-hunt](../examples/patterns/std-bug-hunt.workflow.ts).

### critiqueRevise

Critics critique a draft against its brief, optionally one per lens, and an author revises it until
no issue remains or the rounds run out. Options `CritiqueReviseOptions`, prompts
`CritiqueRevisePrompts`, result `CritiqueReviseResult`.

Team `CritiqueTeam`: `critic`, a read-only entry such as `std.roles.Critic`; `author`,
`std.roles.Writer`, or `std.roles.Scribe` when it should check sources.

| Option             | Default               | Meaning                                                                 |
| ------------------ | --------------------- | ----------------------------------------------------------------------- |
| `brief`            | required, non-blank   | What the draft must achieve; critics judge against it                   |
| `draft`            | the author writes one | The first draft                                                         |
| `rounds`           | 2                     | The most critique rounds                                                |
| `lenses`           | one general critic    | One critic call per lens per round, such as `std.lenses.writing`        |
| `prompts.draft`    | default prompt        | `(brief) => prompt`, used only without `draft`                          |
| `prompts.critique` | default prompt        | `(draft, brief, lens) => prompt`; `lens` is null for the general critic |
| `prompts.revise`   | default prompt        | `(draft, issues, brief) => prompt`                                      |

Round `n` critiques the current draft, and when it raises issues and is not the last round the
author revises the draft. A round approves when every critic answered and none raised an issue. A
round whose critics raised nothing but where one failed does not approve, and the next round
critiques the same draft again. The last round is never followed by an unreviewed revision.

Result: `draft` (the approved draft, or the last critiqued one), `approved` (the last round's
critics all answered and raised no issue), `rounds`, `revisions`, `issues` (the last round's, open
in `draft`), `failedCritics`, `failures` (the same) and `status` (`'degraded'` when a critic failed
in any round, even if a later round approved). Schema: `CritiqueReviseResult`.

Steps, under `<id>/`:

- `draft`: the author's first draft (text), only without `draft`.
- `round/<n>/critique`: the general critic, an `onError: 'return'` call (schema
  `std.types.Critique`), without `lenses`.
- `round/<n>/lens/<key>/critique`: with `lenses`, one critic per lens in the settled map
  `round/<n>/lens`.
- `round/<n>/revise`: the author's revision (text).

Fails the run: an unfilled slot, a blank brief, an invalid `rounds` or `concurrency`, or empty
`lenses`, before any effect; a failed author call (draft or revision), which a resume retries.
Journaled as data: a failed critic, counted in `failedCritics` and logged.

Recipe: [std-doc-polish](../examples/patterns/std-doc-polish.workflow.ts).

### fixUntilGreen

Runs a check command and, while it fails, has a mechanic and then a surgeon fix the code. Only the
command decides success. Options `FixUntilGreenOptions`, result `FixUntilGreenResult`; a slot is an
`EscalationSlot` (`'mechanic'` or `'surgeon'`).

Team `RepairTeam`: `mechanic` (`std.roles.Mechanic`) for the early rounds and `surgeon`
(`std.roles.Surgeon`) for the rest. Fill both with one agent to never escalate. Under
`requireGrants`, both need write grants.

| Option          | Default        | Meaning                                                                                     |
| --------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `check`         | required       | The check `Command`, such as `['npm', 'test']`                                              |
| `rounds`        | 3              | The most fix rounds                                                                         |
| `escalateAfter` | `rounds - 1`   | How many of the first rounds use the mechanic, from 0 to `rounds`; the rest use the surgeon |
| `task`          | none           | What the change is for, given to every fixer; non-blank when given                          |
| `worktree`      | none           | A shared `ctx.worktree` handle for the check and both agents                                |
| `exec`          | none           | `ctx.exec` options for each check, such as `cwd`, `env`, `timeoutMs` or `okExitCodes`       |
| `prompts.fix`   | default prompt | `(request: FixPromptInput) => prompt`                                                       |

`exec` takes `ctx.exec` options without `onError` and `worktree`. A `FixPromptInput` holds the
`round` (from 1), the `slot`, the check `command`, the `failure` this round must fix (a
`CheckOutcome`), the `task` or null, and the `earlier` rounds. The default prompt shows the end of
the failing output and the earlier rounds' reports, and forbids weakening the check.

There is no `concurrency` or `version`. Set the checkout with `worktree`, not `calls.worktree`:
`calls.worktree` without `worktree` is refused, since it would leave the check running outside the
agents' checkout, and `worktree` overrides it.

Result: `outcome` (`'green'` when the last check passed, else `'red'`), `rounds` (0 when the first
check passed), `fixedBy` (the slot whose fix made the check pass; null when it passed at first,
never passed, or passed after a round whose fix call failed), `checks` (every `CheckOutcome`:
`checks[0]` before any fix, `checks[n]` after round `n`), `fixes` (every `FixRound`: `round`,
`slot`, `report` or null, `error` or null), `failedFixes`, `failures` (the same) and `status`
(`'degraded'` when a fix call failed; only `outcome` says whether the check passed). Schema:
`FixUntilGreenResult`.

Steps, under `<id>/`:

- `check/<n>`: the check after `n` fixes, through `std.exec.check`, so a failing exit is data; a
  check that cannot start, times out or is killed fails the run before any fixer sees it.
- `fix/<n>`: round `n`'s fix from 1, an `onError: 'return'` call with schema `std.types.WorkReport`.

Fails the run: an unfilled slot, an invalid `rounds` or `escalateAfter`, a blank `task`, or
`calls.worktree` without `worktree`, before any effect. Journaled as data: a failing check and a
failed fix call, after which the loop runs the next check.

Recipe: [std-fix-tests](../examples/patterns/std-fix-tests.workflow.ts).

### escalate

Gives a task to a mechanic, checks the result with your `accept`, and hands rejected or failed work
to a surgeon. Options `EscalateOptions<V>`, result `EscalateResult<V>`.

Team `EscalationTeam`: `mechanic` (`std.roles.Mechanic`) and `surgeon` (`std.roles.Surgeon`).

| Option         | Default                | Meaning                                                                           |
| -------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `task`         | required, non-blank    | The work, as the opening of every attempt's prompt                                |
| `accept`       | required               | `AcceptCheck<V>`: `(value, slot, attempt) => true \| string`, or a promise of one |
| `schema`       | `std.types.WorkReport` | The schema of an attempt's value                                                  |
| `attempts`     | 2                      | The most attempts                                                                 |
| `start`        | `'mechanic'`           | The slot of attempt 0; every later attempt uses the surgeon                       |
| `prompts.work` | default prompt         | `(request: AttemptPromptInput<V>) => prompt`                                      |

Without `schema` an attempt's value is a `std.types.WorkReport`; options typed as
`EscalateOptions<V>`, whose `schema` may be unset, give a result of
`EscalateResult<V | WorkReport>`. `accept` returns `true` to accept the value, or a string of
problems that the next attempt should fix. An `AttemptPromptInput` holds the `task`, the `attempt`
(from 0), the `slot`, the `previous` attempt's value (null on the first attempt or after a failed
call) and its `problems`.

There is no `concurrency` or `version`. Attempts hand work on through the files, so a fresh checkout
per call (`calls.worktree: true`) would discard each attempt's changes: share a `ctx.worktree`
handle instead. `accept` runs inside the attempt's scope, so its own effects use fixed leaves other
than `work`, such as `std.exec.check(ctx, 'tests', argv)`. It runs again on resume, so build its
decision from the value and durable effects only.

Result: `outcome` (`'accepted'` or `'rejected'`), `slot` (of the accepted or last attempt),
`attempts`, `value` (null when the last call failed), `problems` (null when accepted),
`failedCalls`, `failures` (the same) and `status`. A blank string from `accept` becomes
`Rejected without details.` Schema: `EscalateResult(value?)`, with the attempts' `schema`.

Steps: `<id>/attempt/<n>/work` (from 0, an `onError: 'return'` call with `schema`), and
`<id>/attempt/<n>/<leaf>` for any effect `accept` records.

Fails the run: an unfilled slot, a blank task, an invalid `attempts` or `start`, before any effect;
`accept` returning something other than `true` or a string. Journaled as data: a failed attempt
call, which escalates like a rejection.

Recipe: [std-escalate](../examples/patterns/std-escalate.workflow.ts), whose `accept` refuses a
report that is not done and then runs the check command as `<id>/attempt/<n>/check`.

### tournament

Entrants propose designs from different philosophies, an anonymous judge panel scores every proposal
on a rubric, and a synthesizer builds the final design on the winner. Options
`TournamentOptions<K>`, prompts `TournamentPrompts<K>`, result `TournamentResult<K>`, where `K` is
the rubric's criteria (`DesignCriterion` by default).

Team `TournamentTeam`: `proposer` (a high-effort read-only entry such as `std.roles.Planner`),
`judge` (`std.roles.Judge`) and `synthesizer` (`std.roles.Planner`).

| Option               | Default                   | Meaning                                                                            |
| -------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| `brief`              | required, non-blank       | The design problem                                                                 |
| `entrants`           | `std.lenses.design`       | One proposal per lens, at most 26                                                  |
| `judges`             | 3                         | How many judges score every proposal                                               |
| `rubric`             | `std.lenses.designRubric` | Each criterion mapped to what a 1 to 10 score on it measures                       |
| `minEntrants`        | 2                         | The fewest successful proposals the judging needs; at most the entrants            |
| `synthesize`         | true                      | When false, `design` is the winning proposal's own design                          |
| `dissentGap`         | 3                         | How far below the panel mean a judge's score for the winner counts as dissent      |
| `prompts.propose`    | default prompt            | `(entrant, brief) => prompt`                                                       |
| `prompts.judge`      | default prompt            | `(brief, entries, rubric, seat, seats) => prompt`; show only letters and proposals |
| `prompts.synthesize` | default prompt            | `(brief, winner, standings, dissent) => prompt`                                    |
| `concurrency`        | 4                         | How many proposers or judges run at once                                           |

The successful proposals are lettered A, B, ... in entrant order. Each judge scores every proposal
on the rubric without seeing the entrants, in a different rotation to offset position bias; the
reply schema constrains each sheet's letter. The tally is code: a judge's score for an entry is the
mean of its criterion scores, an entry's score is the mean of its judges' scores, and the highest
score wins, ties going to the earlier entrant. A repeated sheet for a letter is ignored and a letter
a judge left out is that judge's missing vote; both are logged, as are the standings. The default
judge prompt names the safe default: no credit for what a proposal does not show.

Result: `outcome` (`'decided'`, or `'aborted'` when fewer than `minEntrants` proposals succeeded or
every judge failed), `winner` (a `TournamentEntry`: `letter`, `entrant`, `proposal`; null when
aborted), `entries`, `standings` (`Standing`: `letter`, `entrant`, `title`, `score` and `criteria`
rounded to two decimals or null, `votes`, `bestIdeas`; best first, unscored last), `design` (null
when aborted), `dissent`, `failedEntrants` (entrant keys), `failedJudges`, `failures`
(`failedEntrants.length + failedJudges`) and `status`. Schema: `TournamentResult`, for any rubric.

Steps, under `<id>/`:

- `propose/<entrant>/proposal`: the settled map `propose`, keyed by entrant key (schema
  `std.types.Proposal`).
- `judge/<n>/scores`: the settled map `judge`, judge `n` from 0; each item carries its letters and
  rubric, from which its schema is built.
- `synthesize`: the synthesizer's text, unless `synthesize` is false or the tournament aborted.

Fails the run: an unfilled slot, a blank brief, empty or more than 26 entrants, an invalid `judges`,
`minEntrants` or `concurrency`, `minEntrants` above the entrants, a `dissentGap` that is not a
positive number, or an empty rubric or one with a blank key or description, before any effect; a
failed synthesizer call, which a resume retries. Journaled as data: failed proposers and judges. The
tournament aborts, returning `outcome: 'aborted'`, when fewer than `minEntrants` proposals succeed
(no judge runs) or every judge fails.

Recipe: [std-design-tournament](../examples/patterns/std-design-tournament.workflow.ts).

### rank

One agent picks the `pick` items that rank highest on a criterion. Options `RankOptions<T>`, prompts
`RankPrompts`, result `RankResult<T>`.

Team `RankTeam`: `ranker`, a judging entry such as `std.roles.Judge`, or `std.roles.Reviewer` for
code.

| Option         | Default                                                       | Meaning                                                                          |
| -------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `items`        | required                                                      | The candidates                                                                   |
| `pick`         | required                                                      | How many to select, a positive integer                                           |
| `criterion`    | required, non-blank                                           | What ranks an item higher                                                        |
| `key`          | the item's own string `key` member, else its 1-based position | `(item, index) => key` the ranker answers with; unique and non-blank             |
| `describe`     | a string item itself, else JSON with sorted keys              | `(item) => text` for the ranker                                                  |
| `prompts.rank` | default prompt                                                | `(entries, criterion, pick) => prompt`; `entries` are `ItemText` (`key`, `text`) |

There is no `concurrency` or `version`. The reply is the chosen keys, best first, constrained by
`z.enum` to the item keys and at most `pick` of them; a repeated key counts once. The default prompt
names the item whose neglect would cost more as the safe default. What the cap deferred is logged.

Result: `selected` (best first), `deferred` (input order), `rationale`, `ranked` (false when there
were at most `pick` items, so every item was selected and no call was made), `failures` (always 0)
and `status` (always `'complete'`: the ranker call is required). Schema: `RankResult(item)`.

Steps: `<id>/rank`, none when every item fits.

Fails the run: an unfilled slot, an invalid `pick`, a blank criterion or item key, or two items with
one key (`Duplicate item key: ...`), before any effect; a failed ranker call, which a resume
retries.

Recipe: [std-triage](../examples/patterns/std-triage.workflow.ts), which ranks the `classify`
assignments.

### route

One agent chooses the route that fits a subject; the workflow then branches on `result.route`.
Options `RouteOptions<K>`, prompts `RoutePrompts<K>`, result `RouteResult<K>`.

Team `RouteTeam`: `router`, a quick entry such as `std.roles.Clerk`, or `std.roles.Judge` when the
choice is consequential.

| Option          | Default        | Meaning                                                                |
| --------------- | -------------- | ---------------------------------------------------------------------- |
| `subject`       | required       | What to route, non-blank                                               |
| `routes`        | required       | Each route key mapped to when to take it                               |
| `fallback`      | none           | The safe route, one of the keys                                        |
| `prompts.route` | default prompt | `(subject, routes, fallback) => prompt`; `fallback` is null when unset |

There is no `concurrency` or `version`. The reply's `route` is constrained by `z.enum` to the route
keys. The default prompt names the fallback as the safe default when no route clearly fits.

Result: `route`, `reason` (the router's, or its failure when the fallback was taken), `fallback`
(whether the router call failed and the fallback was taken), `failures` (1 then, else 0) and
`status` (`'degraded'` then). Schema: `RouteResult(routes?)`, which checks `route` against the route
keys it is given.

Steps: `<id>/route`.

Fails the run: an unfilled slot, a blank subject, empty `routes` or one with a blank key or
description, or a `fallback` that is not a route, before any effect; without `fallback`, a failed
router call, which a resume retries. With `fallback`, the call runs with `onError: 'return'`, so a
failure is journaled, logged and the fallback taken, and a resume replays that decision.

Recipe: [std-route](../examples/patterns/std-route.workflow.ts), which routes a request to one of
four short branches, with `unclear` as the fallback.

### classify

Labels items from a fixed taxonomy in batches and counts the labels in code. Options
`ClassifyOptions<T, L>`, prompts `ClassifyPrompts<L>`, result `ClassifyResult<T, L>`.

Team `ClassifyTeam`: `tagger`, a quick entry such as `std.roles.Clerk`, or `std.roles.Reader` when
labeling needs the code.

| Option        | Default                                                       | Meaning                                                                                           |
| ------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `items`       | required                                                      | The items to label                                                                                |
| `labels`      | required                                                      | Each label mapped to its definition, or a plain list of label names; this order breaks count ties |
| `multi`       | false                                                         | Whether an item may take several labels                                                           |
| `chunk`       | 10                                                            | Items per tagger call                                                                             |
| `key`         | the item's own string `key` member, else its 1-based position | `(item, index) => key`; unique and non-blank                                                      |
| `describe`    | a string item itself, else JSON with sorted keys              | `(item) => text` for the tagger                                                                   |
| `prompts.tag` | default prompt                                                | `(entries, labels, multi) => prompt`                                                              |

Each batch answers per item key, with keys and labels constrained by `z.enum`. The default prompt
names no label as the safe default. An item the reply leaves out or gives no label is unlabeled; a
reply entry that repeats an item is ignored; the left-out items and the repeats are logged.

Result: `assignments` (`Assignment`: `key`, `item`, `labels` in taxonomy order, `reason`), `counts`
(`LabelCount`: `label`, `count`; most used first, ties in taxonomy order), `unlabeled`, `omitted`
(the unlabeled items a successful reply left out), `failed` (the items of failed batches),
`failedChunks`, `failures` (the same) and `status`. An `Assignment` carries `key`, so `rank` can
take the assignments with its default key. Schema: `ClassifyResult(item, labels?)`, which checks the
labels against the taxonomy or names it is given.

Steps: the settled map `<id>/chunk`, so batch `n` from 0 records `<id>/chunk/<n>/tag`. Each item
carries the batch's keys, the labels and `multi`, from which its schema is built. No items, no map.

Fails the run: an unfilled slot, empty `labels`, a blank label, key or definition, a repeated label
name (`Duplicate label: ...`) or item key, or an invalid `chunk` or `concurrency`, before any
effect. Journaled as data: a failed batch, whose items are reported in `failed` and logged.

Recipe: [std-triage](../examples/patterns/std-triage.workflow.ts).

### mapReduce

Splits many items into chunks, has a mapper answer the task for each chunk, and has a reducer
combine the answers into one text. Options `MapReduceOptions<T, P>`, prompts
`MapReducePrompts<T, P>`, result `MapReduceResult<P>`.

Team `MapReduceTeam`: `mapper`, a fast entry such as `std.roles.Scribe`, `std.roles.Writer` or
`std.roles.Clerk`; `reducer`, a prose entry such as `std.roles.Writer` or `std.roles.Scribe`.

| Option           | Default                                     | Meaning                                                                               |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `items`          | required                                    | The items; they need not be JSON                                                      |
| `task`           | required, non-blank                         | What the mapper does with each chunk                                                  |
| `key`            | a string item itself, else its index        | `(item, index) => key`, unique among the items                                        |
| `chunk`          | 20                                          | Items per mapper call                                                                 |
| `describe`       | a string item itself, else two-space JSON   | `(item, index) => text`; a description that starts with its key is not prefixed again |
| `schema`         | text                                        | Each chunk's answer schema, such as `std.types.Changes`                               |
| `reduce`         | combine the parts into one answer to `task` | The reducer's task; non-blank when given                                              |
| `prompts.map`    | default prompt                              | `(items, keys) => prompt` for one chunk                                               |
| `prompts.reduce` | default prompt                              | `(parts, coverage) => prompt`                                                         |

Coverage is computed in code: an item is covered when its chunk's call succeeded, and missing when
it failed. The reducer is told which items no part covers.

Result: `result` (the reducer's text; empty with no items or no successful chunk), `parts`
(`MapReducePart<P>`: `{ keys, value }` per successful chunk, in item order), `coverage`
(`{ covered, missing }`), `chunks`, `failedChunks`, `failures` (the same) and `status`: `'complete'`
when every chunk succeeded or there were no items, else `'degraded'`. When every chunk failed, the
reducer is not called and `result` is empty. Schema: `MapReduceResult(part?)`.

Steps: the settled map `<id>/map`, keyed by each chunk's first item key, so that chunk records
`<id>/map/<k>/part`; then `<id>/reduce`, the reducer's text, when a chunk succeeded.

Fails the run: an unfilled slot, a blank `task` or `reduce`, an invalid `chunk` or `concurrency`, or
two items with one key (`Duplicate mapReduce item key: ...`), before any effect; a failed reducer
call, after which a resume replays the map and retries only the reducer. Journaled as data: a failed
chunk, counted, logged and reported in `coverage.missing`.

Recipe: [std-changelog](../examples/patterns/std-changelog.workflow.ts).

### decompose

A planner breaks a goal into a backlog of tasks; the IDs and dependencies are checked in code, with
one repair when they are invalid. Options `DecomposeOptions`, prompts `DecomposePrompts`, result
`DecomposeResult`.

Team `PlanTeam`: `planner`, a read-only planning entry such as `std.roles.Planner`.

| Option           | Default        | Meaning                                                                                                                 |
| ---------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `goal`           | required       | What the tasks must achieve together                                                                                    |
| `context`        | none           | Background: a string as written, or any JSON value (read-only arrays and interface-typed results too) as a fenced block |
| `maxTasks`       | 12             | The most tasks                                                                                                          |
| `prompts.plan`   | default prompt | `(goal, maxTasks, context) => prompt`                                                                                   |
| `prompts.repair` | default prompt | `(tasks, problems) => prompt`                                                                                           |

There is no `concurrency` or `version`. The planner answers a `std.types.TaskList` of at most
`maxTasks` tasks. The checks are: every ID unique, every dependency an ID in the list, and no cycle.
Problems are logged and sent back for one repair.

Result: `tasks` (in the planner's order), `waves` (`std.data.topoWaves` of the tasks), `repaired`
(whether the first list had problems and the repair fixed them), `problems` (what the repair fixed),
`failures` (always 0) and `status` (always `'complete'`: the planner calls are required). Schema:
`DecomposeResult`.

Steps: `<id>/plan`, and `<id>/repair` only when the plan had problems.

Fails the run: an unfilled slot, a blank `goal`, an invalid `maxTasks`, or a `context` that is
neither a string nor a JSON value (`decompose context must be a string or a JSON value: ...`, for a
`Date` or `NaN` too), before any effect; a failed planner call; and a repaired list that is still
invalid (`decompose <id>: the repaired task list is still invalid: ...`). Under `--dry-run`,
synthesized task lists name unknown dependencies, so give `<id>/plan` a fixture to rehearse past it.

`std.patterns.taskCall(task, goal?)` returns `{ prompt, schema }` (type `TaskCall`) for having an
implementer do one task: a `std.text.brief` prompt with the goal and the task, and
`std.types.WorkReport` as the schema. Spread it into a call to add placement, as in
`{ ...std.patterns.taskCall(task, goal), worktree: true }`. `std.flow.waves` runs a task after its
dependencies' `run` returned, whatever the report says, so throw from `run` when the report's
`status` is not `'done'`.

Recipe: [std-plan-and-build](../examples/patterns/std-plan-and-build.workflow.ts), with `taskCall`
and `std.flow.waves`.

### checklist

Checks each acceptance criterion against a subject, one call per criterion, and decides the verdict
in code. Options `ChecklistOptions`, prompts `ChecklistPrompts`, result `ChecklistResult`.

Team `ChecklistTeam`: `checker`, a read-only entry such as `std.roles.Reviewer`, or a shell entry
built with `std.claude.shell` when criteria name commands to run.

| Option          | Default             | Meaning                                                                                   |
| --------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `subject`       | required            | What the criteria are checked against, such as a range and its fenced diff                |
| `criteria`      | required, non-empty | Strings (ID `C<n>` from the 1-based position) or `std.types.Criterion` values; IDs unique |
| `prompts.check` | default prompt      | `(criterion, subject) => prompt`                                                          |

The default prompt shows the subject as the target, follows the criterion's `how` and names
`unverifiable` as the safe default. `std.types.Criteria` validates a criteria list in a workflow
input.

Result: `verdict` (`'not-done'` when any criterion failed or holds only in part; otherwise `'done'`
when every criterion passed, else `'unverified'`), `results` (`ChecklistEntry`: `criterion` and
`result` or null), `counts` (`ChecklistCounts`: how many answered `pass`, `fail`, `partial` and
`unverifiable`; a failed call is in none), `failures` (failed checker calls) and `status`. Schema:
`ChecklistResult`. `std.text.checklist` renders the result as Markdown.

Steps: the settled map `<id>/criterion`, keyed by criterion ID (made ID-safe), so `C1` records
`<id>/criterion/C1/check` (schema `std.types.CriterionResult`).

Fails the run: an unfilled slot, empty `criteria`, a blank string criterion, an invalid criterion
object, an invalid `concurrency`, or two criteria with one ID, before any effect. Journaled as data:
a failed checker call, counted in `failures`.

Recipe: [std-acceptance](../examples/patterns/std-acceptance.workflow.ts).

### gate

Assesses a subject on several dimensions, has a panel of skeptics challenge every reported blocker,
and decides `go`, `conditional-go` or `no-go` in code. Options `GateOptions`, prompts `GatePrompts`,
result `GateResult`.

Team `GateTeam`: `assessor`, a read-only reviewer such as `std.roles.Reviewer` (or a shell entry
that can run the checks); `skeptic`, a high-effort read-only entry such as `std.roles.Skeptic`.

| Option              | Default                                              | Meaning                                                                    |
| ------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `subject`           | required                                             | What is gated, such as a commit list and a diff stat                       |
| `task`              | `Assess whether the subject below is ready to ship.` | The assessor prompt's opening and the skeptics' question                   |
| `dimensions`        | `std.lenses.release`                                 | One assessor call per lens                                                 |
| `seats`             | 1                                                    | Skeptics per reported blocker                                              |
| `rule`              | `'majority'`                                         | How many upholding seats confirm a blocker                                 |
| `prompts.assess`    | default prompt                                       | `(dimension, subject) => prompt`                                           |
| `prompts.challenge` | default prompt                                       | `(dimension, assessment, subject, seat, seats) => prompt`                  |
| `concurrency`       | 4                                                    | How many dimensions, and separately how many blockers' panels, run at once |

The default assessor prompt names `concern` or `cannot-check` (never `pass`) as the safe default,
and the default skeptic prompt names `refuted: true`. Each dimension gets a disposition (type
`GateDisposition`):

| Disposition    | When                                                     | Effect on the decision |
| -------------- | -------------------------------------------------------- | ---------------------- |
| `pass`         | Assessed without a problem                               | none                   |
| `concern`      | Assessed with a problem that need not block              | `conditional-go`       |
| `blocker`      | A reported blocker the panel confirmed                   | `no-go`                |
| `undecided`    | A reported blocker whose failed seats left the vote open | `no-go` (fails closed) |
| `downgraded`   | A reported blocker the panel refuted                     | `conditional-go`       |
| `cannot-check` | The assessor could not assess the dimension              | `conditional-go`       |
| `failed`       | The assessor call failed                                 | `conditional-go`       |

Result: `decision`, `assessments` (`GateDimension`: `key`, `lens`, `assessment` or null, `challenge`
(a `GateChallenge`: the panel's `outcome`, `upheld`, `against`, `missing`, `seats` and `reasons`) or
null, `disposition`), the dimension keys by disposition in `blockers`, `undecided`, `downgraded`,
`concerns`, `cannotCheck` and `failed`, `reasons` (one `<key> (<disposition>): <summary>` line per
dimension that is not a pass; empty for `go`), `failedVotes`, `failures` (failed assessors and
seats: `failed.length + failedVotes`) and `status`. Schema: `GateResult`. `std.text.gate` renders
the result as Markdown.

Steps: the settled map `<id>/dimension`, so dimension `k` records `<id>/dimension/<k>/assess`
(schema `std.types.Assessment`); then, when an assessor reported a blocker, the settled map
`<id>/blocker`, each blocker the settled map `<id>/blocker/<k>/seat`, so seat `n` records
`<id>/blocker/<k>/seat/<n>/verdict` (schema `std.types.Refutation`). No blocker, no `<id>/blocker`
map.

Fails the run: an unfilled slot, empty `dimensions`, an invalid `seats` or `concurrency`, or a rule
invalid for `seats`, before any effect. Journaled as data: failed assessors and seats.

Recipe: [std-release-gate](../examples/patterns/std-release-gate.workflow.ts).

### falsify

A theorist proposes competing hypotheses, a falsifier tries to falsify each one separately, and the
confidence in what survives is decided in code. Options `FalsifyOptions`, prompts `FalsifyPrompts`,
result `FalsifyResult`.

Team `FalsifyTeam`: `theorist`, a high-effort read-only entry such as `std.roles.Reviewer` or
`std.roles.Planner`; `falsifier`, a skeptical read-only entry such as `std.roles.Skeptic`, or a
shell entry when predictions need commands.

| Option             | Default             | Meaning                                                                        |
| ------------------ | ------------------- | ------------------------------------------------------------------------------ |
| `question`         | required, non-blank | What to explain                                                                |
| `context`          | none                | What was observed, shown under `### Evidence`; blank counts as none            |
| `count`            | 4                   | The most hypotheses to test, from 1 to 8; any beyond it are logged, not tested |
| `prompts.theorize` | default prompt      | `(question, count) => prompt`; `context` is then unused for it                 |
| `prompts.falsify`  | default prompt      | `(hypothesis, rivals, question) => prompt`                                     |

The default falsifier prompt names `untestable` as the safe default and shows the rivals' causes as
context only. The confidence (type `FalsifyConfidence`) is:

- `high`: exactly one hypothesis survives and every other one was falsified.
- `medium`: exactly one survives, but no rival was falsified, or some rival was left open.
- `split`: more than one survives.
- `none`: none survives.

Result: `hypotheses` (`TestedHypothesis`: `key`, `hypothesis`, `verdict` or null), `survivors`,
`confidence`, `falsified`, `failures` (failed falsifier calls) and `status`. Schema:
`FalsifyResult`.

Steps: `<id>/theorize` (schema `std.types.Hypotheses`), then the settled map `<id>/hypothesis`,
keyed by hypothesis `id`, so hypothesis `k` records `<id>/hypothesis/<k>/falsify` (schema
`std.types.Falsification`).

Fails the run: an unfilled slot, a blank question, a `count` outside 1 to 8 or an invalid
`concurrency`, before any effect; a failed theorist call, which a resume retries. Journaled as data:
a failed falsifier call, whose hypothesis has a null verdict, is not a survivor and keeps the
confidence below `high`.

Recipe: [std-incident](../examples/patterns/std-incident.workflow.ts).

### research

Scouts propose leads per source angle, readers extract cited claims from the most promising distinct
leads, and a synthesizer answers from those claims alone. Options `ResearchOptions`, prompts
`ResearchPrompts`, result `ResearchResult`.

Team `ResearchTeam`: `scout` (`std.roles.Researcher` for web sources, `std.roles.Scout` for a
repository), `reader` (`std.roles.Researcher` or `std.roles.Reader`) and `synthesizer` (a prose
entry such as `std.roles.Writer`, which has no tools, or `std.roles.Scribe`).

| Option               | Default               | Meaning                                                           |
| -------------------- | --------------------- | ----------------------------------------------------------------- |
| `question`           | required, non-blank   | The research question                                             |
| `context`            | none                  | Background every default prompt shows; blank counts as none       |
| `angles`             | `std.lenses.research` | One scout call per lens                                           |
| `reads`              | 6                     | The most distinct leads to read; the rest are logged and deferred |
| `prompts.scout`      | default prompt        | `(angle, question) => prompt`                                     |
| `prompts.read`       | default prompt        | `(lead, question) => prompt`                                      |
| `prompts.synthesize` | default prompt        | `(question, claims, unread) => prompt`                            |
| `concurrency`        | 4                     | How many scouts, and separately how many readers, run at once     |

The leads are merged into one priority order: leads several scouts named first, then by rank, taking
each scout's leads in turn. They are deduplicated by reference, compared case-insensitively without
an `http(s)://` scheme, `www.`, `./` or trailing slash, and without a URL's in-page anchor or a
`#L12` line anchor; a hash route such as `#/docs/api` and an issue such as `owner/repo#12` stay
distinct. The claims are deduplicated by normalized claim text and source, numbered in reading
order, and cited as `[n]`. The default reader prompt names leaving out an unverifiable claim as the
safe default.

Result: `answered` (false when no claim was collected and the synthesizer was not called), `answer`
(empty when unanswered), `sources` (the leads that yielded a claim), `claims`, `deferred` (past the
`reads` cap), `unread` (failed reads), `failedScouts`, `failedReads`, `failures` (their sum) and
`status` (`'degraded'` when a scout or reader failed). Schema: `ResearchResult`.

Steps: the settled map `<id>/scout`, so angle `a` records `<id>/scout/<a>/leads` (schema
`std.types.Leads`); the settled map `<id>/read`, keyed by the lead's reference made ID-safe, so lead
`l` records `<id>/read/<l>/claims` (schema `std.types.Claims`); and `<id>/synthesize`, the
synthesizer's text. Without a lead nothing is read; without a claim the synthesizer is not called.

Fails the run: an unfilled slot, a blank question, empty `angles`, or an invalid `reads` or
`concurrency`, before any effect; a failed synthesizer call, after which a resume replays the scouts
and readers and retries only the synthesizer. Journaled as data: failed scouts and readers, counted
and logged; the synthesizer is told which sources could not be read.

Recipe: [std-research](../examples/patterns/std-research.workflow.ts).

### isolatedEdits

An editor makes each item's change in a fresh checkout of its own; changes outside the paths an item
owns are rejected, and the rest are merged in one `ctx.merge`. Options `IsolatedEditsOptions<T>`,
result `IsolatedEditsResult`.

Team `EditTeam`: `editor`, an editing entry such as `std.roles.Mechanic`, `std.roles.Editor` or
`std.roles.CodexEditor`; under `requireGrants` it needs a write grant.

| Option         | Default                      | Meaning                                                                                 |
| -------------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| `items`        | required                     | One isolated edit each; they need not be JSON                                           |
| `task`         | required                     | `(item, index) => text`, the change to make; non-blank                                  |
| `key`          | the index                    | `(item, index) => label` for the step IDs, such as a task ID                            |
| `owns`         | every change merges          | `(item, index) => paths` the item may change; disjoint across items                     |
| `base`         | `HEAD` when each edit starts | The ref or commit every checkout starts from; `{ commit }` pins one base across resumes |
| `merge`        | `onConflict: 'report'`       | `EditMergeOptions`: `strategy`, `onConflict`, `target` and `commit`, as for `ctx.merge` |
| `prompts.edit` | default prompt               | `(request: EditPromptInput<T>) => prompt`                                               |

`owns` lists the repository-relative paths an item may change: files, or directories that own
everything under them (`src/parser` owns `src/parser/lexer.ts`). An `EditPromptInput` holds the
`item`, its `key`, its `task` text and its `owns` (null without `owns`).

`calls.worktree` is refused: each edit always gets a fresh checkout, and `base` chooses where it
starts. Each item is the text call `team.editor.text('edit', { worktree: true })`, or
`{ worktree: { base } }`. An item that changed nothing is unchanged. With `owns`, an item that
changed a file outside its owned paths is a violation, and none of its change is merged; a renamed
file is checked by both its old and new path. The remaining changes are merged in item order. The
default merge skips and reports a conflicting change and publishes a run-owned ref; set `merge` for
another strategy, a branch or the checkout as the target, or a commit message. Failures, violations
and conflicts are logged.

Result: `status` (`'complete'` when every edit succeeded, stayed within its paths and merged
cleanly; an unchanged item does not count against it, and a violation or conflict degrades it as a
failed edit does), `commit` (the merge's commit, or null when nothing merged), `merge` (the
`MergeResult`, or null when no merge ran), `merged` and `conflicts` (item keys), `changes`
(`EditChange`: `key`, `files`, `summary`), `violations` (`EditViolation`: `key`, `files`),
`unchanged` and `failed` (item keys), and `failures` (failed edit calls). Schema:
`IsolatedEditsResult`.

Steps, under `<id>/`:

- `item/<key>/edit`: the isolated text call, in the settled map `item`.
- `item/<key>/paths`: only for a change that renames a file, `std.exec.changedFiles` over
  `<base>..<snapshot>`, which lists the old path of every rename too.
- `merge`: the merge of the remaining changes; absent when none remain.

Fails the run: an unfilled slot, an invalid `concurrency`, `calls.worktree`, a blank task, an owned
path that is not repository-relative, or overlapping owned paths
(`isolatedEdits <id>: items must own disjoint paths: ...`), before any effect; a merge failure, such
as a conflict under `onConflict: 'fail'`. Journaled as data: a failed edit call, reported in
`failed`. The workflow's checkout must be a Git working tree with a commit, and an embedded caller
passes a process runner (`new NodeProcessRunner()`) to `runWorkflow`. Under `--dry-run`, the
isolated calls synthesize unchanged checkouts, so every item is unchanged and nothing merges.

Recipe: [std-parallel-edits](../examples/patterns/std-parallel-edits.workflow.ts).

### approvedPlan

A planner writes a plan, a reviewer approves it through `ctx.approve` with the plan's digest as the
subject, and a rejection with a comment is revised in the next round. Options `ApprovedPlanOptions`,
prompts `ApprovedPlanPrompts`, result `ApprovedPlanResult`.

Team `PlanApprovalTeam`: `planner`, a read-only planning entry such as `std.roles.Planner`.

| Option           | Default                      | Meaning                                                                 |
| ---------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `task`           | required, non-blank          | What the plan must achieve                                              |
| `context`        | none                         | Background for the planner: a string, or a JSON value as a fenced block |
| `revisions`      | 2                            | The most revisions, so up to three plans are reviewed                   |
| `question`       | the default question (below) | The approval question: one nonblank line of at most 1024 characters     |
| `title`          | `Plan review`                | The question-tool header, 1 to 12 characters                            |
| `audience`       | `'human'`                    | `'human'`, `'agent'` or `'any'`                                         |
| `prompts.plan`   | default prompt               | `(task) => prompt`; a replacement does not receive `context`            |
| `prompts.revise` | default prompt               | `(task, plan, comment) => prompt`                                       |

The default question is
`Approve this implementation plan? Reject with a comment to have it revised.`

There is no `concurrency` or `version`. Round `n` asks for a `std.types.Plan`, then for approval:
the subject is the plan's `std.data.digest`, so an answer applies to exactly that plan, and the
details are the task and the plan as Markdown, clipped to 16000 bytes. The run suspends at each
approval until an answer arrives (`quiet-choir workflow answer`, or `writeAnswer` when embedded);
the answer is saved, so a resume replays it.

Result: `approved`, `outcome` (`'approved'`, `'rejected'` when a rejection had no comment to revise
from, or `'out-of-revisions'`), `plan` (the approved or last reviewed plan), `digest`, `rounds`,
`comment` (the reviewer's comment, or null), `failures` (always 0) and `status` (always
`'complete'`: the planner calls are required). Schema: `ApprovedPlanResult`.

Steps: `<id>/round/<n>/plan` (schema `std.types.Plan`) and `<id>/round/<n>/approve`, for rounds `n`
from 0.

Fails the run: an unfilled slot, a blank task, a `context` that is neither a string nor a JSON
value, or an invalid `revisions`, `question` or `title`, before any effect; a failed planner call.

`std.patterns.planCall(source, task?)` returns `{ prompt, schema }` (type `PlanCall`) for having an
implementer carry out the plan: a `std.text.brief` prompt with the task, the plan and the reviewer's
comment, and `std.types.WorkReport` as the schema. `source` is an `approvedPlan` result or any
`PlanSource` (`{ plan, comment?, approved? }`); `approved: false` throws a `TypeError`, so an
unapproved plan is not implemented.

Recipe: [std-approved-plan](../examples/patterns/std-approved-plan.workflow.ts), with `planCall`.

### reviewRevise

Reviews a draft up to `rounds` times and revises it after each rejection. Options
`ReviewReviseOptions`, result `ReviewReviseResult`. It predates the contract: `id` is optional, and
it takes no `calls`, `concurrency` or `version`.

Team `ReviewTeam`: `actor`, which drafts and revises (such as `std.roles.Writer`); `critic`, which
judges (such as `std.roles.Reviewer`).

| Option           | Default                                          | Meaning                                                                    |
| ---------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| `draft`          | required                                         | The draft to review first                                                  |
| `rounds`         | required                                         | The most reviews; zero or fewer runs none and returns the draft unapproved |
| `id`             | none                                             | A scope prefix; omitted, the IDs are in the caller's scope                 |
| `prompts.review` | `Review this draft: <draft>`                     | `(draft) => prompt`                                                        |
| `prompts.revise` | `Revise <draft> using this feedback: <feedback>` | `(draft, feedback) => prompt`                                              |

Result: `approved` and `draft` (the approved draft, or the last reviewed one). Schema:
`ReviewReviseResult`.

Steps: `review/<n>`, the critic's `{ approved, feedback }` (exactly `std.types.Approval`), and
`revise/<n>`, the actor's text after a rejection, never after the last round; under `<id>/` when
`id` is given.

It checks its team before any effect, as the other patterns do. Every call is required: a failed
critic or actor call fails the run, and a resume retries it. Exhausted rounds return
`approved: false` as data.

Recipe: [review-revise](../examples/patterns/review-revise.workflow.ts).

### tolerantPanel

Asks one panelist about every item and decides a quorum over the answers that succeeded. Options
`TolerantPanelOptions<T, O>`, result `TolerantPanelResult<O>`. It predates the contract: it takes a
`prompt` function instead of `prompts`, a required `concurrency`, and no `calls`.

Team `PanelTeam`: `panelist`, which answers one item.

| Option        | Default  | Meaning                                                              |
| ------------- | -------- | -------------------------------------------------------------------- |
| `id`          | required | The map ID                                                           |
| `items`       | required | The panel items, one call each; plain JSON, since they are map items |
| `prompt`      | required | `(item, index) => prompt`                                            |
| `concurrency` | required | The map's mapper bound                                               |
| `schema`      | text     | Each answer's schema                                                 |
| `version`     | none     | The map's `version`                                                  |

Result: `quorum` (more than half of the items answered), `answers` (in item order) and `failed`.
Schema: `TolerantPanelResult(answer?)`, with the panel's `schema`.

Steps: `ctx.map(id, items, { concurrency, onError: 'return', version })`, so item `i` records
`<id>/<i>/answer`. A failed vote is journaled, so a resume does not retry it into a different
quorum. The map fingerprints the items and the mapper source but not the `prompt` function, the
`schema` or the panelist's configuration: change `version` when you change any of them.

It checks its team before the map, as the other patterns do, so an unfilled `panelist` throws
instead of being journaled as a failed answer for every item.

Recipe: [tolerant-panel](../examples/patterns/tolerant-panel.workflow.ts).

## Recipes

The seventeen `std-*` recipes in `examples/patterns` are complete workflows of at most 30 lines,
registered in `examples/patterns/recipes.json`. Roles from `std.rosters.readers` need no grant;
under `requireGrants`, a `write` role needs one, used or not.

| Recipe                  | What it does                                             | Patterns                                  | Roster                                                        | Grants                |
| ----------------------- | -------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- | --------------------- |
| [std-acceptance]        | Checks a range's diff against acceptance criteria        | `checklist`                               | `readers`: `Reviewer`                                         | none                  |
| [std-approved-plan]     | Plans a task, waits for approval, implements the plan    | `approvedPlan`, `planCall`                | `Planner`, `Mechanic`                                         | `Mechanic`            |
| [std-bug-hunt]          | Hunts a scope for defects within a call cap              | `hunt`                                    | `readers`: `Reviewer`, `Skeptic`                              | none                  |
| [std-changelog]         | Turns a range's commit log into release notes            | `mapReduce`                               | `readers`: `Scribe`, `Writer`                                 | none                  |
| [std-code-review]       | Reviews a range through lenses, then verifies findings   | `lensPanel`, `verify`                     | `readers`: `Reviewer`, `Skeptic`                              | none                  |
| [std-design-tournament] | Runs a design tournament                                 | `tournament`                              | `readers`: `Planner`, `Judge`                                 | none                  |
| [std-doc-polish]        | Polishes a Markdown file and writes it back              | `critiqueRevise`                          | `readers`: `Critic`, `Writer`                                 | none                  |
| [std-escalate]          | Makes a change, escalating until a check command passes  | `escalate`                                | `Mechanic`, `Surgeon`                                         | `Mechanic`, `Surgeon` |
| [std-fix-tests]         | Fixes the code until a check command passes              | `fixUntilGreen`                           | `Mechanic`, `Surgeon`                                         | `Mechanic`, `Surgeon` |
| [std-incident]          | Explains an incident from a range's commits and notes    | `falsify`                                 | `readers`: `Reviewer`, `Skeptic`                              | none                  |
| [std-parallel-edits]    | Makes edits in isolated checkouts and squash-merges them | `isolatedEdits`                           | `Mechanic`                                                    | `Mechanic`            |
| [std-plan-and-build]    | Plans tasks and builds them in dependency waves          | `decompose`, `taskCall`, `std.flow.waves` | `Planner`, `Mechanic`                                         | `Mechanic`            |
| [std-release-gate]      | Decides go, conditional-go or no-go for a release        | `gate`                                    | `readers`: `Reviewer`, `Skeptic`                              | none                  |
| [std-research]          | Answers a question from cited web sources                | `research`                                | `readers`: `Researcher`, `Writer`                             | none                  |
| [std-route]             | Routes a request to one of four branches and answers it  | `route`                                   | `readers`: `Clerk`, `Reader`, `Reviewer`, `Planner`, `Writer` | none                  |
| [std-triage]            | Labels issues and picks the most urgent                  | `classify`, `rank`                        | `readers`: `Clerk`, `Judge`                                   | none                  |
| [std-vote]              | Votes unanimously on whether a range is safe to merge    | `vote`                                    | `readers`: `Skeptic`                                          | none                  |

Most recipes declare a pattern's result schema as their `output` and return the result as it is:
`std-acceptance` (`ChecklistResult`), `std-bug-hunt` (`HuntResult`), `std-changelog`
(`MapReduceResult(std.types.Changes)`), `std-design-tournament`, `std-escalate`, `std-fix-tests`,
`std-incident`, `std-parallel-edits`, `std-release-gate`, `std-research` and `std-vote`. Four wrap
one beside their own data: `std-approved-plan` (`review` and the implementer's `report`),
`std-doc-polish` (`polish` and the write's `receipt`), `std-triage` (`labeled` and the `urgent`
issues) and `std-route` (`routed` and the branch's `reply`). `std-code-review` and
`std-plan-and-build` combine two steps' health with `std.data.health`. The Git recipes read their
range with `std.exec` helpers (`diff`, `diffStat`, `log`), so an option-like range is refused before
any command runs, and `std-incident` and `std-release-gate` show the commits with
`std.text.commits`.

`std-plan-and-build` has a fixture file, `std-plan-and-build.fixtures.json`, so it rehearses past
`decompose` under `--dry-run`. `std-approved-plan` suspends until the approval is answered, and
`std-research` needs network access for its web searches. The skill reference
[`references/std.md`](../plugins/agents/quiet-choir/skills/quiet-choir/references/std.md) walks
through each recipe.

## Writing a pattern of your own

A pattern of your own keeps the same contract with public APIs only. The library's shared helpers
are internal, so do not import them; `std.patterns.CallDefaults` is the one shared type you need.

1. Declare the team with `defineTeam`, one line per slot that says what fills it, and export the
   record type with `TeamOf`.
2. Fill the team with `XTeam.from(options.team)` and validate every option before any effect.
3. Run under `ctx.scope(options.id, ...)` and document the exact step IDs.
4. Tolerate a failed agent with a settled map (`onError: 'return'`) or an `onError: 'return'` call,
   count the failures in `failures`, report health in `status` (`std.data.health(failures)`), and
   put what the pattern decided in a named field.
5. Make each map item carry its key, its rendered prompt (`std.text.promptText`) and the calls'
   placement, so a change to either refuses replay. Forward the caller's `version` to the map for
   what the items do not show, such as a schema.
6. Build default prompts with `std.text.brief` and name the safe default in a skeptical one.
7. Make keys ID-safe and unique with `std.data.uniqueKeys` before the map starts.
8. To let callers return the result as a workflow `output`, export a strict Zod schema under the
   name of its interface, typed `z.ZodType<XResult>`, with `std.data.Health` for `status`.

```ts
import { defineTeam, type Prompt, type TeamOf, type WorkflowContext } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const SummaryTeam = defineTeam({
  summarizer: 'Summarizes one file. Fill with a read-only entry such as std.roles.Scribe.',
});
export type SummaryTeam = TeamOf<typeof SummaryTeam>;

export interface SummarizeOptions {
  readonly id: string;
  readonly team: SummaryTeam;
  readonly files: readonly string[];
  readonly prompts?: { readonly summarize?: (file: string) => string | Prompt };
  readonly concurrency?: number;
  readonly version?: string;
  /** No `worktree`: the items below show `cwd` and `addDirs` only. */
  readonly calls?: Omit<std.patterns.CallDefaults, 'worktree'>;
}

/** Steps: `<id>/file/<key>/summary`, in the settled map `<id>/file`. */
export async function summarize(ctx: WorkflowContext, options: SummarizeOptions) {
  const { summarizer } = SummaryTeam.from(options.team);
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new TypeError(`concurrency must be a positive integer; got ${String(concurrency)}.`);
  const { calls } = options;
  const prompt =
    options.prompts?.summarize ??
    ((file: string) =>
      std.text.brief({
        task: `Summarize ${file} for a new contributor.`,
        guidance: ['If you cannot open the file, say so instead of guessing what it holds.'],
        output: 'Two or three plain sentences.',
      }));
  const keys = std.data.uniqueKeys(options.files);
  const records = options.files.map((file, index) => ({
    key: keys[index] ?? String(index),
    prompt: std.text.promptText(prompt(file)),
    placement: { cwd: calls?.cwd ?? null, addDirs: calls?.addDirs ? [...calls.addDirs] : null },
  }));
  return ctx.scope(options.id, async () => {
    const settled = await ctx.map(
      'file',
      records,
      {
        concurrency,
        key: (record) => record.key,
        onError: 'return',
        version: options.version,
      },
      (record) => summarizer.value('summary', { ...calls, prompt: record.prompt }),
    );
    const failures = std.data.failures(settled).length;
    return { summaries: std.data.oks(settled), failures, status: std.data.health(failures) };
  });
}
```

A pattern that accepts `calls.worktree` must also put a JSON form of it in each item, such as the
handle's `id` and `base`, or the base of a fresh checkout.

[std-acceptance]: ../examples/patterns/std-acceptance.workflow.ts
[std-approved-plan]: ../examples/patterns/std-approved-plan.workflow.ts
[std-bug-hunt]: ../examples/patterns/std-bug-hunt.workflow.ts
[std-changelog]: ../examples/patterns/std-changelog.workflow.ts
[std-code-review]: ../examples/patterns/std-code-review.workflow.ts
[std-design-tournament]: ../examples/patterns/std-design-tournament.workflow.ts
[std-doc-polish]: ../examples/patterns/std-doc-polish.workflow.ts
[std-escalate]: ../examples/patterns/std-escalate.workflow.ts
[std-fix-tests]: ../examples/patterns/std-fix-tests.workflow.ts
[std-incident]: ../examples/patterns/std-incident.workflow.ts
[std-parallel-edits]: ../examples/patterns/std-parallel-edits.workflow.ts
[std-plan-and-build]: ../examples/patterns/std-plan-and-build.workflow.ts
[std-release-gate]: ../examples/patterns/std-release-gate.workflow.ts
[std-research]: ../examples/patterns/std-research.workflow.ts
[std-route]: ../examples/patterns/std-route.workflow.ts
[std-triage]: ../examples/patterns/std-triage.workflow.ts
[std-vote]: ../examples/patterns/std-vote.workflow.ts
