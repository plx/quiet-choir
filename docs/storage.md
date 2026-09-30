# Local journal storage

New runs use storage format 7: one directory per run, an atomic snapshot, and an append-only
journal. The replay contract remains version 6; a storage change does not change effect
fingerprints. The engine still provides at-least-once effects, not atomic transactions with external
systems.

## Find a run

Storage resolution is shared by execution, inspection, and answer delivery:

1. Explicit `--state-dir` or `RunOptions.stateDir`, relative to the run's working directory.
2. `QUIET_CHOIR_STATE_DIR`, with the same relative-path rule.
3. For an existing run ID, its legacy `<cwd>/.quiet-choir/runs` location, with a CLI deprecation
   warning.
4. `${XDG_STATE_HOME:-~/.local/state}/quiet-choir/<project>-<hash>/runs`.

`project` is a bounded, sanitized directory basename. `hash` is the first 12 hex characters of
SHA-256 over `realpath(cwd)`. Symlink aliases share a default root; separate worktrees have separate
roots because their working directories differ. An explicitly configured XDG root or state container
can be inside a working tree. New state containers contain a non-overwriting `.gitignore` with `*`.
Ordinary `git add -A`, `git clean -fd`, and `git stash -u` leave ignored state alone;
`git clean -fdx` still removes it.

The CLI prints the absolute path beside the run ID and includes `stateDir` in execute/resume JSON.
Keep that path when operating from another project. Default `list` and `pending` also look in the
current project's legacy location. `workflow list --all` reads registered XDG projects without
importing workflow modules; rows include their working and state directories. Explicit state
containers are not automatically registered as XDG projects.

```sh
quiet-choir workflow list --all --json
quiet-choir workflow execute --resume --run-id my-run
quiet-choir workflow resume my-run --state-dir /absolute/runs
```

The two resume forms use stored launch paths when no file is supplied. A supplied different file is
refused before import and the error names both paths. Old or embedded runs with no launch metadata
still need `execute FILE --resume --run-id RUN` or their original embedding application. Resume
retains typechecking, code/schema checks, grants, and step identity validation.

## Layout

```text
<project-state>/
  project.json                       # { cwd }, only for default XDG projects
  runs/                              # --state-dir denotes this container
    .gitignore
    <runId>/
      run.json                       # compacted record with storage seq
      journal.jsonl                  # transitions newer than the snapshot
      lock/                          # published whole by one rename
        owner.json
        recovery.json                # only while a recoverer claims a dead owner's lock
        processes/<pgid>.json
      lock.<pid>.<uuid>.tmp/         # an acquire's publish directory; swept once its PID is dead
      lock.<pid>.<uuid>.gone/        # a released or recovered lock's tombstone; swept
      inbox/                         # exclusive answer deliveries
      attempts/<sha256-full-step-id>/<attempt>.<provider>.jsonl
      artifacts/<encoded-id>--<hash>/<attempt>/
      worktrees/                     # reserved; no automatic checkout creation
```

Artifact directories are allocated on demand. Their component uses at most 100 encoded ID characters
and a full SHA-256 of the exact ID, distinguishing case variants on case-insensitive filesystems and
fitting the 255-byte component limit. Artifact writers must create diagnostic files with mode 0600;
their bytes need not be fsynced and are never replay inputs. Native transcripts use the separate
`attempts/` layout, caps, and retention described in [agent streaming](agent-streaming.md). Opt-in
[worktree isolation](worktrees.md) uses its own recorded cache root and pinned Git refs; the default
root stays outside the checkout.

Run records, journals, owners, and answers use 0600; new directories use 0700. Existing permissions
are not repaired. State includes plaintext input, outputs, prompts/previews, and answers. Moving it
outside the workspace prevents ordinary Git cleanup from removing it. Same-user unsandboxed code can
still access it; this is not an authentication boundary for human approvals.

The header keeps canonical CLI entrypoint/tsconfig paths and source hashes, the existing harness
binary/version metadata, and informational `{ quietChoir, node }` engine versions. Harness discovery
uses the existing optional `Harness.metadata` port once per live provider per invocation. Metadata
changes do not affect step identity; no discovery or inference is needed for pure replay.

## Commit and read

The owned writer coalesces concurrent saves. Every waiter settles only after a batch containing its
transition has committed. Journal entries contain a monotonic sequence, timestamp, and changed run
fields, step records, or settled-map records. Only those changes are validated on append; complete
records are validated on read and at initial persistence.

Ordinary attempt starts are appended before work begins, without an fsync. A process crash retains
those bytes; OS crash or power loss may lose them and undercount attempts. Sleep starts are durable
because their wake deadline must not move. Completions, failures, question registration/answers, and
run status changes are fsynced before their corresponding promise or notification becomes
observable. Concurrent outcomes share a flush. A failed append is retried at its prior boundary;
retrying storage never reruns a successful callback or harness invocation in that process.

