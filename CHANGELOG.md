# Changelog

## Unreleased — 0.0.0 prototype

- Run and delivery state in `workflow pending`, and structured `answer.invalid` issues (behavior
  change in the default `workflow pending` listing; no identity or checkpoint format change):
  `pending` now hides rows whose answer is already queued and rows of `failed`, `cancelled` or
  `completed` runs, and the result adds `hidden`, the count it left out; the new `--all` lists every
  row. Each row gains `runStatus`, `delivery` (`{state: 'none' | 'queued', at, by}`, null for a poll
  or deadline wait) and `next` (a `resume` entry repeating the run's launch policy for a queued row
  of a suspended or failed run, otherwise empty). Running rows stay listed, so a `--wait-mode block`
  question is visible. `listPending` still returns every row, now typed `PendingListing`
  (`PendingOperation` plus `PendingRunState`, with `PendingDelivery`); `SuspendedRun.pending` is
  unchanged. `AnswerError` gains `issues` (new public type `AnswerIssue`: `{code, path, message}`),
  and `answer.invalid` carries it as `error.details.issues`, with `path: ['approved']` for a
  non-boolean `approved` and the synthetic codes `answer_not_json`, `question_schema_invalid`,
  `answer_author` and `answer_too_large` (path `[]`) for refusals with no schema location. Its
  message is now one line.
- Recovery hints by typed cause (behavior change in `recoveryHint` and failure messages; no identity
  or checkpoint format change): the saved `recoveryHint` now follows the failure's typed cause
  instead of always advertising `--resume --accept-code-change`. A missing grant suggests
  `--resume --grant <profile>`; a replay divergence names a value computed in the body (use
  `ctx.now` or `ctx.step`), `--fork-from` and `--resume --strict-replay`; a configuration or
  authoring failure keeps the re-finalize text when all recorded work is terminal and otherwise
  suggests fixing, then resuming; an effect failure or a cancellation gets a new plain-resume hint,
  which the CLI appends to `workflow.failed` messages. A run that recorded no step or map, and any
  dry-run, gets no hint, and the CLI no longer appends a run's saved hint to a refusal such as
  `run.incompatible`. `hasTerminalOutcomes`, and so check-resume's `refinalizable`, is false for a
  failed run with nothing recorded. `RootCause` (public type) gains an optional `effect`, the root
  step's call-site effect kind, so `WorkflowRunError` names it (for example `(claude)` or
  `(read-file)`) instead of `(unknown)` when the failing step has no record; older records still
  load. See the [ADR 0006 amendment](docs/decisions/0006-code-change-recovery.md).
- `errorKind` and `retryable` in failure output (additive; no identity or checkpoint format change):
  `rootCause` gains an optional `errorKind`, the root effect's classified kind, null for a body
  failure or interruption. Failure documents add `errorKind` and `retryable` to each `failedSteps[]`
  entry, and `error.details` is `{ errorKind, retryable }` for `workflow.failed` instead of null.
  `retryable` is true for `rate-limit`, `overloaded` and `timeout`, the set
  `retry.on: ['transient']` stands for. The compact run result's `rootCause`, the
  `inspect --summary` rootCause and its step rows carry the kind, and the text view prints
  `[<kind>]` and `Root cause (step, kind)`. Records written before this change still load, inspect
  and resume; summaries fall back to the root step's last attempt, and the stored record is not
  rewritten. `RootCause` (public type) gains the optional field.
- Failure kinds and a transient retry alias (behavior change for `retry` without `on`; no identity
  or checkpoint format change): `ErrorKind` gains `invalid-request` (HTTP 400/404/422, an unknown
  model or an invalid effort or option) and `overloaded` (HTTP 500/502/503/529). `retry.on` accepts
  `'transient'`, which stands for `rate-limit`, `overloaded` and `timeout`, in code, adapter
  definitions, run options, `--policy` rules and saved policies; it is a filter, never a saved kind.
  A `retry` with `on` omitted no longer retries `invalid-request` failures (it still retries
  `unknown`, `overloaded`, `process` and the other non-fatal kinds); list `invalid-request` to keep
  retrying it. `ProtocolFailure` gains an optional adapter-owned `kind`, and `HarnessError.kind`
  takes `HarnessErrorDetails.kind`, then `failure.kind`, then the HTTP status. The built-in Codex
  protocol layer classifies Codex's own `rate limit exceeded` terminal errors and rate-limit
  reconnect notices as `rate-limit` and `invalid_request_error` as `invalid-request`; Claude Code's
  `[claude-code:unrecognized_model]` stderr tag also gives `invalid-request`. The checked-in
  captures now record their kind, plus two synthetic Claude 500/529 captures. Old records still
  validate; records with the new kinds or the alias need this runtime. See the
  [ADR 0007 amendment](docs/decisions/0007-durable-failure-outcomes.md).
- `workflow events` and the `/quiet-choir:run` Claude plugin command (additive command and plugin
  file; no identity or storage change): `workflow events RUN [--follow]` prints a run's `--events`
  lines derived from its persisted record, without importing the workflow, through the same
  formatter as `--events` (one line shape, at most 512 bytes). It covers run lifecycle, phase and
  log entries, settled attempts (`step.completed`, `step.failed`, `step.settled`) and opened
  questions; fields the record cannot supply are omitted, and `ms` is the recorded duration. Lines
  are deduplicated by identity, so the 500-event cap neither repeats nor hides newer lines, though a
  very long run can evict phase and log payloads before a slow follower reads them. `--follow`
  starts at the current end (`--from-start` replays the record first), exits with the watch codes
  (0, 1, 75, 130, 3) and accepts the watch's `--interval`, `--timeout` (79) and `--wait-created`
  (66); `--after-execution N` waits for a later execution, for following a resume. `watchRun` gains
  an optional `done` predicate. The Claude plugin adds `commands/run.md`, which rehearses, launches
  with `run_in_background`, follows with Monitor and answers questions; its manifest description now
  names the command. `skills:check` validates `commands/*.md` (frontmatter, links, fences, no
  `$ARGUMENTS` in shell fences) and lets the two manifests differ in `description` only, and the
  skills smoke runs every command shell block. The Claude skill's answer loop now lists questions
  with `workflow pending`, because the watch snapshot has no `pending[]`. See
  [ADR 0038](docs/decisions/0038-code-free-event-follower.md).
