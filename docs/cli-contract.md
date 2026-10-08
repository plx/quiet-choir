# Scriptable workflow commands

Place flags after the command name. `workflow execute FILE --json` and `workflow inspect ID --json`
each write one single-line JSON document. Validate, typecheck, and check-resume use the same failure
contract, including argument parsing errors. Request human help without `--json`. Use
`npm run --silent cli -- …` when invoking through npm; quiet-choir cannot suppress its parent
process's banner.

Success documents retain their shapes, except for the run commands described below: inspect returns
a run with current ownership diagnostics, validate returns workflow metadata with `diagnostics: []`
(see [durability lint](#durability-lint)), typecheck returns its compiler result, and check-resume
returns a compatible comparison in `check`. `inspect --json --summary` returns the compact
dashboard, including the completed run's `output` (null otherwise), an `agents` roll-up and, when an
attempt reported Claude subscription rate-limit windows, a per-harness `rateLimits` map, and, when
the latest execution was refused by a run cap, its saved `budgetStop`. `workflow list --json`
returns `{kind, ok, stateDir, runs, warnings}` with compact rows: `id`, `workflow`, `status`,
`recordedStatus`, `errorKind`, `retryable`, `counts`, `updatedAt`, `ownership`, `nextWakeAt`, `cwd`,
`stateDir`, `warnings`, `bytes` and a six-field `usage`; `--full` restores whole run summaries,
which carry `bytes` too. `errorKind` is the root cause's failure kind of a run whose
`recordedStatus` is `failed` (the stored kind, else the root step's last attempt for older records)
and `retryable` is whether that kind is transient. Both are `null` and `false` for a body failure, a
record without a recoverable kind and every other status, including a cancelled or interrupted run
that keeps a `rootCause`. For a failed run `errorKind` equals `rootCause.errorKind` in the `--full`
summary. `bytes` is the apparent size of the run's regular files in its runs container: everything
under `<runId>/` (record, journal, `attempts/` transcripts, artifacts, `launch/`, inbox) plus the
legacy `<runId>.json`, `<runId>.json.v<N>`, `<runId>.cancel.json` and `<runId>.inbox/`, without
following symbolic links. Worktree caches are not counted. It is null, with a list warning, when the
size cannot be measured; inspect and watch do not compute it. The text view shows it in a `SIZE`
column (B, KiB, MiB or GiB). `validate --json` and `list-defs --json` print a compact document that
states each capability fact once, at every depth of `children`: no `harnesses[].options` JSON
Schema; no `capabilities.defaults` (read `capabilities.profiles[defaultProfile]`); the default
profile's environment summaries once as `capabilities.environment`, with a profile's own
`environment` listing only the harnesses (`claude`, `codex`) that differ from it (read
`profile.environment?.[h] ?? capabilities.environment[h]`); `workflow.profiles` as the declared
profile names, whose facts live in `capabilities.profiles`; and no root `workflow.entrypoint`, which
equals the top-level `entrypoint` (children keep theirs). `--harness-schemas` prints the complete
document instead: option schemas, `defaults`, every profile's environment, the declared-profile map
and both entrypoint copies. The golden-path `validate --json` is about 2.7 KB. Run records and
checkpoints keep the full manifest. `list-defs` discovers `*.workflow.ts`, `*.workflow.mts` and
`*.workflow.cts` files (not `.d.ts` or `.tsx`). The `configuration` topic has one command,
`configuration doctor`. `list --all` discovers registered XDG projects without imports; rows include
`cwd` and `stateDir`. `execute --resume --run-id ID` may omit FILE and use stored launch paths, as
does `resume ID`. A supplied different FILE is refused before import. See [storage](storage.md).
`inspect --watch --json` emits JSONL per checkpoint/ownership change, ending with a snapshot and
exit 0/1/75/130/3 for completed/failed/suspended/cancelled/stale (an interrupted run ends as
suspended). It does not add an error document for an observed failure. An interrupted watcher emits
an error document and leaves the observed run untouched. Three opt-in flags bound the watch for
hosts with time limits. `--timeout DURATION` is measured from the first successful read: a run still
running then ends the watch with `watch.timeout` (exit 79), whose error document carries the last
observed `status` (`running`) and `details.timeoutMs`; the run keeps running.
`--wait-created DURATION` is measured from the start of the watch: until the first successful read,
a missing record is retried at the interval instead of failing with `run.not_found` (exit 3), and
when the bound expires the watch fails with `watch.record_not_created` (exit 66), `status: null` and
`details.waitCreatedMs`. A record that disappears after it was read stays `run.not_found`. Both take
`ms`, `s`, `m` or `h` durations up to 2147483647 ms and sleep at most until their deadline, then
read once more, so a run that finishes at the deadline is reported as finished and the watch ends
within one read after it. `--final` prints only the final snapshot, or only the error document on a
bound, an interrupt or a missing record. With `--summary`, inspect error documents carry the compact
`summary` instead of the whole `run`. 79 is the first exit after the sysexits block and has no
meaning in sh, Node, `timeout(1)` or xargs; 124 stays `start.timeout`, so a host can tell "runner
stopped without a record" from "run still running". See [run observability](observability.md) for
polling, stale detection, and partial usage. Non-watching inspect exits 0 for any readable
checkpoint status, including `failed`, `cancelled`, and `running`. Plain `inspect ID --json` (not
`--summary` or `--watch`) of a run with a worktree ledger also carries `worktreeAdminLock` while the
repository's worktree administration lock is held:
`{commonGitDir, path, owner, recovery, warning?}`, where `owner` is
`{pid, host, token, state, osStartTime, acquiredAt}` or null when `owner.json` is missing or
unreadable, `state` is `alive`, `dead`, `unknown`, `remote` or `released`, `acquiredAt` is the
approximate ISO modification time of `owner.json` (or null), and `recovery` is `{pid, host, state}`
or null. It is absent when the lock is free, for runs without a ledger, and when the repository
cannot be resolved (logged at debug; inspect still succeeds). Resolving it runs one `git rev-parse`.
The text view prints a `Worktree admin lock` line with the holder and its age, and an `Unlock:` line
naming `workflow unlock --worktree-admin <common Git dir>` (with `--force-remote` and its caveat for
a foreign holder) only when no holder is alive or unverifiable. `workflow pending --json` returns
`{kind:"workflow.pending.result", ok, pending, hidden}`, and `workflow answer --json` without
`--resume` returns `{kind:"workflow.answer.result", ok, delivery}`.

Each `pending` row keeps the question or wait fields and adds `runStatus` (the owning run's
checkpoint status), `delivery` and `next`. `delivery` is `{state, at, by}`: `state` is `queued` when
an answer file is already in the run's inbox, with `at` and `by` read from its envelope (both null
when the file is unreadable), and `none` otherwise; it is null for a poll or deadline wait that
accepts no answer. Delivery is advisory: while an owner is consuming the file a row can read `none`
for a moment, and `answer` stays the authoritative first-answer check. `next` follows the
[next commands](#next-commands) shape: a queued row of a suspended or failed run that has launch
metadata gets one `resume` entry (repeating the run's recorded launch policy) so the owner ingests
the answer; every other row gets `[]`, because a running owner ingests the answer itself. A wait row
(`kind: "wait"`) also has `command`: the argv or `{ shell }` a
[command poll](waits.md#command-polls) runs on each check, or null for any other wait.

By default `pending` lists only rows that still need an answer: it hides rows whose delivery is
`queued` and rows of `failed`, `cancelled` or `completed` runs, and reports how many it hid in
`hidden`. Rows of running runs stay, so a `--wait-mode block` run's live question is listed. `--all`
lists every row (`hidden` is then 0). `--run RUN` (repeatable; duplicates are ignored) lists only
the named runs. It applies before default hiding and `--all`, so `hidden` counts only the named
runs' rows, and a known run with nothing waiting returns `pending: []`. An invalid ID is
`usage.run_id` (exit 2); an ID found in no searched container is `run.not_found` (exit 3, naming the
first unknown ID), as for the other run commands. Only the named records are read, so a damaged
record of another run does not fail the listing. The library `listPending` is not filtered: it
returns every waiting row, with `runStatus` and `delivery` added.

`answer.invalid` (exit 2) carries `error.details.issues`, an array of `{code, path, message}` where
`path` locates the offending field in the answer (`["approved"]`; `[]` for the whole value). A value
that does not match the question's schema reports one issue per Zod issue (`code` is the Zod code
such as `invalid_type`), and `error.message` is one line, for example
`Answer does not match the question schema: approved: Invalid input: expected boolean, received string`.
A refusal with no schema location has one issue with path `[]` and a synthetic code:
`answer_not_json` (not JSON, or not representable as JSON), `question_schema_invalid` (the stored
schema cannot be used), `answer_author` (`--by` is missing or wrong for a human question, or is
invalid, including an unreplaced `human:<NAME>` placeholder) and `answer_too_large` (the envelope
exceeds 1 MiB). Re-ask from `issues`; nothing was written.

## Run results of execute, resume and answer --resume

These three commands print a compact, constant-shape result by default, so an agent session reads
the status and output of a long run without its checkpoint. A run that completes returns

```json
{
  "kind": "workflow.run.result",
  "ok": true,
  "exitCode": 0,
  "runId": "...",
  "stateDir": "...",
  "status": "completed",
  "output": {},
  "usage": { "costUsd": 0.18, "attempts": 180, "undercounted": false },
  "counts": {
    "total": 180,
    "completed": 180,
    "running": 0,
    "failed": 0,
    "cancelled": 0,
    "settled-failed": 0,
    "superseded": 0,
    "waiting": 0,
    "withdrawn": 0
  },
  "rootCause": null,
  "warnings": []
}
```

`output` is the run's output unchanged. `usage` sums the recorded agent attempts: `costUsd` is the
harness-reported estimate (null when none was reported) and `undercounted` is true when the cost or
attempt totals may be low, because of legacy checkpoints or attempts with unknown cost or tokens.
`counts` is the step total by status, `rootCause` the failing effect as `{stepId, error, errorKind}`
(`errorKind` is null for a body failure and for a record from before the kind was stored without an
attempt to read it from) or null, and `warnings` the run's warnings, de-duplicated and capped at 20
followed by a note that says how many more exist.

A suspension (exit 75) returns
`{kind:"workflow.run.suspended", ok:true, exitCode:75, runId, stateDir, pending, resumeCommand, nextWakeAt, summary}`,
where `summary` is the same projection (`runId`, `stateDir`, `status`, `output`, `usage`, `counts`,
`rootCause`, `warnings`) and each `pending` entry keeps its `answerCommand`. `nextWakeAt` is the
epoch millisecond time at which `workflow tick` resumes the run, or null when only an answer or
signal can. A run the `--max-window-utilization` gate suspended has no pending wait and a
`nextWakeAt` at the window's reset
([ADR 0053](decisions/0053-window-utilization-gate-suspends-until-reset.md)).

`--full` prints the whole record instead, exactly as earlier releases did: `{...run, stateDir}` for
a successful run (no `kind` or `ok`; `answer --resume --full` now includes `stateDir` too), and the
suspension and failure documents with `run` in place of `summary`. Use `workflow inspect` to read a
saved run later. `--full` is detected from argv before parsing, so a failure that occurs before
argument parsing completes honours it as well. The `--json` alias of `answer`'s `--value` is
unaffected: pass `--json VALUE --full`.

`execute --dry-run` documents are not compacted: a rehearsal deletes its temporary state, so the
embedded `run` is the only copy. This section applies to success and suspension documents of the
three commands and to their failure documents; every other command keeps its shapes.

`workflow unlock ID [--force-remote] --json` clears an abandoned run lock without importing workflow
code and returns `{kind:"workflow.unlock.result", ok:true, runId, stateDir, forceRemote, locks}`.
`locks` lists every lock found, primary first, as
`{kind:"primary"|"guard", path, owner, recovery, processes, warning?, action:"removed"|"absent"}`,
where `owner` and `recovery` are `{pid, host, state}` (the local judgment) or null, and `warning`
reports missing or unreadable metadata; it is empty when the run was not locked. It refuses with
exit 3 and removes nothing: `run.locked` while an owner or recoverer is alive or unverifiable, or is
on a foreign host without `--force-remote` (`error.details` has `lockPath`, `kind`, `role`, `pid`,
`host` and `state`, and `next`, below); `run.orphans` while a recorded child is alive or
unverifiable (`error.details` has `processes` and `owner`); and `run.not_found` when the run has
neither a lock nor a checkpoint. Every `run.locked` refusal carries `error.details.next`, a list of
`{why, argv}` entries whose `argv` is the `workflow unlock` command to run once the holder is gone,
and the failure document's top-level `next` repeats it. The entry has `--force-remote` only when the
holder is on a foreign host, and then it is the only entry; a transient race
(`lock ownership changed during unlock`) carries the plain command. See
[Next commands](#next-commands) and [process ownership](process-lifecycle.md).

`workflow unlock --worktree-admin PATH [--force-remote] --json` clears a repository's abandoned
worktree administration lock
([ADR 0032](decisions/0032-interprocess-worktree-administration-lock.md)), which belongs to no run.
Give RUN or `--worktree-admin`, not both and not neither, and no `--state-dir` with
`--worktree-admin`; these, and a PATH outside any Git repository, are `usage.flag` (exit 2). PATH
may be a checkout, a linked worktree or the common Git directory; it resolves to the realpath of
`git rev-parse --path-format=absolute --git-common-dir`. The result is
`{kind:"workflow.unlock.worktree-admin.result", ok:true, commonGitDir, lockPath, forceRemote, lock}`,
where `lock` is null when the lock was not held, or
`{path, owner, recovery, warning?, action:"removed"|"absent"}` with `owner` and `recovery` as
`{pid, host, state}` or null. A dead or released owner, a dead recoverer, and missing or unreadable
metadata (reported in `warning`) are cleared under the lock's recovery claim, through the
token-verified tombstone rename. It refuses with `worktree.locked` (exit 3) and removes nothing
while an owner or recoverer is locally alive or unverifiable (never overridable), or is on a foreign
host without `--force-remote`; with it, a foreign holder is judged by local PID observations.
`error.details` has `lockPath`, `commonGitDir`, `role`, `pid`, `host`, `state` and `next`, and the
failure's `runId` and `stateDir` are null. `next` is the
`workflow unlock --worktree-admin <common Git dir>` command to run once the holder is gone, with
`--force-remote` only for a foreign holder; a race (`changed during unlock`) carries the plain
command. Nothing is ever signaled.

`workflow rm ID [--force] [--refs] [--dry-run] --json` removes one saved run without importing
workflow code ([ADR 0049](decisions/0049-guard-held-run-removal.md)): the run directory (record,
journal, `attempts/` transcripts, artifacts, `launch/`, inbox, lock), the legacy `<runId>.json`
marker or flat record, `<runId>.json.lock`, `<runId>.inbox`, `<runId>.cancel.json` and the
`<runId>.json.v<N>` backups, and its worktree caches. Caches are removed through the same cleanup as
`workflow clean`, under the worktree administration lock; when the ledger's repository no longer
exists, rm deletes the caches inside the run's own `<root>/<runId>-<namespace>/` directly, after
checking that each is a real directory named by a SHA-256 digest that matches its ledger key (a
failed check refuses with `workflow.storage` and deletes nothing). It then removes the empty
namespace directory. Pinned refs are deleted only with `--refs`. It refuses with exit 3 and changes
nothing, in this order: `run.locked` while any lock owner or recoverer is alive, unverifiable or on
a foreign host, or has unreadable metadata, even with `--force` (`error.details` has `lockPath`,
`kind`, `role`, `pid`, `host` and `state`; the message names `workflow unlock`, with
`--force-remote` for a foreign host, and `error.details.next` lists the same command, with none for
an alive or unverifiable owner); `run.orphans` while a dead or released owner's recorded child is
alive or unverifiable; and, without `--force`, `run.active` when the recorded status is `running` or
`suspended` or any step is `waiting` (`error.details` is `{status, waiting}`), since a pending wait,
answer or resume may still need the run. After taking the lock rm refuses with `run.exists` and
removes nothing when another run reused the ID since rm inspected it (`error.details` has
`expectedCreatedAt` and `createdAt`). A missing run is `run.not_found` and an unreadable one
`run.unreadable`. rm takes the run lock without registering a project, so a dead owner's lock is
recovered as on resume. When Git cannot remove a cache while its repository exists, rm stops before
deleting the run and fails with `workflow.storage` (exit 74): caches Git already removed stay
removed and are recorded in the ledger (`error.details.removedCaches` names them), no ref is
deleted, the message and `error.details.caches` name each cache that remains,
`error.details.warnings` carries Git's reasons, and the record stays for a retry with
`workflow clean ID`. Success returns
`{kind:"workflow.rm.result", ok:true, runId, stateDir, dryRun, force, refs, verdict, removed, launchOnly, paths, caches, refsRemoved, keptRefs, bytes, tombstones, warnings}`:
`paths` are the run's paths in the runs container, `caches` are `{path, method:"git"|"direct"}`,
`keptRefs` lists the pins that survive without `--refs`, `bytes` is the list `bytes` measured before
removal, and `tombstones` names the abandoned removals this rm swept. `--dry-run` takes no lock,
sweeps nothing and writes nothing; it exits 0 whenever the run exists, with `removed: false` and
`verdict` either `"remove"` or the `{code, message}` refusal a removal would meet now (taking
`--force` into account), and lists what would be removed, with `refsRemoved` naming the refs that
`--refs` would delete and `tombstones` the ones a removal would sweep. See
[storage](storage.md#removing-runs).

A [leftover launch directory](storage.md#removing-runs), the record-less `<runId>/launch/` of a
start that failed before its record
([ADR 0055](decisions/0055-remove-leftover-launch-directories.md)), is not a run, but
`workflow list` reports it and `workflow rm ID` removes it. The list document's `leftoverLaunches`
(in both the compact and the `--full` form) has one
`{runId, stateDir, path, bytes, launches, newest, log}` entry per removable leftover in every
scanned runs container (all of them with `--all`), newest first: `launches` are the launch numbers,
`newest` the newest launch file's modification time and `log` the highest launch's `<n>.log` (null
when absent). A leftover whose launch may still be in flight is omitted, a scan error is a warning,
and with `--status` the array is empty, since a leftover has no status. The text view prints one
`Leftover launch ID (SIZE, no record): LOG; remove with COMMAND` line per leftover after the table,
with the `workflow rm ID --state-dir DIR` command behind the invocation's launcher. When the ID has
no `run.json` or `<runId>.json` and names a leftover, rm takes a separate path instead of reporting
`run.not_found`. It refuses with `run.active` (exit 3), even with `--force`, while any launch may
still be in flight (a recorded runner that is alive, unverifiable or remote, an unreadable runner
record, or, without one, files less than an hour old); `error.details` is
`{status:"starting", waiting:[], launches}` with each launch as `{n, pid, host, state, inFlight}`.
Otherwise it takes only the legacy guard, without registering a project (a held or unreadable guard,
or a lock beside it, is refused as `run.locked` before the guard is taken), re-checks under it
(`run.exists` when a run now holds the ID, `run.active` when a new launch appeared) and renames the
directory to a tombstone before deleting it. The result has `launchOnly: true` (false for every real
run), `paths` naming `<runId>/`, no caches or refs, and `--refs` changes nothing. A dry run of a
leftover exits 0 and reports the verdict a real rm would meet now: `run.active` for an in-flight
leftover, otherwise `run.locked` while the legacy guard (or a lock beside it) is held, otherwise
`remove`. A cancellation signal is honoured up to the rename; an abort until then leaves the
directory in place.

`workflow prune [--older-than DURATION] [--status S[,S]] [--missing-cwd] [--all] [--refs] [--dry-run] --json`
removes finished runs in bulk without importing workflow code
([ADR 0050](decisions/0050-select-runs-for-prune-conservatively.md)). It needs at least one of
`--older-than`, `--status` or `--missing-cwd`; a bare prune fails with `usage.flag` (exit 2) before
reading anything, because prune has no delete-everything mode. `--status` is comma-separated or
repeated and takes only `completed`, `failed` and `cancelled` (the default is all three); any other
value, and an `--older-than` that is not a duration (`ms`, `s`, `m`, `h` or `d`, such as `7d`), fail
with `usage.flag`. `--all` scans every registered XDG project as `workflow list --all` does and
cannot be combined with `--state-dir`; without it prune scans the resolved runs container plus, when
neither `--state-dir` nor `QUIET_CHOIR_STATE_DIR` is set, the current project's legacy
`.quiet-choir/runs`. A run is selected when its observed status is one of the statuses, its
`updatedAt` is strictly older than `--older-than` (an unparseable `updatedAt` never matches), and,
with `--missing-cwd`, its recorded cwd is missing (a stat that fails with `ENOENT` or `ENOTDIR`; any
other error means unknown, which never matches, with a warning). A matching run is still kept, and
listed in `skipped` with its `reason`, when it is `active` (observed running, stale or suspended),
`locked` (any lock owner or recoverer alive, unverifiable or remote, or unreadable lock metadata),
`orphans` (a dead owner's live or unverifiable child), `waiting` (a step is waiting) or
`queued-answer` (a file in `<runId>/inbox/` or `<runId>.inbox/` that a resume could still consume:
every entry counts, even an unknown leftover, except the answer file of a question the record shows
resolved through the inbox and a `.rejected.<uuid>.json` file beside one of the run's answer paths,
which owners leave behind; an unreadable inbox or record counts too). Each selected run, oldest
`updatedAt` first, then goes through `workflow rm`'s removal without `--force`, one at a time and
each under its own guard, so rm re-checks its refusals under the lock; `--refs` is passed through.
Prune also pins the record it selected: when the run's `updatedAt` changed before or under the lock,
that removal refuses and the run is skipped with reason `changed` (code `run.exists`). A refusal or
failure of one removal never stops the batch: it becomes a `skipped` entry with reason `locked`,
`orphans`, `active`, `changed`, `gone` (another removal won, `run.not_found`), `refused` (another
`run.*` code) or `storage` (a cache Git could not remove, or another error of that one removal,
`workflow.storage`). Before removing anything prune sweeps abandoned rm tombstones in every scanned
container. Success (exit 0, also with skipped runs) returns
`{kind:"workflow.prune.result", ok:true, dryRun, stateDirs, filters:{olderThanMs, statuses, missingCwd, all, refs}, removed, skipped, bytes, tombstones, roots, warnings}`:
`removed[]` entries are
`{runId, stateDir, status, updatedAt, cwd, bytes, paths, caches, refsRemoved, keptRefs, warnings}`
as rm reported them, `skipped[]` entries are
`{runId, stateDir, status, updatedAt, cwd, bytes, reason, code, message, details}` where `code` is
the CLI code rm refused (or would refuse) with, `workflow.storage`, or null for `queued-answer`,
`bytes` is the sum of `removed[].bytes`, `tombstones` are absolute paths, and `warnings` carry
unreadable runs (which are never removed), unreadable inboxes and unknown cwds. Runs that do not
match are not listed. `roots` is empty unless both `--missing-cwd` and `--all` are given; then,
after the run removals, prune judges every stale XDG project root
([ADR 0051](decisions/0051-remove-stale-project-roots-by-rmdir.md),
[storage](storage.md#removing-runs)): registered roots whose recorded cwd is missing and roots
without a readable, valid `project.json`; never the current project's root or a root whose cwd
exists. `roots[]` entries, sorted by root, are
`{root, cwd, registered, removed, reason, bytes, paths, runs, message}`: `cwd` is null for an
unregistered root; `reason` is `missing-cwd` (a removed registered root), `empty` (a removed root
without `project.json` that held only empty `worktrees/` directories), `runs-kept` (a run listed in
its `runs/` stays), `in-use` (a `worktrees/<runId>-<namespace>/` directory names a run some scanned
container still holds), `files` (any other file, symbolic link or unknown directory), `busy` (an
`rmdir` found a directory no longer empty, after which prune restored the file it had unlinked) or
`storage` (any other error); `bytes` is, for a removed root, the size of the `project.json` and
`runs/.gitignore` it unlinked and null for a kept root; `paths` lists, for a removed root, the paths
it unlinked or removed in order and, for a kept root, up to 20 paths that keep it; and `runs` names
the runs behind `runs-kept` or `in-use`. Root removal unlinks only those two files and removes every
directory with `rmdir`. `bytes` at the top level remains the sum of `removed[].bytes`, and an
unknown cwd of a root adds a warning instead of an entry. `--dry-run` runs each selected removal as
an rm `--dry-run`: it takes no lock, sweeps nothing and changes nothing, `removed[]` lists the runs
a prune would remove now with their bytes, a dry-run refusal moves the run to `skipped`, and
`roots[]` shows the roots a prune would remove now (`removed: true`), judged without the paths of
the runs it would remove. A runs container that cannot be read fails the command with
`workflow.storage` (exit 74). A signal stops prune between removals (a removal past its commit point
still finishes) or between project roots with `workflow.interrupted` (exit 130),
`error.details.removed` naming the runs and `error.details.roots` the project roots already removed;
run prune again to continue. See [storage](storage.md#removing-runs).

`workflow cancel ID [--force] [--timeout 30s] --json` ends an unfinished run as `cancelled` without
importing workflow code
([ADR 0039](decisions/0039-cancel-a-live-run-through-a-token-bound-request.md),
[ADR 0057](decisions/0057-end-an-unowned-run-as-cancelled.md)). A run that no lock holds
(`suspended`, or `running` after a crashed owner's lock was cleared) is saved `cancelled` under the
run lock, with no signal: cancel takes the lock without recovering a dead owner's, re-reads the
record, and saves the cancelled status, a `run.cancelled` event and a new execution entry, leaving
steps and worktrees as they are. A lock that an owner or tick takes meanwhile is observed again, up
to three times, then reported as `run.locked`. Otherwise cancel signals only a lock owner on this
host that is alive and still has the OS start time it recorded: it writes a cancel request bound to
that owner's lock token, re-verifies the owner, sends one SIGINT to its PID (never a group), and
waits for the run to end. Success (exit 0) returns
`{kind:"workflow.cancel.result", ok:true, runId, stateDir, status, signalsSent, owner, previousStatus}`:
`status` is `cancelled`, or `completed`/`failed` when the run ended first; `owner` is the signalled
`{pid, host, osStartTime}`; `previousStatus` is the unfinished status (`running` or `suspended`)
that cancel itself ended under the lock, and null when an owner ended the run or it had already
ended. A run that already ended is a no-op with `signalsSent: 0`, `owner: null` and
`previousStatus: null`. Refusals exit 3 and send nothing: `run.not_found`; `run.incompatible` for an
unowned format-1 checkpoint, which cannot be saved without its workflow (resume it once or remove
it); and `run.locked` for an unreadable, foreign-host, released, dead or unobservable owner, or one
without a recorded or with a mismatched `osStartTime` (`error.details` has `lockPath`, `pid`,
`host`, `state`, `osStartTime` and `reason`, plus `next` with the `workflow unlock` command for a
released, dead or mismatched owner, the cases whose message names it). After `workflow unlock`
clears a dead owner's lock, a second cancel ends the run. After the signal, an owner that exits
without saving a terminal status is `run.unowned` with `details.reason: "owner-exited"`,
`signalsSent` and `forced`, and the next tick may resume the run; `run.unowned` has no other reason.
The wait is bounded by `--timeout` per signal: past it, `watch.timeout` (exit 79) with
`details: {timeoutMs, signalsSent, forced, pid}` and the last saved `status`; the request stays for
the owner to honour late. With `--force`, cancel first sends a second SIGINT if the same verified
owner still holds the run at the deadline; the owner then force-kills its groups and exits 130,
usually leaving `running` for tick's stale recovery. The cancelled owner itself exits 130 with
`workflow.interrupted` and a saved `cancelled` status, which tick observes and never resumes.

`execute --dry-run --json` returns a `workflow.rehearsal` document with `ok:true`, calls (each with
`worktree`, `{synthesized: true, base, baseSource}` for a synthesized isolated call or null),
commands (each with `stepId`, `parentStepId` (the step or wait whose callback issued it through
`context.exec`, or null for `ctx.exec`), `outputSource` (`synthesized`, `fixture`, or `live` for an
observer's `live: true` command), the matched exec `fixtureIndex` or null, and `error`), `merges`
(synthesized `ctx.merge` effects with `stepId`, `synthesized`, `commit`, `inputs`, `target` and
`baseSource`), replays, provider counts, nominal Claude ceiling, `staleExecFixtures`, warnings, and
its in-memory run record. Failures retain the usual error document and exits, adding `rehearsal` and
`error.stack`; the rehearsal warnings and `Rehearsal: ...` stderr summary are printed on both paths.
Temporary state has already been removed on normal exit; dry-run never overwrites the
requested/default state directory. `workflow fixtures ID --json` returns version-1 fixture JSON from
a completed run: its agent outputs, settled agent failures and agent failures the workflow absorbed
(a body `try/catch` or a settled map item) as `error` rules without `kind`, and its completed
command results as `exec` rules with environment and stdin digests only, plus
`"commands": "fixture"` when there is at least one. See [workflow rehearsal](rehearsal.md).

Failures have these fields:

| Field                         | Meaning                                                                                                                                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`, `ok`, `exitCode`      | `"workflow.error"`, `false`, and the process exit code                                                                                                                                                                                                                            |
| `error.code`, `error.message` | Stable code and diagnostic naming the root effect when available                                                                                                                                                                                                                  |
| `error.stepId`                | Root failing effect, or null for a body failure or interruption; never an aborted sibling                                                                                                                                                                                         |
| `error.details`               | Structured context: lock PID/host, schema issues, input source/position, compatibility comparison, or available run IDs; `{errorKind, retryable}` for `workflow.failed`                                                                                                           |
| `runId`, `stateDir`           | Requested/generated ID and absolute storage directory when known; otherwise null                                                                                                                                                                                                  |
| `status`                      | Actual saved checkpoint status, or null when unavailable                                                                                                                                                                                                                          |
| `summary`                     | execute, resume and answer without `--full`, and inspect with `--summary`: the compact run result, or null when unavailable                                                                                                                                                       |
| `run`                         | Saved record, or null when unavailable. Every other command, inspect without `--summary`, a `--dry-run` failure, or `--full` on execute/resume/answer                                                                                                                             |
| `failedSteps`                 | Saved failed/cancelled steps with ID, kind, attempts, error, `errorKind` (last attempt, or null) and `retryable` (the kind is `rate-limit`, `overloaded`, `timeout` or `idle-timeout`)                                                                                            |
| `diagnostics`                 | Compiler diagnostics (`category`, `code`, `filePath`, `line`, `column`, `message`, `relatedInformation`), or the [durability lint](#durability-lint) entries of a failed validate (`rule`, `category`, `file`, `line`, `column`, `message`); never both; otherwise an empty array |
| `next`                        | Runnable follow-ups `{why, argv}`, or an empty array; see [next commands](#next-commands)                                                                                                                                                                                         |
| `launch`                      | `workflow start` only: `{runId, pid, log, result, exitCode, signal}`; see [workflow start](#workflow-start)                                                                                                                                                                       |

The error codes map to numeric exits in one CLI table:

| Exit | Codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Next step                                                                                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `workflow.failed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | A failed checkpoint was saved. Fix the workflow or execution policy and resume.                                                                                                                                                                     |
| 2    | `usage.flag`, `usage.file_not_found`, `usage.entrypoint`, `usage.run_id`, `usage.input_json`, `usage.input_file`, `usage.input_schema`, `usage.resume_requires_run_id`, `answer.invalid` (the answer was not written)                                                                                                                                                                                                                                                                         | Correct arguments/input. No execution checkpoint was written.                                                                                                                                                                                       |
| 3    | `run.exists` (also `workflow rm` after another run reused the ID), `run.not_found`, `run.locked`, `run.incompatible`, `run.input_changed`, `run.unreadable`, `run.orphans`, `run.unowned` (`workflow cancel`'s owner then exited), `run.active` (`workflow rm` without `--force` found a running, suspended or waiting run), `answer.conflict` (the question is not waiting or already has a delivery), `worktree.locked` (`workflow unlock --worktree-admin` refused a held repository lock) | Correct run/storage selection, wait for the owner, or explicitly resolve compatibility/ownership. No workflow body ran.                                                                                                                             |
| 4    | `load.typecheck`, `load.import`, `load.definition`                                                                                                                                                                                                                                                                                                                                                                                                                                            | Fix trusted source or its definition. No execution checkpoint was written.                                                                                                                                                                          |
| 66   | `watch.record_not_created`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `inspect --watch --wait-created` saw no record within the bound. Check the run ID and `--state-dir`, or whether the launch failed.                                                                                                                  |
| 70   | `start.exited`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | The `workflow start` runner exited without a record or a readable result document; read `launch.log`.                                                                                                                                               |
| 74   | `workflow.storage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Inspect saved state and fix storage/ownership before deciding how to resume. External effects may already have happened.                                                                                                                            |
| 75   | `workflow.run.suspended`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Saved suspension with pending waits, including a run that `inspect --watch` saw end suspended; answer questions, deliver signals, or tick when due.                                                                                                 |
| 79   | `watch.timeout`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `inspect --watch --timeout`, `events --follow --timeout` or `cancel --timeout` stopped waiting while the run had not ended; the run continues. Wait again or inspect it later; a repeated `cancel` is the owner's second SIGINT and force-kills it. |
| 130  | `workflow.interrupted`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | A first signal saved a resumable `suspended` run; the next tick or `resume` continues it. An owner stopped by `workflow cancel` saved `cancelled` instead.                                                                                          |
| 124  | `start.timeout`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `workflow start` stopped a runner that owned no record within `--start-timeout`; read `launch.log`.                                                                                                                                                 |

Typechecking and import are distinct from workflow execution. Imports can have arbitrary side
effects; no exit status promises to undo them. Run-ID and input-JSON validation happen before
import. Schema validation needs the imported workflow definition. Resume with a schema-invalid
replacement input is usage failure; valid but changed input is `run.input_changed`.

A first SIGINT, SIGTERM or SIGHUP drains owned work and, when storage permits, saves a resumable
`suspended` run with `nextWakeAt` set to now and `interruptedBy: {reason, at}` (for example
`Workflow interrupted by SIGTERM.`), then still exits 130 with `workflow.interrupted`. The next
`workflow tick` treats the run as due and resumes it, reusing completed steps; `resume` works too.
Explicit or workflow-scoped cancellation still saves `cancelled`, which tick never retries. See
[ADR 0029](decisions/0029-persist-interruptions-as-resumable-suspensions.md). A second signal kills
tracked groups and writes the last readable checkpoint synchronously and in full, retrying a full
pipe for up to 5 seconds, before exit 130; `error.details.forced` is true and `status` may still be
`running`, which tick recovers as a stale run. SIGKILL, process crashes, and a closed output pipe
cannot deliver a JSON document. Failure documents, like success documents, are written in full
before the process exits, including when stdout is a pipe. Storage failures use exit 74 so that a
failed save never masquerades as exit 1, and a storage failure during an interrupt keeps exit 74
rather than 130 because the interruption checkpoint may not have been saved. A run whose saved
status is `failed` reports `workflow.failed` (exit 1) even when a signal arrived, because the runner
saves an interrupted suspension (or `cancelled`) only when the interrupt caused the failure. Saved
completion with a known cleanup warning still succeeds under the
[process ownership contract](process-lifecycle.md), as does a completion or suspension (exit 75)
that `execute`, `resume`, or `answer --resume` saved before a late signal, or an answer that
`workflow answer` already delivered. Inspect, validate, typecheck, and check-resume report
`workflow.interrupted` after a first signal even when their work finishes.

`check-resume` incompatibility uses exit 3 with the full comparison in `error.details`; a record
this build cannot fully read adds the `record_schema` fields
([record schema revision](storage.md#record-schema-revision)). Its compatible success retains
`check`. `execute --resume --accept-code-change` (and `resume --accept-code-change`) first replays
the accepted body against a disposable copy of the record. When that replay reaches a completed or
settled-failed step whose identity changed, the command refuses with `run.incompatible` (exit 3)
before writing anything: `error.details.divergent` is `[{stepId, components}]` for the first such
step, and `error.details.next` holds one argv array,
`LAUNCHER workflow execute FILE --fork-from RUN --reuse matching --invalidate STEP --run-id <NEW_RUN_ID> --state-dir DIR`,
built behind the same launcher as `resumeCommand` with a placeholder for the new run ID. When the
replay instead finishes without revisiting a completed step, settled map or completed or settled
child frame (a `ReplaySkippedError`), the refusal is the same except that `error.details.divergent`
has one `{stepId, skipped}` entry per skipped ID, where `skipped` is `step`, `map` or `child-frame`
and the IDs come from the first failing check (child frames, then maps, then steps), and the fork
command invalidates the first skipped ID. `execute --dry-run --resume --accept-code-change` returns
the same code, message and details. A missing run includes `details.runId` (the run that was not
found, which is a `--fork-from` source when that is what is missing), `details.stateDir`, sorted
`details.available` (at most 20 IDs), `details.count`, and `details.candidates`: at most 10 other
runs containers that hold the ID, as `{stateDir, cwd}` sorted by `stateDir`, or an empty array. The
search covers every registered XDG project root and its legacy `.quiet-choir/runs`, plus the default
and legacy roots of the current directory and its ancestors; it never lists the root already
searched, and an unreadable candidate is skipped rather than changing the code. The message then
ends with `Found in DIR (project CWD); rerun with --state-dir DIR.` Resolution itself is unchanged:
explicit `--state-dir` and `QUIET_CHOIR_STATE_DIR` win, and the default root still hashes the exact
working directory. A resume whose stored entrypoint no longer exists (a moved checkout or deleted
file) is `run.incompatible` (exit 3) with
`details: {storedEntrypoint, reason:"entrypoint_missing"}`; fork from the new location. A record
written by a newer quiet-choir (a newer `schemaRevision`, or top-level fields this build does not
know) is `run.incompatible` (exit 3) for `resume`, `execute --resume`, `answer --resume`,
`--fork-from`, `--dry-run` and `workflow clean`, with
`details: {reason:"record_schema", schemaRevision, supportedSchemaRevision, hiddenFields}` and
nothing written; `check-resume` reports the same refusal (exit 3, `record schema` in
`details.changed` beside those fields, never overridable by `--accept-code-change`); `inspect` and
`list` warn instead. See [record schema revision](storage.md#record-schema-revision). Storage
resolves explicit options, environment, existing legacy runs, then the external XDG project default;
relative explicit paths resolve against the launch directory.

## Durability lint

After a type check with no errors, the loader runs a static durability lint (rules QC001-QC005,
[ADR 0041](decisions/0041-static-durability-lint.md); rule reference in the skill's
`references/patterns.md`, "Durability lint") over the workflow file and the local modules it
imports, never quiet-choir's own sources or `node_modules`.

- `workflow validate` fails on any finding with `load.typecheck` (exit 4) before importing the
  module. The message starts with "Workflow durability lint failed: N finding(s)" and names the
  suppression comment. Each finding is a `diagnostics` entry
  `{rule, category: "error", file, line, column, message}` with an absolute `file` and 1-based
  `line` and `column`. Human output prints `path:line:col - error QCnnn: message` to stderr, with
  `path` relative to the working directory. Compiler and lint entries share this array and are told
  apart by `rule` versus `code` and `filePath`. They never mix, because the lint runs only after a
  clean type check: a type error keeps the existing compiler diagnostics and skips the lint. A
  successful `validate --json` has `diagnostics: []`.
- `workflow execute`, `resume`, `answer --resume`, `tick`, `check-resume` and the runner behind
  `workflow start` (in its log) write each finding as a
  `[warn] path:line:col - warning QCnnn: message` log line on stderr and continue;
  `--log-level error` hides them. JSON documents are unchanged.
- `workflow list-defs`, and execution by registry name through it, validate each definition with the
  lint as a warning: definitions with findings are still listed and runnable, and the warnings are
  logged when a definition is validated, not when it is served from the definition cache. The listed
  definitions carry no `diagnostics` field, so fresh and cached entries are identical. Use
  `workflow validate` as the gate.
- `workflow typecheck`, `configuration doctor --workflow` and `runWorkflow` do not lint.
- A `// quiet-choir-ignore QC002 <reason>` comment (several rules: `QC002, QC005`) on its own line
  directly before the reported line silences the listed rules for findings that start on that line.
  The CLI accepts a missing reason; this repository's `npm run durability:check` requires one.

## Workflow start

`workflow start FILE [execute flags] [--start-timeout DURATION] [--json]` launches
`workflow execute` as a detached runner and returns once the run's record exists.
`workflow start --resume --run-id ID [FILE] [execute flags]` resumes an existing run the same way
(FILE is optional, as for execute). Start accepts execute's flags, including `--resume`,
`--kill-orphans` and `--accept-code-change`, except `--dry-run`, `--stub-steps` and `--full`. Those
three are refused with `usage.flag` (exit 2) before anything is read or launched. A dry run removes
its state, so no record remains for a detached runner to own; `--stub-steps` applies only to a dry
run; and `--full` only shapes execute's foreground result. The refusal's message gives the reason,
and `next[0].argv` is the launcher-correct foreground `workflow execute` command with start's own
arguments as given, minus `--start-timeout` and its value; for `--full` the message also names
`workflow inspect RUN --json --full`. `--resume` without `--run-id` is refused with
`usage.resume_requires_run_id` and a missing FILE without `--resume` with `usage.flag`, both before
spawning. The run ID is generated when `--run-id` is absent and the state directory is resolved as
for execute, both before the runner starts; start passes the rest of its argv through unchanged,
appends `--run-id` and `--state-dir` when absent, and always appends `--json`. The runner is
`[node, realpath(bin/run.js), "workflow", "execute", …]` (development mode keeps the tsx loader
flags), never a PATH lookup, in its own session with stdin from `/dev/null`. Its stdout and stderr
go to `<stateDir>/<runId>/launch/<n>.result.json` and `<n>.log`, created exclusively for the
smallest free `n` (0600 files, 0700 directories); `--input -` is read by start and passed as
`--input @<n>.input.json`. Right after spawning the runner, start records `{pid, host, osStartTime}`
in `<n>.runner.json` (0600, created exclusively), which judges whether the launch is still in
flight; a failed write changes nothing else.

Readiness: start polls every 50 ms. While the runner lives, start succeeds once the record is
readable and the run lock's owner is the runner's PID; another process's lock does not count. After
the runner exits, a readable record counts when its document is a success (a fast completion or
suspension) or a failure other than `run.exists` and `run.locked`.

Resume readiness ([ADR 0056](decisions/0056-detached-resume.md)): the record exists before the
runner starts, and the runner takes the lock before it refuses an incompatible or changed run, so
neither counts. Before spawning, start reads the run's last execution number as a baseline. While
the runner lives, start succeeds once the record holds an execution numbered above the baseline
whose `pid` is the runner's (saved when the body starts). After the runner exits with a usable
document, such an execution counts whatever the document says, and so does a success document with a
readable record (a completed run, whose resume returns the stored output without a new execution).
Any other document is reported with the runner's own code and the run's `runId`, for example
`run.locked`, `run.orphans`, `run.incompatible` or `run.input_changed`. `--start-timeout` also
covers the runner's `--kill-orphans` recovery of the primary lock and the `--accept-code-change`
preflight. A dead owner's legacy guard (`<runId>.json.lock`) is checked by start itself before it
spawns, so with `--kill-orphans` start stops its identity-confirmed children there, outside
`--start-timeout`, and without the flag it refuses with `run.orphans`. Success (exit 0) is

```json
{
  "kind": "workflow.start.result",
  "ok": true,
  "exitCode": 0,
  "runId": "x",
  "stateDir": "/abs/runs",
  "pid": 12345,
  "status": "running",
  "log": "/abs/runs/x/launch/1.log",
  "result": "/abs/runs/x/launch/1.result.json",
  "next": [
    {
      "why": "...",
      "argv": ["...", "workflow", "inspect", "x", "--state-dir", "/abs/runs", "--json", "--summary"]
    }
  ]
}
```

`status` is the saved status when start returned: `running`, or `completed`, `failed` or `suspended`
when the runner already finished. `next` holds `inspect --json --summary` and `inspect --watch`
entries. The text form prints `Started run ID (runner PID n, status s).` (for a resume,
`Resumed run ID …`) with `Log:`, `Result:` and `Next:` lines. The runner's own exit and document
stay in the result file.

Failures use the ordinary `workflow.error` document with an added `launch` field
`{runId, pid, log, result, exitCode, signal}`: the run ID passed to the runner, its PID (null when
it never spawned), the evidence paths, and how it exited (null while it was still running). A
failure before the record exists, such as `load.typecheck` (exit 4) or a `usage.*` refusal (exit 2),
carries the runner's error, diagnostics and `next`, the exit code of that error, and top-level
`runId: null`, so no run is reported as started. The propagated top-level `next` is rebuilt behind
start's own launcher: each well-formed `{why, argv}` entry keeps its `why` and the words from its
`workflow` program word on (the `workflow` right after the program words start spawned the runner
with, when the entry begins with exactly those, else its first `workflow` word), and a malformed
entry (or a `next` that is not a list) is dropped. `error.message` and `error.details`, including
`details.next` of `run.locked`, stay the runner's verbatim and may name the runner's
`[node, realpath(bin/run.js)]` launcher, so a propagated document's top-level `next` need not equal
`details.next`. Top-level `runId` is set only when a record is readable. An existing run (`run.json`
or a legacy flat checkpoint) is refused with `run.exists` (exit 3) before anything is launched,
without `launch`. With `--resume` the check is inverted: a missing run is refused with
`run.not_found` (exit 3, with `readRun`'s candidates and inspect entries), without `launch` and
without creating `<runId>/`, and an existing run's launch files take the next free `n`, so earlier
launches' evidence is kept. Start checks for the run and creates its launch files while holding the
run's legacy guard, so a held guard (for example a `workflow rm` of that ID still in progress, or a
live runner of the run being resumed) is refused with `run.locked` (exit 3), also without `launch`;
for a resume the failure carries the run's `runId`. Without an owned record (for a resume, an
execution recorded by the runner) within `--start-timeout` (default `60s`), start sends SIGTERM to
the runner's process group, waits `--kill-grace-ms` (default 3000; validated as for execute, so a
bad value is `usage.flag` before anything is launched) plus 2 s for it to save, sends SIGKILL if
needed, and fails with `start.timeout` (exit 124). A runner that exits without a record or a
readable document is `start.exited` (exit 70). A first signal to start stops the runner the same way
and reports `workflow.interrupted` (exit 130); a second one kills it at once. A runner that had
saved a record leaves a resumable suspension, reported with its `runId` and a resume entry in
`next`. The launch directory of a pre-record failure has no `run.json`, so `inspect` reports
`run.not_found`; a retry with the same ID uses the next `n`. Once its runner has exited,
`workflow list` reports it in `leftoverLaunches` and `workflow rm ID` removes it
([ADR 0055](decisions/0055-remove-leftover-launch-directories.md)). See
[ADR 0036](decisions/0036-detached-start.md) and [ADR 0056](decisions/0056-detached-resume.md).
Detached sessions are POSIX behaviour; Windows is not covered.

## Event stream

`--events FILE|-` is accepted by `workflow execute`, `start`, `resume`, `tick` and, with `--resume`,
`answer` (without `--resume` it is a usage error). FILE resolves against the launch directory and
receives one JSON line of at most 512 bytes per step, phase, log, wait and run event, appended to an
owner-only file; see [run observability](observability.md#event-stream) for the fields, the event
set and the replay rule. A sink that cannot open or write its file warns once on stderr and never
changes the result document or the exit code. The flag is not saved with the run.

`-` writes the lines to stdout, which then carries only event lines: workflow console output and the
human result go to stderr, as under `--json`. `--events -` (or `--events=-`) together with JSON
output is refused with `usage.flag` (exit 2) before any run work, because `--json` reserves stdout
for the result document; this includes answer's `--json VALUE` form. `workflow start --events -` is
always refused with `usage.flag`, because the runner's stdout is the launch result file; start
passes `--events FILE` to its runner unchanged. `--events FILE` with `--json` leaves the stdout
document exactly as it is without the flag.

## Event follower

`workflow events RUN [--follow] [--from-start | --after-execution N] [--interval D] [--timeout D] [--wait-created D] [--state-dir DIR] [--json]`
prints a run's compact event lines (the [event stream](#event-stream) shape, at most 512 bytes each)
on stdout, derived from the persisted record without importing the workflow, so it works after the
workflow file moved or stopped compiling. See
[following a run without its events file](observability.md#following-a-run-without-its-events-file)
for what the record can and cannot supply.

- Without `--follow` it prints the record's lines once (all of them, or only those of executions
  after `N` with `--after-execution N`) and exits 0, like non-watching `inspect`.
- With `--follow` it starts from the current end: the first read prints nothing, and each later read
  prints the new lines as soon as it derives them, one write per line. `--from-start` prints the
  whole record first. `--after-execution N` prints only entries recorded by executions after `N` and
  ignores a terminal status until a later execution reaches one; pass the `execution` of a suspended
  snapshot so a follower started beside `answer --resume` waits for the resumed execution instead of
  stopping on the old `suspended` status. An attempt saved before executions were recorded counts as
  earlier.
- `--follow` exits like `inspect --watch` once the run is terminal: 0 completed, 1 failed, 75
  suspended, 130 cancelled, 3 stale. `--interval`, `--timeout` (exit 79, `watch.timeout`) and
  `--wait-created` (exit 66, `watch.record_not_created`) have the watch's syntax, range and rules;
  without `--wait-created` a missing record fails at once with `run.not_found` (exit 3).
  Interrupting the follower exits 130, and so does a reader that closes the pipe.
- Output is always JSONL. `--json` only turns a failure into a `workflow.error` document on stdout
  (with the compact `summary`, never the whole record); without it the failure message goes to
  stderr. `--from-start` with `--after-execution`, a negative `N`, and `--interval`, `--timeout` or
  `--wait-created` without `--follow` are `usage.flag` (exit 2).
- `--log-level debug` reports each read on stderr (`Events: read run …`).

## Next commands

Every failure document has a top-level `next` array, and `inspect --json --summary` (and
`list --full`) summaries carry one too; compact `list` rows do not. Each entry is
`{why: string, argv: string[]}`: run `argv` directly, without a shell, after substituting its
placeholders. Text inspect and human failure messages print each entry as
`Next: <shell-quoted argv>  (why)`.

| Source                                                | Entries                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `workflow.failed`, saved failed run, nothing recorded | none, as there is no recovery hint: the run recorded no step or map                                                       |
| `workflow.failed`, saved failed run, grant cause      | `execute --resume --run-id RUN --state-dir DIR --grant PROFILE`, or `ACCESS` for call-site overrides                      |
| `workflow.failed`, saved failed run, divergence       | a fork from the stored entrypoint; none for a legacy checkpoint                                                           |
| `workflow.failed`, saved failed run, map changed      | `resume … --accept-code-change`, then a fork, when only the mapper changed; otherwise only a fork                         |
| `workflow.failed`, saved failed run, budget stop      | `resume RUN --state-dir DIR <FLAG> <LIMIT>`, FLAG being the stopping cap's flag                                           |
| `workflow.failed`, saved failed run, other cause      | `resume RUN --state-dir DIR`, also for a record without `recoveryCause` (before revision 10)                              |
| `workflow.interrupted` with a saved suspension        | as for a suspended summary                                                                                                |
| `start.timeout` with a saved suspension               | as for a suspended summary                                                                                                |
| `run.orphans`                                         | `resume RUN --state-dir DIR --kill-orphans`                                                                               |
| `run.locked`, holder local, gone or damaged           | `unlock RUN --state-dir DIR` from `error.details.next`                                                                    |
| `run.locked`, holder on a foreign host                | `unlock RUN --state-dir DIR --force-remote` from `error.details.next`, and no other entry                                 |
| `run.locked` from `cancel` or `rm`, live owner        | none: the message does not name `workflow unlock`                                                                         |
| `worktree.locked`                                     | `unlock --worktree-admin DIR`, with `--force-remote` for a foreign holder, from `error.details.next`                      |
| `run.incompatible`, code or schema change only        | `resume … --accept-code-change` (unless the run completed), then a fork                                                   |
| `run.incompatible`, other run-level changes           | a fork from the stored entrypoint; none when the workflow name changed or for a legacy checkpoint                         |
| `run.incompatible`, divergent or skipped path         | the fork command from `error.details.next`                                                                                |
| `run.incompatible`, different requested FILE          | `resume` with the stored entrypoint, then a fork from the requested FILE                                                  |
| `run.incompatible`, `entrypoint_missing`              | `execute <ENTRYPOINT> --fork-from RUN --run-id <NEW_RUN_ID> --state-dir DIR`                                              |
| `run.incompatible`, `record_schema`                   | none: upgrade quiet-choir                                                                                                 |
| `run.not_found` with `details.candidates`             | `inspect RUN --state-dir CANDIDATE` for at most 5 candidates, RUN being `details.runId`                                   |
| Failed summary                                        | as for `workflow.failed` with a saved failed run                                                                          |
| Stale summary                                         | `resume RUN --state-dir DIR`                                                                                              |
| Suspended summary                                     | `answer RUN STEP --state-dir DIR --json <ANSWER_JSON> [--by human:<NAME>]` for at most 5 waiting questions, then `resume` |
| Dry-run failures, embedded runs, any other case       | `[]`                                                                                                                      |

A fork is `execute ENTRYPOINT --fork-from RUN --run-id <NEW_RUN_ID> --state-dir DIR`; it records the
directory it is launched from as the new run's cwd. Placeholders are `<ANSWER_JSON>` (serialized
answer data), `<NAME>` in `--by human:<NAME>` (the name of the human who answered, asked first; a
human question's entry carries the flag, others do not), `<NEW_RUN_ID>`, `<ENTRYPOINT>` (the
workflow file's new path) and `<LIMIT>` (a higher value for the stopping cap's flag, or `off`).
`answer` refuses the unreplaced `human:<NAME>`, and the budget flags refuse an unreplaced `<LIMIT>`.
A run without stored launch paths (an embedded run) gets no entries, since it cannot be resumed by
ID.

A failed run's entries follow its saved `recoveryCause`, the same typed cause that chooses its
`recoveryHint` ([ADR 0006](decisions/0006-code-change-recovery.md#cause-aware-next-entries-284)): a
plain resume would repeat a grant, divergence, settled-map or run-budget failure, so those causes
get the grant, fork or cap the hint names. The grant and cap entries repeat the recorded launch
policy, as resume entries do; `--grant` is saved with the run, so later resumes need not repeat it.
The grant entry uses `execute --resume` because `workflow resume` takes no `--grant`. A call with
call-site capability overrides (under `strictProfiles: false`) ignores named-profile grants, so its
grant cause carries `classOnly` and its entry grants the access class (`write` or `exec`) instead of
the profile. A `workflow.interrupted` or `start.timeout` document whose saved run failed gets the
same entries.

`run.locked` refusals from `resume`, `execute`, `start`, `tick`, `clean`, `rm`, `cancel` and
`unlock` build the unlock entry once, in the runtime, and render both the prose and
`error.details.next` from it, so the two cannot drift; the top-level `next` passes it through, and a
malformed entry is dropped. The skipped entries of `prune` carry the same `details.next`. Its
`details.next` holds `{why, argv}` entries, unlike the older bare argv list that the
`run.incompatible` divergence refusal keeps in its own `error.details.next`. A transient race
(`lock ownership changed during recovery`, `Could not acquire run`) lists the plain command, which
is safe: unlock never removes a live lock and never signals. Library callers choose the launcher
with `RunOptions.commandLauncher` or `RunStoreOpenOptions.commandLauncher`; a custom `RunStore` may
ignore it and fall back to the default.

Emitted argv, including `resumeCommand`, `answerCommand`, the divergence fork command, the
`workflow unlock` command in `run.locked` messages and in `inspect`'s `Unlock:` text line, start
with the launcher of the invocation that produced them. So do the commands that prose hints spell
out: `resume RUN --state-dir DIR --kill-orphans` in the unlock, rm and prune orphans refusals and
tick's orphans entries, tick's crash-loop `resume`, the `workflow rm` suggestions of prune's skipped
entries, rm's `workflow clean` retry hint and the `usage.flag` example. A state directory that needs
quoting is shell-quoted there. When `process.argv[1]` is an installed `quiet-choir` that a PATH
lookup resolves to the same file, the launcher is `quiet-choir`. Otherwise, including
`node "$QC_CHECKOUT/bin/run.js"`, npx and `node_modules/.bin` shims, it is
`[node, realpath(bin/run.js)]` with absolute paths (development mode keeps the tsx loader flags), so
the commands run from any directory without `quiet-choir` on PATH. Embedders and in-process callers
that pass no `commandLauncher` keep `['quiet-choir']`. A `workflow start` failure that propagates
the runner's refusal rebuilds its `next` entries behind start's launcher (see above). Commands are
computed for each invocation and never saved, so a later `pending` or `inspect` regenerates them for
the current Node and checkout. `resumeCommand` and every `resume` entry end with the run's recorded
launch policy flags (below); `answerCommand` and fork entries do not.

## Launch policy

Each execution records a non-secret launch policy in the run's launch metadata (`launch.policy`),
outside the workflow fingerprint and step identity: the global harness kind (`cli` or `fixture`),
each fixture file as its absolute path (resolved against the command's working directory) with the
SHA-256 of its bytes (unnamed for `fixture:<file>`, named for `name=fixture:<file>`), the wait mode,
and `--worktree-keep` and `--worktree-root` (as an absolute path) when given. An execution that
states a policy replaces the previous one, so an explicit flag becomes the new sticky value. An
execution whose launch states none keeps the recorded policy, and `policy: null` clears it; the CLI
passes null for a selection built from data, which a later resume could not reproduce. No
`--harness-config` value is recorded; only its digest is, as before.

- `resume`, `execute --resume` and `answer --resume` without `--harness` use the recorded harness
  kind and fixtures, combined with this invocation's `--harness-config` (or its default); without
  `--wait-mode` they use the recorded wait mode. `tick` without `--harness` does the same for each
  run.
- Explicit `--harness` or `--wait-mode` replaces the recorded value. A different harness kind still
  needs `--allow-harness-change`. `--harness` is repeatable with the same values (`cli`,
  `fixture:<file>`, `name=fixture:<file>`) on `execute`, `resume`, `answer --resume` and `tick`, so
  `answer --resume` can override a run's named fixtures. Two global values or a repeated name is
  `usage.flag`, before the answer is delivered.
- `execute`, `start` and `resume` accept `--worktree-keep all|failed|none` and `--worktree-root DIR`
  (resolved against the working directory; an empty value or an unknown keep is `usage.flag`). They
  replace the root definition's `worktrees.keep` and `worktrees.root` for that run. Only the flags
  are recorded, never the definition's values, and each is inherited separately: `resume`,
  `execute --resume`, `answer --resume` and `tick` without one keep its recorded value, so tick has
  no worktree flags. A run keeps the cache root it first used; a different `--worktree-root` later
  adds a worktree warning instead of relocating it. See
  [worktrees](worktrees.md#cache-policy-and-cleanup).
- A recorded fixture file that is missing or unreadable fails the resume with `usage.flag`, naming
  the path; pass `--harness` explicitly. A fixture whose content changed is used with a warning that
  names the file and both digests, and its new digest is recorded.
- A run started with a custom `--harness-config` must be resumed with the same configuration: a
  plain `resume` or `tick` is refused (`run.incompatible`, naming `--harness-config`) before any
  agent starts, because the configuration is not recorded. Tick skips such a run as `incompatible`
  before importing it.
- `tick` always resumes with `suspend` for that execution only, so one run's waits never hold the
  batch; the recorded wait mode stays, and a later plain `resume` of a `block` run blocks again.
- A run recorded by an older build, or one no CLI execution launched, has no policy and behaves as
  before: the default `cli` selection, with tick forwarding its `--harness-config` only to runs that
  last executed with the CLI harness. An embedder's `RunOptions.launch` without a policy keeps the
  recorded one; with a `LaunchPolicy` it replaces it, and with `null` it clears it.

Emitted resume commands carry `--harness fixture:<abs>`, `--harness <name>=fixture:<abs>`,
`--wait-mode block`, `--worktree-keep` and `--worktree-root` as recorded; the defaults (`cli`,
`suspend`) are omitted, and `--harness-config` is never emitted. `answerCommand` only delivers an
answer, so it carries none; the resume entry after it does.

Workflow `console.log` and `process.stdout.write` during import/execution are redirected to stderr
in JSON mode. `Run ID:`, debug logs, warnings, and human diagnostics also use stderr. Redirecting
output does not sandbox trusted workflow code.

## File and stdin input

```sh
node "$QC_CHECKOUT/bin/run.js" workflow execute workflow.ts --input @input.json --json
cat input.json | node "$QC_CHECKOUT/bin/run.js" workflow execute workflow.ts --input - --json
```

File paths resolve against the shell's working directory. Unreadable files report
`usage.input_file`; invalid JSON reports `usage.input_json` with the source and zero-based character
offset. Omitting input retains `{}` for new runs and the saved/source input for resume/fork.

## Embedding migration

`runWorkflow` throws `WorkflowRunError` after saving a failed/cancelled run. Its `run` is the saved
snapshot, `runId` identifies it, `stepId` is the root effect, and `cause` is the prior rejection.
Match application errors, `HarnessError`, or `FanOutError` through `cause`. If checkpoint problems
were combined, that cause is the existing `AggregateError`, whose cause remains the original primary
failure. An unsuccessful failure save leaves the existing checkpoint-error behavior intact and does
not invent a saved run.

`RunRefusedError` has a stable `run.*` code, run ID, plain details, and an optional underlying
cause. `WorkflowInputError` has `usage.input_schema`, validation issues, and the validator cause.
`StepIdentityChangedError` names the `stepId`, changed `components` and terminal `status` of a
replayed step whose identity changed. An embedded
`runWorkflow({ resume: true, acceptCodeChange: true })` finds such a step on a disposable copy first
and rejects with this error itself, before it changes the run (the CLI maps that to
`run.incompatible`); otherwise, as in a plain resume, it is the cause of a saved run's
`WorkflowRunError`. `isValidRunId` and `CliErrorCode` are exported for callers. `readRun` retains
its low-level ENOENT contract. See [the changelog](../CHANGELOG.md) for the prototype API break.

`workflow typecheck` lists effective compiler flags in human output. JSON success includes
`compilerOptions`; a typecheck failure includes it in `error.details`, alongside compiler version
and config path. Built-in defaults add `noUncheckedIndexedAccess` to strict Node/ES2023 checking;
`exactOptionalPropertyTypes` is enabled only by a project config. Resume also typechecks, so an
unchanged in-flight run can be blocked by these stricter defaults before import or effects.

## Tick

`workflow tick` returns a single aggregate JSON document: `resumed` entries with each started
resume's outcome (completed, suspended, interrupted, failed, cancelled or incompatible), `skipped`
entries with a reason (not due, no longer due, locked, orphans, crash-loop, deadline, incompatible
or unreadable), and an `observed` count of already-terminal runs. A due or stale run whose record
this build cannot fully read ([record schema revision](storage.md#record-schema-revision)) is
skipped `incompatible` with the `run.incompatible` message and left unchanged. Each run appears in
at most one entry. Tick also recovers `running` runs whose owner is gone, up to 3 consecutive times
without a new completed step; then it reports `crash-loop` with a message naming
`workflow resume RUN --state-dir DIR`, behind the detected launcher like the orphans entry. The
count is saved before the resume starts, so any crash during it counts, but a harness configuration
mismatch (below) is skipped before the count and never counts. An `orphans` entry's message says
tick never signals a process and names `workflow resume RUN --state-dir DIR --kill-orphans`, behind
the detected launcher like other emitted commands and with the state directory shell-quoted when it
needs quoting. With --run, exits are 0 completed (now or earlier), 75 pending, interrupted, locked,
orphans or deadline, and 1 failed, cancelled (a run saved as cancelled), crash-loop, incompatible or
unreadable; batch per-run failures remain data with exit 0. An `interrupted` outcome is a resume the
deadline stopped before the runtime reopened a stale run, which stays `running` for the next tick.
Usage/infrastructure errors retain the command failure document. Every tick is bounded by --timeout
(default 540s), including --watch, with --max-runs limiting executed resumes. Without --run, runs
are visited in ascending run-ID order (by character code), so --max-runs takes the first due runs in
that order. When the timeout fires, tick interrupts in-flight resumes into resumable suspensions:
each is reported `suspended` with `message: "Tick timeout reached."` and is due on the next tick,
which reuses its completed steps. `--claim-margin` (same duration syntax; default 10% of --timeout,
`0ms` disables it, and it must be smaller than --timeout) stops new claims once less than the margin
remains: a ready run is then left untouched and reported as skipped `deadline`, and --watch ends
there. Inside the margin tick still reads each record (terminal runs are observed, not-due runs not
due) but checks no locks, orphans, crash-loop count or sources, so a due or stale run is reported
`deadline` with its `nextWakeAt` even if a full scan would have found it locked or incompatible.
After the timeout tick reads no more records: each run not yet reported is skipped `deadline` with a
`message` and no `nextWakeAt` (an earlier --watch pass's entry is kept), and the exit codes above
are unchanged. `--harness-config` supplies CLI harness configuration (JSON or `@file`) for resumed
CLI runs, and omitting it means the defaults. It must match the configuration digest the run
recorded at its latest live execution: otherwise the run is reported as skipped `incompatible` with
the `run.incompatible` message and left unchanged, before tick imports it, counts a stale recovery
or uses a `--max-runs` attempt (with a fixture selection the resume itself ends `incompatible`),
unless `--allow-harness-config-change` accepts the change for every run that tick resumes.
`--harness` (repeatable, the same values as on `resume`) selects the harness for every run that tick
resumes; without it, each run uses its recorded [launch policy](#launch-policy). `workflow resume`,
`execute --resume` and `answer --resume` refuse the same mismatch with `run.incompatible` (exit 3,
`error.details.previousConfigDigest` and `error.details.requestedConfigDigest`) and accept the same
flag. See [waits](waits.md) for due detection and notification hooks.
