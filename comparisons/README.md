# Workflow Lab

[Open the privately published site](https://quiet-choir-workflow-lab.penguinamino.chatgpt.site)
(existing access required), or build the local reader below.

Versioned before/after comparisons of Claude Code JavaScript workflows and direct Quiet Choir
TypeScript ports. Batch 01 contains all 26 workflows from
[ultracode-workflows at 9b5404d](https://github.com/hesreallyhim/ultracode-workflows/tree/9b5404d11b885b28380d3eb17471ef7b17601b5e/plugins/ultracode-workflows/workflows).

Batch 01 is the active regression suite for the current built runtime, not a frozen set of ports.
Its upstream originals remain immutable. The initial porting API is recorded in `apiSnapshot` at
`a6a7b82`, a commit reachable from `main`; the recorded model-file hash belongs to that baseline.
The suite now also uses the current `readRun({ runId, stateDir })` API in its recovery verifier.

The site is a reader, not an execution console. Every original is preserved byte for byte, with its
MIT license. Every port uses `ctx.claude` explicitly. The comparison layer adds no runtime APIs.

Choose a batch and workflow, then use **Source comparison** to compare the implementations, **Port
notes** to review preserved behavior and intentional differences, and **Shared support** to inspect
the helpers and compiler settings used by that batch. Copy buttons copy the full source for either
side.

## Repository layout

| Path                           | Role                                                                       |
| ------------------------------ | -------------------------------------------------------------------------- |
| `batches/index.json`           | Ordered list of batch directory IDs; the first is the default              |
| `batches/<id>/`                | Original snapshots, ports, metadata, attribution, and verification results |
| `scripts/verify-ports.mjs`     | Batch 01's deterministic differential fixtures and recovery check          |
| `scripts/build-site.mjs`       | Packages every registered batch and the static reader                      |
| `site/`                        | Authored HTML, CSS, JavaScript, and the durable Sites identity             |
| `../.context/comparison-site/` | Generated publishing checkout; ignored by this repository                  |

## Check and preview

From the repository root:

```sh
npm ci
npm run build
npm run comparisons:check
node comparisons/scripts/build-site.mjs
python3 -m http.server 4173 --directory .context/comparison-site/dist
```

Open http://localhost:4173. Workflow, batch, and selected view are preserved in the URL hash, so a
comparison can be bookmarked directly, for example
`#batch=01-direct-ports&workflow=bug-hunt&view=notes`. View IDs are `source`, `notes`, and
`support`. Serve the generated directory over HTTP; opening `index.html` as a local file cannot
reliably load its comparison data.

The builder validates original-source hashes and requires a summary note for each catalog entry. It
embeds source text, notes, catalog metadata, and shared support in `dist/data.json`, then copies the
reader assets. It does not typecheck or execute ports. `npm run comparisons:check` typechecks the
active batch and runs its fixtures in read-only `--check` mode. It is part of `npm run check` and
the CI quality job, after the build, because ports import the built package by name.

The verification script compares outputs and prompt/reply sets against the actual original
JavaScript under deterministic, inert harness fixtures. It also tests completed-run reuse and
interrupted pipeline recovery through the real runtime. It never launches Claude, executes agent
commands, or changes a target repository. `verification.json` records the cases. Fixtures are not
live integration evidence and do not prove every branch or the quality of an agent's work. The
verifier's `--check` mode fails if the report is missing or differs, without rewriting it. To update
expected results intentionally, run `node --import tsx comparisons/scripts/verify-ports.mjs`, then
review and commit `verification.json`. Its batch path, scenario inputs, reply generation, and
recovery case are specific to Batch 01, not a generic batch runner.

Batch 01 deliberately retains all seven migration relaxations in its own tsconfig:

- `noImplicitAny: false`
- `strictNullChecks: false`
- `exactOptionalPropertyTypes: false`
- `noUncheckedIndexedAccess: false`
- `noPropertyAccessFromIndexSignature: false`
- `noUnusedLocals: false`
- `noUnusedParameters: false`

Inputs and agent results have concrete Zod schemas. Final results check JSON compatibility rather
than a full domain shape; their TypeScript annotations are inferred from the bodies. The main
library retains its strict settings. Making the ports repo-strict is tracked in
[#65](https://github.com/plx/quiet-choir/issues/65): the initial audit found 273 diagnostics,
including 116 option-spread mismatches and inherited null/index crash paths. Fix the shared options
idiom first, then enable `strictNullChecks` and `noUncheckedIndexedAccess`; this landing does not
silently change the originals' behavior or hide those gaps.

## Regression and snapshot policy

An API change that breaks an active port must update that port and its verification report in the
same PR. Refresh `apiSnapshot.revision` and the matching API-file SHA-256 when the port's target API
changes. Use a durable commit containing that API, reachable from the default branch after landing;
do not leave metadata pointing only at a disposable, pre-squash head. The initial baseline above
remains accurate while these ports continue to use that model contract. The hash is provenance for
one file, not a claim that the entire running implementation is unchanged.

Keep Batch 01 gated while it is the active suite for runtime changes such as
[#44](https://github.com/plx/quiet-choir/issues/44),
[#45](https://github.com/plx/quiet-choir/issues/45), and
[#52](https://github.com/plx/quiet-choir/issues/52). When a later batch supersedes it, move
`comparisons:check` and its verifier to the newest batch in that PR. Older batches become historical
snapshots: reproduce them with their recorded runtime commit and matching batch revision, not by
rebuilding a newer runtime and assuming the results describe the old API.

## Run a port

The ports import this repository's built `quiet-choir` package. The repository is public; the
prototype package remains unpublished. Build it first. For example, this validates a port without
invoking any agents:

```sh
npm run cli -- workflow validate \
  comparisons/batches/01-direct-ports/ported/bug-hunt.workflow.ts
```

Execute through the existing `workflow execute` command when desired. Supply the original workflow
arguments as JSON plus an optional `$claude` object. It accepts `model`, `tools`, `allowedTools`,
`maxTurns`, `maxBudgetUsd`, and `timeoutMs`. The batch defaults to 40 turns, $5, and ten minutes
**per agent call**; built-in tools stay disabled unless explicitly enabled and allowed.
Tool-dependent workflows require suitable configuration. No workflow-level budget is implied.

The shared support files are displayed on the site as part of each comparison. They are local
adapters, not proposed additions to the runtime API. They provide stable scoped IDs, bounded
per-group fan-out, pipelining, and child composition. Agent failures remain native fail-fast
failures. Phases are metadata/stderr only; effort and the shared token ledger are unavailable.
Per-workflow notes describe these differences and source behaviors deliberately retained.

An SDLC human checkpoint is returned data. To supply new answers, start a **new run ID** with that
returned state and the answers as input. Use `--resume` only to retry an interrupted run with
unchanged input.

## Add a batch

1. Create a new directory under `comparisons/batches/`, such as `02-revised-api`; leave previous
   batches and their IDs intact. Use Batch 01's file shapes as the template. For an API comparison,
   keep the upstream originals fixed so differences isolate the Quiet Choir changes.
2. Store the pinned upstream `.js` files in `originals/`, preserve `LICENSE`, and record each file's
   SHA-256 in `source-hashes.json`, keyed by filename including `.js`. Do not format the originals.
3. Add `.workflow.ts` ports and their local helpers to `ported/`, plus a batch `tsconfig.json`. Keep
   workflow names stable across batches so switching batches retains the selected workflow.
4. Fill in `batch.json`: matching directory `id`, display `number`/`label`/`description`, upstream
   `revision`/`sourceUrl`/`sourceFileBase`, `commonChanges`, and an accurate `validation` statement.
   Record the target Quiet Choir commit in `apiSnapshot.revision`, its package version and API file,
   and that file's SHA-256. For the current API file, use
   `shasum -a 256 src/workflow/runtime/model.ts`. The file hash is not a full runtime fingerprint.
5. Add one `catalog.json` entry per workflow: `name` matching both source filenames, `description`,
   `whenToUse`, `phases`, argument `fields`, call-site `counts`, and `hasBudget`. These describe the
   source workflow; call-site counts are not the number of agents a run will invoke.
6. Add `notes.json`, keyed by workflow name, with `summary`, `preserved`, `changes`, and
   `evaluation`. Explain semantic differences, unsupported features, and fixture limits explicitly.
7. Typecheck with `npx tsc -p comparisons/batches/<id>/tsconfig.json` after building Quiet Choir.
   Adapt or add a verifier for the new batch's scenarios and API, run it, and save its
   `verification.json`. Merely running the existing verifier still checks only Batch 01. Update
   `batch.json.validation` from the actual results.
8. Add the directory ID to `batches/index.json`; put it first if it should be the default. Rebuild
   and preview Source comparison, Port notes, and Shared support for the new batch and an existing
   bookmark. New batches using the same source and data contract need no UI code changes.

Ports import the current checkout's built package. To reproduce a historical batch, use its recorded
Quiet Choir commit together with the matching historical batch revision and verification commands;
rebuilding a newer runtime does not reproduce the old target API. Active-batch maintenance follows
the regression policy above; comparisons of deliberately different APIs belong in new batches.

The reader currently attributes all workflows to the Batch 01 upstream, and `license.txt` comes from
the first registered batch. Comparisons from a different upstream or license need corresponding
attribution and license-packaging changes before publication.

## Site assets and publishing decision

The public repository retains the static reader, the private-site link, and
`site/.openai/hosting.json`. The link identifies an optional existing deployment that still requires
access; local preview is available to every reader. The manifest contains the existing project's
identity and static output path, not credentials. Keeping it preserves updates to the same Site
instead of accidentally creating replacements. No access setting changes or deployment are part of
landing the Workflow Lab.

The publishing procedure below is retained for maintainers. Its generated checkout is created by the
builder and stays under git-ignored `.context/`; it is not assumed to exist in a fresh clone. Public
source availability does not imply public access to the private deployment.

## Publish an update to the existing site

Commit the authored files under `comparisons/` and the root configuration changes to this
repository. The generated `dist/` and the Sites source repository stay under `.context/` and are not
part of the Quiet Choir PR. Editing or merging these files does not deploy the ChatGPT site; the
repository's GitHub Pages workflow publishes API documentation separately.

After verification, rerun `node comparisons/scripts/build-site.mjs`. It generates
`.context/comparison-site/dist` and automatically copies `site/.openai/hosting.json` into the
generated checkout. It refuses to overwrite a different Site identity. An optional output directory
can be passed as the script's first argument.

Use the Sites publishing workflow with that generated checkout as the project directory. Initialize
its own Git repository during publishing if needed, save a new version for the existing project, and
deploy that version with the existing private access setting. Keep its publishing Git remote
separate from this repository's `origin`. The builder prepares files only; it does not initialize
Git, upload, or deploy.

Reuse the `project_id` in `site/.openai/hosting.json` for every update, and verify the published
version and a bookmarked comparison after deployment. Do not create a new Site for each batch or
commit publishing credentials. The checked-in hosting manifest contains the Site identity and static
output path, not credentials.