- Compact event stream (additive flag; no identity or storage change): `--events FILE|-` on
  `workflow execute`, `start`, `resume`, `tick` and `answer --resume` appends one JSON line per
  `run.*`, `step.completed`, `step.failed`, `step.settled`, `wait.opened`, `phase` and `log` event,
  shaped `{t, run, ev, step, attempt, harness, ms, costUsd, phase, msg}` with absent fields omitted,
  `msg` truncated near 200 bytes and every line at most 512 bytes. Replay echoes are dropped, so a
  resume that appends to the same file adds only new transitions. The file is created owner-only and
  flushed per line, so `tail -F | grep --line-buffered` sees a line as soon as it is emitted; an
  open or write failure is one warning and never changes the outcome or exit code. The flag is not
  saved with the run. `--events -` writes the lines to stdout and moves workflow console output and
  the human result to stderr; this redirect happens only when the flag is used. `--events -` with
  `--json`, and `workflow start --events -`, are refused with `usage.flag` (exit 2). The Claude
  skill's background section becomes "Drive a run from Claude Code": `start --events` plus a bounded
  watch under `run_in_background`, a Monitor filter on the events file, and the answer loop on
  exit 75. See [ADR 0037](docs/decisions/0037-compact-event-stream.md).
- Bounded `inspect --watch` (additive flags; two new error codes; one small contract change):
  `--timeout DURATION` stops a watch whose run is still running that long after the first successful
  read, with the new code `watch.timeout` (exit 79), the last observed `status` (`running`) and
  `details.timeoutMs`; the run keeps running. `--wait-created DURATION`, measured from the start of
  the watch, retries a missing record until the first read and then fails with the new
  `watch.record_not_created` (exit 66, `status: null`, `details.waitCreatedMs`); a record that
  disappears after it was read is still `run.not_found` (exit 3). Both take `ms`/`s`/`m`/`h`
  durations and are opt-in, so existing watches behave as before. `--final` prints only the final
  snapshot, or only the error document. The public `CliErrorCode` type gains both codes. 79 is the
  first exit after the sysexits block; 66 is `EX_NOINPUT`. Contract change: with `--summary`,
  `inspect` error documents (including an interrupted watch's) carry the compact `summary` instead
  of the whole `run`. The `--watch` help and docs now list suspended (75), and the Claude skill
  shows a background launch with `run_in_background` and a bounded `--final` watch.
- `workflow start` (additive command; two new error codes): `workflow start FILE [execute flags]`
  launches `workflow execute` as a detached runner and returns once the run's record exists and is
  owned by that runner, with
  `{kind:"workflow.start.result", ok, exitCode, runId, stateDir, pid, status, log, result, next}`.
  It generates the run ID when `--run-id` is absent. The runner's result document and log are kept
  owner-only in `<stateDir>/<runId>/launch/<n>.result.json` and `<n>.log` (and `--input -` in
  `<n>.input.json`). A failure before the record exists returns the runner's error and exit code
  with `runId: null` and a new `launch` field (`{runId, pid, log, result, exitCode, signal}`); an
  existing run is refused with `run.exists` before launching. `--start-timeout` (default 60s) bounds
  the wait: start then stops the runner and fails with the new code `start.timeout` (exit 124); a
  runner that exits without a record or a readable document is the new `start.exited` (exit 70). The
  public `CliErrorCode` type gains both. The skill golden path shrinks to `cd`, `validate`, `start`
  and `inspect`. See [ADR 0036](docs/decisions/0036-detached-start.md). Fix: in development mode
  (`npm run cli:dev`) emitted commands now carry the detected `[node, tsx flags, bin/dev.js]`
  launcher instead of falling back to `quiet-choir`, because the detected launchers are now shared
  with the command modules that oclif loads as a second module instance.
- Sticky launch policy (one contract change; additive storage field, no identity or format change):
  each execution records `launch.policy` — the harness kind, each `--harness` fixture file by
  absolute path with its SHA-256, and the wait mode — and never any `--harness-config` value.
  Contract change: `resume`, `execute --resume`, `answer --resume` and `tick` without `--harness`
  now use the run's recorded harness kind and fixtures instead of `cli`, and without `--wait-mode`
  its recorded wait mode; explicit flags replace the recorded values. A recorded fixture that is
  gone fails with `usage.flag`; a changed one is used with a warning. `resumeCommand` and every
  `resume` entry of `next` end with `--harness fixture:<abs>`, `--harness <name>=fixture:<abs>` and
  `--wait-mode block` as recorded. New flags: `workflow tick --harness` (repeatable) and
  `answer --wait-mode`. Tick still suspends waits, now without changing a run's recorded mode. Runs
  recorded by older builds resume as before. New public type `LaunchPolicy`. See
  [ADR 0035](docs/decisions/0035-sticky-launch-policy.md).
- Runnable emitted commands (one contract break and one exit-code change; no identity or
  storage-format change): `resumeCommand`, `answerCommand` and the divergence fork command in
  `error.details.next` now start with the launcher of the invocation that produced them. An
  installed `quiet-choir` on PATH stays `quiet-choir`; the no-install
  `node "$QC_CHECKOUT/bin/run.js"` mode, npx and `node_modules/.bin` shims emit
  `[node, /abs/bin/run.js, "workflow", …]`, so the commands run from any directory without
  `quiet-choir` on PATH (argv[0] changes for those modes). Embedders keep `['quiet-choir']` unless
  they pass the new public `RunOptions.commandLauncher` or `listPending({commandLauncher})`
  (`CommandLauncher` and `ListPendingOptions` types). Commands are computed per invocation and never
  saved. Additive: every failure document has a top-level `next` array of `{why, argv}` follow-ups
  (empty when there is none): resume a failed run, resume with `--kill-orphans` after `run.orphans`,
  resume with `--accept-code-change` or fork after `run.incompatible`, inspect a `run.not_found`
  candidate; `inspect --json --summary` adds `next` for failed, stale and suspended runs; text
  inspect and human failures print `Next:` lines. `run.not_found` adds `details.candidates`
  (`{stateDir, cwd}`, at most 10): registered project roots, their legacy locations and the current
  directory's ancestors that hold the run, so `inspect RUN` from a project subdirectory names the
  exact `--state-dir`; state-directory resolution is unchanged. Exit change: `workflow resume RUN`
  (or `execute --resume --run-id` without FILE) whose stored entrypoint no longer exists is now
  `run.incompatible` (exit 3, `details.reason:"entrypoint_missing"`) instead of `usage.flag` (exit
  2). `npm run skills:check` rejects a skill shell fence line that starts with bare `quiet-choir`
  unless the fence is annotated `<!-- skills-check: installed-mode -->`.
- Inspect, list and validate output (two contract breaks; no identity or storage-format change):
  `workflow list --json` rows are now compact (`id`, `workflow`, `status`, `recordedStatus`,
  `counts`, `updatedAt`, `ownership`, `nextWakeAt`, `cwd`, `stateDir`, `warnings` and a `usage` of
  `attempts`, `costUsd`, `inputTokens`, `outputTokens`, `unknownTokenAttempts` and
  `unknownCostAttempts`), about 1 KB per run instead of every step; `--full` (with `--json`)
  restores whole run summaries. `workflow validate --json` and `workflow list-defs --json` omit
  every `harnesses[].options` JSON Schema, at every depth of `children`, which was about 8.5 KB of a
  12 KB document for the golden-path workflow; `--harness-schemas` (with `--json`) restores them.
  The definition registry cache is unchanged; the schemas are dropped when printing. Additive:
  `inspect --json --summary` (and watch snapshots) gain `output`, the workflow's output for a
  completed run and null otherwise, and `agents` (`total`, a `byRequest` roll-up by requested
  harness, model, effort and profile, and the last 50 calls as `recent`; the model is the requested
  one, never assumed effective). The public `UsageTotals` type gains `unknownTokenAttempts`, the
  attempts without an input or output count. Text changes: a completed command prints as one line
  (`completed ID  git status  2s`) without cwd or absolute argv, and `-v`, failed, running and
  waiting commands keep the two-line form; the summary lists agent calls (the last 20 completed ones
  unless `-v`); and the usage headline now says
  `(tokens complete; cost unreported for K/M attempts)` when only cost is missing,
  `(partial; N/M attempts without token usage)` when tokens are missing, instead of
  `attempts missing usage` for both.
- Run command results (contract break; no identity or storage-format change): `workflow execute`,
  `resume` and `answer --resume` print a bounded result with `--json` instead of the whole run
  record. Success is
  `{kind:"workflow.run.result", ok:true, exitCode:0, runId, stateDir, status, output, usage:{costUsd, attempts, undercounted}, counts, rootCause, warnings}`
  (`warnings` capped at 20 plus an overflow note). The suspension document (exit 75) and the failure
  document carry the same projection under a new `summary` key and no longer carry `run`; the
  suspension keeps `pending[].answerCommand` and `resumeCommand`. A new `--full` flag on the three
  commands restores the earlier documents with `run`, and success as `{...run, stateDir}` with no
  `kind` or `ok`. `answer --resume` success now includes `stateDir` (and is the same
  `{...run, stateDir}` under `--full`). The `answer.invalid` document drops from about 20 KB to
  about 1 KB. Scripts that read `steps`, `executions` or `run.*` from these commands must pass
  `--full` or use the envelope or `workflow inspect`. Unchanged: `execute --dry-run` documents, the
  `workflow.answer.result` success document of `answer` without `--resume`, human output, and the
  failure documents of every other command. The failure documents of `answer` without `--resume`
  (including `answer.invalid`) are compact unless `--full` is given. See ADR 0034.
- Capability manifests (behaviour change; no identity or storage-format change): checkpoints,
  `workflow validate --json` and the record `check-resume` prints no longer contain Claude
  `settings`, `mcpServers`, `agents` (descriptions and prompts), `systemPrompt`,
  `appendSystemPrompt` or Codex `config` values. Each is listed under the profile's new optional
  `redacted` member as `{ sha256, keys? }` (top-level names for objects, digest only for prompts),
  like `env` already was. Live calls, grant pins and step identity use the raw values, so existing
  pins and resumes are unaffected and a changed value is still detected. `extraArgs`, tools, plugins
  and other reviewable controls stay plaintext; never put secrets in `extraArgs`. Older checkpoints
  keep what they saved until the run next executes, which rewrites its manifest, and the definition
  registry cache is rebuilt once. New exported type `RedactedControl`. See ADR 0033.

- Worktree administration (behaviour change; no identity or storage-format change): Git
  `worktree add`, `list` and `remove` (and the interrupted-registration repair) are now serialized
  per repository across processes, not only within one process. Each command takes a new lock
  directory, `<common Git dir>/quiet-choir/worktree-admin.lock`, inside the repository's common Git
  directory, so `workflow clean`, live runs and runs from different linked checkouts or state
  directories no longer race on Git's worktree metadata. The lock reuses the run lock's crash-atomic
  protocol: a dead owner's lock is recovered automatically and a live owner is waited on until
  cancellation. An owner on another host, or one whose liveness or metadata cannot be verified,
  fails the attempt after about 30 s with the lock path to remove. Git commands run outside
  quiet-choir are not serialized. See ADR 0032.
- Child frames (behaviour change; no identity change): a successful completion now marks every child
  frame it never reached that is still `running`, `suspended`, `failed` or `cancelled` with the new
  terminal status `superseded`, like unvisited unfinished steps. `finishedAt` is the supersession
  time and an earlier `error` is kept (a frame without one gets a supersession note). Before, such a
  frame kept its stale `failed`/`cancelled` status, or was marked `cancelled` with "Root workflow
  completed without awaiting this child frame." although the body never invoked it. That
  cancellation now applies only to frames the completing execution invoked but did not await. A new
  `child.superseded` event follows `run.completed` for each retired frame, and `inspect` shows the
  status in the workflow tree. Skipped frames that hold a completed step, and skipped completed
  frames, still fail the run unchanged. Supersession happens last and is undone if the completion
  checkpoint fails. A resume that changes the identity of a failed, cancelled or superseded frame is
  still refused, and the message now says to keep the identity and resume with
  `--accept-code-change`. Storage stays format 7; an older build cannot read a record that contains
  a superseded frame.
- Fixture export (fix; no identity change): `workflow fixtures` now exports settled agent failures
  (`onError: 'return'`) as `error` rules, interleaved with the completed outputs in execution order,
  instead of dropping them, so replaying an exported run no longer fails with
  `No fixture matches step`. The text is the recorded message (never empty; a redundant
  `Step <id>: ` prefix is stripped, so export, replay and export again are stable). On replay the
  step settles with kind `unknown`; the original kind and attempt count are not preserved. Runs with
  no settled agent failures export exactly as before.
- Codex schemas (fix; earlier local error): `checkCodexSchema` has a new rule, `untyped`, for any
  schema node with no `type`, `anyOf`, `oneOf`, `allOf`, `$ref`, `const` or `enum`, which is what
  `z.unknown()`, `z.any()`, `z.never()` and the JSON Schema `true` produce. Codex rejects these
  (probed with codex-cli 0.157.1 as an object property and as a record value). Both
  `structuredOutput` modes now reject them before launch, for properties, array items, record values
  and the root, with the original schema path and a fix (give the value a concrete type, or request
  a `z.string()` and parse it locally), instead of failing inside Codex with an opaque exit code.
  Loose and `catchall` objects are unaffected (strict reports `open-object`; compat still closes
  them), and enum-only nodes such as `z.literal(['x', 1])` and `z.json()` are not flagged. Workflows
  that already failed at Codex now fail at plan time, including in dry runs. No identity change.
- Harness configuration (fix; resume refusal): every live CLI execution now records
  `harness.configDigest`, a SHA-256 of its resolved CLI harness configuration (binary paths, output
  limits, `scrubEnv` and `harnesses.<name>`), never the values, using the same canonical digest as
  environment summaries and step identities. `workflow resume`, `execute --resume`,
  `answer --resume` and `tick` compare the configuration they supply (an omitted `--harness-config`
  means the defaults) and refuse a mismatch with `run.incompatible` before changing the checkpoint,
  with `previousConfigDigest` and `requestedConfigDigest` in the details; tick reports the run as
  `incompatible`. So a tick no longer silently resumes a run started with custom binaries under the
  defaults. The new `--allow-harness-config-change` flag on execute, resume, answer and tick accepts
  the change; on tick it applies to every resumed run. `killGraceMs`, fixtures and the harness
  selection are not digested, a kind change stays governed by `--allow-harness-change`, and dry runs
  and embedders' own harnesses supply no digest (new optional `RunOptions.harnessConfigDigest` and
  `allowHarnessConfigChange`). Records without a digest stay resumable and adopt the next one.
  Additive and optional; no `formatVersion` bump.
