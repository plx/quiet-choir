# Changelog

## Unreleased — 0.0.0 prototype

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