The writer compacts on status changes or approximately 4 MiB of journal. It flushes a new snapshot,
renames it, flushes the directory, then truncates and syncs the journal. Covered entries left after
a crash are harmless. `run.json` alone can lag an active run: use `readRun` or `workflow inspect`,
which apply journal entries newer than its `seq`. Readers retry if compaction moves the snapshot
sequence during the read. An incomplete final line is ignored; the next writer truncates it before
appending. Corrupt complete lines, sequence gaps, and missing journals are refused.

Only one local owner may write. During legacy migration the engine acquires the legacy guard before
the current directory lock and holds both through release. Native children belong to the current
lock. This ordering prevents an abandoned old lock from bypassing a live current writer. Child
identity checks and conservative orphan recovery remain unchanged. Owner-only cleanup removes
recognized UUID temporary files for that run; unrelated data is retained. Deleting active state
reports the state directory explicitly.

Each lock (the current `lock/` and the legacy guard `<runId>.json.lock/`) changes hands by rename
([ADR 0030](decisions/0030-rename-published-run-locks.md)). An acquire writes and fsyncs
`owner.json` in a private sibling `<lock>.<pid>.<uuid>.tmp/`, then renames it onto the lock path, so
a lock never exists without a complete `owner.json`. Release and dead-owner recovery rename the
verified lock to a `<lock>.<pid>.<uuid>.gone/` tombstone, check its tokens and delete it. A
recoverer first links an atomically written `recovery.json` (`{ pid, host, osStartTime, token }`)
into the dead owner's lock; a live, unknown or remote recoverer holds the lock, and the next acquire
reclaims the marker of a dead one. The next owner sweeps its lock's `.gone` tombstones and the
`.tmp` directories of dead creators; a SIGKILL at any of these steps leaves a run that a plain
resume recovers. An older build's `recovery/` directory is ignored.

## Legacy records

Flat format-6 records migrate automatically on their first compatible resume. The original bytes
remain in `<runId>.json.v6`. A rejecting format-7 marker stays at the old filename so an older
binary cannot silently resume stale state. It is written before publishing the new snapshot. A
pending migration marker can recover its original backup if the first directory snapshot never
committed; a finished marker never substitutes for a missing current checkpoint. Runs migrated from
the flat layout keep delivering answers to `<runId>.inbox/` under the format-6 answer filename, so
pre-upgrade and current writers racing a migration still share one exclusive final path.

Original format-1 runs also migrate, retaining `<runId>.json.v1`. The first migration replays the
body to verify the original per-step dependencies, schema, retry settings, and raw agent options,
then records current identities. It does not invent old attempt timing or callback hashes. Original
attempt counts are retained. A changed original step still refuses reuse. A completed migrated run
subsequently takes the ordinary completed fast path.

Format 1 stored only an aggregate code/schema fingerprint. If it differs, explicit
`--accept-code-change` is required, while name, version, cwd, input, and original step checks remain
in force. Older CLI source hashing included absolute paths and engine files, so an engine upgrade
can require this acceptance even when workflow source is unchanged. Format-1 sources must migrate
before supplying fork reuse. Intermediate private formats 2–5 remain inspectable; use their original
runtime to resume them. Backups and markers are retained for inspection, not automatically deleted.

## Storage implementations and verification

`RunOptions.store` accepts a `RunStore`; the default is `FileRunStore`. Its owned handle exposes
read, coalesced append, compact, artifact-directory allocation, optional transcript creation,
process registration, and release. `OwnedRunStore.transcript` returns an `AgentTranscriptWriter`;
custom stores without this port must set agent policy `transcripts: 'off'`. The core can run local
effects against an in-memory implementation. A file store publishes its absolute `stateDir`; an
additional `RunOptions.stateDir` must agree. Durable questions currently require that filesystem
inbox protocol; a store without it refuses questions explicitly.

Run `npm run build && npm run test:storage-benchmark` for the real-filesystem acceptance benchmark.
The unit suite checks the 500 × 5 KiB write-amplification bound and shared-commit visibility; the
benchmark also requires at least 4× speedup for 200 trivial steps at concurrency 16 versus 1.
Results depend on filesystem and load. Tests also SIGKILL local child runners during fan-out and
prove that already-resolved effects are not repeated, including recovery with a torn journal tail.
All storage/CLI tests use local callbacks or fake harnesses, with no paid inference.

The production path always syncs. Only the in-process unit suite disables fsync, through an internal
test-setup hook that the CLI and public API cannot reach; crash, benchmark and CLI tests run in
child processes and keep real fsync, and `test/storage-sync.test.ts` proves both behaviors.

A local macOS run on Node 24.20.0 (2026-09-27) measured 200 trivial steps at 1,571 ms with
concurrency 1 and 168 ms with concurrency 16: **9.38× faster**, with 215 versus 26 flushes. The 500
× 5 KiB run at concurrency 8 took 811 ms, writing 7,176,506 bytes for 3,237,347 bytes of final state
(**2.22×** amplification). These are measured examples, not latency guarantees.

Agent attempts now own capped private [transcripts](agent-streaming.md) outside checkpoint payloads.
The attempt receipt is saved before invocation; output chunks do not trigger checkpoint writes.