- Identity gate (test and diagnostics; no identity change): `test/schema-identity.test.ts` pins the
  literal `schemaJson` encodings of a schema corpus, the built-in result schemas and the
  agent-result identity wrapper (new internal `agentResultIdentitySchema`, extracted from the
  runner), plus the `agentIdentity` digests that go through it, so a zod or tsx bump that would
  strand completed steps fails CI with a message pointing at ADR 0005, ADR 0006 and the durability
  reference. Run records now also list the installed `zod` and `tsx` versions in the informational
  `record.engine` (additive and optional, outside identity and `workflow.identity.engine`; no
  `formatVersion` bump), and a completed run resumed under other versions only refreshes that
  metadata. No digest moves.
- Guard identity (fix; identity change): `guardFile` baseline and restore steps are fingerprinted on
  a versioned guard identity (`guardFile/1`, path, `maxBytes`, and the baseline blob, mode and ref)
  instead of `process.execPath` and the inline guard program text, so a Node or quiet-choir upgrade
  no longer strands a resumed run. The real argv is still executed and recorded. A resumed run whose
  `guard/baseline` completed under an earlier build refuses once with `command, helper changed` and
  needs a new run. Other exec steps keep their digests; no `formatVersion` bump.
- Built-in step identity (fix; identity change): `ctx.now` and `decision.choose` steps are
  fingerprinted on an explicit version (`now/1`, `decision/1`) instead of the text of quiet-choir's
  own callback, so refactoring quiet-choir or changing the loader no longer strands a resumed run. A
  resumed run whose `ctx.now` step completed under an earlier build refuses once with
  `callback, version changed on a completed step`, and one whose `decision.choose` completed refuses
  once with `callback changed on a completed step`; either needs a new run or a fork
  (`--fork-from RUN --reuse matching --invalidate STEP`). Unfinished steps adopt the new identity.
  User `ctx.step` identities and all other digests are unchanged, and
  `test/builtin-identity.test.ts` pins the new digests. No `formatVersion` bump.
