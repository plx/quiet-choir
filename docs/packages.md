# Workflow packages

A package is a directory named `<name>.quiet-choir` that holds several related workflows with their
shared contracts, roster, prompts and helpers, and a `package.ts` manifest that names them.
[ADR 0065](decisions/0065-workflow-packages.md) describes the design. A package is not a different
programming model: each workflow in it is an ordinary `defineWorkflow` definition, and the package
adds a manifest, a version, an entry point, registry discovery, whole-directory fingerprinting and a
`package` section in `validate --json`. This page covers what the CLI does today.

## Layout

```
merge-down.quiet-choir/
  package.ts            definePackage: root, name, version, description, whenToUse, workflows, entry
  workflows/
    merge-down-pr.ts    control flow only; default-exports defineWorkflow
    merge-down-stack.ts
  contracts.ts          Zod schemas for inputs, outputs and structured agent results
  roster.ts             defineRoster
  prompts.ts            definePrompts index
  prompts/
    ReviewAgainstIssue.md
    _fragments/ReviewRules.md
  lib/                  optional shared TypeScript helpers
  resources/            optional static files
  tsconfig.json         optional; the nearest tsconfig rule applies as for any workflow
```

Only `package.ts` and the workflow modules are required. The directory name should be
`<name>.quiet-choir`, with `<name>` the manifest's `name`; this release does not enforce it.

Every module is TypeScript (`.ts`, `.mts` or `.cts`). The loader refuses a `package.js`,
`package.mjs`, `package.cjs`, `package.mts` or `package.cts` manifest, and each workflow must be the
default export of a TypeScript module in the package. JavaScript dependencies under `node_modules`
are unaffected.

## The manifest

```ts
// package.ts
import { definePackage } from 'quiet-choir';
import mergeDownPr from './workflows/merge-down-pr.js';
import mergeDownStack from './workflows/merge-down-stack.js';
import { prompts } from './prompts.js';

export default definePackage({
  root: import.meta.dirname,
  name: 'merge-down',
  version: '1',
  description: 'Merge a reviewed PR stack down to main.',
  whenToUse: 'A stacked PR has approvals and green checks.',
  workflows: [mergeDownPr, mergeDownStack],
  entry: mergeDownPr,
  prompts: [prompts],
});
```

`definePackage` checks its arguments without touching the disk and throws a `TypeError` whose
message names the field:

- `root` is absolute: pass `import.meta.dirname` (`__dirname` in a CommonJS package), or a `file:`
  URL of the directory. A module cannot learn its own location otherwise, and the loader refuses a
  manifest whose root is not the directory it was imported from, comparing real paths; the error
  names both paths.
- `name` matches `/^[a-z][a-z0-9-]{0,63}$/`.
- `version` is a nonempty string, like a workflow's `version`.
- `workflows` is a nonempty array of `defineWorkflow` definitions whose names are unique.
- `entry`, when given, is one of `workflows` (the same imported object).
- `prompts`, when given, holds only `definePrompts` sets.
- `description` and `whenToUse`, when given, are nonempty strings, and no other key is allowed.

A manifest that throws fails like any module that throws while it initializes, as `load.import`.

The result is frozen. It exposes `root` and `resource(relativePath)`, which returns
`<root>/resources/<relativePath>` and refuses an empty, absolute or escaping path. Both work while
modules initialize, because the root is known at the call; `resource` does not check that the file
exists.

Import workflows from the manifest, never the manifest from a workflow module. A workflow that
imports `package.ts` forms an import cycle: while the manifest evaluates, that workflow's definition
is still undefined, and `definePackage` reports `workflows[i] is undefined` with a pointer to the
cycle.

### Package prompt sets

