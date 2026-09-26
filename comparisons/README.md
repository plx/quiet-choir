# Workflow Lab

[Open the privately published site](https://quiet-choir-workflow-lab.penguinamino.chatgpt.site).

Versioned before/after comparisons of Claude Code JavaScript workflows and direct Quiet Choir
TypeScript ports. Batch 01 contains all 26 workflows from
[ultracode-workflows at 9b5404d](https://github.com/hesreallyhim/ultracode-workflows/tree/9b5404d11b885b28380d3eb17471ef7b17601b5e/plugins/ultracode-workflows/workflows).

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
npx tsc -p comparisons/batches/01-direct-ports/tsconfig.json
node --import tsx comparisons/scripts/verify-ports.mjs
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
reader assets. It does not typecheck or execute ports. `npm run check` covers the main repository
quality gates; run the comparison commands above separately before submitting comparison changes.

The verification script compares outputs and prompt/reply sets against the actual original
JavaScript under deterministic, inert harness fixtures. It also tests completed-run reuse and
interrupted pipeline recovery through the real runtime. It never launches Claude, executes agent
commands, or changes a target repository. `verification.json` records the cases. Fixtures are not
live integration evidence and do not prove every branch or the quality of an agent's work. The
verifier rewrites that report; review and commit it with the batch. Its batch path, scenario inputs,
reply generation, and recovery case are specific to Batch 01, not a generic batch runner.

Batch 01 deliberately keeps legacy orchestration locals permissively typed (`noImplicitAny` and
strict null checks are disabled in its own tsconfig). Inputs and agent results have concrete Zod
schemas. The final result validator checks JSON compatibility, not its full domain shape; its
TypeScript annotation is inferred from the body. The main library retains its strict compiler
settings.

## Run a port

The ports import the private repository's built `quiet-choir` package. Build it first. For example,
this validates a port without invoking any agents:

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
Quiet Choir commit together with that batch's files and verification commands; rebuilding a newer
runtime does not reproduce the old target API. Record later API experiments as new batches.

The reader currently attributes all workflows to the Batch 01 upstream, and `license.txt` comes from
the first registered batch. Comparisons from a different upstream or license need corresponding
attribution and license-packaging changes before publication.

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