- Harness isolation (feature; the default is unchanged): Codex calls accept
  `instructions: 'native' | 'none'` (new `CodexOptions.instructions`). `'none'` runs the child
  against a private temporary `CODEX_HOME` holding only a 0600 copy of the real `auth.json` and adds
  `--config project_doc_max_bytes=0`, so neither the user's nor the project's `AGENTS.md`, user
  skills or memories reach the request (asserted in the isolation contract on codex-cli 0.157.1). A
  token refreshed during the call is written back to the real `auth.json` atomically under a lock in
  `os.tmpdir()`, only while the real file is unchanged; otherwise the later `last_refresh` wins and
  the call warns, naming paths and never contents. The private home is removed after success,
  failure and cancellation. `'none'` is rejected with `isolation: 'inherit'`, owns the
  `project_doc_max_bytes` config key, and is rejected for Claude. It is not a capability control, so
  call sites may set it under `strictProfiles`. `'none'` enters step identity; `'native'` and unset
  fingerprint as before, so existing runs keep their identities. Plans carry the new optional
  `CliArgumentPlan.codexHome: 'private'` (shown in dry-run call plans), Codex steps record the new
  optional `RequestSummary.instructions`, and `workflow inspect` shows `no native instructions`. The
  additive record field needs no `formatVersion` bump. The run's user-level instruction warning now
  ends with a hint to set `instructions: 'none'`. See ADR 0031.

- Harness isolation (behavior change, diagnostics only): restricted Codex still loads the user's
  `CODEX_HOME/AGENTS.md` (or `AGENTS.override.md`), the descriptions of `CODEX_HOME/skills`, and
  project `AGENTS.md`/`AGENTS.override.md` from the Git root down to `cwd`, while restricted Claude
  suppresses both. Codex `HarnessMetadata` now carries the new optional
  `HarnessMetadata.instructionSources` (new public type `InstructionSource`: `scope`, `kind`,
  absolute `path` and `sha256`, never contents), recorded in the run record on the first live Codex
  call of each run whatever its isolation mode. The run records one warning in `harnessWarnings`
  naming the user-level files, and a resume adds
  `codex instruction sources changed since this run last used it` when their digests differ. This is
  diagnostics: it never enters step identity, so no completed work is invalidated.
  `workflow doctor`'s inherited-defaults check no longer says restricted calls ignore user
  configuration; it states what restricted mode skips and still loads, names the user-level files it
  finds, and stays passing. `DoctorReport.codexInstructions` lists them. The additive record field
  needs no `formatVersion` bump. `docs/harness-isolation.md` and both skill copies now state the
  Codex instruction boundary, and the opt-in isolation contract records which canaries reach the
  request. The 0.157.1 rules are modelled for defaults only; inherit-mode config keys such as
  `project_doc_max_bytes` are not.

