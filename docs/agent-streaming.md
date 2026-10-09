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

A tool summary names the tool and, when the native input has one, a short target:
`Claude tool: Edit …/src/harnesses/stream.ts`, `Codex command_execution: item.started git status`.
Claude targets come only from the first tool call's `file_path`, `notebook_path`, `command`,
`pattern`, `url`, `query`, `path` or `description` input, in that order, with ` (+N more)` when the
message carries further tool calls; an MCP tool (`mcp__server__tool`) has none, since its summary
names it, and neither has `StructuredOutput` in a structured call, because its input is the result.
Codex targets are a `command_execution` command (one `bash`/`zsh`/`sh` `-c` or `-lc` wrapper is
stripped), a `file_change`'s first path with ` (+N more)` for further files, an `mcp_tool_call`'s
`server/tool`, or a `web_search` query. A target keeps only its first line, with control characters
and whitespace runs collapsed, and is at most 80 code points: a path keeps its tail after a leading
`…`, anything else its head before a trailing `…`. An http(s) URL loses its userinfo, query and
fragment. File contents, edit strings, prompts, MCP arguments and command output are never read, but
the first 80 characters of a command can appear, so an inline secret there can reach the progress
line. Progress stays lossy stderr/`onEvent` output and is never journaled. Lines without a usable
target keep their plain summary.

Claude reports `thinking_tokens` status lines about once a second while it thinks. They read
`Claude: thinking (~N tokens)` (or `Claude: thinking` without an estimate), and a burst of
consecutive thinking lines offers its first line and then at most one line per 10 seconds; any other
progress line starts a new burst.

Both `agent.finished` and `step.completed` can carry the same usage; do not sum across event types.
`agent.finished` also carries `durationMs`, the attempt's monotonic duration including any admission
wait (the same value as `attemptHistory[].durationMs`), and its progress line shows
`completed durationMs=1234`. It is not `diagnostics.durationMs`, which is the duration the native
CLI reported.

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

`workflow transcript RUN STEP [--attempt N] [--stream stderr]` does that decoding: it reads the run
record without importing workflow code, selects the agent step's latest (or `--attempt N`) attempt,
and writes the selected stream's native bytes to stdout unchanged, so Claude stream-json or Codex
JSONL can go straight into `jq`. A truncated transcript prints a warning on stderr, and so does a
still-running (or crashed, not yet resumed) attempt, whose output may end early. It reads only a
retained receipt's `<runId>/attempts/<hash>/<file>` tail, re-rooted under the current state
directory (so a moved or symlinked state directory still works), whose file resolves inside the
run's `attempts/` directory, opened without following symlinks. See
[the CLI contract](cli-contract.md#workflow-transcript) for its failures.

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
successful transcript only after the validated outcome commits, flushing the deletion to the
containing directory before the receipt is marked unretained. A cleanup failure, including a discard
that does not settle within that bound, preserves the completed outcome and reports a warning; it
never reruns paid work. `off` creates no transcript.

## Diagnostics, failures, and compatibility

`AgentResult.diagnostics` and `attemptHistory[].diagnostics` are loose JSON records. Native fields
include turns, duration, terminal/stop reasons, denied tool names/count, subagent counts, selected
initial capabilities, model/version, warnings, stderr tail, skipped-line count, transcript receipt,
and `toolUses`, the tool calls counted from every parsed line and from the headers of skipped
oversized Codex tool items (see
[tool-use diagnostics](harness-controls.md#idle-deadline-and-tool-use-diagnostics)). A skipped
oversized Claude assistant line makes a zero count unknown (`null`), so it never warns. A Claude
attempt that streamed a `rate_limit_event` also has `rateLimit`, the latest valid event's status,
type, reset time and window utilizations (see
[subscription rate-limit windows](usage-and-budgets.md#subscription-rate-limit-windows)); Codex
attempts have none. Missing native fields remain absent or null; a version or model found by
discovery is kept when the stream reports none. The completed `agent.finished` event also carries
the step's `warnings` (such as `no-tool-use`) when there are any. The compact `--events` lines and
`workflow events` carry the same evidence without `agent.finished`: `toolUses` on an agent step's
terminal line and the warnings as `msg` on `step.completed`
([event stream](observability.md#event-stream)). Full initialization paths/socket details are not
copied into diagnostics; raw transcripts can contain them.

Failed attempts retain session, usage, error/stack/category, diagnostics, and available rejected
response text (up to 256 KiB, with `responseTruncated`). Local Zod failures also retain
`validationIssues`. Every retry appends a new attempt; later success preserves earlier evidence.
`failedAttempts` remains a compatibility usage view. Missing/interrupted usage stays unknown. See
[usage and budgets](usage-and-budgets.md) for normalized categories, run totals and admission gates;
these are not a billing ledger.

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
