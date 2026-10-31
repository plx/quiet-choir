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

A completed command returns `CompletedExecResult`: `code` (a number), `signal` (null), `stdout`,
`stderr`, `truncated`, and `durationMs`. `ExecResult` is the raw shape a `ProcessRunner` returns and
an `ExecError` carries, with `code` null and `signal` set for a signalled process. By default, only
exit 0 succeeds. Non-ok exits throw `ExecError`; attempt history preserves the exit code, signal,
classification, and the last 1024 characters of each output stream. `ctx.exec.json` parses stdout
with its required Zod schema and checkpoints that value instead of raw output. Truncated JSON output
fails with kind `output-limit`. Stdout that is not JSON after an accepted nonzero exit (in
`okExitCodes`, or `'any'`) fails with kind `process`, because the command failed without a body; any
other invalid JSON or schema mismatch fails with kind `schema`.

A `try/catch` around a command is not a durable decision: resume runs the command again and can take
the other branch. To branch on a failure, pass `onError: 'return'`, as every effect that can fail
allows. `ctx.exec` then returns `Settled<CompletedExecResult, ExecStepError>` and `ctx.exec.json`
returns `Settled<T, ExecStepError>`. The final failure, after retries, is saved as `settled-failed`
and replays on resume without running the command. `ExecStepError` adds the exit `code`, `signal`,
and the last 1024 characters of stdout and stderr (`stdoutTail`, `stderrTail`) to `message`, `kind`,
and `attempts`. A timeout settles with kind `timeout` and whatever partial output the runner
reported. With `NodeProcessRunner`, a command that cannot start (a missing executable, a `cwd` that
does not exist, a permission error) settles with kind `process`, `code` and `signal` null, empty
tails and its `Cannot start <binary>…` message. That is the same kind as a nonzero exit or a signal
kill, and it still fails under `okExitCodes: 'any'`. For `ctx.exec.json`, `parsed` holds stdout as
JSON when the output was complete, valid JSON, and at most 16384 UTF-8 bytes; it is not checked
against the success schema, so a failing tool's JSON report stays usable. The process fields are
absent when the runner's error is not an `ExecError`, such as a custom `ProcessRunner`'s plain
error. Cancellation and a missing process adapter still reject and leave the step unfinished.