- Waits (feature; the default is unchanged): a poll may set
  `onError: { tolerate, classify?, retryAfterMs? }` to tolerate up to `tolerate` consecutive
  observation errors (rejections and `observeTimeoutMs` expiries) instead of failing the wait. A
  tolerated error counts as a check, keeps the note, and is recorded as the new optional
  `WaitRecord.lastError` (`{ message, consecutive, at }`), shown as `PendingWait.lastError` (null
  when absent) by `workflow pending` and its `--json`. A success clears it, the count persists
  across resumes, and the deadline still wins. Run cancellation, context-operation violations, wrong
  result shapes, terminal schema failures and note errors are never tolerated. `onError` is policy,
  not wait identity, so existing polls keep their identities. Observers now receive
  `PollContext.previous` (`note`, `checks`, `openedAt`, as persisted before the check), so debounce
  state survives suspend and tick. New public types: `PollContext`, `PollErrorPolicy`, `WaitError`.
  The additive `lastError` field needs no `formatVersion` bump, following `waitWarnings` and
  `interruptedBy`: an older build that rewrites the record drops it, losing only the diagnostic and
  resetting the consecutive count. The polling recipe tolerates a briefly missing status file and is
  now version `'3'`.

- Waits (behavior change): each poll observation now gets its own `signal`, which aborts when the
  run is cancelled or interrupted, when the wait deadline passes during the observation, and when
  the new `PollSource.observeTimeoutMs` elapses (a positive integer, default 60 s, never past a
  deadline still ahead). A deadline during an observation resolves the wait by `deadline` with the
  last note; an `observeTimeoutMs` expiry before the deadline fails the wait like a thrown observer,
  with an error naming `observeTimeoutMs`. An observation slower than 60 s, with more than 60 s left
  before the deadline or in an unbounded `ctx.wait`, used to succeed and now fails; raise
  `observeTimeoutMs` for it. The final check after a missed deadline is bounded the same way and
  resolves by `deadline` if it does not finish. An observer that ignores its aborted signal is
  abandoned after a 2 s grace, also when the run closes or is interrupted, so it no longer blocks
  interruption or lock release; the run records the warning in the new optional
  `RunRecord.waitWarnings`, which the completed result's `warnings` and `inspect` include.
  `observeTimeoutMs` is policy, not wait identity: it is not persisted and may change on resume.

- CLI: `--resume --accept-code-change` (on `execute` and `resume`) no longer destroys a run when the
  edit changed a completed step. It first replays the accepted body against a disposable copy of the
  record, with fixtures disabled and every unfinished local step, file effect, poll observer and
  command stubbed. If the copy meets a completed or settled-failed step whose identity changed, the
  command refuses with `run.incompatible` (exit 3) and leaves status, fingerprint, output,
  `codeChanges` and waiting questions unchanged. `error.details.divergent` is
  `[{ stepId, components }]` and `error.details.next` holds the argv
  `quiet-choir workflow execute FILE --fork-from RUN --reuse matching --invalidate STEP --run-id <NEW_RUN_ID> --state-dir DIR`,
  also named in the message. Other preflight outcomes let the resume proceed; the workflow body (not
  its unfinished callbacks) runs one extra time. `execute --dry-run --resume --accept-code-change`
  returns the same code and details. The plain-resume and check-resume messages point at that
  preview and, for a completed run, list `--fork-from` before `--accept-code-change`. See ADR 0006.

- API: new public, branded `StepIdentityChangedError` (`stepId`, `components`, `status`) is the
  cause of the `WorkflowRunError` for a replayed completed or settled-failed step whose identity
  changed; its message now names `--fork-from RUN --reuse matching --invalidate STEP` instead of
  "start a new run". Embedded `runWorkflow({ acceptCodeChange: true })` has no preflight.

- Rehearsal (behavior change): `--stub-steps` patterns and the `RunOptions.rehearsal.localStep` hook
  now also match `ctx.poll` wait IDs. A matched poll completes with a synthesized value, parsed by
  its schema, without calling its observer.

- CLI: `workflow unlock RUN [--state-dir DIR] [--force-remote] [--json]` clears an abandoned run
  lock without importing workflow code and returns
  `{kind:"workflow.unlock.result", ok, runId, stateDir, forceRemote, locks}`. It judges the primary
  lock and the legacy guard before removing anything, and refuses with exit 3: `run.locked` for a
  locally alive or unverifiable owner or recoverer, or a foreign host without `--force-remote`;
  `run.orphans` for an alive or unverifiable child record; `run.not_found` for a run with neither a
  lock nor a checkpoint. `--force-remote` asserts that the recorded host is this machine under an
  old name or is gone, and judges it by local observations. Metadata-less older-build locks,
  unreadable markers and dead recoverers' markers are removed with a warning. Removal uses the
  tombstone rename only and never signals a process; a run with no lock is a no-op. The three
  `run.locked` refusals (incomplete metadata, locked by PID on host, lock recovery in progress) keep
  their prefixes and now print the `quiet-choir workflow unlock RUN --state-dir DIR` command (with
  `--force-remote` for a foreign host), and the docs and skills no longer describe manual cleanup.
  `OrphanProcessesError` gains an optional third constructor argument, the lock owner
  `{ pid, host, state }` or null, added to `details.owner` and the message (additive). See ADR 0030.

- Runtime: run locks change hands by rename, so a crash at any step leaves a run that a plain resume
  or tick recovers. An acquire publishes a sibling directory that already holds a fsynced
  `owner.json`, so a lock never exists without complete ownership metadata, and an empty lock left
  by an older build's interrupted acquire is taken over. Release and dead-owner recovery rename the
  verified lock to a `.gone` tombstone, check its tokens and delete it, and the next owner sweeps
  stray tombstones and dead acquirers' `.tmp` directories. Recovery is claimed with an atomically
  linked `lock/recovery.json` (`{ pid, host, osStartTime, token }`) instead of a `recovery/`
  directory: a live, unknown or remote recoverer holds the lock ("lock recovery is in progress"),
  and the next acquire reclaims a dead recoverer's marker without stealing one that replaced it. An
  older build's `recovery/` directory is ignored. See ADR 0030.