`prompts` lists prompt sets declared once for the package. The loader runs the
[load-time checks](prompts.md#load-time-checks) on them after import, as for a workflow's own
`prompts`: an error fails `load.definition`
(`Package <name> prompt templates failed their load-time checks`), and a warning is logged. Their
roots join the source fingerprint
([templates as execution dependencies](prompts.md#templates-as-execution-dependencies)), so a
template edit is refused on resume like a code edit. A workflow that renders a set can still list it
in its own `prompts`; a set listed in both places is hashed once and its warnings are logged once.

## Running a package

Every command that takes a workflow FILE also takes a package directory:

```sh
quiet-choir workflow execute merge-down.quiet-choir --input @input.json
quiet-choir workflow execute merge-down.quiet-choir --workflow merge-down-stack
quiet-choir workflow validate merge-down.quiet-choir --json
quiet-choir workflow execute merge-down.quiet-choir --dry-run
quiet-choir workflow check-resume merge-down.quiet-choir --run-id RUN
quiet-choir workflow start merge-down.quiet-choir --workflow merge-down-stack
quiet-choir workflow typecheck merge-down.quiet-choir
```

A path whose last segment ends in `.quiet-choir` is a package. Without `--workflow` the CLI runs the
package's `entry`; `--workflow <name>` selects another declared workflow. A package without `entry`
needs `--workflow`. Both failures are `usage.entrypoint` (exit 2) with the declared names:
`details.reason` is `package_workflow_required` or `package_workflow_unknown`, and
`details.workflows` lists the names in declaration order. `--workflow` with a single-module FILE,
with a registered name, or on a resume without FILE is `usage.flag`. A missing package directory or
`package.ts` is `usage.file_not_found`; a directory with only a JavaScript manifest is
`usage.entrypoint` with `details.reason: 'JAVASCRIPT_PACKAGE_MANIFEST'`.

The typecheck entrypoint is the manifest, which reaches every workflow by import, so a type error or
durability lint finding in any workflow of the package fails `validate` and every run, not only the
selected one's. The nearest `tsconfig.json` above the manifest applies, and a package may carry its
own. `workflow typecheck <dir>` checks the manifest.

After the type check, the loader imports the manifest, selects the workflow, and finds the module
that default-exports that same definition object among the compiler's TypeScript sources under the
package root, `workflows/` first. A module the manifest already evaluated is not run again. Only a
module that the manifest reaches through a type-only import is evaluated for the first time, and
only when no earlier candidate matched; it is trusted code, as everything validate imports is.
`validate` (and `list-defs`) resolve the module of every declared workflow the same way, while a run
resolves only the selected one. The module is found after import because the plan stays plain data
([ADR 0001](decisions/0001-plan-execute-cli.md)): a command records the package root, its manifest
and the requested workflow name (or null), and the executor resolves the module path. That module
path is the validate result's `entrypoint` and the run's `launch.entrypoint`. The validate result
also carries the [package section](#validate-output), and the human line reads
`Validated merge-down/merge-down-stack@1 (package merge-down@1, <module>).`

## Validate output

`workflow validate <dir> --json` describes every declared workflow, not only the selected one, so a
workflow whose own checks fail (a broken template in its own prompt set, say) fails `validate` as
`load.definition` even when another workflow is selected; the message names the package and the
workflow. The top-level `workflow` is the selected workflow's compact document, as for a single
module. Beside it, `package` describes the whole package and is not compacted:

```json
{
  "root": "/work/merge-down.quiet-choir",
  "name": "merge-down",
  "version": "1",
  "description": "Merge a reviewed PR stack down to main.",
  "whenToUse": "A stacked PR has approvals and green checks.",
  "entry": "merge-down-pr",
  "workflows": [
    {
      "name": "merge-down-pr",
      "version": "1",
      "description": "Land one PR.",
      "whenToUse": null,
      "entrypoint": "/work/merge-down.quiet-choir/workflows/merge-down-pr.ts",
      "inputSchema": { "type": "object" },
      "roster": [
        {
          "name": "Reviewer",
          "harness": "codex",
          "access": "read",
          "model": "gpt-5.5",
          "description": "Reviews the diff."
        }
      ]
    }
  ],
  "prompts": [
    {
      "root": "/work/merge-down.quiet-choir/prompts",
      "entries": [
        {
          "name": "ReviewAgainstIssue",
          "file": "ReviewAgainstIssue.md",
          "description": null,
          "params": ["issue", "pr"],
          "variables": ["issue", "pr"]
        }
      ]
    }
  ],
  "files": { "count": 14, "bytes": 23817, "sha256": "<64 hex digits>" }
}
```

- `root`, `name` and `version` are those of `launch.package`; `entry` is the entry workflow's name,
  or null.
- `workflows` lists every declared workflow in declaration order, with its own module as
  `entrypoint`, its input JSON Schema, and `roster`: the workflow's [roster](roster.md) entries (the
  manifest profiles pinned to a harness) in key order, each with the pinned harness's `access` and
  the entry's `model` for that harness (null when it sets none).
- `prompts` lists the package's prompt sets and every set in each workflow's static tree, one per
  root, first seen first (package sets before workflow sets). `params` are the sorted keys of the
  entry's params schema, and `variables` the top-level variables the template reads. An entry that
  repeats exactly (same name, file, params and variables) is listed once; differing declarations
  under the same name, from two sets on one root, are each listed.
- `files` covers the [fingerprinted files](#fingerprinting) under the root: their count, total bytes
  and a SHA-256 digest over their root-relative paths and contents, so a copy of the package at
  another path has the same digest. Files outside the root are not counted.

## Discovery

`workflow list-defs [DIR...]` finds `<stem>.quiet-choir` directories beside `*.workflow.ts`, `.mts`
and `.cts` files, including a DIR that is itself a package. A package is one artifact: its contents
are not scanned for loose definition files, and the bare `.quiet-choir` state directory is never a
package. A DIR inside a package that another DIR discovers does not list the package's files as
loose definitions. A package directory without `package.ts`, or with only a JavaScript manifest,
fails `list-defs` with the message `validate` gives.

Each package is validated once and contributes one entry per declared workflow, in declaration
order, listed as `<package>/<workflow>`; a package without `entry` still lists. An entry's
`entrypoint` is the workflow's module, and it carries
`package: { root, name, version, description, whenToUse }`; a loose definition has no `package`.
Entries are sorted by file path or package root. Listing names must be unique: two packages with the
same name, or a loose workflow literally named like a package entry, are duplicates, while two
packages that both declare `review` list as `demo/review` and `other/review`. Human rows read
`demo/main@1<TAB><module><TAB><workflow description>`, followed by
`<TAB>package demo@1: <package description>` when the package has a description.

By-name dispatch (`workflow execute NAME`) takes either spelling. An exact listing name wins, so a
loose `main` stays runnable beside `demo/main`; otherwise a bare name selects the one package
workflow of that name, and several are refused as `load.definition`:
`Workflow name review is ambiguous: demo/review, other/review; use <package>/<workflow>`. A selected
package workflow runs through its manifest, as `execute <root> --workflow <name>` would, and records
`launch.package`. Without `--registry-dir`, a missing argument shaped `<package>/<workflow>` (a
package name, one `/` and no other separator, no TypeScript or `.quiet-choir` suffix) is treated as
a registered name rather than a missing file.

The private definition cache keeps one entry per package holding all of its workflows. It is served
only while the package's walked files are exactly the recorded ones and none has changed, so
editing, adding or removing a file under the package revalidates it. The files under the package's
own prompt roots, inside the package or outside it, are checked like a workflow's prompt roots: by
real path and contents, and an added or removed file revalidates too.

## Fingerprinting

A package run fingerprints every regular file under the package root, except anything under an entry
named `node_modules` or `.git` at any depth, in addition to the compiler's dependencies outside the
root and prompt roots outside it. File symlinks are not listed and directory symlinks are not
followed: TypeScript reached through a symlink stays fingerprinted through the compiler's closure,
and templates through their prompt roots. Each file is recorded in `launch.sources` by absolute path
and SHA-256, so a resource, a template or a helper that nothing imports is an execution dependency
like the workflow's own code. The [ADR 0006](decisions/0006-code-change-recovery.md) rules apply
unchanged: a resume refuses the drift as `run.incompatible` with `details.changed: ["code"]` and
`canAcceptCodeChange: true`, and `--accept-code-change` proceeds, while completed steps keep their
own fingerprint checks. `validate`, `check-resume` and `execute` all use this one fingerprint. A
single-module run keeps its compiler closure plus its declared prompt roots.

Every resume hashes all of these files, so `validate` and `execute` log one warning when they total
more than 10 MiB, naming the total and the five largest files. Keep large or generated artifacts
outside the package root. That includes a legacy `<cwd>/.quiet-choir/runs` state directory or any
other file that changes while a run is in flight: inside the root it would be drift on every resume.

## Records and resume

A package run records the selected workflow's module as `launch.entrypoint`, the real path a single
module run would record, and adds `launch.package = { root, name, version }` with the package's real
root ([storage](storage.md#record-schema-revision), revision 21). `inspect` prints
`<package>/<workflow>@<version>` in its header with a `Package: <name>@<version> at <root>` line,
`list` rows show `<package>/<workflow>@<version>`, and the `inspect --summary` and `list` JSON rows
carry `package`. Fork entries in `next` start the new run from the package:
`workflow execute <root> --workflow <name> --fork-from RUN ...`.

A package run's `launch.sources` and source identity cover every [walked file](#fingerprinting)
under the package root, the manifest's compiler dependencies outside it and its prompt roots. To
keep that identity, every resume of a package run re-enters through the manifest:

- `workflow resume RUN`, `workflow execute --resume --run-id RUN` without FILE and `workflow tick`
  typecheck `<launch.package.root>/package.ts` with the recorded tsconfig and select the run's
  recorded workflow name.
- `execute <dir> --resume --run-id RUN` and `check-resume <dir> --run-id RUN` without `--workflow`
  resume or check the run's own workflow, not the package's entry.
- After import the selected module must equal `launch.entrypoint`.

On `execute --resume` and `check-resume`, a mismatched launch mode is refused as `run.incompatible`
before import, with `storedEntrypoint` and `requestedEntrypoint` in `details` and resume and fork
entries in `next`: a single-module FILE given for a package run, a package given for a single-module
run, or a different package root. A selection that resolves to a different module than
`launch.entrypoint` (a renamed workflow file, or `--workflow` naming another workflow) is refused
the same way after import. A refused package request also carries `requestedPackage` and
`requestedWorkflow`, so its fork entry stays a package run. A deleted manifest or module is the
`entrypoint_missing` refusal, whose fork hint is `<PACKAGE_DIR> --workflow NAME` for you to fill in
with the package's new directory.

## Worked packages

[`packages/merge-down.quiet-choir`](../packages/merge-down.quiet-choir/README.md) ports the native
`merge-down-pr` workflow script (#589): control flow in `workflows/`, prompts in `prompts/`, the
tier map as a roster, teams for its swappable slots, and the git and check mechanics as versioned
steps in `lib/`.
[`packages/execute-epic-ticket.quiet-choir`](../packages/execute-epic-ticket.quiet-choir/README.md)
ports the native `execute-epic-ticket` script (#590) the same way, and lands each ticket's pull
request by running merge-down's workflow as a typed inline child (`ctx.workflow`, declared in
`children`), which `workflow inspect` shows in its workflow tree. It imports merge-down's generic
helpers rather than copying them; they are compiler dependencies, so they join its fingerprint.

`npm run packages:rehearse` (after `npm run build`) validates every package in the table of
`scripts/rehearse-packages.mjs` and rehearses each one's cases in `packages/rehearsals/<name>/`,
kept outside the package roots because every file under a root is fingerprinted; a case can also
require an inline child frame to complete and show in the inspect summary. Each package's
`tsconfig.json` maps `quiet-choir` and its subpaths to `src/`, and the repository's
`.prettierignore` keeps formatters off `packages/*/prompts/`, whose rendered text is step identity.

## For agents

Both skill copies carry a condensed authoring reference, `references/packages.md`, and the Claude
plugin's `/quiet-choir:run WORKFLOW [--workflow NAME] [--fixtures FILE]` command accepts a package
directory ([installing the plugins](plugins.md)).

## What comes next

- #592 removes profiles.
