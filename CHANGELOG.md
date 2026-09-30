# Changelog

## Unreleased — 0.0.0 prototype

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