- API and CLI: `RunOwnership` (from `inspectRunOwnership` and `workflow inspect --json`) has a new
  `locks` array listing the existing primary lock and legacy guard, each as
  `{ kind, path, owner, recovery, warning? }` (new exported type `RunLockView`), and text inspection
  prints one line per lock. The top-level `locked`, `owner`, `processes` and `warning` fields are
  unchanged. Tick now skips a run as `locked` while either lock's owner, or a recoverer, is alive,
  unknown or remote, and resumes a run whose recoverer crashed.

- Runtime and CLI (breaking): an external interruption is now a resumable suspension instead of
  `cancelled`. The new public, branded `RunInterruptedError` marks it: the CLI's first
  SIGINT/SIGTERM/SIGHUP aborts with `Workflow interrupted by <SIGNAL>.` and tick's `--timeout` with
  `Tick timeout reached.`, and embedders opt in by aborting `RunOptions.signal` with it. The run
  drains as before, then saves `suspended` with `nextWakeAt` = now and a new optional
  `interruptedBy { reason, at }` field (no `error` or `rootCause`), so the next tick resumes it
  without repeating completed steps. `execute`/`resume` still exit 130 with `workflow.interrupted`,
  and the rejection is still a `WorkflowRunError`. Tick reports such a resume as `suspended` with a
  `message` (`--run` exits 75). `inspect` shows the reason, and `inspect --watch` on an interrupted
  run now ends as suspended with exit 75 instead of 130. Unmarked aborts, workflow-scoped
  cancellation and explicit failures still save `cancelled` or `failed`. See ADR 0029.

- CLI: `workflow tick --claim-margin` (ms/s/m/h; default 10% of `--timeout`; `0ms` disables it; must
  be smaller than `--timeout`) stops tick from claiming new runs near its deadline. Ready runs seen
  inside the margin are left untouched and reported as skipped `deadline` (`--run` exits 75), and
  `--watch` ends when the margin starts. See docs/waits.md.

- CLI (breaking): `workflow tick` recovers crashed runs. A `running` run whose owner is gone (no
  lock, or a dead or released owner) is resumed through ordinary lock recovery, and a due suspended
  run behind a lock left by a dead owner is resumed instead of skipped. The `running` skip reason is
  replaced by `locked` (live, unknown or remote owner, or incomplete lock metadata), `orphans` (the
  owner is gone but a child process is alive or unverified; tick never kills it; `--run` exits 75)
  and `crash-loop` (3 consecutive recoveries without a new completed step; `--run` exits 1 and
  `--watch` stops retrying it until an explicit `workflow resume`). See docs/waits.md.

- Runtime: `RunRecord` has an optional `staleRecovery { count, completedSteps, at }` counter. Tick
  saves it durably under ownership before each stale recovery, and the runner removes it on a clean
  suspension or completion. `inspect` and `list` still derive `stale` without writing it.

- CLI (breaking): `workflow tick --json` now reports only what the tick did. The resumed count and
  the `completed`, `suspended`, `failed` and `incompatible` buckets are replaced by `resumed`
  entries (`{ runId, outcome, nextWakeAt?, message? }` for each run whose resume started), `skipped`
  entries (`{ runId, reason, message?, nextWakeAt? }`, with reasons not due, no longer due, locked,
  running, incompatible and unreadable) and an `observed` count of already-terminal runs. Each run
  appears in at most one entry, so a not-due or incompatible run is no longer also listed as
  suspended. A cancelled resume is reported as `cancelled`, not failed. `--run` on a run that
  already failed or was cancelled exits 1, and on one that already completed exits 0. `--max-runs`
  counts only executed resumes. See docs/waits.md.

- Runtime: under `workflow execute`, errors and evidence from workflow and custom-adapter code now
  behave as they do embedded. tsx gives that code its own copy of quiet-choir, so identity checks
  failed across the boundary: a custom adapter's `HarnessError` with HTTP 429 was recorded as
  `unknown` and never retried by `retry.on: ['rate-limit']`, a `ConfigurationError` was settled or
  retried instead of rejecting, `attachHarnessEvidence` data was lost, and `e instanceof ExecError`
  was false in workflow code. Every public error class is now branded with a `Symbol.for` name chain
  checked by `Symbol.hasInstance`, and evidence is a non-enumerable symbol property. A branded
  error's unknown `kind` is recorded as `unknown`. See ADR 0028.

- CLI: piped `--json` failure documents from `workflow execute`, `resume`, `answer --resume` and
  `configuration doctor` were cut off at the pipe buffer (64 KiB on macOS), because the CLI exited
  before stdout drained. The CLI now waits for its own output before exiting on a command failure,
  so these documents arrive whole. Exit codes are unchanged; see docs/cli-contract.md.

- Workflow Lab: `comparisons:check` now fails when any upstream `originals/*.js` file or batch
  `LICENSE` differs from its SHA-256 in `source-hashes.json`, or when an original has no entry or an
  entry has no file, in every registered batch. The site build uses the same check. Both
  `source-hashes.json` files now record the `LICENSE` hash. No runtime behavior changes; see
  comparisons/README.md.

- Workflow Lab: `comparisons:check` now fails when a batch's `apiSnapshot.sha256` differs from
  `src/workflow/runtime/model.ts` and rejects a hand-written `apiSnapshot.revision`. Squash merges
  orphan the commit a PR could pin, so the site build derives the revision (the newest commit
  reachable from HEAD whose model file has that hash) and shows it in the Target API block. No
  runtime behavior changes; see comparisons/README.md, "Regression and snapshot policy".

- Development and test infrastructure: run every `test/*smoke.mjs` in CI through
  `scripts/run-cli-smokes.mjs` in a separate CLI smokes job (eight smokes never ran there), in
  parallel with a private state directory each and a guard that fails when real quiet-choir state
  gains entries. CI gates coverage on the Node 24 leg only, `resume`, `pending` and `tick` have
  in-process exit-code tests, and the dependency pin policy (`@types/node`, the TypeScript aliases,
  the `vitest` group) is encoded in Dependabot and `test/package.test.ts`. No runtime behavior
  changes; see CONTRIBUTING.md.

