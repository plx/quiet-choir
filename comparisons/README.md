# Workflow Lab

[Open the privately published site](https://quiet-choir-workflow-lab.penguinamino.chatgpt.site)
(existing access required), or build the local reader below.

Versioned comparisons of the same pinned Claude Code JavaScript workflows and Quiet Choir TypeScript
ports. Batch 01 contains all 26 workflows from
[ultracode-workflows at 9b5404d](https://github.com/hesreallyhim/ultracode-workflows/tree/9b5404d11b885b28380d3eb17471ef7b17601b5e/plugins/ultracode-workflows/workflows).
Batch 02 rewrites six of them around code-owned effects, named profiles, isolated writers, settled
panels and inline children. Both batches preserve the original source bytes and license.

**Batch 02 is the active primitive regression suite and the reader default.** Batch 01 is retained
as its historical comparison baseline. This transition also makes all 26 Batch 01 ports compile
under the root settings: all seven former compiler relaxations are gone. Its shared `callOptions`
helper omits undefined option fields, and typed composition/indexing fixes replace local casts. The
initial audit counted 273 errors; the pre-#65 audit against the expanded API counted 396; there are
now zero. Those historical counts describe different snapshots.

Batch 01 retains its loose final JSON schemas and source-style orchestration. It has 70 fixtures: 61
differential cases, six durable-question contracts, two intentional inherited-crash corrections, and
one interrupted pipeline. The added cases reproduce the originals' missing
`dependency-upgrade.failures` and empty `api-migration.files` TypeErrors, then verify the corrected
port behavior. Per-workflow notes disclose additional defensive guards and missing-credibility
ordering; the original snapshots are never edited to manufacture equality. Its shared helpers
forward to `ctx.phase` and `ctx.log`, and its legacy context forwards `worktree`/`merge` alongside
durable commands, files, waits, `ask`/`approve` and `value` overloads; the recovery verifier
inspects saved runs through `readRun({ runId, stateDir })`.

Batch 02 has real input/output schemas and root-strict types. Its
[notes](batches/02-idiomatic-ports/notes.json),
[verification](batches/02-idiomatic-ports/verification.json) and
[paired metrics](batches/02-idiomatic-ports/metrics.json) distinguish measured orchestration from
unmeasured model quality. Both sides use inert harness replies. Temporary Git repositories, command
exit codes, file writes and SIGKILLs are real. F1–F5 record final status, repeated calls, filesystem
state and whether the final output admits degradation. F4 changes one wrapper statement and uses
explicit source acceptance through the embedding API. F5 uses actual inbox answers, plus a Batch 02
SDLC CLI exit-75 check. Read-only workflows mark write-effect crashes not applicable.

The main count is Prettier-formatted entrypoint lines, excluding shared helpers/children; shared
code is visible in the reader. Agent-call counts are fixture-path observations, **not measured cost
or quality savings**. Batch 01 receives its historical global read/write/command tool input; Batch
02 uses per-role privileges. The focused test-gap port takes an operator-selected target and test
command, and the lifecycle children are compact rewrites. These interface/scope differences are
explicit in the notes and limit direct comparisons of call counts.

## Build and verify locally

```sh
npm ci
npm run build
npm run comparisons:check
node comparisons/scripts/build-site.mjs
python3 -m http.server 4173 --directory .context/comparison-site/dist
```

Open `http://localhost:4173`. The builder checks pinned source hashes and required metadata, embeds
both batches and copies the static reader. It does not execute ports, upload or deploy anything.
`comparisons:check` compiles both batches under root settings, verifies the Batch 01 baseline and
runs the Batch 02 paired fault suite in read-only `--check` mode after the package build. It is part
of `npm run check` and the CI quality job. The fixture suite needs local Git and process identity
inspection; it uses no native model CLI, credentials, network or paid inference.

Regenerate reports only for an intentional change, then review their diffs:

```sh
node --import tsx comparisons/scripts/verify-ports.mjs
node --import tsx comparisons/scripts/verify-idiomatic-ports.mjs
```

## Regression and snapshot policy

A PR changing a primitive exercised by Batch 02 must update the matching port, port notes and fault
row in the **same PR**, even when the API still compiles. The mapping is:

| Primitive                                                       | Acceptance port                |
| --------------------------------------------------------------- | ------------------------------ |
| Commands/files, schema-first values (#58, #52)                  | release-notes, test-gap-filler |
| Questions, isolated integration, roles (#55, #59, #45)          | project-bootstrap              |
| Codex structured output and restricted reads (#35, #60)         | incident-investigation         |
| Inline children, scoped IDs and stage decisions (#63, #44, #55) | sdlc-orchestrator              |
| Settled maps, admission limits and usage gates (#42, #47, #62)  | bug-hunt                       |
| Accepted-code replay (#41)                                      | Every F4 row                   |

Refresh `apiSnapshot.revision` and the API-file SHA-256 when the target API changes. Use a durable
commit containing that API, reachable from the default branch after landing; replace a disposable
pre-squash reference after landing if necessary. The hash identifies one API file, not the entire
runtime. Reproduce an older report using its recorded runtime **and matching batch revision**. Batch
01 stays compiled and checked as the paired baseline; future primitive acceptance belongs to
Batch 02. Further intentional API/idiom comparisons belong in a new numbered batch.

## Run a port

The ports import this repository's built `quiet-choir` package. The repository is public; the
prototype package remains unpublished. Build it first. For example, this validates a port without
invoking any agents:

```sh
npm run cli -- workflow validate \
  comparisons/batches/02-idiomatic-ports/ported/bug-hunt.workflow.ts
```

For Batch 02, validate first, provide the described required input and grant only roles that write.
A bootstrap launch needs `--grant writer`; its plan approval is a separate durable question. The
source repository must have committed history and a clean checkout for isolated publication. Run
state and worktree caches should remain outside the source checkout. Ordinary commands execute with
the operator's privileges; the plan displays agent-proposed argv commands before approval.

For a bounded read-only hunt:

```sh
npm run cli -- workflow execute \
  comparisons/batches/02-idiomatic-ports/ported/bug-hunt.workflow.ts \
  --run-id hunt --input '{"scope":"src/","maxRounds":2}' \
  --max-agents 3 --max-run-cost-usd 5 --max-run-agent-attempts 30
```

Cost gates use available reported usage, including failures; unknown costs remain unknown and
already admitted work may overshoot. Resume a budget-stopped run with a higher cap. A suspended
approval/stage gate exits 75: inspect `workflow pending`, answer its exact step with
`workflow answer ... --by human:<name>`, then resume the **same run ID**. Bootstrap reuses the saved
plan; SDLC passes a redo answer only to the requesting stage and its new round.

Batch 01 preserves its optional `$claude` input (`model`, `tools`, `allowedTools`, `maxTurns`,
`maxBudgetUsd`, `timeoutMs`) and `strictProfiles: false`. Tools are disabled by default; tools imply
allowedTools unless narrowed, and elevated raw tools require write/exec/all launch grants. Its 68
original per-call effort choices are supported. Use named roles for new workflows. The local support
files shown in the reader are batch helpers, not additions to the runtime API.

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
