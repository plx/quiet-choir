# Durable commands and files

Use `ctx.exec(id, argv, options)` for deterministic commands, including tests, Git, and the
installed `gh` CLI. The CLI supplies `NodeProcessRunner`; embedded callers supply
`RunOptions.processRunner`. The core never imports a process-spawning adapter. A fixture can
implement `ProcessRunner.run` with in-memory results. `RunOptions.execRunner`, when set, serves
every command instead: `ctx.exec` effects (including `guardFile`'s helpers), a callback's or
observer's `context.exec`, and each command-poll check. Worktree Git always keeps `processRunner`.
Custom adapters must enforce limits and register children before sending stdin. They are responsible
for the correctness of their saved outputs; use separate run IDs/state for mocked and real
executions. Commands do not consume an agent concurrency slot.

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
`inheritEnv`, `scrubEnv` when it is enabled, accepted exit codes, output schema/mode, and `onError`
when it is `'return'` (omitting it and passing `'throw'` are the same identity). `timeoutMs`,
`maxOutputBytes`, and `retry` are policy, so raising them does not invalidate completed work. Sticky
run policy accepts `kind: 'exec'`, timeout/output caps, and retry. Unfinished effects retain the
existing explicit redefinition/history behavior; completed identity changes require a new run or an
appropriate fork. Repeated observations need fresh IDs or a read-only `ctx.poll`: a command poll
runs one command per check, and an observer can run its commands through `context.exec`.

`meta` attaches JSON labels to the step record, like `StepDefinition.meta`. It is neither identity
nor policy, so relabelling never refuses a resume. `inspect` shows a step with a string
`integration` label as `integration.op`; integration helpers such as
[`quiet-choir/github`](github.md) record `{ integration, op }`. A non-JSON value is rejected before
the command runs.

The default environment inherits the parent plus `env`. `inheritEnv: false` supplies only that
overlay and engine metadata (the selected executable or shell may itself add variables). Rotating
authentication belongs in the parent environment. Explicit overlay values and stdin are hashed, not
checkpointed; output can still contain anything the command prints. The `QUIET_CHOIR_` prefix is
reserved. Children receive `QUIET_CHOIR_IDEMPOTENCY_KEY` (`runId/stepId`), `QUIET_CHOIR_RUN_ID`,
`QUIET_CHOIR_STEP_ID`, and `QUIET_CHOIR_ATTEMPT`. Scripts must implement their own reconciliation;
the runtime cannot make external writes exactly once. For GitHub,
[`quiet-choir/github`'s writes](github.md#writes) package it: each comment, thread reply, issue
create, close or reopen, alert dismissal, pull request create or edit, merge and failed-run rerun is
one `ctx.step` that finds its own earlier write by a marker or by the state it left, or acts only
when a preceding read says it still needs to; the merge is also pinned to a head SHA by GitHub.

A command that launches `claude`, `codex` or a wrapper around them can opt in to the host
agent-session scrub that agent children always get, with `scrubEnv`. `true` removes the names
`childEnvironment` removes ([harness isolation](harness-isolation.md): `CLAUDECODE`,
`CODEX_THREAD_ID`, `TRACEPARENT`, most `CLAUDE_CODE_*` names and the rest) and keeps authentication
and configuration such as `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_*` and
`CODEX_HOME`; an array removes those plus its exact names, as `CliHarnessOptions.scrubEnv` does. The
scrubbed parent comes first, then `env`, so the overlay can restore a scrubbed name; the
`QUIET_CHOIR_` variables are added last and always delivered. `scrubEnv` with `inheritEnv: false` is
rejected before the command runs, since nothing is inherited, and so is a name that is not an
identifier. Omitted or `false` keeps full inheritance, which stays the default (#337): most commands
(Git, `gh`, `npm`, scripts) are unaffected by these variables, some tools read `TRACEPARENT`,
`AI_AGENT` or `CLAUDE_CODE_*` settings on purpose, and a new default would have changed every
existing workflow's commands and the identity of their completed steps. Enabled, the scrub enters
identity as its sorted, deduplicated extra names (`true` and `[]` are the same identity), so
toggling it on a completed step needs a new ID; omitting it or passing `false` leaves identity and
the recorded summary byte-identical. Host values and the removed names are never recorded, and
completed replay does not read the environment. A custom `ProcessRunner` receives the extra names as
`ProcessRunRequest.scrubEnv` (present only when enabled) and must honor it like `inheritEnv`;
`NodeProcessRunner` applies it with `childEnvironment`.

## Commands inside a callback or observer

A `ctx.step` callback or `ctx.poll` observer cannot call durable `ctx.exec`. It runs commands
through its own context instead: `context.exec(argv, options)` and
`context.exec.json(argv, { schema })` take the same command and options as `ctx.exec`, without an
ID, `worktree`, `retry` or `meta`. They go through the same runner as `ctx.exec`
(`RunOptions.execRunner`, or `processRunner`), with the same five-minute and 1 MiB defaults,
environment overlay, opt-in `scrubEnv`, reserved `QUIET_CHOIR_` prefix, exit-code and JSON rules.

These commands are **not durable effects**. They are never replayed or reused, and they run again
whenever the parent reruns: on a retry, on a resume of an unfinished step, and on every poll check.
Treat them as at least once. The child gets the parent's metadata, so `QUIET_CHOIR_IDEMPOTENCY_KEY`
equals the callback's `context.idempotencyKey` and `QUIET_CHOIR_STEP_ID` names the parent step or
wait. It is registered under the parent's ID and attempt, so a runner killed while it runs leaves a
`lock/processes` record that orphan recovery reports (`run.orphans`) or stops (`--kill-orphans`) on
resume. A command still running when the callback or observation settles is terminated before the
step finishes; call `context.exec` only while the callback is active. An observer's commands are
aborted with its observation signal, so `observeTimeoutMs` and the deadline bound them.

The runtime does keep a record of them, for `workflow fixtures` only: the parent's step or wait
record carries `innerCommands`, each command's argv or shell source, its `envSha256` and
`inputSha256` digests (never environment values or stdin) and its raw result (exit code, signal,
stdout and stderr), at most 256 commands and 1 MiB of output per attempt.

> **Command output is retained.** Whatever a command prints, including secrets, can be stored in the
> checkpoint and journal, whether the command succeeds or fails. For `context.exec.json` the
> `schema` filters only the parsed value you get back, not the raw stdout that is kept. Do not print
> credentials from these commands. See [storage](storage.md#record-schema-revision) (Revision 15)
> and [rehearsal](rehearsal.md).

A failure throws an `ExecError` into the parent attempt; left uncaught, it fails the step and the
attempt history keeps its exit code and 1024-character output tails. `onError: 'return'` resolves to
`{ ok: false, error }` with the same `ExecStepError` fields as a settled `ctx.exec`, but the failure
is not a reusable result: a rerun of the parent runs the command again. Cancellation and a missing
process adapter still reject. Sticky run policy rules (`RunOptions.policy`) do not apply to these
commands; set `timeoutMs` and `maxOutputBytes` in the call. Nothing about them enters identity: a
step is still identified by its callback source, and a wait by its observer.

When a poll's check is one command, use the [command form of `ctx.poll`](waits.md#command-polls)
(`{ command, output, done }`) instead of an observer. Each check runs the command through this same
path, owned by the wait, and `done(output, previous)` decides the outcome. Unlike an observer's
`context.exec`, the command, its semantic options and its `output` schema are part of the wait's
identity, and `workflow pending` shows the command.

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
exports completed command results as exec rules keyed by argv and environment/stdin digests, and
settled or absorbed command failures as rules with their exit `code` and recorded output tails when
a command result reproduces them (an exit code outside `okExitCodes` or an `exec.json` schema
failure). A spawn failure, timeout, signal or output-limit failure gets no exported rule yet; the
export still sets `"commands": "fixture"`, so a replay of that run fails at that step. An `exec`
rule with `error` (and optionally `kind`) can describe such a failure by hand: the command rejects
with an `ExecError` of kind `process` by default, with no exit code or output. File effects, local
callbacks, and top-level workflow code still run for real unless selected by `--stub-steps`.

Commands a callback or observer runs through `context.exec` are rehearsed the same way: synthesized
or answered by an `exec` rule, and listed in `commands` with `parentStepId` set to the step or wait
(null for `ctx.exec`). A rule's `step` matches the parent's ID. `occurrence` counts distinct step
IDs, so all of one parent's commands share an occurrence. `call` tells them apart: it selects the
nth command of that parent, counted per attempt, so two identical `gh pr checks` commands in one
callback can get different answers (`argvPrefix` also works when their argv differs). Each check of
a command poll counts as a call. A poll observer may pass `live: true` to run a read-only command
for real under `--dry-run`; it is listed with `outputSource: 'live'`. Each check of a command poll
is rehearsed the same way, with `stepId` and `parentStepId` set to the wait ID, and a command poll's
own `live: true` keeps it real. A dry run makes up to five checks of a poll in one process, each
rehearsed this way; see [repeated poll checks](rehearsal.md#repeated-poll-checks). `live` is refused
in a step callback, and outside `--dry-run` it changes nothing. `workflow fixtures` exports these
commands as `exec` rules keyed by the parent's ID, argv and digests: a step's latest attempt, or a
poll's terminal check, with `call` only where the parent ran more than one matching command. See
[command fixtures](rehearsal.md#command-fixtures) and the
[verified cookbook](../plugins/agents/quiet-choir/skills/quiet-choir/references/patterns.md#commands-and-test-verdicts).
