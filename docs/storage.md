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
      launch/<n>.runner.json         # workflow start: the spawned runner's PID, host, birth (0600)
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
launch's evidence, and skips an `n` whose `<n>.runner.json` survives. Numbering continues across
`workflow start --resume` launches of the same run: a run started with start and then resumed
detached has `launch/1.*` and `launch/2.*`. Right after spawning the runner it records
`{pid, host, osStartTime}` in `<n>.runner.json` (best effort; a failed write changes nothing else).
A launch that failed before the record existed (for example a type error) leaves `<runId>/launch/`
without `run.json`, and the log keeps the only copy of the compiler output. `inspect` reports
`run.not_found` for it. Such a directory is a leftover launch directory when the ID has no
`run.json` or `<runId>.json`, no `<runId>.inbox/`, `<runId>.cancel.json` or `<runId>.json.v<N>`
sibling, and `<runId>/` holds only `launch/` with nothing but numbered `<n>.log`, `<n>.result.json`,
`<n>.input.json` and `<n>.runner.json` files. Each launch number is settled when its
`<n>.runner.json` names a runner that is dead, or, without a runner record, when its newest file is
more than an hour old. A runner that is alive, unverifiable or on another host, or an unreadable
runner record, keeps the launch in flight. Once every launch is settled, `workflow list` reports the
leftover (`leftoverLaunches` in JSON, a `Leftover launch` line in text, with the `workflow rm`
command) and `workflow rm ID` removes it; see
[ADR 0055](decisions/0055-remove-leftover-launch-directories.md). Anything else in the directory (a
lock, a journal, an unknown file) leaves it alone, and rm keeps reporting `run.not_found`.

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
      owner.json                     # { pid, host, token, osStartTime, released? }
      recovery.json                  # only while a recoverer claims a dead owner's lock
    worktree-admin.lock.<pid>.<uuid>.tmp/   # an acquire's publish directory; swept once its PID is dead
    worktree-admin.lock.<pid>.<uuid>.gone/  # a released or recovered lock's tombstone; swept
