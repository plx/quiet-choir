# Agent streaming and attempt evidence

`CliHarness` reads Claude `--output-format stream-json --verbose` and Codex JSONL incrementally. It
accepts startup events before initialization and events after the terminal result. A successful
protocol still requires a successful process exit. Claude structured streams retain
`structured_output`; Codex still requires a final agent message and `turn.completed`.

## Live progress and early sessions

`workflow execute --progress` prints `agent.started`, `agent.progress`, and `agent.finished` to
stderr, keeping `--json` stdout machine-readable. Embedded callers receive the same events through
`onEvent`. Progress contains a short activity kind/summary, with model and CLI version when native
initialization reports them. The first initialization is immediate; subsequent summaries are limited
to about ten per second. These notifications are lossy and never journaled. Finished events describe
the outcome after local JSON/Zod validation. Observer failures cannot fail a call.

Both `agent.finished` and `step.completed` can carry the same usage; do not sum across event types.

Each attempt saves the first native session ID before processing more stdout. Claude also receives a
UUID before spawn, stored as `requestedSessionId`. Derive it with
`deriveAgentSessionId(run.sessionSalt, fullStepId, attempt.attempt)`: UUIDv5 uses the stored random
UUID as its namespace and `fullStepId/attempt` as its name. Forks receive a fresh salt; copied
results retain their original IDs. Codex relies on `thread.started` because `codex exec` cannot
request a thread ID. The requested and observed Claude IDs are kept separately.

These IDs are correlation keys. Native `--no-session-persistence` / `--ephemeral` remain enabled;
quiet-choir does not resume native conversations.

## Private transcripts and independent caps

By default, every agent attempt creates a 0600 transcript under
`<runDir>/attempts/<sha256-full-step-id>/<attempt>.<provider>.jsonl`, with private 0700 directories.
Hashing the full ID keeps slashes, `..`, long IDs, and case differences inside the run directory.
FileRunStore allocates these files through the optional `OwnedRunStore.transcript` port. Custom
stores can return an `AgentTranscriptWriter` (snapshot/write/close/discard); stores without this
port must set policy `transcripts: 'off'`. The core never bypasses the store to choose a file
location. Running receipts reflect the last checkpoint; the file can hold newer chunks. The
transcript receipt is saved before invocation and includes `path`, `bytes`, `truncated`, and
`retained`. Default project state lives outside the working tree. Explicit state paths remain the
operator's choice. Raw output can contain secrets; retain these private files accordingly.

Each line is `{ "stream": "stdout" | "stderr", "base64": "..." }`. Decode and concatenate bytes for
each stream to recover its output, including split UTF-8 characters. Cross-stream ordering is
callback arrival order, not a total order of native writes. The final
`{ "type": "truncated", "reason": "maxTranscriptBytes" }` marker is included in the cap. Transcript
truncation does not fail a valid call.

| Policy / CLI flag                               | Default | Meaning                                                                 |
| ----------------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `maxRetainedBytes` / `--max-retained-bytes`     | 8 MiB   | Bounds retained protocol state and each stdout line                     |
| `maxStreamBytes` / `--max-stream-bytes`         | 1 GiB   | Combined raw stdout/stderr safety limit                                 |
| `maxTranscriptBytes` / `--max-transcript-bytes` | 64 MiB  | File size including JSONL/base64 overhead and marker; minimum 128 bytes |
| `transcripts` / `--transcripts`                 | `on`    | `on`, `on-failure`, or `off`                                            |

All four are execution policy, outside fingerprints and sticky on CLI resume. Pass them through
`RunOptions.policy` when embedding. `CliHarnessOptions` / `--harness-config` also accept
`maxRetainedBytes` and `maxStreamBytes` as adapter defaults. `maxOutputBytes` is a legacy agent
alias for `maxRetainedBytes`; `ctx.exec` retains its independent per-stream capture semantics.

The parser discards oversized lines only when their bounded native header proves they contain
nonessential activity, such as Codex command output. Required final messages and unknown/reordered
oversized headers fail with `maxRetainedBytes` in the error. The separate stderr tail is 64 KiB. No
whole trace is buffered in memory. Async session and transcript callbacks apply pipe backpressure
and finish before child ownership is released. Transcript write failures are infrastructure errors;
they cannot become retryable failures or settled fallback values. Transcript close and discard are
bounded to 2 seconds after the invocation ends: a close that never settles (for example, behind a
stalled write) is an infrastructure failure, so the run fails instead of holding its ownership.

`on-failure` retains protocol, process, cancellation, and local validation failures. It removes a
successful transcript only after the validated outcome commits. A cleanup failure, including a
discard that does not settle within that bound, preserves the completed outcome and reports a
warning; it never reruns paid work. `off` creates no transcript.

## Diagnostics, failures, and compatibility

`AgentResult.diagnostics` and `attemptHistory[].diagnostics` are loose JSON records. Native fields
include turns, duration, terminal/stop reasons, denied tool names/count, subagent counts, selected
initial capabilities, model/version, warnings, stderr tail, skipped-line count, and transcript
receipt. Missing native fields remain absent or null. Full initialization paths/socket details are
not copied into diagnostics; raw transcripts can contain them.

Failed attempts retain session, usage, error/stack/category, diagnostics, and available rejected
response text (up to 256 KiB, with `responseTruncated`). Local Zod failures also retain
`validationIssues`. Every retry appends a new attempt; later success preserves earlier evidence.
`failedAttempts` remains a compatibility usage view. Missing/abandoned usage is still not a billing
ledger; the usage normalization follow-up is separate.

Claude `onPermissionDenied: 'fail'` rejects a successful envelope that reports denied tools and
lists their names. The default `warn` records them and prints a CLI warning. A per-call selection
overrides the profile's policy and participates in semantic identity.

Adding the diagnostics field changes agent result-schema fingerprints once. In-flight runs with
pre-streaming completed agent calls cannot reuse those calls after upgrading merely by accepting
code changes; start a new run or invalidate them in a fork. Later diagnostic key additions do not
change fingerprints. Existing checkpoints remain readable.

`test/fixtures/harness-stream/` contains sanitized Claude 2.1.283 and Codex 0.157.1 captures,
including Claude structured output and requested IDs with persistence disabled. Refresh them with
`npm run build` then `npm run test:contract -- --stream --refresh`. The probe uses fresh homes,
dummy keys and loopback fake APIs; it performs no paid inference. Native protocol references:
[Claude headless output](https://code.claude.com/docs/en/headless),
[Claude CLI flags](https://code.claude.com/docs/en/cli-reference), and
[Codex machine-readable output](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable).
