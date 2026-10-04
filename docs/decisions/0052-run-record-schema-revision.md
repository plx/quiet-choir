# 0052: A run-record schema revision that writers refuse to outrun

- Status: accepted
- Issue: #167 (third slice of the drift work in #131)
- Builds on: [0019](0019-journal-storage-and-project-state.md) (journal storage) and
  [0009](0009-scoped-step-ids.md) (storage formats)

## Context

`parseRunRecord` validates `run.json` with a non-strict Zod object, which drops top-level keys it
does not list, and the owner compacts its in-memory record back to `run.json`. A build that predates
a field therefore deletes it when it resumes a run that a newer build wrote, with exit 0 and no
warning. Fields have been added without a `formatVersion` bump (`worktrees`, `runBudget`,
`children`, `harnesses` among them), and `engine.quietChoir` is the constant `0.0.0`, so nothing
told an older build that the record was newer. Different builds can share a state directory: default
state is keyed by the target project, not by the quiet-choir checkout.

## Decision

**A revision, separate from the format.** Records carry an optional `schemaRevision`, a positive
integer with no cap at the supported value. `SUPPORTED_SCHEMA_REVISION` in `record.ts` is 1, and an
absent field means 1, which covers every earlier record; revision 1's key set includes
`schemaRevision` itself. `formatVersion`, the accepted formats and the replay contract do not
change. The runner stamps the supported revision on new records and, in memory, on a resumed record
after the checks pass, so it reaches disk with the next real save; a completed run is not rewritten
just to stamp it. Reads never fill the field in, so a fork's pinned source digest (the digest of the
read view) stays valid.

**Detect on read, refuse on write.** `parseRunRecord` records the names of unknown top-level keys;
`replayJournal` tolerates journal changes to unknown run-level keys (a newer build journals a field
before compaction moves it into `run.json`), skips them, and tracks whether a later entry removed
them. The names go into a module-level `WeakMap` keyed by the returned record object
(`hiddenRecordFields`); values are never kept. `recordSchemaDrift` combines that with a newer
revision (and any unknown own keys, for a custom store's record). Writers refuse a drifted record
with `run.incompatible`, `details.reason: "record_schema"`:

- `FileOwnedRun.read()`, which every owned writer calls first, covers the runner, tick's claim and
  its stale-recovery write, and `workflow clean`, under the lock and before any append;
- `JournalWriter.prepare` repeats the check before it truncates a torn tail;
- the runner checks next to its format check, for custom `RunStore`s;
- `loadFork`, the dry-run copy, and the executor right after its lock-free read on resume (so the
  refusal precedes the type check and the accepted-change preflight copy);
- `compareResume` adds a `record schema` run-level gate, outside the set `--accept-code-change` can
  accept, so `check-resume` and `checkResume()` report `compatible: false` with the refusal's
  message and `reason`, `schemaRevision`, `supportedSchemaRevision` and `hiddenFields`, instead of
  assuring a preflight that the resume then refuses (the executor returns it as `run.incompatible`);
- tick skips a due or stale run as `incompatible` and maps a refusal from a read to the same skip;
- `workflow rm` refuses only when it would first save the worktree ledger.
- `pinnedFork` does not refuse, because the target run is not drifted: when an existing fork's
  source has drifted since the fork pinned it, reuse closes with a warning and the remaining effects
  run live (the pinned digest covers the record as read, so it cannot see hidden fields).

Read paths (`readRun`, inspect, list, pending) keep working; summaries add a warning and drop resume
and answer follow-ups. When the record has a newer revision or unknown fields and a known field also
fails validation, so the record does not parse, the read error becomes the same refusal with an
upgrade message instead of a Zod error.

**The bump rule.** Adding or changing the accepted shape of any persisted run-level field, nested
fields included, bumps the revision. A unit test ties the sorted top-level keys to the newest
revision in `test/fixtures/schema-revision/record-keys.json` and pins each released revision by
digest, so a new key cannot land without a new revision. Nested shapes are covered by review only.

## Alternatives

- **Preserve unknown fields (passthrough).** Keeping values this build does not understand would let
  it write them back next to fields it changed under different assumptions. The ticket chose
  refusal; the `WeakMap` keeps names only.
- **Refuse in the runner only.** Tick's stale-recovery write and `workflow clean` write after
  `owned.read()` without going through the runner, so the refusal lives in the owned read as well.
- **A strict schema on read.** It would make inspect and list fail on a newer record, which the
  ticket requires to keep working.
- **A format bump per field.** Format numbers gate replay and migration; using them for additive
  fields would force a migration path for every new field.

## Consequences

- Builds with this guard never silently drop a newer build's top-level fields. Builds that predate
  it still do: the guard protects only builds that contain it.
- Tolerating unknown run-level journal keys on read loosens corruption detection for that one case:
  a garbage key now reads with a warning, and every writer refuses the run.
- The `WeakMap` entry is lost on a clone or a re-read; checks run on the object the read returned.
- `answer --resume` delivers its answer file before the resume refuses; a newer build consumes it.
- A record that once carried a since-removed key would be refused. No key has been removed from
  `recordFieldsSchema` so far; the refusal names the key if it happens.
