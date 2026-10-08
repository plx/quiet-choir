# Changelog

## Unreleased — 0.0.0 prototype

- Fixture export now writes `kind` on the agent `error` rules it produces for settled failures and
  for failures the workflow absorbed (behavior change for exported files), so a replay takes the
  same kind-based branches and `retry.on` decisions as the original run. A failure whose recorded
  kind is `unknown` (or `cancelled`, which would be fatal on replay) exports exactly as before, and
  the attempt count is still not preserved (#305).

- `--accept-code-change` now refuses, before changing the run, a resume that would meet a settled
  map whose `items`, `keys`, `version` or `cwd` changed after an item completed, or any changed map
  in a journal saved before per-component digests (behavior change): the CLI and its `--dry-run`
  preview return `run.incompatible` with `details.divergent`
  `[{stepId: MAP_ID, components, map: true}]` (plus `legacy: true` for a legacy journal) and the
  fork command invalidating the map ID; an embedded `runWorkflow({ resume, acceptCodeChange })`
  rejects with a bare, new public `SettledMapChangedError` (`mapId`, `components`, `legacy`).
  Status, the saved fingerprint, output and `codeChanges` stay unchanged, where the run used to fail
  after recording the acceptance. A mapper-only edit is still accepted and re-finalizes with no
  repeated effect. `check-resume` stays body-free and its code-change advice now names settled maps.
  See ADR 0006 (#303).

- Default (prefix) fork reuse no longer reruns the surviving items of a named map after the fork
  drops one of its keys (behavior change): source steps under a removed key, including keys that
  contain `/`, now count as sibling items instead of causes, so later steps in the surviving items
  are reused. Steps after the map, such as a root step over its results, still run live, and another
  invocation of the same map ID (for example a later loop round, even with the same keys) still
  counts as a cause, as do removed-key steps that a different execution of the source (before a
  resume) launched. Record format: schema revision 13 adds the nested step field `mapItems`
  (`{item, invocation}` per enclosing named-map item: the exact item prefix and a digest of a value
  unique to the body execution, the invocation's map prefix, its ordinal among that execution's
  invocations of the same map ID and its item-prefix set), recorded on live launches, questions and
  waits, and on reused fork copies with the fork's own scopes; no step identity change. Revision-12
  records read and resume unchanged, and a fork from one keeps the earlier, conservative behavior; a
  revision-12 build refuses to rewrite a revision-13 record. New public type `StepMapItem`. See ADR
  0006 (#302).

- The healed-step check no longer flags a sibling that was relaunched beside a later failing launch
  of the healed step after an earlier run's failure (behavior change): a step that fails in run 1,
  fails again in run 2 while a `Promise.all` sibling relaunched with it completes, and heals in run
  3 no longer reports `replay.divergence` for that sibling, so a `--strict-replay` resume no longer
  stops on it. A genuine dependent of any earlier failure is still flagged, including a completed
  wait launched right after the first failure: each execution now starts the settlement counter one
  past the highest saved stamp, so later launches never tie with earlier ones. Record format: schema
  revision 12 adds the nested step field `failureHistory` (at most 8 `{launchStamp, failureStamp}`
  entries, removed when the step completes); no step identity change. Revision-11 records read and
  resume unchanged and keep the conservative `failureStamp` watermark, as does a history that has
  dropped entries; a revision-11 build refuses to rewrite a revision-12 record. See ADR 0007 (#300).

- A replay-divergence `recoveryHint` now suggests `workflow resume RUN --strict-replay` instead of
  `--resume --strict-replay`, and the inspection and durability references match (behavior change in
  saved hint prose only; no record format, schema revision, step identity or `next` entry change);
  an embedded run without a stored launch is told to resume with `strictReplay: true` in its
  embedding application instead (#298).

- A resume reports the healed-step divergence for a step that failed, was cancelled or interrupted
  in a later run (or left `running` by a crashed owner), and then succeeds (behavior change; no
  record format, schema revision or step identity change): `replay.divergence`, the saved
  `replayWarnings` entry and `healed` in `ReplaySkippedError` now cover it, as they already did for
  a step still recorded `failed`. Under `--strict-replay` such a resume now stops before the next
  live effect. A step that was only ever cancelled still reports nothing. See ADR 0007 (#297).

- `configuration doctor`'s Codex exact-argv probe sends a fresh nonexistent model
  (`quiet-choir-nonexistent-<uuid>`) beside the invalid effort, instead of the inherited model or
  `gpt-5`, so it cannot reach inference whichever the server rejects first (behavior change). The
  argv check passes on a 400 listing the efforts or a 400/404 naming the sentinel. After a model
  rejection the Codex enums check reports `warn` (effort drift unverified; verdict
  `usable-with-warnings`, exit 0), and `--strict` fails it. `npm run test:contract:doctor` checks
  the probe's requests against a loopback fake API. See ADR 0040 (#295).

- A forced `workflow cancel` sticks against stale recovery (behavior change; no record format,
  schema revision or step identity change): when `--force`, or a cancel whose SIGINT was the owner's
  second signal, force-kills the owner before it saves, cancel keeps its request, bound to that
  owner's token, and reports `run.unowned` with the new `details.requestKept: true`, also when a
  tick has already reclaimed the dead lock. The next tick that retires exactly that owner's lock
  saves the run `cancelled` (the same record cancel or the runner saves) instead of resuming it,
  removes the request and reports it with the new tick skip reason `cancelled` (final; `--run` exits
  1). It is honoured before the crash-loop and source checks, imports nothing, uses no `--max-runs`
  attempt and counts no stale recovery. A request from any other lock acquisition never matches, and
  an explicit resume or `workflow unlock` of the dead lock, or an embedder that released its lock
  cleanly, leaves it inert. Plain signals, tick deadlines and embedders still leave a resumable run.
  Scripts that switch on tick skip reasons must handle `cancelled`. See ADR 0058 (#293).

- `workflow cancel` ends an unowned run (behavior change; no record format, schema revision or step
  identity change): an unfinished run that no lock holds, such as a parked or interrupted
  `suspended` run or a `running` record whose crashed owner's lock was cleared, is now saved
  `cancelled` under the run lock instead of being refused with `run.unowned` (`reason: "unlocked"`,
  no longer produced), so tick observes it and never resumes it. Cancel takes the lock without
  recovering a dead or released owner's lock, which keeps its `run.locked` refusal with the
  `workflow unlock` command; a second cancel after the unlock ends the run. The saved record matches
  a runner-saved cancellation (status, error, recovery cause, child frames, a new execution entry
  and a `run.cancelled` event) and leaves steps and worktrees as they are. An unowned format-1 or
  format 2 to 5 checkpoint is refused with `run.incompatible`, unchanged. `workflow.cancel.result`
  gains `previousStatus` (`running`, `suspended` or null), and the text output reads
  `Run <id> was suspended with no owner; saved cancelled.` `run.unowned` now means only that a
  signalled owner exited without saving `cancelled`. See ADR 0057 (#292).

- Development and test infrastructure: guard the Node-free authoring model (#290). Workflow type
  checks import `src/workflow/runtime/model.ts` under tsconfigs without `types`, so it and every
  module it imports, `wait-model.ts` among them, must type-check without `@types/node`; a type-only
  import of `store.js` or `record.js` there used to fail the loader and registry tests with
  `@types/node` diagnostics. `test/node-free-model.test.ts` now walks that closure, checks it
  against a real Node-free type check, and names the offending import file, line and chain. No
  runtime behavior changes; see CONTRIBUTING.md, "TypeScript and package conventions".

- Structured owner-side rejections (addition; record `schemaRevision` 11, no format or step identity
  change): when the run owner quarantines an inbox delivery because the answer fails the question's
  own Zod schema or the attribution check, the rejection in `question.rejections` (and so
  `pending --json` rows) now carries `issues`, the same `{code, path, message}` list the writer
  reports as `answer.invalid` (`answer_author` for attribution), at most 20 per rejection with
  bounded strings. Every other refusal, such as a malformed envelope, stale fingerprint, earlier run
  generation or late delivery, records only `error` and has no `issues`. The owner's schema-mismatch
  `error` text is now the writer's one-line `Answer does not match the question schema: ...` summary
  instead of Zod's multi-line JSON dump. A revision-10 build refuses to rewrite a record that
  carries the field (#289).

- Cause-aware next entries (behavior change; record `schemaRevision` 10, no format or step identity
  change): failed and cancelled runs save the typed `recoveryCause` behind their `recoveryHint`
  (`RecoveryCause` is now a public type), and a failed run's `next` entries in failure documents,
  `inspect --summary` and `list --full` follow it. A grant failure gets
  `workflow execute --resume --run-id RUN --state-dir DIR --grant <profile>` (`--grant <access>`,
  and a cause with `classOnly`, when call-site capability overrides make profile grants
  ineffective), a replay divergence a fork, a settled map change a fork (after an
  `--accept-code-change` resume when only the mapper changed), and a run-budget stop `resume` with
  the cap's flag and the new `<LIMIT>` placeholder. A failed run that recorded no step or map now
  gets no entry, matching its absent hint. Other causes and records from older builds keep the plain
  resume. A revision-9 build refuses to rewrite a record that carries `recoveryCause` (#284).

- Run-budget recovery hint (fix; no record format, `schemaRevision` or step identity change): a run
  stopped by `--max-run-cost-usd`, `--max-run-agent-attempts` or a window stop that cannot wait
  (`--max-window-utilization`) now saves a `recoveryHint` that names the cap's flag and says to
  resume with a higher value or the flag off, instead of the authoring or re-finalize text. The hint
  wins over the effect, cancelled and authoring causes even when all recorded work is terminal, and
  never suggests `--accept-code-change` (#283).

- Failure kind on list rows (addition; no record format, `schemaRevision` or step identity change):
  `workflow list --json` rows gain `errorKind` and `retryable` after `recordedStatus`: the root
  cause's kind for a failed run (the stored kind, else the legacy fallback to the root step's last
  attempt) and whether it is transient, as in failure documents. Body failures, older records
  without a recoverable kind and every non-failed status, including a cancelled or interrupted run
  that keeps a `rootCause`, give `null` and `false`. The text table appends `[<kind>]` to a failed
  run's status and adds no column; `--full` summaries are unchanged and carry the same value as
  `rootCause.errorKind`. Watch JSONL is unchanged: `--summary` lines already carry
  `rootCause.errorKind` and `steps[].errorKind` (#275), and live `retryable` belongs to the event
  stream (#280) (#281).

- Failure kind on event lines (addition; no record format, `schemaRevision` or step identity
  change): `WorkflowEvent` gains an optional `errorKind`, the failed attempt's recorded kind on
  `step.failed` and the root cause's kind on `run.failed` that names a root effect. `--events` and
  `workflow events` write `errorKind` and `retryable` after `attempt` on `step.failed` lines (JSON
  `null` and `false` when the attempt recorded no kind) and on such `run.failed` lines, with
  `retryable` meaning a transient kind as in failure documents, not a guaranteed retry. A body
  failure, `step.settled` and other lines are unchanged, and the debug log and `--notify-command`
  payloads are unchanged (#280, ADR 0037).

- `skills:check` pre-execution syntax (addition; no runtime, record format, `schemaRevision` or step
  identity change): rejects Claude Code's !`cmd` pre-execution syntax, and a fence whose info string
  starts with `!`, anywhere in a plugin command or `SKILL.md` (prose, inline code, fences and
  comments included), naming the file and line, so a command cannot silently run shell when it loads
  (#272).

- `workflow pending --run RUN` (addition; no record format, `schemaRevision` or step identity
  change): lists only the named runs, repeatable. It composes with the default hiding and `--all`
  (`hidden` counts only the named runs), a known run with nothing waiting lists nothing, an invalid
  ID is `usage.run_id` and an unknown one `run.not_found`. Only the named records are read, so a
  damaged record of another run no longer fails the listing. Without the flag the output is
  unchanged, and the library `listPending` stays unfiltered. `/quiet-choir:run` uses it instead of
  filtering the JSON (#271).

- Step error text on event lines (addition; no record format, `schemaRevision` or step identity
  change): `WorkflowEvent` gains an optional `error` on `step.failed` and `step.settled`, the step's
  error text bounded to one line of at most 500 characters with no stack. `--events` and
  `workflow events` write it as `msg` on those lines (still within the 200-byte `msg` budget and
  512-byte line cap), one per attempt on a retry. The debug log and `--notify-command` payloads are
  unchanged (#267, ADR 0037).

- `workflow start` failures (fix; no record format, `schemaRevision` or step identity change): the
  `next` entries propagated from the runner's refusal (`run.locked`, `run.orphans`,
  `run.incompatible`, `usage.*`, …) are rebuilt behind start's own launcher, so behind an installed
  `quiet-choir` they start `quiet-choir workflow` rather than the runner's `node /path/bin/run.js`.
  Malformed entries are dropped. `error.message` and `error.details` stay the runner's verbatim
  (#263).
- Detached resume (addition; no record format, `schemaRevision` or step identity change):
  `workflow start --resume --run-id ID [FILE]` resumes an existing run detached, with
  `--kill-orphans` and `--accept-code-change` as for execute. It returns once the new runner has
  recorded its own execution in the record (or returned a completed run's stored output), and
  reports a refusal by the runner (`run.locked`, `run.orphans`, `run.incompatible`, …) with its own
  code and the run's ID. A missing run is `run.not_found` and a missing `--run-id` is
  `usage.resume_requires_run_id`, both before anything is launched; launch numbering continues, so
  earlier launch evidence is kept. `--dry-run`, `--stub-steps` and `--full` stay refused, now with
  `usage.flag` and a `next` entry for the foreground `workflow execute` command instead of oclif's
  unknown-flag error (#262, ADR 0056).
- Leftover launch directories (addition; no record format, `schemaRevision` or step identity
  change): `workflow start` now records its spawned runner in `launch/<n>.runner.json`
  (`{pid, host, osStartTime}`, 0600) as additive launch evidence. The record-less `<runId>/launch/`
  of a start that failed before its record is reported by `workflow list` (`leftoverLaunches` in
  JSON, a `Leftover launch` line with the `workflow rm` command in text) once every launch has
  settled: its recorded runner is dead or, without a runner record, its files are more than an hour
  old. `workflow rm ID` removes it under the legacy guard (`launchOnly: true` in the result) and
  refuses with `run.active`, even with `--force`, while the start may still be in flight. Prune and
  clean are unchanged (#261, ADR 0055).
- `workflow answer --harness` (addition; no identity or storage-format change): the flag is now
  repeatable and takes `cli`, `fixture:<file>` and `name=fixture:<file>` like `resume`, `execute`
  and `tick`, so `answer --resume` can override a run's named fixtures. Omitted, it still inherits
  the recorded selection (#259).
- Launch policy (behavior change; no identity or storage-format change): an embedder's
  `RunOptions.launch` without a `policy` now keeps the policy the run record holds instead of
  erasing it, so a later CLI resume continues under the harness selection and wait mode the run
  started with. A `LaunchPolicy` still replaces the recorded one and `policy: null` clears it; the
  CLI passes null for a selection built from data. `RunOptions.launch` is typed as the new exported
  `WorkflowLaunchOptions`. Records, `formatVersion`, `schemaRevision`, fingerprints and step
  identity are unchanged (#258).
- Emitted answer commands (bug fix; no identity or storage-format change): a human question's
  `answerCommand` (suspension, `workflow pending`, `inspect`) and the `answer` entries of `next` now
  end with `--by human:<NAME>`, so they no longer fail verbatim; replace `<NAME>` with the name of
  the human, asked first. `answer` and inbox ingestion refuse an unreplaced `human:<...>` author
  with `answer_author`, so a queued delivery whose author is such a placeholder is now quarantined
  as a rejection. Other audiences' commands are unchanged (#256).
- Runtime prose hints (bug fix; no identity or storage-format change): the `resume --kill-orphans`
  command in the unlock, rm, prune and tick orphans messages, tick's crash-loop message, prune's
  `workflow rm` suggestions, rm's `workflow clean` retry hint and the `usage.flag` example now start
  with the detected launcher instead of a hard-coded `quiet-choir`, like `next` entries, and
  shell-quote a state directory that needs it. The crash-loop hint now includes `--state-dir`, so it
  runs from any directory (#255).
- `validate --json` and `list-defs --json` (behavior change; no identity or storage-format change):
  each capability fact is stated once, at every depth of `children`. `capabilities.defaults` is gone
  (read `profiles[defaultProfile]`), the default profile's environment summaries are one shared
  `capabilities.environment` and a profile's own `environment` lists only the harnesses that differ,
  `workflow.profiles` is the array of declared profile names, and the root `workflow.entrypoint` is
  omitted because it equals the top-level `entrypoint`. The golden-path document shrinks from 3,974
  to 2,737 bytes, under the 3 KB target (#254). `--harness-schemas` prints the complete document as
  before. Run records, checkpoints, `check-resume`, grant digests and step identity are unchanged.
- Public capability manifests (bug fix; no persisted-shape or identity change): re-projecting a
  public manifest no longer re-digests a registered harness's `env` in `harnessCapabilities`, so the
  projection is safe to apply to its own output (#248, ADR 0033).
- Registered harness declarations (addition; storage revision 9, nested-only): `defineHarness`
  accepts `sensitiveOptions`, a list of option keys whose profile values public capability manifests
  (checkpoints, `workflow validate --json` and the record `check-resume --json` prints) move out of
  `harnesses.<name>` and `harnessCapabilities.<name>` into `redacted.harnesses.<name>.<key>` as
  `{ sha256, keys? }`, with `keys` only for an object value (#247, ADR 0033). It rejects unknown and
  duplicate keys, and `prompt`, `model`, `env` and the call options profiles cannot set, which never
  reach a manifest. Grant pins and step identity still use the raw values, so declaring a key
  changes neither and a rotated value still invalidates both. Revision-8 checkpoints read and resume
  unchanged and are scrubbed the next time they execute; a revision-8 build refuses a record holding
  `redacted.harnesses` with the upgrade message. The definition registry cache envelope moves to
  version 4, so cached validate results that printed a now-sensitive option are recomputed.
  `redactControls` gives an array value only a `sha256`; no built-in redacted control is an array.
- Worktree administration lock (behavior change; no identity or storage-format change): a release of
  the repository lock whose tombstone rename fails (for example `EACCES`) now rewrites its verified
  `owner.json` as `released: true` before it throws, the way a run lock with orphans is handed over.
  Other processes recover the lock at once instead of waiting for the still-running owner to exit,
  `workflow inspect` shows it as `released`, and `workflow unlock --worktree-admin` clears it
  instead of refusing a live owner. When even that rewrite fails, only the owner's own next
  administration command recovers the lock, as before, and the release error names both failures.
- Worktree administration lock (addition; no identity or storage-format change): the repository lock
  `<common Git dir>/quiet-choir/worktree-admin.lock` (ADR 0032) can now be seen and cleared.
  `workflow unlock --worktree-admin PATH [--force-remote]`, with PATH any path inside the repository
  and no RUN or `--state-dir`, clears a dead or released owner, a dead recoverer, or unreadable
  metadata through the same judgment and token-verified tombstone removal as a run unlock, and
  returns `workflow.unlock.worktree-admin.result`. It refuses a locally alive or unverifiable
  holder, and a foreign one without `--force-remote`, with the new error code `worktree.locked`
  (exit 3) and the command to rerun in `error.details.next`. Plain `workflow inspect RUN` of a run
  with a worktree ledger adds `worktreeAdminLock` (holder PID, host, token, state, OS start time and
  an approximate `acquiredAt`) to the JSON while the lock is held, and a `Worktree admin lock` line
  with an `Unlock:` hint to the text; this runs one `git rev-parse`, and `--summary`, `--watch` and
  `list` run none. Behavior change: the error after an unverifiable holder blocks an attempt for 30
  s now names `quiet-choir workflow unlock --worktree-admin <common Git dir>` (with `--force-remote`
  for another host) instead of telling the operator to remove the lock directory.
  `workflow unlock`'s RUN argument is now optional. Both forms of unlock now take the lock's
  recovery claim before removing it, as automatic recovery does, so a concurrent recoverer can no
  longer retire and replace a lock that unlock is removing; a live recoverer's claim refuses the
  unlock as "changed during unlock; retry".
- Step supersession (fix; no identity or storage change): a completion now marks unvisited
  unfinished steps `superseded` only after the output validates and worktree cleanup succeeds, and
  puts them back if the completion checkpoint fails, as child frames already did. Before, a run that
  failed output validation, cleanup or the completion save recorded those steps as `superseded` in
  its failure snapshot, although it never completed. `step.superseded` events still follow
  `run.completed`.
- A failed, cancelled or superseded child frame can now be resumed after a change to its child's
  name, version, input or schemas, when it is not settled, no committed settled-map item or settled
  frame owns it, and nothing beneath it (steps, settled maps, descendant frames) is completed or
  settled; a settled map journal records the new optional `MapRecord.frame` that ran it, so a map
  run through a bound `within` view still counts (an uncommitted journal adopts the frame that runs
  it next, and a committed one refuses to run in another frame). Such a frame adopts the new
  identity, records the replaced one in the new optional `ChildRecord.redefinitions` history
  (exported type `ChildRedefinition`, kept across later resumes), emits a `child.redefined` event
  before `child.started`, and shows the history in `inspect`. This applies to declared and
  dynamically invoked children. Completed, settled, running and suspended frames, frames holding
  terminal work, owned frames and parent changes still refuse; the refusal for a failed, cancelled
  or superseded frame now names the work or owner that blocks it. Behavior change: such a resume
  used to fail with `Child frame ... changed`; a CLI resume still needs `--accept-code-change` for
  the edited source. The history and map frame bump the record schema revision to 8 (nested-only);
  revision-7 records still read and resume, and a revision-7 build refuses to rewrite a revision-8
  record.
- Fixture export (fix; no identity change): `workflow fixtures` now also exports agent steps whose
  failure the workflow absorbed (a `try/catch` around the call, or a settled map item), which stay
  `failed` in a completed run, as `error` rules in execution order, so replay reproduces the failure
  instead of failing with `No fixture matches step`. The text comes from the step's recorded error
  with the same prefix stripping and non-empty fallback as settled failures; kind and attempt count
  are not exported. Runs without such steps export exactly as before.
- `workflow tick` no longer counts a stale recovery for a CLI run it is certain to refuse for a
  harness configuration mismatch. A cron tick without the run's original `--harness-config` used to
  save the `staleRecovery` counter before the runtime refused the resume, so after 3 ticks a healthy
  run was reported `crash-loop` and the real cause disappeared. Tick now applies the runtime's
  configuration rule (shared through one pure helper) after claiming the run and before saving the
  counter: the counter, the checkpoint and `--max-runs` stay untouched and the workflow is not
  imported. Behavior change: such a run is reported under `skipped` with reason `incompatible` and
  the same `run.incompatible` message, instead of under `resumed` with outcome `incompatible`; the
  `--run` exit code (1) is unchanged. Other refusals that tick can find only after importing the
  workflow, such as a harness kind change with an explicit `--harness`, still count, because the
  counter is saved before the resume so that every crash counts.
- A Codex auth write-back lock file that is not a quiet-choir owner record (corrupt, or another
  user's file in a shared `/tmp`) is now reclaimed with a warning once it is older than 60 s,
  instead of every `instructions: 'none'` call waiting about 10 s and losing the write-back. A
  younger one is still waited on, and a live owner is never reclaimed. A lock that cannot be moved
  aside fails fast, and every lock failure warning names the lock path.
- Instruction detection covers more native sources, measured with the zero-cost isolation contract
  on codex-cli 0.160.0 and Claude Code 2.1.290. Codex: skills under `$HOME/.agents/skills` (user
  level, counted in the user-level warning), `.agents/skills` in each directory from the Git root
  down to `cwd` and `<cwd>/.codex/skills` (project level, a run warning counts files beyond 64), and
  skills nested up to six directories below each skill root, including `CODEX_HOME/skills`.
  `CODEX_HOME` memories are not detected: they load only with `features.memories` enabled. Claude:
  an inherit-mode call's user `CLAUDE.md` (`CLAUDE_CONFIG_DIR`, else `~/.claude`, plus
  `~/.claude/CLAUDE.md` when `HOME` is an ancestor of `cwd`) is recorded in `projectInstructions`
  with the new `InstructionSource` kind `'claude-md'`; restricted calls record nothing, and
  `workflow doctor` names the file. The new kind bumps the record schema revision to 7
  (nested-only); revision-6 records still read and resume, and a revision-6 build refuses a record
  holding a `claude-md` source as `run.incompatible`. Behavior change: the runtime now calls
  `projectInstructions` once per distinct resolved `cwd`, isolation mode and env edits, so an
  adapter can be called more than once for one `cwd`; later detections at a `cwd` in the same run
  invocation add their files to its entry instead of replacing it. The contract also found that
  `instructions: 'none'` does not remove the `$HOME/.agents/skills`, project `.agents/skills` or
  `<cwd>/.codex/skills` roots; the docs and the user-level warning now say so. Detection stays
  outside step identity and replay.
- Codex project instruction files are now detected once per distinct resolved call `cwd` (each
  worktree or map item with its own `cwd`), instead of only from the first live Codex call's `cwd`,
  and recorded in a new top-level run-record field `projectInstructions`
  (`{ harness, cwd, sources }` entries, at most 128 with the oldest dropped). The field bumps the
  record schema revision to 6; revision-5 records still read and resume. User-level sources and
  their warning are still detected once per registration per run invocation. Adapters gain an
  optional `projectInstructions(request, invocation)` hook (`Harness`, and `HarnessAdapter` with a
  signal argument) and the exported `ProjectInstructions` and `ProjectInstructionsRecord` types; a
  rejecting hook becomes a run warning. Detection stays outside step identity and replay. Behavior
  change: `CliHarness.metadata` (and the built-in adapters' `metadata`) now reports only user-level
  Codex `instructionSources`; project files come from `projectInstructions`.
- Codex instruction detection now ignores an empty or whitespace-only user-level
  `AGENTS.override.md` and `AGENTS.md` and a blank project-level `AGENTS.md`, matching measured
  Codex behavior (a blank user override falls back to `AGENTS.md`; blank `AGENTS.md` files send
  nothing), so the user-level instruction warning no longer fires for them. A blank project-level
  `AGENTS.override.md` is still recorded, because it displaces `AGENTS.md`. This is a
  diagnostics-only change: the isolation contract gains three whitespace cases
  (`codex-restricted-whitespace-override`, `-whitespace-user-agents`, `-whitespace-project-agents`)
  and `instructionsMessageReachedRequest` on `codex-restricted`, with no identity change and no
  `formatVersion` bump. A resumed run whose earlier metadata recorded a blank user file may see the
  existing "instruction sources changed" warning once.
- Each poll error that `onError` tolerates now records a `wait.tolerated` run event, saved with the
  wait's `lastError` and announced after that save: `stepId` is the wait ID, `message` the error
  message cut to 1024 characters, and `data` `{ consecutive, tolerate }` plus the error's string
  `code` when it has one (such as `QUIET_CHOIR_POLL_OBSERVE_TIMEOUT`). `RunEvent['type']` and so
  `WorkflowEvent['type']` gain the value. It appears in `onEvent`, `--events` and `workflow events`
  as `tolerated 2/3: message` (with ` [code]`), among `workflow inspect`'s recent entries with its
  wait ID, and in the CLI's info-level log. The error past the tolerance records none and fails the
  wait as before. The event never replays and leaves wait identity unchanged. Run records move to
  schema revision 5: a revision-4 build refuses to rewrite them, and cannot read at all a record
  that holds a `wait.tolerated` entry (every read is the `run.incompatible` upgrade refusal).
- `ctx.poll` (both forms) and `ctx.wait` poll sources take an optional `noteSchema`, a Zod schema
  that infers the note type, so `previous.note` is `z.infer<typeof schema> | null` without type
  arguments, and validates it in both directions: a nonterminal note is parsed before it is saved
  (unknown keys are dropped), and the saved note is parsed again before the next check, so a note
  left by an older body fails before the observer runs, without counting as a check. A null note
  bypasses the schema. A failure throws an error with code `QUIET_CHOIR_POLL_NOTE_INVALID` (error
  kind `schema`, the Zod error as `cause`) that `onError` never tolerates. `noteSchema` is policy,
  not identity, so it is not persisted and may change on resume. The note type parameter `N` of
  `PollContext`, `PollSource`, `CommandPollSource`, `PollOptions`, `CommandPollOptions` and the
  `ctx.poll` overloads now accepts `JsonInput`, so a schema with optional fields type-checks;
  `WaitSources` and `ctx.wait` gain the same `N`, inferred from the poll source's `noteSchema`. A
  nonterminal result's `note` may be null, or `previous.note`, whatever the schema. Without
  `noteSchema` nothing changes (#222).

- A body failure now aborts an in-flight poll observation as soon as the failure drain starts,
  instead of waiting for it to settle or for `observeTimeoutMs` (60 s by default). The aborted
  observation records no `error` or `lastError` and leaves the wait due, so it reruns on resume; an
  observer that ignores its signal is abandoned after the usual 2 s grace with a `(run failing)`
  `waitWarnings` entry. Other operations still drain to completion without a signal (#220).

- Re-reading a completed run (`runWorkflow({ resume: true })` on a run that already completed) now
  returns its worktree and wait warnings in `warnings`, as the original completion and
  `workflow inspect` do; it previously returned only the policy, replay and harness warnings. One
  internal helper now builds that list for the fresh completion, the re-read, inspection and the
  compact run result (#219).

- The accepted-replay preflight (`runWorkflow({ resume: true, acceptCodeChange: true })` and the
  CLI's `--accept-code-change`) no longer stops early, and so fails open, at a Git worktree effect
  or at a question whose answer was delivered but not yet consumed. Its probe now synthesizes
  `ctx.worktree`, isolation on a handle and merges of captured commits with placeholders and no Git
  command, and its disposable copy holds the run's pending answer deliveries (copied, so the real
  run still consumes the source delivery). An edit to a completed step, or one that skips completed
  work, after such a point is now refused without changing the run (`run.incompatible`, exit 3, in
  the CLI) instead of recording the acceptance and then failing. `--dry-run` keeps its refusals of
  those worktree effects (#217).

- An accepted resume (`runWorkflow({ resume: true, acceptCodeChange: true })` and the CLI's
  `--accept-code-change`) now also refuses without changing the run when the changed body would
  finish without revisiting a completed step, settled map or completed or settled child frame.
  Previously it recorded the acceptance, replaced the fingerprint and cleared the saved output, then
  failed at the end of the body. The end-of-body checks now throw the new public, branded
  `ReplaySkippedError` (`kind`: `steps`, `maps` or `child-frames`; `skipped` IDs; `healed` steps),
  with unchanged message text, so a plain resume still fails with the same `WorkflowRunError`
  message, its cause now typed; a skipped child frame's `recoveryHint` is now the replay-divergence
  advice instead of re-finalize advice. Embedded callers get a bare `ReplaySkippedError` whose
  message adds the fork recipe. The CLI reports `run.incompatible` (exit 3) with one
  `error.details.divergent` entry `{stepId, skipped}` per skipped ID (`skipped` is `step`, `map` or
  `child-frame`; identity entries keep `{stepId, components}`) and an `error.details.next` fork
  command that invalidates the first skipped ID; `--dry-run --resume --accept-code-change` returns
  the same refusal. This includes an accepted fix to a failed step whose `catch` fallback already
  completed, which is now refused up front; fork to adopt it (#216).

- An embedded `runWorkflow({ resume: true, acceptCodeChange: true })` now refuses without changing
  the run when the accepted replay would meet a changed completed or settled-failed step: it replays
  the body once on a disposable copy of the record, with every unfinished effect synthesized, and
  rejects with a bare `StepIdentityChangedError` (no longer a `WorkflowRunError` after a saved
  failure) while status, fingerprint, output, `codeChanges`, waiting questions and the journal stay
  as they were. Embedded accepted resumes therefore run the workflow body once more. The CLI's
  `--accept-code-change` behaves as before (`run.incompatible`, exit 3, same details) but now
  preflights once, through the runtime, on the record read under the writer lock. An abort during
  that preflight ends the run `cancelled` (or suspended for a `RunInterruptedError`) without
  recording the acceptance (#215).

- `run.locked` refusals from `workflow resume`, `execute`, `start`, `tick`, `clean`, `rm`, `cancel`
  and `unlock` (and the skipped entries of `prune`) now carry `error.details.next`, a list of
  `{why, argv}` entries, and the failure document's top-level `next` repeats it. The entry is the
  `workflow unlock` command behind the invocation's launcher (`node` plus the absolute `bin/run.js`
  outside an installed `quiet-choir`), with `--force-remote` only when the holder is on a foreign
  host. The refusal prose and `workflow inspect`'s `Unlock:` line embed the same command, so a path
  that needs shell quoting is quoted. Embedders get the same through `RunOptions.commandLauncher`
  and the new `RunStoreOpenOptions.commandLauncher`; without one the argv starts with `quiet-choir`
  (#213).

- `workflow inspect` text now prints one `Unlock:` line naming the exact `workflow unlock` command
  after the `Lock` lines when no lock owner or recoverer is alive or unverifiable locally and no
  child is alive or unverifiable: a dead or released owner, a dead recoverer, or missing or damaged
  lock metadata. The line adds `--force-remote` and its caveat only when a holder is on a foreign
  host, and is omitted for a live local owner, an unlocked run, or a summary without a state
  directory. `--json` output is unchanged (#212).

- A `workflow tick` resume that the deadline interrupts after tick saved its stale-recovery count,
  but before the runtime reopened the run, is now reported as resumed outcome `interrupted` (exit 75
  with `--run`) instead of a final `cancelled`. The run stays `running` and the next tick recovers
  it. `cancelled` is reported only for a run saved as `cancelled`, and an interrupted resume whose
  record cannot be re-read reports `failed` (#206).

- `workflow tick` no longer overruns `--timeout` by scanning the remaining runs. Inside the claim
  margin it still reads each run's record, so terminal runs are observed and not-due runs reported
  `not due`, but it skips the lock, orphan, crash-loop and source checks and reports a due or stale
  run as skipped `deadline` with its `nextWakeAt`, even one a full scan would report `locked`,
  `orphans`, `crash-loop` or `incompatible`. Once the timeout fires, it reads no more records: each
  run not yet reported is skipped `deadline` with a message saying tick did not read it and no
  `nextWakeAt`. The report shape and exit codes are unchanged (#205).

- A `workflow tick` skipped entry with reason `orphans` now says that tick never signals a process
  and names `quiet-choir workflow resume RUN --state-dir DIR --kill-orphans`, instead of advising
  `--kill-orphans`, a flag tick does not have. The `resume`, `unlock` and `rm` messages are
  unchanged (#202).

- `workflow tick` (and every run listing built on `FileRunStore.list`) visits runs in ascending
  run-ID order, by character code, whatever order the file system lists them in. The order is now
  documented and covered by tests, and without `--run`, `--max-runs N` resumes the first N due runs
  in that order (#200).

- Evidence a custom adapter attaches to a frozen (non-extensible) error under `workflow execute` now
  reaches the attempt record (#195, ADR 0028). It was previously kept in a store that only the
  workflow's own quiet-choir copy could read, so the host recorded none of it. Frozen-error evidence
  now lives in a lazily created, weakly keyed `WeakMap` on `globalThis` under
  `Symbol.for('quiet-choir.frozenEvidence')`, shared by every copy in the process.

- A forced second signal under `--json` no longer truncates a large failure document piped to a slow
  reader (#193, #122). A single `writeSync` on the non-blocking fd 1 wrote only what fit in the pipe
  buffer, about 64 KiB. The document is now written in full, retrying short writes and `EAGAIN` for
  up to 5 seconds. `EPIPE` is ignored. Exit code 130 and the kill-before-write order are unchanged.

- An unfinished original format-one agent step now migrates on resume when its request and output
  schema are unchanged, and runs live; otherwise it gets the `original format-one identity changed`
  refusal (#191). It previously failed with a raw `Transforms cannot be represented in JSON Schema`
  error, because the legacy check hashed the runtime result schema. Agent steps are now compared
  against the frozen format-one result wrapper. Terminal format-one agent steps are still refused.

- A short-lived child that exits before its stdin is written, such as `git rev-parse` under load, no
  longer fails a successful `ctx.exec`, runtime Git call or harness process with `write ENOTCONN`
  (#189): `EPIPE` and `ENOTCONN` on stdin are ignored and the exit status decides. Empty input
  closes stdin without a zero-length write, still after durable registration. Cleanup no longer
  warns `Could not send SIGTERM … kill EPERM` for a group whose members have all exited.

- A Claude profile may declare `claude.addDirRoots` (#171; ADR 0054). Under `strictProfiles`, a
  Claude call using that profile may pass `addDirs`; each entry is refused if it has a `..` segment,
  is canonicalized (the real path of its deepest existing ancestor plus any not-yet-created
  segments; a dangling symlink is refused) and must equal or sit inside a canonical root. Accepted
  entries are appended to the profile's own `addDirs` as canonical absolute paths, which reach
  `--add-dir` and step identity. A profile without roots, a Codex call and any other raw key keep
  the `strictProfiles forbids call-site …` error, and `strictProfiles: false` is unchanged (a call
  replaces the list). `codex.addDirRoots` fails validation, because Codex directories are writable
  roots. Roots appear in `workflow.capabilities` and in `profileGrantDigest` only when declared, so
  existing named grant pins are unchanged; changing roots requires a renewed grant. A tool-less
  rooted Claude role is `read`. Child delegation checks a child's roots and absolute call-site
  directories by canonical containment in the parent role's roots. The strict call-site type now
  permits Claude `addDirs` (the runtime rejects them for a profile without roots); Codex `addDirs`
  stay `never`. Attempt and step request summaries record `addDirs` when nonempty. The record schema
  revision becomes 4, so a revision-3 build refuses to rewrite a record written by this build.
- `ctx.workflow` and `ctx.merge` accept `onError: 'return'` (#170; ADR 0007, ADR 0026). A merge
  failure such as an `onConflict: 'fail'` conflict, a dirty checkout target or a moved target is
  saved as a `settled-failed` step and returned as `Settled<MergeResult>`; resume replays it without
  running Git. Only `'return'` changes a merge's fingerprint. A child call returns
  `Settled<O, MapStepError>` (by name: the declared output, or JSON) and records the frame's
  terminal outcome in the new optional `ChildRecord.onError` and `ChildRecord.settled` (outcome plus
  owned step, map and frame IDs; type `ChildSettledRecord`). Resume returns the saved outcome
  without running the body or emitting `child.started`; a settled failure emits the new
  `child.settled` event instead of `child.failed`. Cancellation, budget stops, configuration and
  checkpoint failures, authoring guards, input validation, the depth guard and identity refusals
  still reject. A settled frame's descendants must be declared, its `onError` cannot change on
  resume (an unsettled frame may switch), supersession skips it, and skipping it fails the run with
  "Replay skipped completed or settled child frames" (formerly "Replay skipped completed child
  frames"). A fork reruns a settled frame's body, reusing its terminal steps. Inspection summaries
  show a compact `settled` field on child rows and mark `(settled)` in the text tree. The record
  schema revision becomes 3, so a revision-2 build refuses to rewrite a record written by this
  build. Code that passes a variable typed `MergeOptions` or `ChildOptions` now gets the
  `EffectResult` union, because both types gained `onError`.
- `assertHarnessConformance` (`quiet-choir/harness-kit`) passes the adapter a recording
  `HarnessInvocation` in every scenario and adds six scenarios: `registration-before-input`,
  `session`, `transcript`, `timeout`, `rate-limit` and `env` (#169). `HarnessConformanceCase` widens
  to those twelve names, so existing fixtures must handle the new cases. Fixtures now receive a
  second `HarnessConformanceProbe` argument naming marker files the fake writes (`started`, `input`,
  `environment`), may set `expectedStdout` (required by `transcript`), and the options gain
  `timeoutMs` (default 250, applied to both `request.options.timeoutMs` and
  `invocation.policy.timeoutMs`). The `env` scenario sets and restores host-session variables in
  `process.env`. Failures are `AssertionError`s whose message starts `Conformance scenario <name>:`.
  The built-in Claude and Codex adapters pass unchanged. A registered harness's attempt policy,
  `invocation.policy` and request options now carry `maxTurns` and `maxBudgetUsd` only when its
  options schema declares them, so `--dry-run` no longer warns that undeclared limits remain in use;
  an adapter that read them without declaring them no longer receives them. Claude and Codex records
  are unchanged, except that a Codex call inside a child workflow no longer fails with
  `Unrecognized key(s) "maxTurns", "maxBudgetUsd"` from the delegated profile ceiling.
- `--max-window-utilization <0..1|off>` on `execute`, `start` and `resume`
  (`RunOptions.maxWindowUtilization`) is a third sticky run cap (#168; ADR 0053). Saved in
  `runBudget` and outside identity, it is kept by resume and tick, cleared by `off` or
  `--policy-reset`. Agent admission reads the admitting harness's latest recorded rate-limit report
  (#156) and refuses a new attempt while a window whose reset has not passed reports a utilization
  at or above the cap; a run without a report, and Codex, are never refused by it. The refusal
  latches like the other caps, and its `budgetStop` names the metric `maxWindowUtilization`, the
  `harness`, `window`, `resetsAt` and the `observed` utilization. When every exceeded window has a
  known reset, the run then ends `suspended` instead of failing, with `nextWakeAt` at the latest
  reset (or an earlier wait deadline), exit 75 and a `run.suspended` message naming the window;
  `workflow tick` resumes it after the reset, and an earlier `resume` suspends it again without a
  new attempt. It suspends even under `--wait-mode block`. With an unknown reset the run fails with
  `RunBudgetExceededError` as the other caps do. The `workflow.run.suspended` document gains a
  top-level `nextWakeAt` for every suspension, inspection summaries an optional `budgetStop` key and
  a `Budget stop:` text line, and a gated run's resume follow-up says when tick resumes it. Records
  are written with `schemaRevision` 2 (nested `runBudget` and `budgetStop` changes); revision-1
  records read and resume unchanged, and a revision-1 build refuses to rewrite a revision-2 record.
- Run records carry a `schemaRevision` (#167; ADR 0052). New records, and resumed records at their
  next save, are written with `SUPPORTED_SCHEMA_REVISION` (1); an absent field means 1, reads never
  fill it in, and existing records resume unchanged. A record with a newer revision, or with
  top-level fields this build does not know (in `run.json` or in a journal entry), is no longer
  stripped and rewritten: `resume`, `execute --resume`, `answer --resume`, `--fork-from`,
  `--dry-run`, `workflow clean` and embedded `runWorkflow` resumes refuse with `run.incompatible`
  (`details: {reason: "record_schema", schemaRevision, supportedSchemaRevision, hiddenFields}`, no
  next command but upgrading) and leave `run.json` and `journal.jsonl` byte for byte unchanged;
  `workflow tick` skips the run as `incompatible` (exit 1 with `--run`); `workflow check-resume` and
  `checkResume()` report it incompatible (`record schema` in `changed`, plus the same `reason`,
  revisions and hidden fields; `--accept-code-change` does not override it). `inspect` and `list`
  still work and add a warning naming the newer revision or the hidden fields; such runs get no
  resume or answer follow-ups. A record with a newer revision or unknown fields that does not parse
  at all reads as the same refusal instead of `run.unreadable`. Journal replay now tolerates changes
  to unknown run-level keys on read (writers stay strict). `workflow rm` refuses such a run only
  when it would first save its worktree ledger. Builds that predate this guard still drop unknown
  fields. Contributors bump the revision for any persisted run-level field change; a key snapshot
  test enforces it for top-level keys.
- `workflow prune --missing-cwd --all` also removes stale XDG project roots (#366, split from #166;
  ADR 0051). After its run removals it judges every root registered for a missing cwd and every root
  without a valid `project.json` (the `Skipped project` roots of `list --all`), never the current
  project's root or a root whose cwd exists. A pure, table-tested `rootDecision`
  (`root-selection.ts`) keeps a root while a run in its `runs/` stays (`runs-kept`), a
  `worktrees/<runId>-<namespace>/` directory names a run a scanned container still holds (`in-use`),
  or it holds any file, symbolic link or unknown directory (`files`). Otherwise prune unlinks
  `runs/.gitignore`, rmdirs `runs/`, rmdirs the `worktrees/` tree bottom-up, unlinks `project.json`
  and rmdirs the root: it unlinks no other file, so a cache a live run creates meanwhile makes an
  `rmdir` fail, and prune restores the file it just unlinked and reports the root `busy`. The result
  gains `roots[]` (`{root, cwd, registered, removed, reason, bytes, paths, runs, message}`, empty
  without both flags), `--dry-run` lists the roots it would remove without changing anything, the
  text output adds a line per root after the unchanged first line, and an interrupted prune names
  the roots already removed in `error.details.roots`. Internally, `projectRoots()` lists every XDG
  root with its registration or problem, and `projectStateDirectories` is rebuilt on it unchanged.
- `workflow prune` removes finished runs in bulk (#365, split from #166; ADR 0050).
  `workflow prune [--older-than DURATION] [--status S[,S]] [--missing-cwd] [--all] [--refs] [--dry-run] [--json]`
  needs at least one of `--older-than`, `--status` or `--missing-cwd` (a bare prune is `usage.flag`,
  exit 2); `--status` takes only `completed`, `failed` and `cancelled`, defaulting to all three, and
  `--all` scans every registered project. A pure, table-tested selector (`prune-selection.ts`) never
  selects a running, stale or suspended run, one with a waiting step or an inbox file a resume could
  still consume (an answer the record shows consumed, or a quarantined `.rejected.` delivery, does
  not count), or one held by a lock owner, recoverer or live orphan; such matching runs are listed
  in `skipped` with a reason. Each selected run is removed oldest first through `workflow rm`'s
  guarded removal, one at a time and never forced, with `--refs` passed through; a refusal or
  failure of one removal becomes a `skipped` entry and the batch exits 0, while an unreadable runs
  container still fails the command. `--dry-run` takes no lock and changes nothing, and lists
  per-run and total `bytes`. Prune sweeps dead rm tombstones in every scanned container. The result
  is
  `{kind:"workflow.prune.result", dryRun, stateDirs, filters, removed, skipped, bytes, tombstones, warnings}`.
  Internally, `removeRun` gains an optional `expectedUpdatedAt` that prune pins to the record it
  selected, checked on the first read (a dry run too) and under the lock, so a run that changed
  after selection is skipped as `changed` (`run.exists`) instead of removed; rm never sets it. CLI
  durations (`tick --timeout`, `start --start-timeout`, watch bounds and `--older-than`) also accept
  a `d` (day) unit; the existing upper bounds still apply. The operating-runs skill reference gains
  a retention recipe, and a new CLI smoke covers prune.
- A guarded `workflow rm` and on-disk bytes in `workflow list` (#364, split from #166; ADR 0049).
  `workflow rm RUN [--force] [--refs] [--dry-run] [--json]` removes one saved run without importing
  workflow code: the run directory (record, journal, `attempts/` transcripts, artifacts, `launch/`,
  inbox), the legacy `<runId>.json` marker or flat record, `<runId>.json.lock`, `<runId>.inbox`,
  `<runId>.cancel.json` and `<runId>.json.v<N>` backups, and its worktree caches. Caches go through
  the same cleanup as `workflow clean` under the worktree administration lock; a cache Git cannot
  remove while its repository exists stops the removal before the run is deleted
  (`workflow.storage`, exit 74, naming the remaining caches in `error.details.caches`; caches Git
  already removed stay removed, listed in `error.details.removedCaches`, and no ref is deleted), and
  when the repository is gone rm deletes the run's caches in their namespace directly, only when
  each is a real directory named by a digest that matches its ledger key. Pins are deleted only with
  `--refs`; otherwise the result lists them as `keptRefs`. rm refuses with exit 3 `run.locked` while
  any lock owner or recoverer is alive, unverifiable or remote, even with `--force`, and
  `run.orphans` for a dead owner's live recorded child. The new code `run.active` (exit 3) refuses,
  without `--force`, a running or suspended run or one with a waiting step. Holding the legacy
  guard, rm deletes the flat file before renaming `<runId>/` to a dotted
  `.<runId>.<pid>.<uuid>.removing` tombstone, so `list` and `inspect` see an intact run or none, and
  each rm sweeps the tombstones of dead removals. A `workflow answer` that links its delivery while
  rm removes the run re-reads the run afterwards and fails with `answer.conflict`, withdrawing the
  delivery only while its path still holds an envelope addressed to the removed run. Answer
  envelopes gain an optional `runCreatedAt`, the `createdAt` of the run the writer addressed, and
  the owner rejects a delivery whose `runCreatedAt` differs from its own, so no answer outlives the
  run to resolve a later run that reuses the ID; envelopes without it are still accepted.
  `workflow start` checks for an existing run and creates its launch files under the run's legacy
  guard, refusing with `run.locked` while an rm of that ID is in progress, so rm never renames a new
  launch directory into its tombstone. `--dry-run` takes no lock, writes nothing and exits 0 with
  the verdict, paths, caches, refs and bytes. `workflow list --json` rows (compact and `--full`)
  gain `bytes`, the apparent size of the run's files in its runs container excluding worktree caches
  (null with a warning when unmeasurable), and the text view gains a `SIZE` column. A new CLI smoke
  covers rm and list bytes.
- Docs and CLI drift (#165). `workflow list-defs` discovers `*.workflow.mts` and `*.workflow.cts` as
  well as `*.workflow.ts` (never `.d.ts` or `.tsx`), matching the extensions the golden path tells
  agents to use. The `configuration get` and `configuration set` placeholder commands, which only
  printed "not implemented yet" and exited 2, are removed, so `configuration --help` lists only
  `doctor`; the internal `StubExecutor` and the unused `src/harnesses/index.ts` re-export are
  deleted. `skills:check` requires the `patterns.md` index table to link every H2 recipe section,
  and the five missing rows (commands and test verdicts, file snapshots, hash guard, GitHub
  snapshots, Workflow Lab recipes) are added. Corrections: the README's checkpoint paragraph now
  says new runs use storage format 7 with replay contract 6 and lists which older formats resume and
  seed forks; the docs and skills teach `--harness-limit` instead of the hidden `--provider-limit`
  alias (still accepted); closed-issue links and their history are removed from the skills; ADRs
  0002, 0005 and 0006 link forward with "Superseded in part by".
- Agent-facing docs for porting and burning down work (#164). Both skill copies gain
  `references/porting-native-workflows.md`, which maps native Workflow's `agent`, `parallel`,
  `pipeline`, `phase`, `log`, `args`, `budget`, model and effort, worktree isolation, `agentType`,
  `workflow()`, `resumeFromRunId` and null-on-failure to quiet-choir, lists the parity gotchas, maps
  the `merge-down-pr` and `execute-epic-ticket` reference workflows onto `quiet-choir/github`, and
  shows a compiled exec role with its `--grant` command and a bounded loop under run caps. The
  Claude skill's native comparison is now a present-tense decision table; it states that native
  `budget` is a hard token ceiling, unlike quiet-choir's cost and attempt caps, and that restricted
  calls see no CLAUDE.md, MCP servers, plugins, skills or memory unless a profile opts back in. Two
  recipes join `examples/patterns/` and `patterns.md`: `ci-gate.workflow.ts` waits for CI with
  `gh.waitChecks` under head-SHA-keyed IDs, fixes, pushes and takes the new head from
  `git rev-parse`, and `ticket-loop.workflow.ts` works one epic ticket per run with
  `gh.epic.snapshot`, `nextTicket` and `gh.issue.close`, with a shell driver that keeps one state
  directory per repository and epic and stops when the epic points back to a ticket it already ran,
  and the costs of the in-run `ctx.workflow` alternative. The skills check's `sourceExample` now
  maps `quiet-choir/github` beside the runtime it maps the root to, so fences can import it.
  `waits.md` says an observer's own `child_process` spawn is neither registered for orphan recovery
  nor stopped with the observation unless given its `signal`, and `child-workflows.md` cites only
  the open #18.
- `quiet-choir/github` adds an epic snapshot and a pure next-ticket selector (#163, slice D of #21;
  ADR 0048). `gh.epic.snapshot(id, { number })` is one `ctx.exec.json` over a fixed `gh api graphql`
  (`-F number=N`, no pagination), labelled `{ integration: 'github', op: 'epic.snapshot' }`,
  returning a compact snapshot: the epic's sub-issues with state, labels, assignees, blocked-by
  relations, linked pull requests, "Depends on #N" / "blocked by" / "requires" references and
  `<!-- epic:depends-on -->` markers from bodies and comments, and the viewer's
  `<!-- epic:split a,b -->` markers, ordered by the epic body's checklist (fenced and inline code
  ignored). An epic without sub-issues falls back to its `- [ ] #N` checklist
  (`source: 'task-list'`). Any truncated connection, or fewer sub-issues listed than
  `subIssuesSummary.total`, throws `IncompleteCollectionError` instead of shrinking; the read's
  `maxOutputBytes` defaults to 8 MiB. The pure
  `nextTicket(snapshot, { order, holdLabels, outside })` picks the first `in-flight` item (an open
  linked pull request), else a `close-split` parent whose slices have all closed, else the first
  `ready` item, and lists every other open item in `skipped` with its reason (`waiting` with
  `waitingOn`, `held`, `split` with `openSlices`, `other-repository`, `not-a-sub-issue`, or a later
  `in-flight`, `close-split` or `ready`); `done` is true only when every item is closed, and a
  snapshot with fewer items than its total throws. A dependency outside the epic counts as open
  until `outsideReferences(snapshot)` is read and passed as `outside`. `parseEpicChecklist`,
  `parseDependencies`, `parseSplit`, `epicSnapshotResponseSchema` and the snapshot, selector and
  `Raw*` types are exported, and
  [`examples/patterns/next-ticket.workflow.ts`](examples/patterns/next-ticket.workflow.ts) composes
  the reads with the selector.
- `quiet-choir/github` adds pull request and check writes (#162, slice C2 of #21; ADR 0047):
  `gh.pr.create` (reconciled: returns the pull request carrying its marker in any state and base,
  else an open one for the same head and base, and only otherwise opens one), `gh.pr.edit`
  (check-then-act on `expectHead`, patching only the fields that differ), `gh.pr.merge` and
  `gh.checks.rerunFailed`. The merge is `PUT .../pulls/N/merge` with `sha` and `merge_method`, never
  `gh pr merge`, auto-merge or a merge queue: a pull request already merged at `sha` returns its
  merge commit with no second `PUT`, one merged at another head throws, and a closed pull request, a
  moved head (also GitHub's 409) or GitHub's 405 return `{ merged: false, reason }` as data; any
  other refusal throws. After a merge it reads until GitHub reports it merged (20 reads, 3 seconds
  apart). `rerunFailed` reruns completed failed runs of a commit at or below an explicit `attempt`
  baseline and skips runs past it, so a retry, resume or later round does not rerun a run that
  started at the baseline twice; a run below the baseline that was rerun before a crash and failed
  again can be rerun again (pass the lowest failing attempt for strictly once-only reruns). Each op
  is one version-identified `ctx.step` (`github.pr.merge/1` and so on) over `gh api` through the
  step's `context.exec`, so `--dry-run` lists its commands without spawning. The client gains
  `pr.create`, `pr.edit`, `pr.merge` and `checks.rerunFailed`, with their option and result types
  exported, and the [guarantees table](docs/github.md#guarantees) names a class (reconciled,
  conditional check-then-act or atomic, at-least-once) for every write.
- `quiet-choir/github` adds reconciled writes (#161, slice C1 of #21; ADR 0046): `gh.comment`,
  `gh.thread.reply` (resolving bot threads by default, human threads only with `resolve: true`),
  `gh.issue.create` (with an optional same-repository `parent` sub-issue link),
  `gh.issue.close`/`gh.issue.reopen` (conditional on `ifState`, with an optional comment) and
  `gh.alert.dismiss` (reason from the alert's path unless given; comment truncated to 280
  characters). Each is exactly one `ctx.step`, identified by a version constant such as
  `github.comment/1` rather than callback text, labelled `{ integration: 'github', op }`, and runs
  its gh commands through the step's `context.exec`, so `--dry-run` lists them without spawning.
  Writes that create something append the marker `<!-- quiet-choir:RUN/STEP -->` and search for it
  first, so a retry or resume after a crash between GitHub's commit and the checkpoint finds the
  earlier write instead of repeating it; the others read the state and act only when it still needs
  to change. Request bodies go to gh on stdin, never in argv. `github(ctx, ...)` now takes
  `Pick<WorkflowContext, 'exec' | 'poll' | 'step'>`, so a caller passing a narrowed context must
  also pass `step`. `alertDismissReason`, `GithubWritePolicy` and the write option and result types
  are exported; [GitHub writes](docs/github.md#writes) has the per-op guarantees table.
- `quiet-choir/github` adds head-pinned waits (#160, slice B of #21; ADR 0045).
  `gh.waitChecks(id, { pr, sha, ... })`, `gh.waitPr(id, { pr, sha, until, ... })` and
  `gh.waitReview(id, { pr, sha, since, reviewers, ... })` are each exactly one `ctx.poll`, so one
  `wait` record however many checks, and take exactly one of `timeoutMs` and `deadline`. No wait
  reports `success`, `clean` or `merged` for a head other than `sha`: another head ends the wait
  with `head-moved`, after an optional `staleGraceMs` in which an ancestor head (GitHub compare
  `ahead`) is a stale view. `waitChecks` rolls up the head's checks (`failure` only once nothing is
  pending, `no-checks` only after `graceMs`, failed checks with URL and Actions run ID); `waitPr`
  reports `merged` only for the pinned head and a pull request closed without merging as `closed` at
  once; `waitReview` waits for every `ReviewerBot` to be final, commits those verdicts, then reports
  untriaged threads and open alerts on the next check. A deadline returns `timeout` with the last
  progress. Each wait tolerates 5 consecutive transient gh errors by default, classified from typed
  facts. `codexReviewer()` and `codeqlReviewer({ settleMs, checkName })` port `merge-down-pr`'s
  rules, with Codex's two-check debounce and the CodeQL settle start kept in the wait's note, so
  they survive suspend and tick. Codex judges every summary row for `sha`, and CodeQL's
  `no analysis found` waits for the check and settle window instead of passing at once. `waitChecks`
  and `waitReview` read the head through a focused `pr.head` GraphQL read, so unrelated truncated
  fields such as closing issues never fail them. Grace, stale grace and settle use the wall clock,
  not `RunOptions.clock`. `github(ctx, ...)` now takes `Pick<WorkflowContext, 'exec' | 'poll'>`, so
  a caller passing a context with only `exec` must also pass `poll`. The new REST and state response
  schemas and `Raw*` types are exported.
- Built-in helpers can give a poll an internal versioned identity (`poll-identity.ts`, a registry
  symbol): its wait request's `observe` digest is then that value's, not the observer's or `done`'s
  source text (#160; ADR 0045). The request schema is unchanged and every other poll keeps its
  identity. `test/builtin-identity.test.ts` pins the three GitHub wait fingerprints.
- New `quiet-choir/github` subpath: typed, complete-or-throw GitHub reads over the installed `gh`
  (#159, slice A of #21; ADR 0044). `github(ctx, { repo })` offers `repo.info`, `pr.view` (closing
  issues and summarized head checks), `pr.list`, `pr.reviewThreads`, `issue.view` (optionally with
  every comment) and `codeScanning.alerts`. Each read is one `ctx.exec.json` over `gh api` argv with
  the caller's ID, no environment overlay or stdin, so its identity is the argv, the response schema
  and the fixed exec defaults. A connection that reports another page throws
  `IncompleteCollectionError` (branded) and is never checkpointed; code scanning that is not set up
  returns `status: 'unavailable'` as data, and every other gh failure rejects. `HOST/OWNER/REPO`
  adds `--hostname`. The response schemas, `parseGithubRepo` and `summarizeChecks` are exported.
  `examples/patterns/github-snapshot.workflow.ts` is rewritten on these reads, and
  [GitHub reads](docs/github.md) documents them.
- `ExecOptions.meta` records JSON labels on a `ctx.exec` step, like `StepDefinition.meta`, outside
  identity and policy (#159; amends ADR 0027). A callback's or observer's `context.exec` rejects
  `meta`, since it writes no step record. Compact `inspect` lines now show an integration label such
  as `github.pr.view` for a completed labelled command instead of its program name.
- Breaking: Codex has one effort option, and `reasoningEffort` is renamed to `effort` everywhere
  (#341, part of #158; amends ADR 0011). Migrate as follows:
  - Call options, profiles and defaults: Codex `reasoningEffort: X` becomes `effort: X`.
    `CodexOptions.effort` accepts
    `'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`; Claude's `effort` keeps the
    shared levels, so `'none'` and `'minimal'` are type errors there. The "Set effort or
    reasoningEffort, never both" error is gone: a call-site Codex `effort` now replaces one
    inherited from profile defaults.
  - Policy overrides: `PolicyOverride.reasoningEffort` becomes `effort`
    (`--policy '{"kind":"codex","effort":"high"}'`). It is still Codex-only: a `claude`, `step` or
    `exec` rule rejects it and an unscoped rule never changes a Claude call. The
    `--allow-model-override` error now reads "Model and effort policy overrides require
    allowModelOverride (--allow-model-override)."
  - Attempt records: `AttemptPolicy.reasoningEffort` becomes `effort`. A Codex call-site `effort`
    now enters the policy as `call-site`, so `attempt.effort` and `sources.effort` record it;
    before, only `reasoningEffort` reached the attempt record. A delegated child role now inherits
    its parent role's Codex `effort` when it sets none.
  - A runtime `reasoningEffort` on a call, profile, defaults block or incoming policy rule fails
    before any effect with "reasoningEffort was renamed to effort; use effort (accepts
    none/minimal/low/medium/high/xhigh/max)."
  - Old data still loads: attempts, saved policy rules and capability manifests (run records and the
    definition registry) written with `reasoningEffort` read back as `effort`, and a record holding
    both keys is rejected. The checkpoint format stays 7 and new writes carry `effort`, so a runtime
    from before this change cannot read attempts written after it. Attempt `sources` keys are
    historical provenance and keep their recorded names.
  - Identity: Codex `effort` keeps the `reasoningEffort` identity slot, so Codex calls recorded with
    `reasoningEffort` resume unchanged after the source is migrated. Codex calls recorded with the
    old shared `effort` change identity once: resume reports
    `option.effort, reasoningEffort changed on a completed step`, and `--accept-code-change` cannot
    reuse them. Recover with `--fork-from RUN --reuse matching --invalidate STEP`, which re-runs
    only those calls. Claude effort identity is unchanged.
- Breaking: `worktree` is the only agent checkout selector, and `isolation` is only the native
  configuration mode (#340, part of #158; amends ADR 0023). Migrate as follows:
  - `isolation: 'worktree'` and `worktree: 'worktree'` become `worktree: true`.
  - `isolation: { kind: 'worktree', base }` and `worktree: { kind: 'worktree', base }` become
    `worktree: { base }`; `{ kind: 'worktree' }` without a base becomes `worktree: true`.
  - `isolation: handle` becomes `worktree: handle`.
  - `AgentOptions.isolation` is now `HarnessIsolation` (`'restricted' | 'inherit'`) and
    `AgentOptions.worktree` is `AgentWorktree` (`true | WorktreeCreateOptions | WorktreeHandle`).
    Steps and exec still take only a `WorktreeHandle`.
  - The old spellings are type errors but still run: they normalize to the same step identity, so an
    in-flight run recorded with one resumes after the source is migrated, even under
    `--accept-code-change`. Supplying both `worktree` and a legacy worktree `isolation` still fails
    before the harness runs, now naming the `worktree` forms.
  - `WorktreeIsolation` and `AgentIsolation` are no longer exported; use `AgentWorktree`,
    `WorktreeCreateOptions` or `HarnessIsolation`. The harness kit's `resolveIsolation` declares its
    parameter with those public types; it still normalizes the legacy values at runtime.
- Breaking: `ctx.map` has one named form, and `onError` is split into a result mode and
  `cancelSiblings` (#339, part of #158; amends ADRs 0008, 0009 and 0041). Migrate as follows:
  - Positional `ctx.map(items, n, mapper[, options])` is removed: use
    `ctx.map(id, items, { concurrency: n }, mapper)`. Named maps prefix each item's step IDs with
    `id/key/`, so a migrated workflow needs a new run or a deliberate fork. A positional call is a
    type error and fails at runtime with a message showing the named form.
  - `onError: 'settle'` is now `onError: 'return'`. Neither enters the map journal's identity, so
    journals are byte-identical and in-flight runs replay after the edit; `'settle'` is still
    accepted at runtime but is no longer typed.
  - `onError: 'drain'` is the default (omit it) and `onError: 'abort'` is `cancelSiblings: true`.
    Both old values now fail validation with a message naming `'throw'`, `'return'` and
    `cancelSiblings`. `FanOutError.policy` keeps its `'drain'`/`'abort'` values.
  - New: `onError: 'return'` with `cancelSiblings: true` cancels only that map's subtree after the
    first failure and still returns the full `Settled[]`. A sibling that resolves anyway keeps its
    value, a cancelled sibling returns `kind: 'cancelled'` with its cancelled step's ID, and an
    unstarted item returns `kind: 'cancelled'` with `attempts: 0` and a null `stepId`. A resume that
    finds a committed failure cancels the unfinished items before scheduling them.
  - A mistyped `onError` now reports the valid literals instead of "No overload matches this call".
  - `SettledMapOptions` and `SettledNamedMapOptions` are no longer exported; `MapOptions` carries
    `onError`, `cancelSiblings` and `version`.
  - Durability lint rule QC006 (positional `ctx.map`) is retired and its code reserved; the lint
    reports QC001-QC005.
- The published harness-kit declarations are complete, and the kit exports the helpers adapters
  re-implemented (#157; ADR 0043, amends ADR 0023). `dist/harness-kit.d.ts` re-exported 16 helpers
  (`attachHarnessEvidence`, `boundedResponse`, `validateAgentOptions`, `environmentEdits`,
  `checkAllowedTools`, `tomlLiteral`, `effortValues`, `codexEffortValues`, `permissionModeValues`,
  `snapshotImages`, `resolveIsolation`, `matchesStepGlob`, `knownSum`, `measurement`,
  `normalizeUsage`, `usageObject`) whose declarations `stripInternal` removed, so consumers saw
  TS2305 or `any`; they are now documented public API, `HarnessEvidence` is exported as a type, and
  the root entry no longer names the internal `lockRun` or an undeclared `BuiltinAdapter`, which is
  now exported from `quiet-choir` as a type. `test/public-types.test.ts` compiles a consumer of
  every export of `quiet-choir`, `quiet-choir/harness-kit` and `quiet-choir/decision` against
  freshly emitted declarations with `skipLibCheck: false`. New harness-kit exports: `JsonLines`
  (byte-bounded JSONL framing), `childEnvironment` and the `ScrubEnvironment` type,
  `createInvocationStream` (the `onOutput` tee, `onSession`-once and throttled `onProgress`
  contracts, now shared with the built-in adapters), `standaloneInvocation`, `outputLimitError` and
  `outputLimitCode` (the documented `QUIET_CHOIR_OUTPUT_LIMIT` contract behind the `output-limit`
  kind), and `promptedStructuredOutput`. `structuredOutput: 'prompted'` now has a defined meaning:
  the adapter prompts for and extracts the JSON, and the runtime parses and validates
  `response.text` exactly as for `'native'`, without rewriting prompts. Behavior change: the
  host-session scrub for built-in Claude and Codex children and doctor probes now matches patterns,
  removing every `CLAUDE_CODE_*` name except `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_CODE_SUBAGENT_MODEL`, plus `CLAUDE_PLUGIN_*`,
  `CODEX_INTERNAL_*` and `CODEX_COMPANION_*`. Host settings such as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
  no longer reach children; restore one with `env.set`, or disable scrubbing with `scrubEnv: false`.
- Claude attempts now record the subscription rate-limit windows the CLI reports (#156). The latest
  valid stream `rate_limit_event` of an attempt is kept in `attemptHistory[].diagnostics.rateLimit`
  as `{ status, type, resetsAt, windows }`, where `windows` maps a name such as `five_hour` or
  `seven_day` to `{ utilization, resetsAt? }`; `resetsAt` stays Unix epoch seconds as reported.
  Strings are cut to 64 characters, at most 8 windows are kept, and a malformed or empty event is
  ignored without failing or changing the call. `agent.finished` carries it and the `--progress`
  line appends `rate-limit: 5h window 22%, 7d 67%`. `inspect --json --summary` gains an optional
  per-harness `rateLimits` map (absent when nothing was reported, so other runs serialize as before)
  and text inspect prints a `Rate windows claude: ...` line after the usage lines. Only Claude
  reports windows; Codex attempts are unchanged. This is observation only: no checkpoint schema
  change, and run caps still measure USD and attempts. The utilization gate and suspend-until-reset
  follow-up is #168. The new `claude-rate-limit-success` fixture is a live subscription capture
  (Claude Code 2.1.286).
- Agent attempts can enforce an output idle deadline and report their tool use (#109; ADR 0042,
  amends ADR 0007 and ADR 0010). `idleTimeoutMs` is accepted on workflow `defaults`, profiles, call
  options, `--profile name.idleTimeoutMs=N` (`profileOverrides`) and agent `--policy` rules (rules
  with `kind: 'step'` or `'exec'` reject it). It is off by default and is execution policy outside
  step identity, so a resume can raise it; children inherit the parent's value as a ceiling.
  `runProcess` (and so `CliHarness`) arms it once the prompt is written and re-arms it on every
  stdout/stderr chunk, never counting time a stream consumer holds a chunk; on expiry the group is
  stopped like `timeoutMs` with code `QUIET_CHOIR_IDLE_TIMEOUT`. The failure has the new error kind
  `idle-timeout`, which `retry.on` can name and which joins the `'transient'` set and `retryable`
  failure documents; its message suggests `--resume --profile <role>.idleTimeoutMs=<double>`.
  Request summaries record `limits.idleTimeoutMs`, and `inspect` prints `idle timeout`. Each agent
  attempt's diagnostics now include `toolUses`, counted from the parsed stream (Claude `tool_use`
  blocks by ID, excluding the `StructuredOutput` carrier of structured calls; distinct Codex
  `command_execution`, `file_change`, `mcp_tool_call` and `web_search` items). When a profile's
  `expectsToolUse` is true and a completed attempt reports zero tool calls, the step records a
  `no-tool-use: ...` warning, the completed `agent.finished` event carries the step's `warnings`,
  the CLI logs it at warn level, and `inspect --summary` agent rows gain optional `toolUses` and
  `warnings` (text: `tools N`). The `expectsToolUse` default changes: it is true when a profile
  grants more than the text baseline (any Claude tool, or a Codex sandbox beyond read-only), so the
  built-in `text` profile now resolves to false and `readonly`/`edit` to true. A Codex attempt now
  keeps the CLI version found by version discovery instead of recording `cliVersion: null`.
  `CliHarnessPlan` gains `idleTimeoutMs`, and `ProcessRequest`, `AgentOptions`, `ProfileLimits`,
  `ExecutionPolicy` and `PolicyOverride` gain an optional `idleTimeoutMs`.
- Authoring types now match runtime strictness (#155; amends ADR 0010 and ADR 0027). This is a
  source-level break: code that compiled but failed when the call ran now fails typecheck, and
  `workflow validate` (and `execute`'s check) with `load.typecheck`, even in a branch that never
  runs. Under the default `strictProfiles`, `ctx.claude`, `ctx.codex` and `ctx.agent(name)` options
  omit the capability keys strict profiles own (`isolation` keeps every value except `'inherit'`);
  only a literal `strictProfiles: false` types them. `ctx.agent(name)` profiles accept only built-in
  or declared roles. By-name `ctx.workflow(id, name, input)` checks the name and input against the
  declared `children` and infers the child's output; a workflow without children rejects it, while a
  bare `WorkflowContext` or an erased `WorkflowDeclaration` child falls back to JSON. The built-in
  `capabilityKeys` gain the keys the runtime already rejected (Claude `permissionMode`, `agent`,
  `strictMcpConfig`, `addDirs`; Codex `addDirs`) and share one list with the runtime check, exported
  as `claudeCapabilityKeys` and `codexCapabilityKeys`; runtime behavior, messages and identity are
  unchanged. New type parameters: `WorkflowContext` `TStrict` and `TChildren`, `WorkflowDefinition`
  `TStrict`, `TChildren` and `TName`, and `HarnessDefinition` `K` (inferred by `defineHarness` and
  `defineWorkflow`). New public types: `CallOptions`, `CapabilityKeysOf`, `ChildNamesOf`,
  `ChildInputOf` and `ChildOutputOf`. `defineHarness` defaults `K` to the widened key list, so an
  omitted `capabilityKeys` or explicit `<N, O, C>` type arguments forbid nothing at type level (the
  runtime check still applies). Explicit `defineWorkflow` type arguments are all-or-nothing: with a
  shorter prefix such as `defineWorkflow<Input, Output>`, the rest take the strict, childless
  defaults, so `strictProfiles: false` or a nonempty `children` list fails typecheck; drop the type
  arguments (preferred) or spell all seven. `runWorkflow` keeps its four-argument
  `<Input, Output, Profile, Harnesses>` form as an overload.
- `workflow validate` runs a static durability lint after a clean type check (#154; ADR 0041). Rules
  QC001-QC006 report a discarded effect promise, a nondeterministic read in the workflow body
  (`Date.now()`, `new Date()`, `Math.random()`, `performance.now()`, `crypto.randomUUID`,
  `process.env`, `fs` `*Sync`), a durable call inside a step `run` or poll
  `observe`/`done`/`onError` callback, `Promise.race`/`any` over durable calls, a literal effect ID
  reused or repeated in a loop on the root context, and the deprecated positional `ctx.map`.
  Receivers resolve by type, and the callback `context.exec`, `ctx.exec` with `onError: 'return'`
  and the command form of `ctx.poll` are not flagged. Any finding fails `validate` with
  `load.typecheck` (exit 4) before import, printing `path:line:col - error QCnnn: message`;
  `validate --json` failures carry `{rule, category, file, line, column, message}` entries in the
  existing `diagnostics` array, and a successful validate result now has `diagnostics: []`.
  `execute`, `resume`, `answer --resume`, `start`'s runner, `tick` and `check-resume` log the
  findings as `warning QCnnn` lines and run; `list-defs` and execution by name list and run such
  definitions and warn when they validate them. `// quiet-choir-ignore QCnnn <reason>` on the line
  before a finding silences that rule there. `WorkflowFailure.diagnostics` widens to compiler or
  durability diagnostics, and `ValidateWorkflowPlan` gains optional
  `durabilityLint: 'error' | 'warn'`. The new `npm run durability:check` (in `npm run check` and CI)
  keeps `examples/` and the Workflow Lab ports lint-clean; Batch 01's positional maps carry reasoned
  QC006 suppressions.
- `ctx.merge` can set the integration commit's message and author (#153; amends ADR 0022):
  `MergeOptions.commit` (new public type `MergeCommitOptions`) takes `{ message, author? }`, where
  `author` is `'quiet-choir'` (default), `'git-config'` (`git var GIT_AUTHOR_IDENT` and
  `GIT_COMMITTER_IDENT` from git config; a failure fails the step) or `{ name, email }`. The message
  goes on the squash commit or the last clean integrate commit; the identity applies to every commit
  the merge creates. It is resolved once and recorded in the new optional `MergePreparation.commit`
  (new public type `MergeIdentity`), so a retry or resume reproduces the same commit ID. A no-op
  merge ignores it. Merges without `commit` keep the `quiet-choir <quiet-choir@localhost>` identity,
  their generated messages and their step identity digest. docs/worktrees.md has a new "Open a PR
  from an isolated change" recipe that pushes `result.commit` with `--force-with-lease`.
- Worktree policy can be declared on the root workflow definition (#152; amends ADR 0022 and ADR
  0035): `defineWorkflow({ worktrees: { setup, keep, root, captureExclude } })`, validated when the
  workflow loads (`workflow validate`), outside step identity, and ignored on child definitions.
  `RunOptions.worktrees` overrides it field by field. `workflow execute`, `start` and `resume`
  accept `--worktree-keep all|failed|none` and `--worktree-root DIR`; both are recorded in the
  launch policy (`LaunchPolicy.worktrees`), inherited per field by `resume`, `answer --resume` and
  `tick`, and repeated on emitted resume commands. Capture now leaves out the untracked paths that
  `setup` created (recorded as `setupPaths` on the ledger cache entry, so a resume excludes them
  too) and the new `captureExclude` glob pathspecs, so a setup-created `node_modules` symlink is no
  longer committed or merged. A captured symlink pointing outside the repository adds a worktree
  warning, and a resume requesting a different cache root than the pinned one warns instead of
  silently keeping the old root. New public fields `WorktreePolicy.captureExclude` and
  `WorkflowDefinition.worktrees`; `WorktreeLedger` cache entries gain optional `setupPaths`.
- `ctx.poll` (and `ctx.wait`'s `poll` source) has a command form (#151; amends ADR 0020):
  `{ input, schema, every, timeoutMs | deadline, command, output, done, commandOptions?, live? }`.
  Each check runs `command` through the run's process runner like an observer's `context.exec.json`,
  owned by the wait for orphan recovery and stopped with the observation's signal, with
  `observeTimeoutMs` as its timeout; `done(output, previous)` decides the outcome and must be pure.
  A failing command is an `ExecError` (`process`, `output-limit` or `schema`) that the poll's
  `onError` may tolerate. Under `--dry-run` each check is synthesized from `output` or answered by
  an exec fixture rule, listed in `commands` under the wait ID, and `live: true` runs it for real.
  New public types `CommandPollSource`, `CommandPollOptions` and `PollCommandExecOptions`;
  `WaitSources.poll` accepts either form; `PollSource` gains `command?: never`; `PollRequest` gains
  optional `command` (the prepared `ExecSummary` and the `output` JSON Schema, with `observe`
  holding `done`'s digest); `PendingWait` and `workflow pending` rows gain `command`. The command
  and its options are validated when the wait opens. Observer-form requests and identities are
  unchanged.
- Step callbacks and poll observers can run commands through `context.exec(argv, options?)` and
  `context.exec.json(argv, { schema })` (#150; amends ADR 0027 and ADR 0016). They take `ctx.exec`'s
  command and options without an ID, `worktree` or `retry`, go through `RunOptions.execRunner` (or
  `processRunner`) with the same defaults, caps, environment overlay and `QUIET_CHOIR_*` metadata,
  and register their children under the parent step or wait and attempt, so orphan recovery covers
  them. They are not durable: no checkpoint or step record is written and every rerun of the parent
  runs them again. A failure throws `ExecError` into the parent attempt; `onError: 'return'`
  resolves to an unsaved `{ ok: false, error: ExecStepError }`. A command still running when its
  callback or observation settles is terminated, and a call after that rejects. Under `--dry-run`
  they are synthesized or answered by exec fixture rules like `ctx.exec`, except an observer call
  with `live: true`, which runs for real. New public types `StepExecFunction`, `StepExecOptions` and
  `PollExecOptions`; `StepContext` gains `exec`; `PollContext` gains `exec` with `live`;
  `ProcessRunRequest` gains optional `nested`; `WorktreeSetupContext` no longer includes `exec`.
  Rehearsal `commands` entries gain `parentStepId` and the `outputSource` value `live`. Identities
  are unchanged.
- `ctx.exec`, `ctx.exec.json`, `ctx.readFile` and `ctx.writeFile` accept `onError: 'return'` (#149;
  amends ADR 0007). A final failure, after retries, is saved as `settled-failed` and replays on
  resume without running the command or touching the file, like settled local and agent calls; fork
  reuse and `--invalidate` treat it the same way. Commands return
  `Settled<ExecResult, ExecStepError>` and `Settled<T, ExecStepError>`; the new public
  `ExecStepError` adds optional `code`, `signal`, `stdoutTail` and `stderrTail` (1024 characters
  each) and, for `exec.json`, `parsed`: stdout as raw JSON when it was complete, valid and at most
  16384 UTF-8 bytes. `ExecError` gains the same optional `parsed`, and `EffectResult` gains a
  defaulted error type parameter. A command timeout settles with kind `timeout`; cancellation, a
  missing process adapter and checkpoint failures still reject. `onError` enters identity only as
  `'return'`, so existing calls keep their fingerprints. The command-verdict and guard-mutation
  recipes now use `onError: 'return'` instead of `okExitCodes: 'any'`. `workflow fixtures` does not
  export settled-failed commands yet (#306), so a `"commands": "fixture"` replay of such a run fails
  at that step.
- `--dry-run` synthesizes worktree-isolated agent calls and merges of their unchanged changes
  instead of failing (#148; amends ADR 0016). A fresh isolated Claude or Codex call is planned in an
  absolute placeholder directory that is never created and returns
  `{ base, commit: null, ref: null, files: [] }`; `ctx.merge` over unchanged changes returns
  `{ commit, merged: [], conflicts: [] }` with `commit` the target branch or `HEAD`. The base comes
  from a read-only `git rev-parse` (the runtime refuses every other Git command under rehearsal), an
  unresolvable base fails with the real configuration error, and outside a Git working tree a
  forty-zero placeholder base is used with a warning. No refs, worktrees or cache directories are
  created. Report calls gain `worktree` (`{ synthesized: true, base, baseSource }` or null), the
  report gains `merges`, and `RunOptions.rehearsal` gains an `onWorktree` observer. `ctx.worktree`,
  handle-isolated effects and merges of captured commits still fail with a configuration error whose
  message now names what dry-run synthesizes. The CLI passes the real process runner for that Git
  and the synthesizing runner as `RunOptions.execRunner`, so `ctx.exec` still never spawns, and it
  prints the rehearsal warnings and `Rehearsal: ...` summary on a failed dry-run too, with
  synthesized isolated-call and merge counts when nonzero.
- Fixture files can answer commands (#147; amends ADR 0016). A new optional `exec` array holds
  first-match command rules (public `FixtureExecCall` type) filtered by step glob, exact
  `argvPrefix`, `envSha256`, `inputSha256`, `attempt` and per-rule `occurrence`, each answering with
  `json` or `stdout` plus optional `stderr` and `code`. `--dry-run` uses a matching rule instead of
  synthesis, and `--harness fixture` answers matched commands without spawning through the new
  `RunOptions.execRunner` (worktree Git keeps `processRunner`). With `"commands": "fixture"` an
  unmatched command fails at its step as a configuration error naming the argv, also under
  `--dry-run`; named per-harness fixture files cannot carry `exec` or `commands`. Dry-run `commands`
  entries now carry `outputSource`, `fixtureIndex` and `error`, the report adds `staleExecFixtures`
  with a warning, and the synthesis warning appears only when a command was synthesized.
  `workflow fixtures` also exports completed command results as exec rules with environment and
  stdin digests only, and sets `commands: "fixture"` when it does; runs without commands export as
  before. A fixture `error` rule accepts an optional `kind` (an `ErrorKind`) and then rejects with a
  `HarnessError` of that kind and the same message, so `retry.on` and `StepError.kind` can be
  rehearsed.
- Settled maps name the changed fingerprint component and accept mapper-only edits under
  `--accept-code-change` (#146; amends ADR 0006, ADR 0008 and ADR 0009). A map journal now also
  saves per-component digests (`items`, `mapper`, `version`, `cwd`, and `keys` for a named map) in
  the new optional `MapRecord.components` (public `MapComponents` type); the aggregate fingerprint
  is unchanged, so existing journals still replay, and a matching one gets components backfilled. A
  change after an item committed is refused with `(changed: ...)` in the message. A mapper-only
  change suggests `--accept-code-change` and the thin-mapper idiom (`(item) => handle(ctx, item)`);
  under `acceptCodeChange` it is accepted: committed items keep their saved outcomes, unfinished
  items run with the new mapper, and `codeChanges` gains an entry with the new optional
  `CodeChange.map` field, `components: ['mapper']` and the map's old and new fingerprints. Items,
  keys, version and cwd stay strict. A journal saved before components keeps the refusal and says
  the changed component is unknown. The saved `recoveryHint` suggests `--accept-code-change` only
  for a mapper-only change, and `workflow inspect` prints the last five accepted code changes.
- Default fork reuse (`--reuse prefix`) is now causal instead of closing at the first miss (#145;
  amends ADR 0006). A matching terminal source step is copied when every source step that had
  settled before it launched was copied too, and no step that ran live in the fork settled before
  the fork requested it. Steps in sibling items of a named map never block each other. An unchanged
  12-item, 3-stage concurrent named map now reuses all 36 steps (before: 6), an edit to one stage
  re-runs only that stage, and a `Promise.all` sibling of an invalidated step (such as an
  issue-filing followups step) is reused instead of repeating its side effect. A step launched after
  a missed step settled still runs live, and a sequential chain still re-runs from its changed step.
  Sources saved without launch stamps fall back to `seq` order for each pair. `--reuse matching` is
  unchanged. The `ForkProvenance` schema is unchanged and old records load: `reuseClosed` is now set
  only when the pinned source changed or became unavailable (a target an older build closed on a
  miss stays closed), and `cursor` now counts the steps prefix reuse copied rather than a position
  in source launch order. Named-map items that share mutable state or files must be invalidated
  explicitly; with unchanged code, a concurrent multi-step chain outside a named map can still run a
  few steps live.
- A healed step (failed before, succeeds on resume) now flags only recorded steps launched at or
  after its failure settled, instead of every step with a higher `seq` (#144; amends ADR 0006 and
  ADR 0007). A `Promise.all` sibling launched with the failing step no longer produces a
  `replay.divergence` warning, and `--strict-replay` no longer fails the resume for it. Step records
  gain three optional fields on the public `StepRecord` type, from a run-level settlement counter:
  `launchStamp` (when the body last requested the effect live), `settleStamp` (after its latest
  terminal settlement) and `failureStamp` (its first terminal failure since it last completed). The
  checkpoint format is unchanged. Records without stamps, such as existing checkpoints or a failure
  saved between retries, keep the `seq` rule for that pair. The check is still a conservative
  watermark: a step launched after the failure by unrelated control flow is flagged.
  `workflow resume RUN --strict-replay` is now accepted, equivalent to
  `execute --resume --strict-replay`, and the shared flag description names healed failures.
- `configuration doctor` grades each harness version against the tested range instead of one pinned
  version, always runs the exact-argv probe once `--version` answered, and exits 1 only when blocked
  (ADR 0040; amends ADR 0011). A version inside `testedHarnessVersions` passes; an untested patch of
  the same major.minor warns (`WARN`, exit 0, verdict `usable-with-warnings`); another major.minor,
  an unparseable or prerelease version, a nonzero exit and process warnings fail. Before, any
  untested version failed and skipped the probe, so `zeroInference` was false; now the probe's own
  result and `zeroInference` are reported whatever the version grade, and a probe is skipped only
  when the binary did not answer `--version`. New public fields: `DoctorCheck.status` (`pass`,
  `warn`, `fail`), `DoctorReport.verdict` (`ok`, `usable-with-warnings`, `blocked`),
  `DoctorReport.warnings` and `DoctorOptions.strict`; code that builds a `DoctorReport` by hand must
  supply the first three. `ok` is now `verdict !== 'blocked'`. The new `--strict` flag treats an
  untested patch version as a failure (exit 1). Text output prints `PASS`/`WARN`/`FAIL` per check
  and ends with a verdict line naming the next command; the `--workflow` registry report carries the
  same fields. Probing an untested CLI is no longer gated: the Codex probe has no cost cap, which
  the docs record as a residual risk. `workflow execute` also records one `harnessWarnings` entry,
  naming `configuration doctor`, when `CliHarness` discovers a version outside the tested range.
- `workflow cancel RUN [--force] [--timeout 30s] [--json] [--state-dir DIR]` ends a live local run
  as `cancelled`, which tick observes and never resumes (ADR 0039; amends ADR 0029, under which a
  plain signal saves a resumable suspension). It signals only a lock owner on this host that is
  alive and still has its recorded OS start time: it writes `cancel.json` bound to that owner's lock
  token, re-verifies the owner, sends one SIGINT to its PID, and waits. The owner's executor turns
  that interruption into a cancellation; the owner exits 130. Success returns
  `{kind: 'workflow.cancel.result', ok, runId, stateDir, status, signalsSent, owner}`; a run that
  already ended is a no-op. A foreign, dead, released or unverifiable owner is refused with
  `run.locked` (exit 3), and an unfinished run with no live owner with the new error code
  `run.unowned` (exit 3), which also reports an owner that exited without saving `cancelled`. The
  bounded wait ends with `watch.timeout` (exit 79) and the last saved status; `--force` then sends a
  second SIGINT to the same verified owner. A stale request never cancels a later execution.
  `RunOwnership.owner` and `RunLockView.owner` (and so `inspect --json`) gain `osStartTime`; the
  `inspect` text output is unchanged. `WorkflowExecutorOptions` gains `sendSignal`.
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

- CLI (breaking): `workflow tick` recovers crashed runs and `--json` reports only what the tick did
  (#197, #198). A `running` run whose owner is gone (no lock, or a dead or released owner) is
  resumed through ordinary lock recovery, and a due suspended run behind a lock left by a dead owner
  is resumed instead of skipped; a stale `running` run is recovered or skipped, never reported as
  `running`. The resumed count and the `completed`, `suspended`, `failed` and `incompatible` buckets
  are replaced by `resumed` entries (`{ runId, outcome, nextWakeAt?, message? }` for each run whose
  resume started), `skipped` entries (`{ runId, reason, message?, nextWakeAt? }`) and an `observed`
  count of already-terminal runs. The skip reasons are not due, no longer due, locked, orphans,
  crash-loop, deadline, incompatible and unreadable. `nextWakeAt` goes with not due, no longer due
  and deadline (see `--claim-margin`), and `message` with orphans, crash-loop, incompatible and
  unreadable. `locked` means a live, unknown or remote owner, or incomplete lock metadata. `orphans`
  means the owner is gone but a child process is alive or unverified; tick never kills it, and
  `--run` exits 75. `crash-loop` means 3 consecutive recoveries without a new completed step;
  `--run` exits 1 and `--watch` stops retrying it until an explicit `workflow resume`. Each run
  appears in at most one entry, so a not-due or incompatible run is no longer also listed as
  suspended. A cancelled resume is reported as `cancelled`, not failed. `--run` on a run that
  already failed or was cancelled exits 1, and on one that already completed exits 0. `--max-runs`
  counts only executed resumes. See docs/waits.md.

- Runtime: `RunRecord` has an optional `staleRecovery { count, completedSteps, at }` counter. Tick
  saves it durably under ownership before each stale recovery, and the runner removes it on a clean
  suspension or completion. `inspect` and `list` still derive `stale` without writing it.

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

- Development and test infrastructure: add an internal, opt-in `TypecheckProgramCache` that reuses
  unchanged files' parsing and semantic diagnostics between type checks (#173). The replay-loader,
  registry, doctor and typecheck suites share one per suite, so only their first engine compile is a
  full check, and their timeouts come down. The CLI passes no cache, so its type-check results and
  behavior are unchanged; see CONTRIBUTING.md, "Test timeouts and storage sync".

- Development and test infrastructure: add a per-test state directory fixture,
  `test/setup/state-dir.ts` (#174). Its `runs` scope passes the test's abort signal to `runWorkflow`
  and to forked children, then waits (up to 10 s) for them to settle before the directory is
  removed, so a timed-out test no longer turns into ENOTEMPTY failures. The journal suite uses it,
  and `test/state-dir-fixture.test.ts` forces timeouts to check it. No runtime behavior changes; see
  CONTRIBUTING.md, "Per-test state directories".

- Development and test infrastructure: add a per-test CLI capture fixture,
  `test/setup/cli-capture.ts` (#249). A timed-out `test/cli.test.ts` body kept running and
  re-pointed later tests' console spies and wrote `process.exitCode`, so under load one timeout
  became several empty-stdout failures. The fixture's `cli.run` captures each call's output and exit
  code on its own, refuses calls after its test ends, and drains the call in flight at teardown;
  `test/cli.test.ts` uses it and `test/cli-capture-fixture.test.ts` forces a timeout to check it. No
  runtime behavior changes; see CONTRIBUTING.md, "CLI command capture".

- Development and test infrastructure: shorten the Node 24 coverage CI leg (#286), which took 13m57s
  on `74bf584` (Vitest 819 s, `test/tick.test.ts` alone 527 s). The tick, durability-lint-loader,
  launch-policy, loader, rehearsal, github-waits, cancel, scriptable-errors and exec-fixtures suites
  and the GitHub rehearsal helper now share one program cache per file, which cut the local Node 24
  coverage run from 268 s to 134 s (tick from 226 s to 98 s) and the run without coverage from 96 s
  to 66 s. CI runs the coverage suite in three `vitest --shard` jobs that save blob reports, and a
  coverage-gate job merges them and enforces the unchanged thresholds. On the change's CI run the
  Node 24 coverage critical path fell from 13m57s to 4m43s, 22.13 from 7m25s to 5m49s and 26 from
  5m48s to 4m09s. The coverage slowdown comes from in-process TypeScript compiles under precise
  coverage; coverage-v8 never instruments spawned children. No runtime behavior changes; see
  CONTRIBUTING.md.

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
