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

The default root still hashes the exact working directory, so a project subdirectory has its own
root. When a run is not found there, `run.not_found` lists `details.candidates` (`{stateDir, cwd}`):
registered project roots, their legacy locations, and the default and legacy roots of the current
directory's ancestors that hold the ID. The message names the first one's exact `--state-dir`, and
the failure's `next` entries inspect the run there. See
[next commands](cli-contract.md#next-commands).

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
      launch/<n>.log                 # workflow start: the runner's stderr (0600)
      launch/<n>.result.json         # workflow start: the runner's final JSON document (0600)
      launch/<n>.input.json          # workflow start --input -: the stdin input (0600)
      attempts/<sha256-full-step-id>/<attempt>.<provider>.jsonl
      artifacts/<encoded-id>--<hash>/<attempt>/
      worktrees/                     # reserved; no automatic checkout creation
  worktrees/                         # default worktree cache root of the repository with this cwd
    <runId>-<namespace>/<digest>/    # one cache per isolated call (see worktrees.md)
```

The default worktree cache root is keyed by repository, not by runs container:
`defaultWorktreeRoot(repo)` is the `worktrees/` directory of the repository's own project root, and
`RunWorktrees` creates it on demand. A run with an explicit `--state-dir` (or a project
subdirectory) therefore still puts its caches in the repository's root, which may have no
`project.json` and only a `worktrees/` directory; `workflow list --all` warns
`Skipped project <root>: ...` for such a root.

Artifact directories are allocated on demand. Their component uses at most 100 encoded ID characters
and a full SHA-256 of the exact ID, distinguishing case variants on case-insensitive filesystems and
fitting the 255-byte component limit. Artifact writers must create diagnostic files with mode 0600;
their bytes need not be fsynced and are never replay inputs. Native transcripts use the separate
`attempts/` layout, caps, and retention described in [agent streaming](agent-streaming.md). Opt-in
[worktree isolation](worktrees.md) uses its own recorded cache root and pinned Git refs; the default
root stays outside the checkout.

`workflow start` allocates the smallest free `n` exclusively, so a retry never overwrites an earlier
launch's evidence. A launch that failed before the record existed (for example a type error) leaves
`<runId>/launch/` without `run.json`; `list` and `inspect` ignore it, and the log keeps the only
copy of the compiler output. Remove it by hand when it is no longer needed.

Run records, journals, owners, and answers use 0600; new directories use 0700. Existing permissions
are not repaired. State includes plaintext input, outputs, prompts/previews, and answers. Moving it
outside the workspace prevents ordinary Git cleanup from removing it. Same-user unsandboxed code can
still access it; this is not an authentication boundary for human approvals.

The header keeps canonical CLI entrypoint/tsconfig paths and source hashes, the existing harness
binary/version metadata, and informational `{ quietChoir, node, zod, tsx }` engine versions (the
last two are optional in older records). Harness discovery uses the existing optional
`Harness.metadata` port once per live provider per invocation. Metadata changes do not affect step
identity; no discovery or inference is needed for pure replay.

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
resume recovers. An older build's `recovery/` directory is ignored. A lock that resume refuses
(incomplete metadata, a damaged marker, or a gone foreign host) is cleared with
`workflow unlock RUN`, never by deleting the directory; see
[process ownership](process-lifecycle.md).

### Worktree administration lock

Opt-in [worktree isolation](worktrees.md) keeps one more lock, outside the state directory: Git
worktree administration is serialized per repository by a lock in the repository's common Git
directory, the only location that every process administering that repository shares (runs started
from different linked checkouts, or with different `--state-dir` values, have different state
directories).

```text
<common Git dir>/                    # for example <repo>/.git
  quiet-choir/                       # 0700; Git ignores unknown entries here
    worktree-admin.lock/             # published whole by one rename
      owner.json                     # { pid, host, token, osStartTime }
      recovery.json                  # only while a recoverer claims a dead owner's lock
    worktree-admin.lock.<pid>.<uuid>.tmp/   # an acquire's publish directory; swept once its PID is dead
    worktree-admin.lock.<pid>.<uuid>.gone/  # a released or recovered lock's tombstone; swept
```

It changes hands exactly like a run lock (same owner, marker, tombstone and sweep rules), but it is
held only around each Git administration command and a contender waits instead of refusing. It
records no child processes and changes no storage format. See
[ADR 0032](decisions/0032-interprocess-worktree-administration-lock.md).

## Removing runs

Nothing deletes a run automatically. `workflow rm RUN` removes one saved run without importing
workflow code ([ADR 0049](decisions/0049-guard-held-run-removal.md); flags, refusals and result in
the [CLI contract](cli-contract.md)). It deletes `<runId>/` with everything listed above, the legacy
`<runId>.json` (a format-7 marker or an unmigrated flat record), `<runId>.json.v<N>` backups,
`<runId>.json.lock`, `<runId>.inbox/` and `<runId>.cancel.json`, and the run's worktree caches.
`workflow list` reports each run's on-disk `bytes`: the apparent size of those files in the runs
container, without following symbolic links. Worktree caches live in their own cache root and are
not counted.

rm refuses a held lock or live children, and without `--force` a running, suspended or waiting run.
Then it takes the run lock (legacy guard first, without a working directory, so it never registers a
project), re-reads the record, refuses (`run.exists`) if it is no longer the run rm inspected
(another run reused the ID, so its `createdAt` differs) and removes caches. If Git cannot remove one
while its repository exists, rm stops before deleting the run: caches Git already removed stay
removed and are recorded in the ledger, no ref is deleted, and the record stays for a retry with
`workflow clean`. When the repository is gone, rm deletes only caches named by a digest that matches
their ledger key. Holding the legacy guard throughout, it deletes in this order:

1. `<runId>.cancel.json` and `<runId>.inbox/`.
2. The flat `<runId>.json`, then flushes the directory. For an unmigrated flat run this is the
   commit point: `<runId>/` then holds only the lock, so the run no longer lists.
3. The `<runId>.json.v<N>` backups.
4. The primary `<runId>/lock`, released with the usual token and live-child checks. The guard stays
   held, and every writer takes the guard first, so no writer can start meanwhile. `workflow start`
   checks that the run is absent and creates `<runId>/launch/` under the guard as well, so it
   refuses with `run.locked` rather than creating launch files that step 5 would rename away.
5. A rename of `<runId>/` to `.<runId>.<pid>.<uuid>.removing` in the runs container, then a
   directory flush. For a directory run this is the commit point. A dotted name is never a valid run
   ID, so the tombstone never lists.
6. The legacy siblings once more, the tombstone, and finally the guard.

`workflow answer` takes no lock, so rm and the answer writer meet in a handshake instead: after
linking its delivery, the writer re-reads the run and, when the run is gone (or the ID now names a
run with another `createdAt`), withdraws the delivery and removes any empty inbox and run directory
it recreated, and fails with a conflict. It deletes only an envelope addressed to the removed run's
`createdAt`: it first renames the path to a private name, and puts back anything else, such as a
delivery a run reusing the ID has since received there. rm's commit point (step 2 or 5) precedes the
sweep in step 6, so a delivery linked before the commit point is swept from `<runId>.inbox/` or
renamed into the tombstone with `<runId>/inbox/`, and one linked after it finds the run gone at the
writer's check. Because that check follows the link, a run that reuses the ID at once could read the
delivery first; the envelope's `runCreatedAt` closes that gap, since the owner rejects a delivery
addressed to a run with another `createdAt` ([questions](questions.md#inbox-protocol-and-trust)). No
answer outlives the run to resolve a later run that reuses the ID.

A crash at any step leaves either an intact run that lists and inspects normally (run rm again) or a
tombstone. `list` and `inspect` never see a half-deleted run, because the flat marker goes before
the directory. A signal stops rm only before step 2; after that the removal finishes. Each rm,
before reading its target, deletes the tombstones in its runs container whose PID is dead (best
effort), leaving live and unverifiable ones alone, so a concurrent rm of another run is never
disturbed. `--dry-run` lists them without deleting anything. A start that failed before its record
existed (a lone `<runId>/launch/`) is not a run; rm reports `run.not_found` for it, so remove it by
hand.

`workflow prune` removes runs in bulk, still only when asked
([ADR 0050](decisions/0050-select-runs-for-prune-conservatively.md)). It selects finished runs by
age (`--older-than 7d`), status (`--status completed,failed,cancelled`) or a missing recorded cwd
(`--missing-cwd`), and needs at least one of them. It never deletes a file itself: each selected run
goes through the rm removal above, oldest first, one run at a time, each under its own guard and
never with `--force`, and with the record's `updatedAt` pinned so a run that changed after selection
is skipped rather than removed. A running, stale or suspended run, a run with a waiting step, a file
in either inbox that a resume could still consume (consumed and rejected deliveries do not count),
or a held lock or live orphan is never selected; it is listed in `skipped` with its reason, as is a
run that rm refuses at removal time, and the batch goes on. Prune sweeps dead rm tombstones in every
runs container it scans, and its `--dry-run` takes no lock and changes nothing. Flags, reasons and
result are in the [CLI contract](cli-contract.md).

`workflow prune --missing-cwd --all` then removes stale project roots
([ADR 0051](decisions/0051-remove-stale-project-roots-by-rmdir.md)); without both flags it never
touches a root. A root is stale when its `project.json` records a cwd that is missing (stat fails
with `ENOENT` or `ENOTDIR`), or when it has no readable, valid `project.json` (the roots behind a
`Skipped project` warning). The current project's root and roots whose cwd exists are never
considered. A stale root is kept and reported when a run listed in its `runs/` stays (`runs-kept`:
protected, refused or not selected), when a `worktrees/<runId>-<namespace>/` directory names a run
that a scanned runs container still holds (`in-use`), or when it holds anything else (`files`): for
a registered root, anything but `project.json`, `runs/`, `runs/.gitignore`, `worktrees/` and
directories below `worktrees/`; for a root without `project.json`, anything but `worktrees/` and
directories below it. A file, a symbolic link or an unknown directory at any depth counts, so a
macOS `.DS_Store` keeps a root too. Otherwise prune removes it in a fixed order: unlink
`runs/.gitignore` and rmdir `runs/`, rmdir the `worktrees/` tree bottom-up, unlink `project.json`,
then rmdir the root. Those two files are the only ones it ever unlinks; every directory goes by
`rmdir`, never a recursive delete, and no lock is taken. A cache that a live run (even one with an
explicit `--state-dir`) creates meanwhile makes an `rmdir` fail with `ENOTEMPTY`, and the root is
reported `busy` after prune puts back the file it unlinked just before (`runs/.gitignore` or
`project.json`, with its original bytes), so a half-cleaned root keeps its `project.json` and never
turns into a `Skipped project` root. A root without `project.json` is removed only when its
`worktrees/` tree holds nothing but empty directories; those are recreated on demand.

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

An accepted code change on any format writes `codeChanges`, the new `workflow` fingerprint and a
cleared `output` before the body replays. The CLI therefore replays the accepted body against a
disposable copy first; when the copy meets a changed completed step, `--accept-code-change` refuses
with `run.incompatible` and the checkpoint keeps its bytes, status, fingerprint, output and
`codeChanges`. A settled map that accepts a mapper-only change appends its own `codeChanges` entry
with `map` set, and its journal saves per-component digests in `components` beside the aggregate
`fingerprint`. See [ADR 0006](decisions/0006-code-change-recovery.md).

Format 1 stored only an aggregate code/schema fingerprint. If it differs, explicit
`--accept-code-change` is required, while name, version, cwd, input, and original step checks remain
in force. Older CLI source hashing included absolute paths and engine files, so an engine upgrade
can require this acceptance even when workflow source is unchanged. Format-1 sources must migrate
before supplying fork reuse. Intermediate private formats 2–5 remain inspectable; use their original
runtime to resume them. Backups and markers are retained for inspection, not automatically deleted;
`workflow rm` removes them with their run.

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