- Development and test infrastructure: route every in-process fsync through one internal helper and
  run the unit suite with it disabled (about 80% of summed test time on APFS), then return the
  raised test timeouts to the default or a measured, commented value. Production still syncs and no
  runtime behavior changes; see CONTRIBUTING.md, "Test timeouts and storage sync".

- Add Workflow Lab Batch 02: six idiomatic ports with domain schemas, named roles, code-owned
  commands/writes, approved isolated setup, recoverable mutation tests, inline lifecycle children
  and settled bug panels. Record paired fixture metrics and actual SIGKILL recovery; keep model
  quality and billing claims outside those measurements.
- Recover an interrupted Git worktree registration with an empty `commondir` only when both
  ownership links match a saved planned cache. Refuse different owners, preserve fresh retry
  directories and record a repair warning. The Workflow Lab SIGKILL matrix exposed this window.
- Remove all Batch 01 TypeScript relaxations, fix its shared option construction, and regress two
  inherited null/index crash paths. Make Batch 02 the active primitive acceptance suite and reader
  default, retaining Batch 01 as its checked baseline and preserving all upstream snapshots.

- Register package harnesses with typed `ctx.agent` clients, strict option schemas and capability
  gates. Requests now name `harness` and include direct attempt identity; agent records carry a
  registration revision. Preserve preceding built-in fingerprints and normalize old names on read.
  Add per-harness CLI configuration/fixtures, workflow-aware doctor and the public harness kit.
- Keep service integrations as helpers over ordinary effects. Add inspection metadata and local
  attempt usage reporting, with a transport-injected decision helper as the reference pattern.

- Add inline `ctx.workflow` frames with validated I/O, child identity checks, delegated profiles,
  configurable depth and inspectable usage trees. Child waits suspend the shared run; settled maps
  require declared children so their identities can be checked without rerunning committed mappers.
- Publish workflow descriptions, required input/output schemas and child declarations through
  validation. Add cached directory discovery and execution by registry name; imports remain trusted.

- Normalize native usage into explicit token categories and effective-model totals; preserve raw and
  custom measurements without changing the preceding agent fingerprint schema. Inspection exposes
  public `summarizeUsage` totals, unknown counts and interrupted attempts.
- Add sticky run-wide reported-cost and attempt gates. Refusals leave no agent record, drain
  admitted calls and latch failure; higher limits on resume preserve completed work. These are
  admission gates, not hard billing ceilings.

- Stream Claude/Codex output incrementally, save early native IDs, and expose `--progress` live
  activity. Keep capped private transcripts and failed response/validation evidence per attempt,
  with CLI-settable policy limits and retention. Add extensible result diagnostics and per-call
  Claude permission-denial policy. **Agent result fingerprints change once:** in-flight runs with
  older completed agent calls require a new run or fork invalidation. See
  [streaming and attempt evidence](docs/agent-streaming.md).

- Default agent configuration to `restricted`, with explicit inherited roles and independent Git
  `worktree` selection. Scrub host-session environment, support fingerprinted `env.set`/`env.unset`,
  and retain only names/digests in environment diagnostics. Existing agent fingerprints can become
  incompatible. See [harness isolation](docs/harness-isolation.md) for native boundaries and probes.

- Add runtime-owned Git worktree isolation for Claude and Codex calls, with a pinned base, fresh
  retry directories, and captured commit results. Shared `ctx.worktree` handles serialize effects
  and restore completed snapshots; `ctx.merge` integrates changes in input order with explicit
  conflict and target policies. Inspection and source-free `workflow clean` expose and remove owned
  caches and optional refs. See [worktree isolation](docs/worktrees.md).

- Add operator-privileged durable `ctx.exec`/`ctx.exec.json` through an injected process runner,
  bounded per-stream capture, exit diagnostics, and child idempotency metadata. Add canonical cwd,
  memoized `readFile`, atomic hash-receipt `writeFile`, and raw-Git-blob `guardFile` restoration
  after one journaled body. Commands are synthesized in dry-run; files remain real unless stubbed.
  See [command and file contracts](docs/command-effects.md).

- Add recorded `ctx.now`, one-record signal/poll/deadline waits, `sleepUntil`, and bounded `poll`.
  Long sleeps suspend after active work drains; `--wait-mode block` retains live waiting.
  `workflow tick` resumes due stored entrypoints under the normal lock, with bounded watch and
  best-effort notification hooks. Existing sleep records replay. See [waits](docs/waits.md).

- **Storage revision:** new runs use format 7, per-run directories, coalesced append-only journals,
  and project-specific XDG state outside the working tree by default. Preserve observable outcomes
  before promise settlement, compact by status/size, and recover torn tails under ownership.
  `RunStore` separates orchestration from owned persistence. Original format 1 and flat format 6
  migrate with retained backups and old-binary guards; formats 2–5 remain inspectable. See
  [local storage](docs/storage.md).
- `workflow execute --resume --run-id RUN` can omit FILE. Stored launch paths are used, different
  supplied entrypoints are refused before import, and state paths appear in text/JSON output.
  `workflow list --all` discovers registered projects without loading source. New state containers
  self-ignore under Git; answers live in each run's inbox with case-distinct bounded names.

- Add durable `ctx.ask`/`ctx.approve`, quiescent suspension, and an atomic lock-free answer inbox
  with early JSON Schema and authoritative Zod validation. Started sibling work finishes before
  suspension. `runWorkflow` now returns a completed/suspended union; narrow by `status` or use
  `assertCompleted`. CLI `pending`, `answer`, and stored-entrypoint `resume RUN` support exit 75.
  Bootstrap and SDLC ports keep human decisions in one run, preserving the approved plan and binding
  redo answers to their requesting stage. See [durable questions](docs/questions.md).

- Add twelve runnable, failure/resume-tested workflow patterns and a current traps table to both
  authoring skills. `skills:check` keeps their complete fences and rehearsal fixture identical to
  `examples/patterns/`; every workflow recipe is at most 30 lines.

- Reorganize both distributed skills around cross-project setup, background operation, inspection,
  recovery, shared agent controls, and embedding recipes. The Claude package compares native
  Workflow with the implemented runtime. `skills:check` validates manifests, links, intentional
  differences, and complete TypeScript examples; CI runs the documented recipes with fake harnesses.

- Add `ctx.claude.value` / `ctx.codex.value`: schema-inferred output or plain text, with the same
  durable identities/records as `object`/`text` and normal `onError` behavior. New agent completion
  events carry detached usage/session metadata; replay does not report spend again.