```

It changes hands exactly like a run lock (same owner, marker, tombstone and sweep rules), but it is
held only around each Git administration command and a contender waits instead of refusing. It
records no child processes and changes no storage format. `released: true` is set only by a release
whose tombstone rename failed: it marks the still-live owner's lock free, so any process recovers it
at once. Plain `workflow inspect RUN` shows it for a run whose worktree ledger names the repository.
A lock left by a holder that is gone, on a gone host, or with damaged metadata is cleared with
`workflow unlock --worktree-admin PATH` (PATH is any path inside the repository), never by deleting
the directory. See [ADR 0032](decisions/0032-interprocess-worktree-administration-lock.md).

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
(another run reused the ID, so its generation differs: the random `generation` a run records when it
is created, or its `createdAt` for a record from before schema revision 17, which has none) and
removes caches. Comparing generations also refuses a replacement created with the same `createdAt`.
If Git cannot remove one while its repository exists, rm stops before deleting the run: caches Git
already removed stay removed and are recorded in the ledger, no ref is deleted, and the record stays
for a retry with `workflow clean`. When the repository is gone, rm deletes only caches named by a
digest that matches their ledger key. Holding the legacy guard throughout, it deletes in this order:

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
run with another generation, which falls back to `createdAt` as above), withdraws the delivery and
removes any empty inbox and run directory it recreated, and fails with a conflict. It deletes only
an envelope addressed to the removed run's generation (every binding field it carries matches): it
first renames the path to a private name, and puts back anything else, such as a delivery a run
reusing the ID has since received there. rm's commit point (step 2 or 5) precedes the sweep in step
6, so a delivery linked before the commit point is swept from `<runId>.inbox/` or renamed into the
tombstone with `<runId>/inbox/`, and one linked after it finds the run gone at the writer's check.
Because that check follows the link, a run that reuses the ID at once could read the delivery first;
the envelope's `runGeneration` (with `runCreatedAt`, kept for older owners) closes that gap, since
the owner rejects a delivery addressed to a run with another generation
([questions](questions.md#inbox-protocol-and-trust)). No answer outlives the run to resolve a later
run that reuses the ID. A delivery from a `workflow answer` build before #371 carries only
`runCreatedAt`, so a replacement with the same `createdAt` still accepts it.

A crash before step 2 leaves an intact run that lists and inspects normally (run rm again), and a
crash after step 5 leaves a tombstone. `list` and `inspect` never see a half-deleted run, because
the flat marker goes before the directory. A crash between steps 2 and 5 of an unmigrated flat run
leaves a record-less `<runId>/` holding only its lock (with the lock's strays), any backups not yet
deleted and the legacy guard; such an ID does not list as a run
([ADR 0061](decisions/0061-finish-interrupted-flat-run-removal.md)). `workflow rm ID` finishes that
removal: with `interrupted: true` in its result, it refuses `run.locked` or `run.orphans` while a
lock owner, recoverer or a dead owner's child is alive, unknown, remote or unreadable (even with
`--force`), takes the run lock (recovering the crashed rm's dead locks), re-checks under it that no
record exists (`run.exists`) and that nothing else appeared in the directory (`run.not_found`), and
runs the steps above again. A directory with anything else, such as `journal.jsonl`, `inbox/` or
`launch/`, is not such a leftover and stays `run.not_found`. A signal stops rm only before step 2;
after that the removal finishes. Each rm, before reading its target, deletes the tombstones in its
runs container whose PID is dead (best effort), leaving live and unverifiable ones alone, so a
concurrent rm of another run is never disturbed. `--dry-run` lists them without deleting anything.

A start that failed before its record existed leaves a leftover launch directory (above), which is
not a run. When the ID has no record and names such a directory, rm takes a separate path with
`launchOnly: true` in its result. It refuses with `run.active`, even with `--force`, while any
launch may still be in flight, because the start's runner may still create the record. Otherwise it
takes only the legacy guard, without a working directory, so it never registers a project. Start's
allocation and the runner's lock take the same guard first. Under it rm re-checks that no record
exists (`run.exists` when a run now holds the ID) and that the directory is still a settled leftover
(a new launch allocated meanwhile refuses with `run.active`). It then renames `<runId>/` to a
tombstone, flushes the container (the commit point), deletes the tombstone and releases the guard. A
held guard refuses with `run.locked`. `workflow prune` never selects a leftover; remove each with
rm.

A run whose record file (`<runId>/run.json` or `<runId>.json`) is present but whose content is
damaged cannot be judged from its record, so rm refuses it with `run.unreadable` and names
`workflow rm ID --unreadable` ([ADR 0060](decisions/0060-remove-an-unreadable-run-on-request.md)).
So both cases that once needed hand deletion go through `workflow rm ID`: a lone `launch/` leftover
without a flag, a damaged record with `--unreadable`. Damaged means invalid JSON or a record that
fails validation, a journal sequence gap, a format-7 marker whose directory is missing, a record
path of the wrong kind (`EISDIR`, `ENOTDIR`), or `run.json` without `journal.jsonl` (which rm
reports as `run.unreadable`, not `run.not_found`). A record that cannot be read for access or I/O
reasons (`EACCES`, `EPERM`, `EIO` and the like) may be intact and is still refused, as is a newer
build's record (`run.incompatible`). With `--unreadable`, rm refuses a held lock (`run.locked`) or a
dead owner's live child (`run.orphans`) as above, and refuses `run.active`, even with `--force`,
while any launch in `<runId>/launch/` may still be in flight by the leftover rule (files there that
are not launch evidence are ignored). It then takes the run lock as for any run, re-reads the record
under it (`run.exists` when it is readable now, so rm judges it as usual next time), judges the
launches again and deletes in the order above. It touches no worktree caches or pinned refs, because
the ledger that names them cannot be read: the result has `unreadable: true` and a warning that
points to `git worktree list` in the repository and `refs/quiet-choir/<runId>/`. A readable run is
removed as without the flag. `workflow prune` never selects an unreadable run.

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
runs container it scans, then finishes every interrupted flat-run removal it finds there, under each
ID's run lock and with the same refusals and re-checks as rm (a held one is skipped silently), and
lists them in `unfinishedRemovals`; rm by ID does not scan its container. Its `--dry-run` takes no
lock and changes nothing. Flags, reasons and result are in the [CLI contract](cli-contract.md).

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
cleared `output` before the body replays. `runWorkflow` therefore replays the accepted body against
a disposable copy first; when the copy meets a changed completed step, it rejects with
`StepIdentityChangedError`, and when the copy skips a completed step, settled map or child frame,
with `ReplaySkippedError`, and when it meets a settled map changed beyond its mapper, with
`SettledMapChangedError` (the CLI's `--accept-code-change` refuses any of them with
`run.incompatible`), and the checkpoint keeps its bytes, status, fingerprint, output and
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

## Record schema revision

A run record carries `schemaRevision` beside `formatVersion`
([ADR 0052](decisions/0052-run-record-schema-revision.md)). `formatVersion` changes when the layout
or replay contract changes; `schemaRevision` changes when the set of persisted run-level fields
does. A record without the field is revision 1, which covers every record written before it existed,
so reads never fill it in and fork source pins keep their digests. Every new record, and every
resumed record at its next save, is written with this build's `SUPPORTED_SCHEMA_REVISION`; a
completed run whose only change would be the stamp is not rewritten.

**The bump rule.** Adding a persisted run-level field, or changing the accepted shape of one,
including fields nested inside run-level objects such as `runBudget` or `worktrees`, bumps
`SUPPORTED_SCHEMA_REVISION` in `record.ts` and adds the new revision's top-level keys to
`test/fixtures/schema-revision/record-keys.json` (with its pinned digest in
`test/record-schema-revision.test.ts`); a nested-only change repeats the previous revision's list.
The test fails when the top-level keys change without a new revision. From revision 17 it also pins,
per revision, a digest of the run-level JSON Schema without `steps` and a digest of the step schema
(with the installed zod version), so a nested addition, removal or type change in a run-level object
or a step fails it too (#374); add the printed digests under the new revision and never edit a
released pin (while the current revision is still unreleased, correct its own pin instead of bumping
again). Schemas that `record.ts` imports count. Validators inside `z.custom`, refinements and
transforms render as `{}` or not at all in the JSON Schema, so changes there are still caught only
in review. A zod upgrade that merely changes the JSON Schema encoding also fails the check: if
`record.ts` and the schemas it imports did not change, re-pin the current revision's digests and zod
version in place; that is safe because these digests are never persisted.

**Revisions so far.** Revision 1 is every record up to and including #167. Revision 2 (#168) is a
nested-only change: `runBudget` gains the optional `maxWindowUtilization`, and `budgetStop` gains
the metric `maxWindowUtilization` with optional `harness`, `window` and `resetsAt`
([ADR 0053](decisions/0053-window-utilization-gate-suspends-until-reset.md)). Revision-1 records
read unchanged, since the new field is optional; a revision-1 build refuses to rewrite a revision-2
record. Revision 3 (#170) is also nested-only: each `children` frame gains the optional
`onError: 'return'` and the terminal `settled` outcome of an `onError: 'return'` child frame
([ADR 0007](decisions/0007-durable-failure-outcomes.md)). Revision-2 records read and replay
unchanged; a revision-2 build refuses to rewrite a revision-3 record instead of dropping `settled`.
Revision 4 (#171) is nested-only too: a capability profile's `claude` gains the optional
`addDirRoots`, and step and attempt request summaries gain the optional `addDirs`
([ADR 0054](decisions/0054-bounded-call-site-adddirs.md)). Revision-3 records read, and their
completed agent steps replay, unchanged. A revision-3 build cannot read a record whose capabilities
declare `addDirRoots` (its strict manifest parse rejects the field), and refuses to rewrite any
other revision-4 record instead of dropping `addDirs`. Revision 5 (#223) is nested-only as well: run
`events` gain the type `wait.tolerated`, one entry per poll error that `onError` tolerated
([waits](waits.md#checks-and-outcomes)). Revision-4 records read unchanged, and a waiting poll's
saved `lastError` count carries on after a resume. A revision-4 build cannot parse a record that
holds a `wait.tolerated` entry (its event-type enum rejects it), so every read of that record is the
`run.incompatible` upgrade refusal described below; it refuses to rewrite any other revision-5
record. Revision 6 (#226) adds the top-level `projectInstructions`: project-level instruction files
(paths and digests) that a harness reported for each distinct resolved call `cwd`, at most 128
entries with the oldest dropped ([harness isolation](harness-isolation.md)). Revision-5 records read
and replay unchanged, including Codex project entries that older builds kept in
`harnesses.codex.instructionSources`; a later live call adds `projectInstructions`. A revision-5
build reads a revision-6 record without the field and reports it hidden, and refuses to rewrite it.
Revision 7 (#227) is nested-only: instruction sources in `harnesses` and `projectInstructions` gain
the kind `claude-md`, the user `CLAUDE.md` an inherit-mode Claude call loads
([harness isolation](harness-isolation.md)). Revision-6 records read and resume unchanged. A
revision-6 build cannot parse a record that holds a `claude-md` source (its kind enum rejects it),
so every read of that record is the `run.incompatible` upgrade refusal described below; it refuses
to rewrite any other revision-7 record. Revision 8 (#240) is nested-only: each `children` frame
gains the optional `redefinitions` history, the prior identities (`workflow`, `schemaDigest`,
`inputDigest`, `redefinedAt`) of an unfinished frame that a resume invoked under a changed identity
([ADR 0026](decisions/0026-inline-children-and-definition-registry.md)), and each `maps` journal
gains the optional `frame`, the inline child frame that ran it (a journal with nothing committed
adopts the frame that runs it next, and a committed one refuses to run in another frame), so a map
run through a bound view outside the frame's ID prefix still counts as that frame's terminal work.
Revision-7 records read and resume unchanged, and a failed frame in one can be redefined. A
revision-7 build reads a revision-8 record without the history or map frames and refuses to rewrite
it instead of dropping `redefinitions` and `frame`. Revision 9 (#247) is nested-only: `capabilities`
profiles gain the optional `redacted.harnesses`, digests and key names of the registered harness
options a declaration lists in `sensitiveOptions`, which no longer appear under the profile's
`harnesses` or `harnessCapabilities` ([harness controls](harness-controls.md)). Revision-8 records
read and resume unchanged, and the next execution rewrites `capabilities` without the plaintext
values. A revision-8 build cannot parse a record that holds `redacted.harnesses` (its strict
`redacted` shape rejects the key), so every read of that record is the `run.incompatible` upgrade
refusal described below; it refuses to rewrite any other revision-9 record. Revision 10 (#284) adds
the top-level `recoveryCause`: the typed cause behind a failed or cancelled run's `recoveryHint`,
which also selects the run's `next` commands
([ADR 0006](decisions/0006-code-change-recovery.md#cause-aware-next-entries-284)). Revision-9
records read and resume unchanged; without the field, a failed run gets the plain resume entry it
had before. A revision-9 build reads a revision-10 record without the field, reports it hidden, and
refuses to rewrite it; every failed or cancelled run this build saves carries the field. Revision 11
(#289) changes only a nested shape: a rejection in `question.rejections` may carry an optional,
bounded `issues` list of `{code, path, message}`. Revision-10 records read and resume unchanged, and
a rejection without `issues` stays valid. A revision-10 build reads a revision-11 record, but its
parse strips the nested field, so it refuses to rewrite it. Revision 12 (#300) changes only a nested
shape: a step in `steps` may carry `failureHistory`, at most 8 `{launchStamp, failureStamp}` entries
for its terminal failures since it last completed, which the healed-step check uses to tell which
failure a later launch could observe ([ADR 0007](decisions/0007-durable-failure-outcomes.md)). Step
identity is unchanged. Revision-11 records read and resume unchanged; a failed step without the
history keeps the conservative `failureStamp` watermark until it completes. A revision-11 build
reads a revision-12 record, but its parse strips `failureHistory`, so it refuses to rewrite it.
Revision 13 (#302) changes only a nested shape: a step in `steps` may carry `mapItems`, one
`{item, invocation}` entry per named-map item that enclosed its live launch (the exact item prefix
and a digest of a random value unique to the body execution that launched it, the invocation's map
prefix, its ordinal among that execution's same-prefix invocations and its item-prefix set), which
default fork prefix reuse reads to treat source steps under a key the fork dropped as sibling items
([ADR 0006](decisions/0006-code-change-recovery.md#amendment-removed-named-map-keys-302)). Step
identity is unchanged. Revision-12 records read and resume unchanged; a fork from one keeps the
earlier, conservative behavior for removed keys. A revision-12 build reads a revision-13 record, but
its parse strips `mapItems`, so it refuses to rewrite it. Revision 14 (#311) is nested-only:
`rootCause.errorKind` and a step attempt's `errorKind` accept the error kind `configuration`, which
the runtime records only on the root cause of a configuration refusal raised before the effect's
attempt ([observability](observability.md)). Revision-13 records read and resume unchanged and keep
the `unknown` kind they recorded for such a refusal. A revision-13 build cannot parse a record whose
root cause holds `configuration` (its kind enum rejects it), so every read of that record is the
`run.incompatible` upgrade refusal described below; it refuses to rewrite any other revision-14
record. Revision 15 (#317) changes only a nested shape: a step in `steps` may carry `innerCommands`,
`{attempt, commands, omitted?}`, the commands its latest settled callback attempt (or a wait's
terminal poll observation) ran through `context.exec`. Each entry holds the command, its `envSha256`
and `inputSha256` digests (never environment values or stdin), whether it was structured or `live`,
and either the raw process result (`code`, `signal`, `stdout`, `stderr`, `truncated`) or an
`{kind, message}` error; the list keeps at most 256 commands and 1 MiB of stdout plus stderr, with
the rest counted in `omitted`. Only `workflow fixtures` reads it ([rehearsal](rehearsal.md)); step
identity, replay, resume and fork reuse ignore it. Revision-14 records read and resume unchanged. A
revision-14 build reads a revision-15 record, but its parse strips `innerCommands`, so it refuses to
rewrite it. Revision 16 (#337) changes only a nested shape: the exec summary in `steps[].exec` (and
a step attempt's `exec`) and in a command poll's wait request (`poll.command.exec`) may carry
`scrubEnv`, the sorted extra names of an opted-in host agent-session scrub (empty for
`scrubEnv: true`; [command effects](command-effects.md)). It is present only when the scrub is
enabled, so revision-15 records read and resume unchanged with the same identities. A revision-15
build reads a revision-16 record, but its parse strips `scrubEnv`, so it refuses to rewrite it.
Revision 17 (#371) adds the top-level `generation`, a random UUID written once when a run is created
(including a fork or a dry run), and never backfilled. Answer envelopes and `workflow rm` bind to
it, so a run that reuses an ID is told apart even with the same `createdAt`
([questions](questions.md#inbox-protocol-and-trust)). Revision-16 records read and resume unchanged
and keep `createdAt` as their generation for life, so an answer already written for one stays valid.
A revision-16 build reads a revision-17 record without the field, reports it hidden, and refuses to
rewrite it, so it can never drop the token.

**Refusals.** A build must not rewrite a record it cannot fully read: its parse strips unknown
top-level fields, and the next compaction would write the record back without them. When a record
has a newer `schemaRevision`, or top-level fields this build does not know (in `run.json` or in a
journal entry a newer build wrote before compacting), these commands refuse with `run.incompatible`
(exit 3) and leave `run.json` and `journal.jsonl` byte for byte unchanged:

- `workflow resume`, `execute --resume` and `answer --resume` (the answer file is still delivered to
  the inbox, and a newer build consumes it);
- `workflow tick`, which reports the run as skipped `incompatible` with the same message (exit 1
  with `--run`);
- a fork from the run (`--fork-from`) and a `--dry-run` resume, which would copy the record;
- `workflow clean`, which rewrites the worktree ledger.

`workflow execute` without `--resume` (or `runWorkflow` without `resume`, including a fork target)
onto the ID of such a run refuses with `run.exists` (exit 3), as for any existing run, and writes
nothing; only the commands above that need to read the record keep `run.incompatible`.

`workflow check-resume` and `checkResume()` write nothing but report the same drift, so a compatible
preflight is never followed by this refusal: the check is incompatible (exit 3) with `record schema`
among `changed`, the refusal's message, and `reason`, `schemaRevision`, `supportedSchemaRevision`
and `hiddenFields` beside the usual comparison fields. `--accept-code-change` does not override it
(`canAcceptCodeChange` is false).

`error.details` is
`{reason: "record_schema", schemaRevision, supportedSchemaRevision, hiddenFields}`; the message
names the revision and up to 10 hidden field names, and the only remedy is to upgrade quiet-choir.
The refusal comes after the lock-free read and again under the run lock, before any journal append,
truncation or compaction; the lock itself is taken and released as usual. A custom `RunStore`'s
record gets the same check in the runner.

An existing fork is not refused when its pinned source later drifts (the source gains an unknown
field or a newer `schemaRevision` after the fork began): the resume closes reuse, warns that the
remaining effects will execute live, and copies nothing more from the source.

**Reads.** `readRun`, `workflow inspect`, `list` and `pending` still work. The read view leaves out
what this build does not know (never its values, which are not kept in memory), `inspect` and `list`
rows add a warning naming the newer revision or the hidden fields, and the run gets no `resume` or
`answer` follow-ups. If the record has a newer revision or unknown fields and a known field also
fails validation, so the record does not parse at all, every read is the same `run.incompatible`
refusal instead of `run.unreadable`, and `list` reports it among its skipped runs. `workflow rm` and
`prune` still remove such a run, except when rm would first have to update its worktree ledger
(caches not yet removed, or `--refs` with recorded refs): that rm refuses the same way before
deleting anything.

**Older builds.** A build that has this guard treats a newer build's record as above. A build that
predates it (every build before #167) still strips unknown top-level fields and deletes them at its
next compaction, exit 0 and without a warning; the guard protects only builds that contain it.
Unknown fields inside step records survive any build, because steps are not stripped.
`formatVersion`, the accepted formats (resume 1, 6 and 7; forks 6 and 7) and the replay contract are
unchanged.

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
