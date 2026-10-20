# 0065: Package saved workflows as directories

- Status: proposed
- Issue: to be filed (the packaged-workflows epic)
- Builds on: [0026](0026-inline-children-and-definition-registry.md) (definition registry),
  [0006](0006-code-change-recovery.md) (source fingerprinting),
  [0063](0063-bound-agents-and-typed-rosters.md) (rosters) and
  [0064](0064-prompt-templates-as-execution-dependencies.md) (prompt templates)

## Context

The project's primary use case is now the saved, reusable, carefully engineered workflow, authored
by people and agents together and read many times. Such a workflow has four kinds of content with
different readers and change rates: control flow, data contracts, prose for agents, and agent
configuration. A single file mixes them. The registry (ADR 0026) discovers only `*.workflow.ts`
files, the loader imports one default export, and `fingerprintSources` follows only TypeScript.

The desired shape is an Apple-style bundle: a directory treated as one artifact, discovered,
validated, executed and fingerprinted as a whole, whose parts are files a human can open.

## Decision

### 1. Layout and manifest

A package is a directory named `<name>.quiet-choir` with a `package.ts` manifest at its root:

```
merge-down.quiet-choir/
  package.ts            definePackage: root, name, version, description, whenToUse, workflows, entry
  workflows/
    merge-down-pr.ts    control flow only; default-exports defineWorkflow
    merge-down-stack.ts
  contracts.ts          Zod schemas for inputs, outputs and structured agent results
  roster.ts             defineRoster (ADR 0063)
  prompts.ts            definePrompts index (ADR 0064)
  prompts/
    ReviewAgainstIssue.md
    _fragments/ReviewRules.md
  lib/                  optional shared TypeScript helpers
  resources/            optional static files
```

```ts
// package.ts
export default definePackage({
  root: import.meta.dirname, // the loader refuses a manifest whose root is not its own directory
  name: 'merge-down',
  version: '1',
  description: 'Merge a reviewed PR stack down to main.',
  whenToUse: 'A stacked PR has approvals and green checks.',
  workflows: [mergeDownPr, mergeDownStack], // imported definitions; names must be unique
  entry: mergeDownPr, // optional; the workflow `execute <dir>` runs
  prompts: [prompts], // prompt sets declared once for the package
});
```

- Module files are TypeScript (`.ts`, `.mts`, `.cts`). The loader does not accept `.js` or `.mjs` as
  a manifest or workflow module; JavaScript dependencies under `node_modules` are unaffected.
- A package is not a different programming model. Every workflow in it is an ordinary
  `defineWorkflow` that imports the package's roster, prompts and contracts, and a single-file
  workflow can use the same `roster` and `prompts` fields with an adjacent directory. The package
  adds a manifest, discovery, whole-directory fingerprinting and a conventional layout.
- `definePackage` takes `root` explicitly (`import.meta.dirname`), because a module cannot otherwise
  learn its own location at evaluation time, and the loader refuses a manifest whose declared root
  is not the directory it was imported from. It validates the name (`/^[a-z][a-z0-9-]{0,63}$/`), the
  version, that workflow names are unique, that `entry` is one of `workflows`, and the declared
  prompt sets (ADR 0064 checks). The returned value exposes `root` and `resource(relativePath)`,
  which resolves a path confined to `resources/`; both are usable during module initialization
  because the root is known at the call.

### 2. Loading and the CLI

- `workflow execute <dir>.quiet-choir` runs the entry; `--workflow <name>` selects another declared
  workflow. `validate`, `rehearse`, `check-resume` and `list-defs` take the same forms. Plans stay
  plain data (ADR 0001): the plan records the package root, the selected workflow name and the
  workflow module path.
- `launch.entrypoint` keeps recording the selected workflow module, so resume, fork and
  `check-resume` work as before, and `launch.package = { root, name, version }` is added so
  `inspect` and `list` can show the package.
- The typecheck entrypoint is the manifest, which reaches every workflow by import; the nearest
  tsconfig rule is unchanged, and a package may carry its own.

### 3. Discovery

The registry scans the given directories for `*.quiet-choir` directories as well as `*.workflow.*`
files. Each package contributes one entry per declared workflow, shown as `<package>/<workflow>`
with the package's description and `whenToUse` beside the workflow's own. By-name dispatch accepts
either spelling when unambiguous. The cache envelope version is bumped.

### 4. Fingerprinting

For a package run, `launch.sources` holds every regular file under the package root except
`node_modules/` and `.git/`, as path and SHA-256, in addition to compiler-discovered dependencies
outside the root. Prompts therefore need no separate handling inside a package. The ADR 0006 rules
apply to all of them: resume refuses drift without `--accept-code-change`, and completed steps keep
their own fingerprint checks. A package over a size threshold produces a warning naming the largest
files, since a large resource makes every resume hash it.

### 5. Validation output and agent-facing docs

`validate --json` gains a `package` section: name, version, workflows with their input schemas, the
roster summary from each workflow's manifest, the prompt inventory with parameter keys, and the file
count and aggregate digest. The skill reference gains a package authoring page, and the
`/quiet-choir:run` command accepts a package path.

## Alternatives

- **`info.yaml` manifest.** Rejected for this revision: the registry already imports modules to read
  metadata, a TypeScript manifest is typed and needs no YAML runtime dependency, and the choice is
  consistent with the roster and prompt indexes. A static manifest can be added later if tooling
  that cannot run TypeScript needs to read packages.
- **`.mjs` workflows inside packages.** Rejected: typed profiles, children and schema-inferred
  results are the engine's strength, and the legibility gain comes from moving prose and
  configuration out, not from dropping types.
- **Fingerprint only declared files.** Rejected for packages: a helper or resource the compiler does
  not see would otherwise drift silently. Declared-file fingerprinting remains the rule for
  single-file workflows with an adjacent prompts directory.
- **Archive formats.** Rejected: a directory of openable files is the point.

## Consequences

- New module area `src/workflow/package/` for `definePackage`, layout validation and resource
  resolution; loader, registry and the affected CLI commands learn package paths. `model.ts` changes
  only through ADRs 0063 and 0064.
- The acceptance test for this and the two preceding ADRs is porting `merge-down-pr` and then
  `execute-epic-ticket` from native scripts to packages and measuring lines and prose ratio against
  the originals. Expect one revision round of the roster and prompt APIs from that port.
- Package-local `node_modules` are outside fingerprinting, as today (ADR 0027), so a package should
  pin its engine version in its own `package.json` when it has one.
- A standard library of roster entries, higher-order patterns and common schemas is the natural next
  package consumer and gets its own record once the first ports show which pieces recur.