- Omit undefined object members at checkpoint boundaries, including saved input passed to the body.
  Undefined array elements/holes still fail with boundary, step, and JSON path. Export `JsonInput`
  for dependency objects; persisted `JsonValue` stays strict JSON.
- **Type checking change:** schemas alone infer callback output contracts through whole-callback
  `NoInfer`. Wider returns now fail to compile; zero-parameter literal callbacks may need
  `as const`. Built-in CLI defaults add `noUncheckedIndexedAccess`, without
  `exactOptionalPropertyTypes`. An unchanged in-flight resume can now fail typechecking before
  running; use explicit code-change recovery after fixing the source. Typecheck human/JSON output
  lists effective compiler options.

- Add CLI fixture selection, config JSON/@file, fixture export, and `--dry-run` with temporary
  checkpoints, resume previews, named local-step stubs, immediate durable sleeps, and call reports.
  Local callbacks still run for real. See [workflow rehearsal](docs/rehearsal.md).
- `HarnessRequest.call` now carries durable run/step/attempt/idempotency metadata outside effect
  fingerprints. Use `HarnessRequestInput` for pure `CliHarness.plan()`/direct adapter inputs. Export
  `FixtureHarness`, fixture types/parser, and deterministic schema sampling from the root.
- New records save harness provenance; changing kinds on resume/fork requires `allowHarnessChange` /
  `--allow-harness-change`, except from a harness-less (`none`) run. Unlabelled format-6 checkpoints
  remain resumable.
- Ship repository-only real-envelope fake CLIs and an opt-in, zero-cost `test:contract` capture job.

- Persist step/attempt timing, resolved request summaries, usage, stacks, and body executions.
  `ctx.phase` and `ctx.log` provide scoped, replay-marked observations without effect identities.
  Retain 500 event payloads plus compact replay counts. Debug events include time and run ID.
- `workflow inspect` now shows a dashboard; `--json --summary`, `--watch --interval`, and
  `workflow list --status` support monitoring without imports. Watch JSON is JSONL and exits
  0/1/130/3 for completed/failed/cancelled/stale. `-v` prints saved failure stacks.
- Observability introduced format 6; the storage revision above defines current migration support.
  Step semantic fingerprints are unchanged. Existing `attemptHistory` and cancellation status are
  extended rather than duplicated. Custom contexts must forward phase/log.
- `WorkflowRunError` now exposes `runId` and names the root step/kind in its message, preserving the
  original `cause`. Prompt previews and log data are persisted; treat checkpoints as sensitive. See
  [run observability](docs/observability.md).

- Workflow CLI failures now emit one JSON document with stable error codes, a generated/requested
  run ID, root effect, and the actual saved checkpoint. Typecheck supports `--json`; workflow stdout
  is redirected to stderr in JSON mode. Input accepts inline JSON, `@file`, and `-` for stdin.
- **Breaking:** exit 1 now means a saved workflow failure. Usage, run refusals, and loading errors
  use 2, 3, and 4; storage failures use 74; interrupts use 130. Exit 75 means durable suspension.
  Check-resume incompatibility now uses exit 3 with its comparison in `error.details`.
- **Breaking:** successfully saved failed/cancelled runs reject with `WorkflowRunError`. Match the
  original error class through `.cause`; `.run` and `.stepId` carry saved context. Existing
  checkpoint aggregates retain the original primary cause. Refusals and input-schema errors now use
  `RunRefusedError` and `WorkflowInputError`. `readRun` still exposes ENOENT for missing files.
- Export `CliErrorCode`, `WorkflowRunError`, `RunRefusedError`, `WorkflowInputError`, and
  `isValidRunId`. Invalid CLI run IDs are rejected before any workflow import.

- Harness calls settle after bounded output draining and reap owned groups on every exit. Cleanup
  grace defaults to 3000ms, settable with `--kill-grace-ms`. SIGINT/SIGTERM/SIGHUP first drain; a
  second signal synchronously kills tracked groups and exits 130.
- Durable child ownership prevents abandoned-lock recovery beside live agents. Inspection reports
  owner/process liveness; `--resume --kill-orphans` stops only identity-confirmed groups. Refusals
  use exit 3 (`run.orphans`). See [process lifecycle](docs/process-lifecycle.md) for remaining gaps.
- **Harness port migration:** `invoke` and optional `metadata` now receive `HarnessInvocation` with
  `signal`, run/step/attempt IDs and `trackProcess`, replacing the bare signal parameter. Registry
  persistence failures use `CheckpointError.operation: 'process'`; they cannot retry or become
  settled workflow data. This migration originally retained format 5; the observability epoch above
  now requires format 6.

- Live agents now share a run-wide concurrency cap, defaulting to min(8, max(1, available CPUs -
  2)). Configure total/provider limits through RunOptions or CLI flags, or share a limiter across
  runs. Queueing is cancellable, visible through admission events, and outside per-call deadlines.
  See [agent concurrency](docs/agent-concurrency.md).

- Both harnesses accept shared effort and typed native controls, private role/config files,
  content-snapshotted images and fingerprinted, denylisted args/env/config. Capability controls
  compose with profiles and grants. See [harness controls](docs/harness-controls.md).
- `configuration doctor` now probes native CLI contracts without inference. Runs record CLI versions
  and warn on resumed version changes. The Workflow Lab preserves all 68 original effort settings
  and checks effort alongside prompts and outputs.

- Workflow agent defaults, named profiles, capability manifests, launch grants and sticky
  `--profile` limit overrides are available. See [agent profiles](docs/agent-profiles.md).
- **Privilege change:** Claude `tools` now implies `allowedTools` when omitted. Existing calls that
  expose Edit/Write/Bash may now execute those tools without interactive approval. Workflow runs
  require write/exec grants and default to strict declared profiles. Direct `CliHarness` callers own
  authorization. Explicit allowed rules can narrow the exposed set.
- **Migration:** raw call-site tools/allowedTools/sandbox now require `strictProfiles: false`, plus
  class/all grants for elevated calls. Prefer a declared role. The text preset is now 10 Claude
  turns, $0.50 per call and a five-minute deadline; readonly/edit have larger limits. Custom
  harnesses receive resolved profile options and must enforce them.
- Default empty tool gates and read-only sandbox use canonical omitted identity components. Legacy
  implicit calls retain their format-5 semantic fingerprints; old explicitly spelled default
  components can require a new run/fork. Completed semantic checks are never bypassed.
