# Workflow packages

A package is a directory named `<name>.quiet-choir` that holds several related workflows with their
shared contracts, roster, prompts and helpers, and a `package.ts` manifest that names them.
[ADR 0065](decisions/0065-workflow-packages.md) describes the design. A package is not a different
programming model: each workflow in it is an ordinary `defineWorkflow` definition, and the package
adds a manifest, a version and an entry point. This page covers what the CLI does today. Registry
discovery, whole-directory fingerprinting and the full `validate --json` package section come next
([below](#what-comes-next)).

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
only when no earlier candidate matched; it is trusted code, as everything validate imports is. The
module is found after import because the plan stays plain data
([ADR 0001](decisions/0001-plan-execute-cli.md)): a command records the package root, its manifest
and the requested workflow name (or null), and the executor resolves the module path. That module
path is the validate result's `entrypoint` and the run's `launch.entrypoint`. The validate result
also carries `package: { root, name, version }`, and the human line reads
`Validated merge-down/merge-down-stack@1 (package merge-down@1, <module>).`

## Records and resume

A package run records the selected workflow's module as `launch.entrypoint`, the real path a single
module run would record, and adds `launch.package = { root, name, version }` with the package's real
root ([storage](storage.md#record-schema-revision), revision 21). `inspect` prints
`<package>/<workflow>@<version>` in its header with a `Package: <name>@<version> at <root>` line,
`list` rows show `<package>/<workflow>@<version>`, and the `inspect --summary` and `list` JSON rows
carry `package`. Fork entries in `next` start the new run from the package:
`workflow execute <root> --workflow <name> --fork-from RUN ...`.

A package run is fingerprinted from the manifest: its `launch.sources` and source identity cover the
manifest's compiler closure plus its prompt roots. To keep that identity, every resume of a package
run re-enters through the manifest:

- `workflow resume RUN`, `workflow execute --resume --run-id RUN` without FILE and `workflow tick`
  typecheck `<launch.package.root>/package.ts` with the recorded tsconfig and select the run's
  recorded workflow name.
- `execute <dir> --resume --run-id RUN` and `check-resume <dir> --run-id RUN` without `--workflow`
  resume or check the run's own workflow, not the package's entry.
- After import the selected module must equal `launch.entrypoint`.

A mismatched launch mode is refused as `run.incompatible` before import, with `storedEntrypoint` and
`requestedEntrypoint` in `details` and resume and fork entries in `next`: a single-module FILE given
for a package run, a package given for a single-module run, or a different package root. A selection
that resolves to a different module than `launch.entrypoint` (a renamed workflow file, or
`--workflow` naming another workflow) is refused the same way after import. A refused package
request also carries `requestedPackage` and `requestedWorkflow`, so its fork entry stays a package
run. A deleted manifest or module is the `entrypoint_missing` refusal.

## What comes next

- #585 discovers `*.quiet-choir` directories in the registry (`list-defs`, by-name dispatch as
  `<package>/<workflow>`), fingerprints every file under the package root instead of the manifest's
  compiler closure plus prompt roots, warns about large packages, and fills the `validate --json`
  `package` section with the workflows, input schemas, roster summaries and prompt inventory.
- #591 adds the package authoring reference to the skill copies and a package-aware run command.