`okExitCodes: 'any'` instead records ordinary nonzero exits as completed results. Prefer it when the
exit code and the output are the data: the `CompletedExecResult` keeps both streams up to
`maxOutputBytes` (head and tail), `truncated` and `durationMs`, while a settled `ExecStepError`
keeps only the 1024-character tails and has no duration or truncation flag. Signals, timeouts and
launch failures still fail under it, and `ctx.exec.json` keeps only the parsed value, not the exit
code. Combine it with `onError: 'return'` when a red command's output is the evidence, such as a
test run an agent repairs from or a report quotes. A nonzero exit then completes with its full
capped output and the checkpoint keeps it, while a timeout, signal or launch failure still settles
as `{ ok: false }` with tails. The body judges `result.value.code` itself: `ok` means only that the
command exited. An accepted exit is not a failure, so `retry` does not repeat it. On a worktree
handle, an accepted exit advances the handle's snapshot with what the command wrote (see
[worktrees](worktrees.md#shared-write-test-fix-sequences)).

Commands default to a five-minute deadline and 1 MiB **per stream**. Plain commands continue after
output overflow, retaining the first and last half of each stream's byte cap. No separator is
inserted; inspect `truncated`. Overflow alone never fails a plain command: it completes with its
real exit status, so judge a check by `code` and report `truncated` separately. JSON commands
terminate on overflow. POSIX adapters own the process group, reap same-group descendants after exit,
and bound inherited-pipe draining. A child that escapes into a separate session/group is outside
that ownership, as with native agents. Windows process-tree semantics are weaker; filesystem
durability uses the existing local POSIX contract.

A completed plain command checkpoints its retained `stdout` and `stderr`, up to 2 MiB per command at
the defaults. They are journaled and rewritten into `run.json` at every compaction. For a command
repeated in a loop (a stress run, a benchmark) whose output the workflow reduces to a verdict, lower
`maxOutputBytes`. The result keeps `code`, `signal`, `durationMs`, `truncated` and the first and
last half of each stream, and the cap is policy, so changing it never refuses a resume. To scan the
whole output and keep only the facts, have the command print them as JSON and read it with
`ctx.exec.json`, which checkpoints only the parsed value. Running the command in a `ctx.step`
through `context.exec` does not shrink the record: the step's `innerCommands` keeps up to 1 MiB of
the raw output per attempt (#524).

Identity covers the command, canonical cwd, hash of the explicit environment overlay, stdin digest,
`inheritEnv`, `scrubEnv` when it is enabled, accepted exit codes, output schema/mode, and `onError`
when it is `'return'` (omitting it and passing `'throw'` are the same identity). `timeoutMs`,
`maxOutputBytes`, and `retry` are policy, so raising them does not invalidate completed work. Sticky
run policy accepts `kind: 'exec'`, timeout/output caps, and retry. Unfinished effects retain the
existing explicit redefinition/history behavior; completed identity changes require a new run or an
appropriate fork. Repeated observations need fresh IDs or a read-only `ctx.poll`: a command poll
runs one command per check, and an observer can run its commands through `context.exec`.

A completed read also replays on resume. A precondition the operator can fix, such as a clean
checkout, must fail inside an effect, not in the body after a completed read. A `throw` on a
replayed `git status` repeats on every resume, even after the checkout is cleaned, and only a new
run or a fork that invalidates the read recovers. Check it in a `ctx.step` callback through
`context.exec`, or as a command whose nonzero exit makes `ctx.exec` throw. The failed step then runs
again on resume, and once it passes it replays as passed.

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
the runtime cannot make external writes exactly once.

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
> credentials from these commands. See `docs/storage.md` (Revision 15) and
> [rehearsal](rehearsal.md).

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
Each missing parent directory is created with mode 0700 and a new file with mode 0600, whatever the
umask; an existing file keeps its mode and existing directories are left unchanged. A Git checkout,
and so `std.exec.committedArtifact`, uses the umask instead (0644 and 0755 under umask 022). Git
commits the 0600 file as `100644`, so a clone does not keep it private, but a 0700 directory stays
0700 for files later checked out under it. For a document other local users should read, create its
parents in a local step first, or `chmod` it after the write (#798). Publication uses a
same-directory temporary file, file fsync, rename, and directory fsync. File effects accept regular
files only, not devices, FIFOs, or directories.

`ifMatch: null` creates exclusively. A SHA-256 requires that baseline, checked again immediately
before publication. If the desired bytes are already present, either form succeeds without writing
and without checking the baseline, since no other content would be replaced. An `ifMatch` failure
names the path as the workflow passed it and what it found there: an existing file and its SHA-256,
a missing file, or content with another SHA-256. `previousSha256` is the hash observed on that
attempt. When it equals `sha256`, the attempt found the desired bytes and wrote nothing, whether
they came from an earlier attempt killed before its checkpoint or from another writer. A re-executed
write therefore reports the desired hash rather than the original baseline, so an uninterrupted run
and a resumed one can return different receipts. A workflow that reports the baseline it replaced
should take it from its own `ifMatch`, or from the journaled read that chose it, rather than from
the receipt. A hash check plus rename is an **optimistic check**, not an atomic content transaction
against unrelated writers. It does not replace worktree isolation or coordination. Paths, including
existing symlink targets and missing-file parents, resolve against cwd; `allowOutsideCwd: true` is
required to escape it on both reads and writes. This is a path guard, not a sandbox against hostile
processes racing directory replacements.

Both file effects accept `onError: 'return'` and then return `Settled<ReadFileResult>` or
`Settled<WriteFileResult>`. An oversized snapshot, an `ifMatch` conflict, or another final failure
is saved with `message`, `kind`, and `attempts` and replays on resume even after the file changes. A
settled file failure carries no file-specific reason yet (#ISSUE-C03-1): an `ifMatch` conflict or an
oversized snapshot is `unknown`, and a missing `readFile` target is `process` with Node's `ENOENT`
message. Invalid options, paths outside cwd, and paths that cannot be resolved still reject before
the effect starts, even with `onError: 'return'`, and fail the run without recording the step: a
parent that is a regular file (`ENOTDIR`), another `realpath` error such as `EACCES` or `ELOOP`, or
a dangling symlink (#ISSUE-C03-2). Like commands, only `onError: 'return'` enters identity.

To learn only whether a file exists, or its baseline for `ifMatch`, probe it in a local `ctx.step`
that returns `{ sha256, bytes } | null`, with the path in `input`. Resolve the path against
`StepContext.cwd`, `stat` it and throw for anything but a regular file (reading a FIFO would block),
return `null` only for `ENOENT`, and hash the raw bytes with `node:crypto` as SHA-256 hex. Only the
digest is journaled, so the probe also works for a file over the snapshot cap or not in UTF-8. Its
`sha256` is exactly what `ifMatch` compares: `ifMatch: probe?.sha256 ?? null` creates only a missing
file and replaces only an unchanged one, without matching a settled read's `ENOENT` message. Like
`readFile`, the probe replays its saved digest on resume, and like `ifMatch` it is an optimistic
check. `writeFile` still applies its own cwd path guard and regular-file check at publication.

```ts
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';

const Digest = z.object({ sha256: z.string(), bytes: z.int().nonnegative() }).nullable();

/** Journal the digest of `path`, never its content; null only when it is missing. */
const probe = (ctx: WorkflowContext, id: string, path: string) =>
  ctx.step(id, {
    input: { path },
    schema: Digest,
    run: async ({ cwd, signal }) => {
      const file = resolve(cwd, path);
      const info = await stat(file).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (!info) return null;
      if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
      const bytes = await readFile(file, { signal });
      return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    },
  });

export default defineWorkflow({
  name: 'publish-report',
  version: '1',
  input: z.object({ out: z.string(), report: z.string() }),
  output: z.string(),
  async run(ctx, input) {
    const before = await probe(ctx, 'baseline', input.out);
    // Creates out when it was missing, or replaces exactly the bytes the probe saw.
    const written = await ctx.writeFile('publish', input.out, input.report, {
      ifMatch: before?.sha256 ?? null,
    });
    return written.sha256;
  },
});
```

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
a command result reproduces them (an exit code outside `okExitCodes`, an `exec.json` accepted
nonzero exit without JSON, or an `exec.json` schema failure). A spawn failure, timeout, signal or
output-limit failure gets no exported rule yet (an `exec` rule with `error` and optional `kind` can
describe one by hand); the export still sets `"commands": "fixture"`, so a replay of that run fails
at that step. File effects, local callbacks, and top-level workflow code still run for real unless
selected by `--stub-steps`.

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
[verified cookbook](patterns.md#commands-and-test-verdicts).
