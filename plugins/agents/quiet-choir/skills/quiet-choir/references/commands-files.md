# Durable commands and files

Use `ctx.exec(id, argv, options)` for deterministic commands, including tests, Git, and the
installed `gh` CLI. The CLI supplies `NodeProcessRunner`; embedded callers supply
`RunOptions.processRunner`. The core never imports a process-spawning adapter. A fixture can
implement `ProcessRunner.run` with in-memory results. `RunOptions.execRunner`, when set, serves
`ctx.exec` effects (including `guardFile`'s helpers) instead, while worktree Git keeps
`processRunner`. Custom adapters must enforce limits and register children before sending stdin.
They are responsible for the correctness of their saved outputs; use separate run IDs/state for
mocked and real executions. Commands do not consume an agent concurrency slot.

An argv tuple runs directly. `{ shell: '...' }` explicitly selects `sh -c` (`cmd.exe` on Windows),
and inspect prints `[SHELL]`. Both forms run with the operator's privileges. Agent tool grants do
not restrict them. Bind agent-proposed commands to a saved plan and `ctx.approve` before execution;
argv protects argument boundaries, not the meaning of the selected program. Do not put secrets in
arguments or shell source: command descriptions are recorded and visible in inspection.

`ExecResult` contains `code`, `signal`, `stdout`, `stderr`, `truncated`, and `durationMs`. By
default, only exit 0 succeeds. Non-ok exits throw `ExecError`; attempt history preserves the exit
code, signal, classification, and the last 1024 characters of each output stream. `ctx.exec.json`
parses stdout with its required Zod schema and checkpoints that value instead of raw output. Invalid
or truncated JSON fails.

A `try/catch` around a command is not a durable decision: resume runs the command again and can take
the other branch. To branch on a failure, pass `onError: 'return'`, as every effect that can fail
allows. `ctx.exec` then returns `Settled<ExecResult, ExecStepError>` and `ctx.exec.json` returns
`Settled<T, ExecStepError>`. The final failure, after retries, is saved as `settled-failed` and
replays on resume without running the command. `ExecStepError` adds the exit `code`, `signal`, and
the last 1024 characters of stdout and stderr (`stdoutTail`, `stderrTail`) to `message`, `kind`, and
`attempts`. A timeout settles with kind `timeout` and whatever partial output the runner reported.
For `ctx.exec.json`, `parsed` holds stdout as JSON when the output was complete, valid JSON, and at
most 16384 UTF-8 bytes; it is not checked against the success schema, so a failing tool's JSON
report stays usable. The process fields are absent when the runner's error carried no process
result. Cancellation and a missing process adapter still reject and leave the step unfinished.
`okExitCodes: 'any'` is the older alternative: it records ordinary nonzero exits as completed
results, but signals and timeouts still fail and `ctx.exec.json` keeps only the parsed value, not
the exit code.

Commands default to a five-minute deadline and 1 MiB **per stream**. Plain commands continue after
output overflow, retaining the first and last half of each stream's byte cap. No separator is
inserted; inspect `truncated`. JSON commands terminate on overflow. POSIX adapters own the process
group, reap same-group descendants after exit, and bound inherited-pipe draining. A child that
escapes into a separate session/group is outside that ownership, as with native agents. Windows
process-tree semantics are weaker; filesystem durability uses the existing local POSIX contract.

Identity covers the command, canonical cwd, hash of the explicit environment overlay, stdin digest,
`inheritEnv`, accepted exit codes, output schema/mode, and `onError` when it is `'return'` (omitting
it and passing `'throw'` are the same identity). `timeoutMs`, `maxOutputBytes`, and `retry` are
policy, so raising them does not invalidate completed work. Sticky run policy accepts
`kind: 'exec'`, timeout/output caps, and retry. Unfinished effects retain the existing explicit
redefinition/history behavior; completed identity changes require a new run or an appropriate fork.
Repeated observations need fresh IDs or a read-only `ctx.poll` observer, which can run its commands
through `context.exec`.

The default environment inherits the parent plus `env`. `inheritEnv: false` supplies only that
overlay and engine metadata (the selected executable or shell may itself add variables). Rotating
authentication belongs in the parent environment. Explicit overlay values and stdin are hashed, not
checkpointed; output can still contain anything the command prints. The `QUIET_CHOIR_` prefix is
reserved. Children receive `QUIET_CHOIR_IDEMPOTENCY_KEY` (`runId/stepId`), `QUIET_CHOIR_RUN_ID`,
`QUIET_CHOIR_STEP_ID`, and `QUIET_CHOIR_ATTEMPT`. Scripts must implement their own reconciliation;
the runtime cannot make external writes exactly once.

## Commands inside a callback or observer

A `ctx.step` callback or `ctx.poll` observer cannot call durable `ctx.exec`. It runs commands
through its own context instead: `context.exec(argv, options)` and
`context.exec.json(argv, { schema })` take the same command and options as `ctx.exec`, without an
ID, `worktree` or `retry`. They go through the same runner as `ctx.exec` (`RunOptions.execRunner`,
or `processRunner`), with the same five-minute and 1 MiB defaults, environment overlay, reserved
`QUIET_CHOIR_` prefix, exit-code and JSON rules.

These commands are **not durable**. They write no checkpoint and no step record, and they run again
whenever the parent reruns: on a retry, on a resume of an unfinished step, and on every poll check.
Treat them as at least once. The child gets the parent's metadata, so `QUIET_CHOIR_IDEMPOTENCY_KEY`
equals the callback's `context.idempotencyKey` and `QUIET_CHOIR_STEP_ID` names the parent step or
wait. It is registered under the parent's ID and attempt, so a runner killed while it runs leaves a
`lock/processes` record that orphan recovery reports (`run.orphans`) or stops (`--kill-orphans`) on
resume. A command still running when the callback or observation settles is terminated before the
step finishes; call `context.exec` only while the callback is active. An observer's commands are
aborted with its observation signal, so `observeTimeoutMs` and the deadline bound them.

A failure throws an `ExecError` into the parent attempt; left uncaught, it fails the step and the
attempt history keeps its exit code and 1024-character output tails. `onError: 'return'` resolves to
`{ ok: false, error }` with the same `ExecStepError` fields as a settled `ctx.exec`, but nothing is
saved: a rerun of the parent runs the command again. Cancellation and a missing process adapter
still reject. Sticky run policy rules (`RunOptions.policy`) do not apply to these commands; set
`timeoutMs` and `maxOutputBytes` in the call. Nothing about them enters identity: a step is still
identified by its callback source, and a wait by its observer.

## Files

`ctx.cwd` and `StepContext.cwd` expose the canonical run directory. `ctx.readFile(id, path)` records
a UTF-8 snapshot and its SHA-256. Its default 1 MiB cap can be raised with `maxBytes` on resume; it
checks the actual read, not only the initial stat size. Replaying the read returns the saved
snapshot even if the file changed. It rejects content that is not valid UTF-8 rather than saving a
lossy snapshot; use binary-specific local callbacks for binary content.

`ctx.writeFile(id, path, content, options)` writes exact UTF-8 bytes and records only
`{ path, sha256, bytes, previousSha256 }`. Content hashes participate in identity; content is not
stored by the write effect. Workflow inputs or an earlier read may separately contain the content.
Missing parent directories are created privately; new files use mode 0600 and existing file modes
are preserved. Publication uses a same-directory temporary file, file fsync, rename, and directory
fsync. File effects accept regular files only, not devices, FIFOs, or directories.

`ifMatch: null` creates exclusively. A SHA-256 requires that baseline, checked again immediately
before publication. If the desired bytes are already present, either form succeeds without writing.
`previousSha256` is the hash observed on that attempt, so an idempotent retry can report the desired
hash rather than the original baseline. A hash check plus rename is an **optimistic check**, not an
atomic content transaction against unrelated writers. It does not replace worktree isolation or
coordination. Paths, including existing symlink targets and missing-file parents, resolve against
cwd; `allowOutsideCwd: true` is required to escape it on both reads and writes. This is a path
guard, not a sandbox against hostile processes racing directory replacements.

Both file effects accept `onError: 'return'` and then return `Settled<ReadFileResult>` or
`Settled<WriteFileResult>`. An oversized snapshot, an `ifMatch` conflict, or another final failure
is saved with `message`, `kind`, and `attempts` and replays on resume even after the file changes.
Invalid options and paths outside cwd still reject before the effect starts. Like commands, only
`onError: 'return'` enters identity.

## Guarding a mutation

`guardFile(ctx, id, path, body, { onChange: 'restore' | 'error' })` saves the current uncommitted
text as a raw Git blob, journals one body outcome, then compares and restores the file in one
command. No blob bytes appear in command output or checkpoints. The baseline blob stays pinned under
`refs/quiet-choir/guards/` until restore finishes, so `git gc` cannot prune it in the meantime.
`--no-filters` preserves CRLF. The default is to restore silently; `'error'` restores first and then
rejects if content or permission bits changed. The file must be a regular UTF-8 file inside cwd
(symlink leaves are rejected), cwd must be in a Git repository, and Git/Node must be installed.
`maxBytes` defaults to 1 MiB. `version` declares changes in closed-over body dependencies; body
source and onChange policy participate in its journaled identity. The baseline and restore steps are
fingerprinted on a versioned guard identity (guard program version, path, `maxBytes` and the
baseline blob, mode and ref), not on the Node binary path or the inline program text, so a Node
upgrade or path change does not strand a resumed guard. quiet-choir bumps the version only when the
guard program's behavior changes.

The body must return JSON. Its success or ordinary failure is terminal for that guard ID, preventing
a failed body from rerunning after an already completed restore replays. Retrying that whole body
requires a new guard ID/run. A restore failure can resume without rerunning a settled body. Neither
cancellation, runner death, suspension, nor external writers are filesystem rollback: after a hard
kill an unfinished body may rerun before restoration. The durable baseline still replays the
original blob. Do not treat this as automatic restore-before-retry or concurrent-writer protection.

## Rehearsal

CLI `--dry-run` never spawns commands, records them in `commands`, and uses temporary state. A
command is answered by the first matching `exec` rule of the fixture file, if any, and otherwise
synthesized: plain stdout is empty and JSON follows the schema, so the exercised branch may differ
from reality. `--harness fixture` answers agents from `calls` and commands from `exec` rules without
spawning; unmatched commands run for real there, and worktree Git always does. A file with
`"commands": "fixture"` fails an unmatched command at its step in both modes. `workflow fixtures`
exports completed command results as exec rules keyed by argv and environment/stdin digests. It does
not export a settled-failed command yet, so a `"commands": "fixture"` replay of that run fails at
that step. File effects, local callbacks, and top-level workflow code still run for real unless
selected by `--stub-steps`.

Commands a callback or observer runs through `context.exec` are rehearsed the same way: synthesized
or answered by an `exec` rule, and listed in `commands` with `parentStepId` set to the step or wait
(null for `ctx.exec`). A rule's `step` matches the parent's ID. `occurrence` counts distinct step
IDs, so all of one parent's commands share an occurrence; tell them apart with `argvPrefix`. A poll
observer may pass `live: true` to run a read-only command for real under `--dry-run`; it is listed
with `outputSource: 'live'`. `live` is refused in a step callback, and outside `--dry-run` it
changes nothing. `workflow fixtures` cannot export these commands, because they have no records. See
[command fixtures](rehearsal.md#command-fixtures) and the
[verified cookbook](patterns.md#commands-and-test-verdicts).
