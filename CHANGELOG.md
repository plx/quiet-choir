# Changelog

## Unreleased — 0.0.0 prototype

- Harness calls settle after bounded output draining and reap owned groups on every exit. Cleanup
  grace defaults to 3000ms, settable with `--kill-grace-ms`. SIGINT/SIGTERM/SIGHUP first drain; a
  second signal synchronously kills tracked groups and exits 130.
- Durable child ownership prevents abandoned-lock recovery beside live agents. Inspection reports
  owner/process liveness; `--resume --kill-orphans` stops only identity-confirmed groups. Refusals
  use exit 3 (`run.orphans`). See [process lifecycle](docs/process-lifecycle.md) for remaining gaps.
- **Harness port migration:** `invoke` and optional `metadata` now receive `HarnessInvocation` with
  `signal`, run/step/attempt IDs and `trackProcess`, replacing the bare signal parameter. Registry
  persistence failures use `CheckpointError.operation: 'process'`; they cannot retry or become
  settled workflow data. Checkpoint format 5 and completed replay remain compatible.

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
  implicit format-5 calls still replay; old explicitly spelled default components can require a new
  run/fork. Completed semantic checks are never bypassed.
