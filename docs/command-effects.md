# Durable commands and files

Use `ctx.exec(id, argv, options)` for deterministic commands, including tests, Git, and the
installed `gh` CLI. The CLI supplies `NodeProcessRunner`; embedded callers supply
`RunOptions.processRunner`. The core never imports a process-spawning adapter. A fixture can
implement `ProcessRunner.run` with in-memory results. Custom adapters must enforce limits and
register children before sending stdin. They are responsible for the correctness of their saved
outputs; use separate run IDs/state for mocked and real executions. Commands do not consume an agent
concurrency slot.

An argv tuple runs directly. `{ shell: '...' }` explicitly selects `sh -c` (`cmd.exe` on Windows),
and inspect prints `[SHELL]`. Both forms run with the operator's privileges. Agent tool grants do
not restrict them. Bind agent-proposed commands to a saved plan and `ctx.approve` before execution;
argv protects argument boundaries, not the meaning of the selected program. Do not put secrets in
arguments or shell source: command descriptions are recorded and visible in inspection.

`ExecResult` contains `code`, `signal`, `stdout`, `stderr`, `truncated`, and `durationMs`. By
default, only exit 0 succeeds. Non-ok exits throw `ExecError`; attempt history preserves the exit
code, signal, classification, and the last 1024 characters of each output stream.
`okExitCodes: 'any'` records ordinary nonzero exits as completed results, suitable for branching on
test outcomes. Signals, timeouts, and cancellation still fail. `ctx.exec.json` parses stdout with
its required Zod schema and checkpoints that value instead of raw output. Invalid or truncated JSON
fails.

Commands default to a five-minute deadline and 1 MiB **per stream**. Plain commands continue after
output overflow, retaining the first and last half of each stream's byte cap. No separator is
inserted; inspect `truncated`. JSON commands terminate on overflow. POSIX adapters own the process
group, reap same-group descendants after exit, and bound inherited-pipe draining. A child that
escapes into a separate session/group is outside that ownership, as with native agents. Windows
process-tree semantics are weaker; filesystem durability uses the existing local POSIX contract.

Identity covers the command, canonical cwd, hash of the explicit environment overlay, stdin digest,
`inheritEnv`, accepted exit codes, and output schema/mode. `timeoutMs`, `maxOutputBytes`, and
`retry` are policy, so raising them does not invalidate completed work. Sticky run policy accepts
`kind: 'exec'`, timeout/output caps, and retry. Unfinished effects retain the existing explicit
redefinition/history behavior; completed identity changes require a new run or an appropriate fork.
Repeated observations need fresh IDs or a read-only `ctx.poll` observer; do not nest exec in one.

The default environment inherits the parent plus `env`. `inheritEnv: false` supplies only that
overlay and engine metadata (the selected executable or shell may itself add variables). Rotating
authentication belongs in the parent environment. Explicit overlay values and stdin are hashed, not
checkpointed; output can still contain anything the command prints. The `QUIET_CHOIR_` prefix is
reserved. Children receive `QUIET_CHOIR_IDEMPOTENCY_KEY` (`runId/stepId`), `QUIET_CHOIR_RUN_ID`,
`QUIET_CHOIR_STEP_ID`, and `QUIET_CHOIR_ATTEMPT`. Scripts must implement their own reconciliation;
the runtime cannot make external writes exactly once.

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

## Guarding a mutation

`guardFile(ctx, id, path, body, { onChange: 'restore' | 'error' })` saves the current uncommitted
text as a raw Git blob, journals one body outcome, then compares and restores the file in one
command. No blob bytes appear in command output or checkpoints. `--no-filters` preserves CRLF. The
default is to restore silently; `'error'` restores first and then rejects if content or permission
bits changed. The file must be a regular UTF-8 file inside cwd (symlink leaves are rejected), cwd
must be in a Git repository, and Git/Node must be installed. `maxBytes` defaults to 1 MiB. `version`
declares changes in closed-over body dependencies; body source and onChange policy participate in
its journaled identity.

The body must return JSON. Its success or ordinary failure is terminal for that guard ID, preventing
a failed body from rerunning after an already completed restore replays. Retrying that whole body
requires a new guard ID/run. A restore failure can resume without rerunning a settled body. Neither
cancellation, runner death, suspension, nor external writers are filesystem rollback: after a hard
kill an unfinished body may rerun before restoration. The durable baseline still replays the
original blob. Do not treat this as automatic restore-before-retry or concurrent-writer protection.

## Rehearsal

CLI `--dry-run` synthesizes exec results without spawning, records planned commands in `commands`,
and uses temporary state. Plain stdout is empty and JSON follows the schema, so the exercised branch
may differ from reality. File effects, local callbacks, and top-level workflow code still run for
real unless selected by `--stub-steps`. `--harness fixture` replaces agents only; ordinary commands
and files remain real. See the
[verified cookbook](../plugins/agents/quiet-choir/skills/quiet-choir/references/patterns.md#commands-and-test-verdicts).
