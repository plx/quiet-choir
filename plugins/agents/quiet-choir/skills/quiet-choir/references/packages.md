# Workflow packages

A package is a directory named `<name>.quiet-choir` that holds several related workflows with their
shared contracts, roster, prompts, teams and helpers, and a `package.ts` manifest that names them.
It is not a different programming model: each workflow in it is an ordinary `defineWorkflow`
definition. The package adds a manifest, a version, an entry point, registry discovery,
whole-directory fingerprinting and a `package` section in `validate --json`. This page is the
authoring reference; [workflow authoring](workflow-authoring.md) covers the workflows themselves.

## When to package

Write a single `*.workflow.ts` file while a workflow is small. Move to a package when one of these
holds:

- the workflow calls several agents, or you want the same roster in more than one workflow;
- prompts have grown past a few lines and deserve markdown files with typed parameters;
- the mechanics (git, checks, state files) have become helpers worth unit-testing apart from the
  control flow;
- related workflows share contracts (Zod schemas), so a change to one should be fingerprinted with
  the others.

Porting a native Workflow script usually ends here: see
[porting native workflows](porting-native-workflows.md) and the
[worked example](#worked-example-merge-down).

## Layout

```
merge-down.quiet-choir/
  package.ts            definePackage: root, name, version, description, whenToUse, workflows, entry
  workflows/
    merge-down-pr.ts    control flow only; default-exports defineWorkflow
  contracts.ts          Zod schemas for inputs, outputs and structured agent results
  roster.ts             defineRoster, shared by the workflows
  prompts.ts            definePrompts index
  prompts/
    ReviewAgainstIssue.md
    _fragments/ReviewRules.md
  lib/                  optional shared TypeScript: teams.ts, durable steps, pure policy
  resources/            optional static files
  tsconfig.json         optional; the nearest tsconfig rule applies as for any workflow
```

Only `package.ts` and the workflow modules are required. Name the directory `<name>.quiet-choir`,
with `<name>` the manifest's `name`; this release does not enforce it. Every module is TypeScript
(`.ts`, `.mts` or `.cts`): the loader refuses a `package.js`, `package.mjs`, `package.cjs`,
`package.mts` or `package.cts` manifest (use `package.ts`), and each workflow must be the default
export of a TypeScript module inside the package. JavaScript under `node_modules` is unaffected.

## The manifest

`definePackage` takes the root, identity and the workflows. This example type-checks as written, but
it declares its workflows inline to stay in one file. In a real package each workflow is the default
export of its own `workflows/NAME.ts`, because the loader resolves the selected workflow to that
module, and `package.ts` imports them (see the fragment after it).

```ts
import {
  definePackage,
  defineRoster,
  defineTeam,
  defineWorkflow,
  z,
  type TeamOf,
} from 'quiet-choir';
import * as std from 'quiet-choir/std';

const roster = defineRoster({
  Writer: { ...std.claude.Edit, ...std.tiers.Mechanic, description: 'Drafts the change.' },
  Reviewer: { ...std.claude.ReadOnly, ...std.tiers.Skeptic, description: 'Reviews a draft.' },
});

const ReviewTeam = defineTeam({
  writer: 'Drafts the change.',
  critic: 'Reviews the draft and asks for a revision.',
});
type ReviewTeam = TeamOf<typeof ReviewTeam>;

const draft = defineWorkflow({
  name: 'draft',
  version: '1',
  roster,
  input: z.object({ task: z.string() }),
  output: z.string(),
  async run(ctx, { task }) {
    const team: ReviewTeam = ReviewTeam.from({
      writer: ctx.roster.Writer,
      critic: ctx.roster.Reviewer,
    });
    return team.writer.value('draft', { prompt: task });
  },
});

const review = defineWorkflow({
  name: 'review',
  version: '1',
  roster,
  input: z.object({ diff: z.string() }),
  output: z.string(),
  run: (ctx, { diff }) => ctx.roster.Reviewer.value('review', { prompt: `Review:\n${diff}` }),
});

export default definePackage({
  root: import.meta.dirname,
  name: 'drafting',
  version: '1',
  description: 'Draft a change and review it.',
  whenToUse: 'A task needs a written draft or a second opinion on a diff.',
  workflows: [draft, review],
  entry: draft,
});
```

A real `package.ts` imports its workflows and prompt sets:

<!-- skills-check: fragment; reason: package.ts of a real package; ./workflows/*.js and ./prompts.js are sibling modules of the package. -->

```ts
import { definePackage } from 'quiet-choir';
import { prompts } from './prompts.js';
import mergeDownPr from './workflows/merge-down-pr.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'merge-down',
  version: '1',
  description:
    'Land one PR: rebase onto main, review against its issue with a local Codex review, triage threads, fix, gate on CI + Codex, squash-merge, report',
  whenToUse:
    'Merging down a stack of agent-authored PRs (or Dependabot PRs) one PR per run, in stack order. Input: {pr, repo?, followupEpic?, parentEpic?, until?}.',
  workflows: [mergeDownPr],
  entry: mergeDownPr,
  prompts: [prompts],
});
```

`definePackage` checks its arguments without touching the disk and throws a `TypeError` whose
message names the field:

- `root` is absolute: pass `import.meta.dirname` (`__dirname` in a CommonJS package), or a `file:`
  URL of the directory. The loader refuses a manifest whose root is not the directory it was
  imported from, comparing real paths; the error names both.
- `name` is lowercase letters, digits and hyphens, starts with a letter and has at most 64
  characters; `version` is a nonempty string, like a workflow's.
- `workflows` is a nonempty array of `defineWorkflow` definitions with unique names.
- `entry`, when given, is one of `workflows` (the same imported object). Without it, every run must
  pass `--workflow`.
- `prompts`, when given, holds only `definePrompts` sets.
- `description` and `whenToUse` are optional nonempty strings; no other key is allowed.

The result is frozen and exposes `root` and `resource(relativePath)`, which returns
`<root>/resources/<relativePath>` and refuses an empty, absolute or escaping path (it does not check
that the file exists). A manifest that throws fails like any module that throws while it
initializes, as `load.import`.

**Import direction.** Import workflows from the manifest, never the manifest from a workflow. A
workflow that imports `package.ts` forms an import cycle: while the manifest evaluates, that
workflow's definition is still undefined, and `definePackage` reports `workflows[i] is undefined`
with a pointer to the cycle. Workflows get shared things (roster, prompts, teams, contracts) from
sibling modules such as `../roster.js`, never from the manifest.

## Roster

Keep one `roster.ts` at the package root, a data-only `defineRoster` module, and let every workflow
import it. A workflow's `roster` field lists only the entries it calls, so the shared module can be
wider than any one workflow (under `--require-grants`, every write-capable entry in a workflow's
roster needs a grant, so a narrow field matters there). `defineWorkflow` accepts only a
`defineRoster` result, so a plain object of shared entries fails typecheck, and a spread or rest
copy of the shared roster keeps every shared entry in the type of `ctx.roster`, even one it leaves
out. Pick the entries by passing them to `defineRoster` again in the workflow:

<!-- skills-check: fragment; reason: Sibling-module imports in a workflow file of a package; ../roster.js is the package's own roster.ts. -->

```ts
import { defineRoster, defineWorkflow, z } from 'quiet-choir';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'review-only',
  version: '1',
  roster: defineRoster({ Reviewer: roster.Reviewer }),
  input: z.object({ diff: z.string() }),
  output: z.string(),
  run: (ctx, { diff }) => ctx.roster.Reviewer.value('review', { prompt: diff }),
});
```

Build entries from the `quiet-choir/std` fragments instead of retyping options: `std.claude.Text`,
`ReadOnly` and `Edit` (and `std.codex`) carry the runtime's text, read-only and edit configurations
(Codex has no tool-less mode: `std.codex.Text` can still read any file the user can read, not only
its working directory), and `std.tiers` fixes a Claude model and effort (`Clerk`, `Copyist`,
`Scribe`, `Mechanic`, `Planner`, `Skeptic`, `Surgeon`, ...). Compose by spread:
`Mechanic: { ...std.claude.Edit, ...std.tiers.Mechanic, maxTurns: 200 }`. See
[agent calls](agent-calls.md#roster) for the entry rules. `std.claude.Edit` has no shell, so its
agent cannot delete or rename a file: retract paths from code on the handle
([shared write, test, fix sequences](worktrees.md#shared-write-test-fix-sequences)) or widen the
entry with a narrow `Bash(git rm:*)` rule, which makes it `exec` access.

`validate --json` lists each workflow's roster in the `package` section, so you can check what a
package will spend before a run (see [the validate output](#validate-output)).

## Prompts

Keep prompt prose out of the control flow. A `prompts.ts` module declares a `definePrompts` index
over a `prompts/` directory of markdown templates, each with a typed Zod `params` schema, and the
workflow calls `prompts.ReviewAgainstIssue({ issue, pr })` as a plain function. Shared text lives in
`prompts/_fragments/` and is included by the templates. The template rules, load-time checks and
`Prompt` result are in [prompt templates](prompts.md).

<!-- skills-check: fragment; reason: prompts.ts of a package; the template files live in prompts/ beside it. -->

```ts
import { definePrompts, z } from 'quiet-choir';

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  ReviewAgainstIssue: {
    file: 'ReviewAgainstIssue.md',
    description: 'Review a PR against the issue it closes.',
    params: z.object({ issue: z.string(), pr: z.int() }),
  },
});
```

- **Package prompt sets.** The manifest's `prompts` field lists the sets declared once for the
  package. After import the loader runs the [load-time checks](prompts.md#checks-and-errors) on them
  as for a workflow's own `prompts`: an error fails `load.definition`
  (`Package <name> prompt templates failed their load-time checks`) and a warning is logged. A
  workflow that renders a set may also list it in its own `prompts`; a set listed in both places is
  hashed once and warned about once.
- **Templates are execution dependencies.** Rendered text is step identity, and the files of every
  prompt root join the source fingerprint, so a template edit is refused on resume like a code edit
  ([templates as execution dependencies](prompts.md#templates-are-execution-dependencies)).
- **Keep formatters off templates.** A formatter that rewraps a template changes the rendered text
  and so the step identity. This repository's `.prettierignore` lists `packages/*/prompts/`; add the
  equivalent rule for your package's `prompts/` directory in your own project.
- **No multi-line literals in workflows.** A prompt of more than a line in `workflows/` belongs in a
  template; `merge-down`'s rehearsal script rejects them there.

## Teams

A team names the swappable roles a helper or a stage needs, independent of which roster entry fills
them (ADR 0067). Declare teams in `lib/teams.ts` with `defineTeam({ slot: 'one-line description' })`
and derive the record type with `TeamOf`. A team registers nothing and checks no capability, so put
expectations about a slot in its description. Fill it at the call site from roster entries, which
lets one workflow choose a different entry for a slot by kind or complexity:

<!-- skills-check: fragment; reason: lib/teams.ts of a package, then a body that fills the team; ctx and the package roster come from the surrounding workflow. -->

```ts
// lib/teams.ts
import { defineTeam, type TeamOf } from 'quiet-choir';

export const FixTeam = defineTeam({
  mechanic: 'Implements mechanical fixes and dependency updates.',
  surgeon: 'Implements subtle fixes, and takes over when the suite still fails after a fix.',
});
export type FixTeam = TeamOf<typeof FixTeam>;

// In a workflow body, with the package roster declared on the workflow:
const team: FixTeam = FixTeam.from({ mechanic: ctx.roster.Mechanic, surgeon: ctx.roster.Surgeon });
const fixer = complexity === 'high' ? team.surgeon : team.mechanic;
await fixer.value(ctx.id('fix', round), { prompt: prompts.Implement(params), schema: Fix });
```

`FixTeam.from(record)` keeps only the slot keys of any record that has them (a record missing a slot
fails typecheck and throws a `TypeError` for an untyped caller), so a team whose slot names equal
roster names is filled by `Team.from(ctx.roster)`, and
`Team.from({ ...ctx.roster, critic: ctx.roster.Skeptic })` overrides one slot. Calls through a slot
are identical to calls through the entry that fills it: same step IDs, fingerprints and records,
including the prefix. Slots filled from `ctx.roster` take a `ctx.within` view's prefix only when the
pattern calls them inside its own `ctx.scope` or `ctx.map` on that view (`tolerantPanel` always
does; `reviewRevise` does with `id`); otherwise they keep the caller's prefix, so scope the stage or
fill the slots from `view.roster`. Teams serve in-process patterns; pass one to a `quiet-choir/std`
pattern such as `std.patterns.reviewRevise`
([bounded review/revise](patterns.md#bounded-reviewrevise)), or to your own helper typed with the
team's record. `merge-down` has two teams: `FixTeam` (`mechanic`, `surgeon`) and `ResolveTeam`
(`resolver`, the surgeon for a change PR and the mechanic for a Dependabot PR).

## Run a package

Every command that takes a workflow FILE also takes a package directory. A path whose last segment
ends in `.quiet-choir` is a package. Use the launcher from the
[first-run setup](../SKILL.md#run-a-first-workflow-against-a-project), with `QC_WORKFLOW` set to the
package directory:

```sh
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow validate "$QC_WORKFLOW" --json
node "$QC_CHECKOUT/bin/run.js" workflow execute "$QC_WORKFLOW" --run-id pkg-1 \
  --state-dir "$QC_RUNS" --input '{}' --dry-run --json
node "$QC_CHECKOUT/bin/run.js" workflow execute "$QC_WORKFLOW" --workflow review \
  --run-id pkg-2 --state-dir "$QC_RUNS" --input '{"diff":"..."}' --json
node "$QC_CHECKOUT/bin/run.js" workflow start "$QC_WORKFLOW" --workflow review \
  --run-id pkg-3 --state-dir "$QC_RUNS" --input '{"diff":"..."}' --json
node "$QC_CHECKOUT/bin/run.js" workflow check-resume "$QC_WORKFLOW" --run-id pkg-2 \
  --state-dir "$QC_RUNS" --json
node "$QC_CHECKOUT/bin/run.js" workflow typecheck "$QC_WORKFLOW"
```

Claude Code's `/quiet-choir:run PACKAGE --workflow NAME` command drives the whole rehearse, launch
and follow flow for a package; without that command, run the commands above by hand.

- **Entry versus `--workflow`.** Without `--workflow` the CLI runs the package's `entry`;
  `--workflow NAME` selects another declared workflow.
- **`usage.entrypoint` (exit 2).** A package without `entry` and no `--workflow`, or a name the
  package does not declare, fails with `details.reason` of `package_workflow_required` or
  `package_workflow_unknown`, and `details.workflows` lists the declared names in declaration order.
  Show them to the user and choose; do not guess.
- **`usage.flag`.** `--workflow` with a single-module FILE, with a registered name, or on a resume
  without FILE.
- **Missing files.** A missing package directory or `package.ts` is `usage.file_not_found`. A
  directory with only a JavaScript manifest is `usage.entrypoint` with
  `details.reason: 'JAVASCRIPT_PACKAGE_MANIFEST'`.
- **One type check for all.** The typecheck entrypoint is the manifest, which reaches every workflow
  by import, so a type error or durability lint finding in any workflow of the package fails
  `validate` and every run, not only the selected one's. The nearest `tsconfig.json` above the
  manifest applies, and a package may carry its own, as `merge-down` does to map `quiet-choir` to
  the source tree.
- **Selection.** After the type check the loader imports the manifest, selects the workflow, and
  finds the module that default-exports that same definition object under the package root,
  `workflows/` first. That module is the run's `launch.entrypoint`.

## Validate output

`workflow validate PACKAGE --json` describes every declared workflow, not only the selected one, so
a workflow whose own checks fail fails `validate` as `load.definition` even when another is
selected. The top-level `workflow` is the selected workflow's compact document, as for a single
module (its `name` is what the default run ID in `/quiet-choir:run` uses). Beside it, `package`
describes the whole package:

| Field                | Meaning                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `root`               | The package's real root; with `name` and `version`, what the run records as `launch.package`                                       |
| `entry`              | The entry workflow's name, or null                                                                                                 |
| `workflows[]`        | Every declared workflow in declaration order: `name`, `version`, `description`, `whenToUse`, `entrypoint`, `inputSchema`, `roster` |
| `workflows[].roster` | The workflow's roster entries in key order, each with `name`, `harness`, `access`, `model` (null when unset) and `description`     |
| `prompts[]`          | One per prompt root: `root` and `entries` with `name`, `file`, `description`, `params` (sorted keys) and `variables`               |
| `files`              | `count`, `bytes` and a `sha256` over root-relative paths and contents, so a copy at another path has the same digest               |

The human line reads `Validated merge-down/merge-down-pr@1 (package merge-down@1, <module>).`

## Discovery

`workflow list-defs [DIR...]` finds `<stem>.quiet-choir` directories beside `*.workflow.ts` files,
including a DIR that is itself a package. A package is one artifact: its contents are not scanned
for loose definitions, and the bare `.quiet-choir` state directory is never a package. Each package
is validated once and contributes one entry per declared workflow, listed as `<package>/<workflow>`
(a package without `entry` still lists). An entry's `entrypoint` is the workflow's module, and it
carries `package: { root, name, version, description, whenToUse }`.

Listing names must be unique: two packages with the same name are duplicates, while two packages
that both declare `review` list as `demo/review` and `other/review`. By-name dispatch
(`workflow execute NAME`) takes either spelling: an exact listing name wins, otherwise a bare name
selects the one package workflow of that name, and several are refused as `load.definition`
(`Workflow name review is ambiguous: demo/review, other/review; use <package>/<workflow>`). A
selected package workflow runs through its manifest, as `execute <root> --workflow <name>` would,
and records `launch.package`. See
[child workflows and discovery](child-workflows.md#describe-discover-and-execute).

## Fingerprinting and resume

A package run fingerprints every regular file under the package root, except anything under an entry
named `node_modules` or `.git` at any depth, plus the compiler's dependencies outside the root and
any prompt roots outside it. File symlinks are not listed and directory symlinks are not followed
(TypeScript reached through one stays fingerprinted through the compiler's closure, templates
through their prompt roots). Each file is recorded in `launch.sources` by absolute path and SHA-256,
so a resource, a template or a helper that nothing imports is an execution dependency like the
workflow's own code. `validate`, `check-resume` and `execute` use one fingerprint.

- **Drift.** A resume refuses changed code as `run.incompatible` with `details.changed: ["code"]`
  and `canAcceptCodeChange: true`; `--accept-code-change` proceeds, and completed steps keep their
  own fingerprint checks ([recovery paths](durability.md#choose-a-recovery-path)).
- **Size.** Every resume hashes all of these files, so `validate` and `execute` log one warning when
  they total more than 10 MiB, naming the total and the five largest files. Keep large or generated
  artifacts outside the package root.
- **Keep volatile files outside the root.** Rehearsal fixtures, scratch worktrees, state directories
  (including a legacy `<cwd>/.quiet-choir/runs`) and any file that changes while a run is in flight
  would be drift on every resume if they lived under the root.
- **Resume re-enters through the manifest.** A package run records `launch.entrypoint` (the selected
  module) and `launch.package = { root, name, version }`. `workflow resume RUN`,
  `workflow execute --resume --run-id RUN` without FILE, and `workflow tick` typecheck
  `<root>/package.ts` and select the run's recorded workflow, so no selection is needed.
  `execute DIR --resume` and `check-resume DIR` without `--workflow` check the run's own workflow,
  not the package's entry.
- **Refusals.** A single-module FILE given for a package run, a package given for a single-module
  run, a different package root, or a selection that resolves to a different module than
  `launch.entrypoint` is `run.incompatible` with `storedEntrypoint` and `requestedEntrypoint` and
  fork entries in `next`; a deleted manifest or module is `entrypoint_missing`.

## Rehearse a package

Rehearse a package like any workflow: `execute --dry-run --harness fixture:FILE` answers every agent
call and command from a [fixture file](rehearsal.md#fixtures) at zero cost. A real package workflow
cannot be meaningfully rehearsed with synthesized commands, because its `gh` reads would parse empty
output, so write fixtures for each path you care about (`workflow fixtures RUN` exports command
fixtures from a real run).

Keep the fixture files, case inputs and every `root`/state directory the rehearsal writes
**outside** the package root, since every file under it is fingerprinted. If the workflow takes a
`root` input for its worktree and state files, pass a temporary directory:

```sh
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow execute "$QC_WORKFLOW" --workflow merge-down-pr \
  --run-id rehearse-1 --state-dir "$QC_RUNS" --input @"$QC_CASE/input.json" \
  --dry-run --harness fixture:"$QC_CASE/fixtures.json" --json
```

A good rehearsal asserts that the run completed with the expected output, that every call and
command was answered by a fixture (`outputSource` is `fixture`), and that no fixture rule went
unused (`staleCallFixtures` and `staleExecFixtures` are empty). This repository's
`npm run packages:rehearse` does exactly that for `merge-down`, one case per path, and fails when a
change alters a path without a matching case.

## Worked example: merge-down

`packages/merge-down.quiet-choir` (issue #589) ports the native `merge-down-pr` Workflow script and
its helper CLI. It lands one pull request: it rebases it onto the default branch in a dedicated
worktree, reviews it against its issue, triages review threads, fixes what is in scope, files
follow-ups, gates on CI and reviewers, squash-merges at the gated head and records the result on the
issue. It is the first package built to this page.

```
merge-down.quiet-choir/
  package.ts               definePackage: name merge-down, entry merge-down-pr
  workflows/merge-down-pr.ts   control flow only
  contracts.ts             input, agent result schemas, the ledger record
  roster.ts                the tier map as a roster
  prompts.ts, prompts/     every prompt as a markdown template; _fragments/ for shared text
  lib/policy.ts            pure decision rules, unit-tested apart from the workflow
  lib/prepare.ts           GitHub reads, written out as the state files
  lib/state.ts             pure renderers for the state files agents read
  lib/git.ts, checks.ts, codex.ts, land.ts   git, check-suite, local-review and landing mechanics as durable steps
  lib/teams.ts             FixTeam and ResolveTeam slots
  tsconfig.json            maps quiet-choir, quiet-choir/github and quiet-choir/std to src/
```

What each native construct became:

| Native script                                             | Package                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The `TIER` map of model and effort entries                | `roster.ts`: `Reviewer` and `Judge` local, `Mechanic`, `Surgeon` and `Scribe` spread `std.tiers`     |
| Twelve multi-line template literals                       | `prompts/*.md` with `_fragments/`, indexed by `definePrompts` with typed params and load-time checks |
| Picking an agent tier by complexity or PR kind            | `FixTeam` and `ResolveTeam` slots filled from the roster at the call site                            |
| Clerk and copyist agents relaying `merge-down.mjs` output | Versioned `ctx.step` effects in `lib/` and `quiet-choir/github` calls: no model, no nonces or hashes |
| The helper CLI's pure decisions                           | `lib/policy.ts`, unit-tested                                                                         |
| `args`                                                    | The workflow's Zod `input` (`pr` required; `repo`, `root`, `until` and the caps optional)            |
| Stage stops (`until`)                                     | An `until` enum input that returns a `stopped` result early                                          |
| State files and a worktree beside the checkout            | A `root` input; durable steps read before they write                                                 |

The package keeps the ledger record's field names, so the `blocked`, `stopped`, `deferred` and
`skipped` results read as before, and it runs as
`workflow execute packages/merge-down.quiet-choir --run-id merge-down-pr-N --input '{"pr":N,"repo":"OWNER/REPO"}'`.
Its README measures the port against the native pair,
[merge-down-pr.js](https://github.com/plx/quiet-choir/blob/657334c8b994ba6c0166347c4e61cefef4a54a50/.claude/workflows/merge-down-pr.js)
and
[merge-down.mjs](https://github.com/plx/quiet-choir/blob/657334c8b994ba6c0166347c4e61cefef4a54a50/.claude/workflows/merge-down-pr/merge-down.mjs)
(removed in #693; measured on its branch under issue #589):

| Measure                                                  | Package                                       | Native                                                               |
| -------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| Total lines (package without README; script plus helper) | 4,653 in 28 files                             | 3,377 (merge-down-pr.js 1,552 + merge-down.mjs 1,825)                |
| Prompt prose                                             | 355 lines, 21.9 KB in prompts/\*\*/\*.md      | 12 multi-line template literals, 139 lines, 19.2 KB in the script    |
| Control flow                                             | 1,358 lines in workflows/                     | the whole 1,552-line script                                          |
| Mechanics                                                | 2,261 lines in lib/ (623 of them pure policy) | 1,825 lines in merge-down.mjs                                        |
| Agent call sites                                         | 9 roster or team-slot calls                   | 9 judgment `agent(` calls + 13 clerk relay calls (one `agent(` site) |
| Model calls per mechanical step                          | 0                                             | 1 haiku clerk, plus a sonnet copyist on a failed relay               |

The package is about 38% longer than the native pair. The relay protocol is gone, but the port
spells out what the native JavaScript left implicit: Zod contracts for every agent result and the
ledger, typed prompt parameters, the roster's tools and limits, versioned step definitions, and
Prettier's 100-column formatting of typed TypeScript. The prose moved out of the control flow nearly
unchanged in size. The gain is that no mechanical step costs a model call, every agent call site is
a named roster or team entry, and each path has a free rehearsal.

A live landing makes GitHub and model calls. Rehearse first with fixtures, then execute the package
against a real PR with `"until":"review"` in the input, which reads GitHub and runs the reviewers
but publishes nothing, before running it without `until`.
