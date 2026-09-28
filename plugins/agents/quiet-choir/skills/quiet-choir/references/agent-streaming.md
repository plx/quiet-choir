# Streaming and attempt evidence

Native Claude stream-json and Codex JSONL are parsed as output arrives. Use
`workflow execute --progress` to print bounded tool/message/status summaries to stderr; `--json`
stdout stays clean. Embedded observers receive `agent.started`, `agent.progress`, and
`agent.finished`. Summaries are lossy (about ten per second after the first initialization), never
journaled, and cannot fail a call. Final success still requires a valid terminal protocol,
successful process exit and local JSON/Zod validation. Events after a native result are allowed.

Both `agent.finished` and `step.completed` can carry the same usage; do not sum across event types.

## Early session IDs

Each attempt saves its first native `sessionId` before consuming more stdout. Claude also saves a
`requestedSessionId` before spawn. With the public
`deriveAgentSessionId(run.sessionSalt, fullId, attemptNumber)`, a checkpoint alone reconstructs that
UUID: UUIDv5 uses the saved random UUID salt as namespace and `fullId/attemptNumber` as name. Forks
use a fresh salt for new calls. Codex cannot request a thread ID and relies on `thread.started`.

The IDs remain correlation keys. Claude `--no-session-persistence` and Codex `--ephemeral` stay
enabled; quiet-choir does not restore a native conversation.

## Private files and caps

Every attempt defaults to a 0600 file at
`<runDir>/attempts/<sha256-full-step-id>/<attempt>.<provider>.jsonl`. Private directories and a hash
of the full ID keep `/`, `..`, long IDs and case differences safe. The attempt's `transcript`
receipt records `path`, `bytes`, `truncated`, and `retained` before the child runs. A running
receipt reflects the last checkpoint; the file can hold newer chunks. Default project state is
outside the worktree; choose explicit storage accordingly because raw output can contain secrets.

Each JSONL entry has `stream: "stdout" | "stderr"` and `base64`. Decode and concatenate entries for
each stream to recover raw bytes, including split UTF-8 characters. A capped file ends with
`{ "type": "truncated", "reason": "maxTranscriptBytes" }`; this marker counts toward its cap.

| CLI flag / policy                               | Default | Purpose                                                      |
| ----------------------------------------------- | ------- | ------------------------------------------------------------ |
| `--max-retained-bytes` / `maxRetainedBytes`     | 8 MiB   | Retained parser state and each stdout line                   |
| `--max-stream-bytes` / `maxStreamBytes`         | 1 GiB   | Combined raw stdout/stderr safety cap                        |
| `--max-transcript-bytes` / `maxTranscriptBytes` | 64 MiB  | File bytes including base64/JSON overhead; minimum 128 bytes |
| `--transcripts` / `transcripts`                 | `on`    | `on`, `on-failure`, or `off`                                 |

These are sticky execution policy, outside fingerprints. Embedders set `RunOptions.policy`.
`CliHarnessOptions` / `--harness-config` can set parser and stream defaults. Custom stores supply
`OwnedRunStore.transcript` returning an `AgentTranscriptWriter` (snapshot/write/close/discard), or
set `transcripts: 'off'`; the core does not bypass that storage port. Legacy agent `maxOutputBytes`
now aliases retention; `ctx.exec` keeps separate per-stream capture behavior. The parser skips
oversized recognized nonessential events such as Codex command output. Required final text and
unknown/reordered oversized headers fail naming `maxRetainedBytes`. Stderr retains its last 64 KiB
separately. Transcript truncation does not fail a valid answer.

`on-failure` removes a transcript only after local validation and durable success; failed, cancelled
and schema-rejected attempts keep it. Cleanup failure warns without repeating successful work. `off`
creates no file. A transcript/session write failure is infrastructure, never a retry or a settled
fallback. Transcript close/discard is bounded to 2 seconds: a close that never settles is
infrastructure too, while a stalled discard only warns.

## Failed attempts and diagnostics

Read `steps[id].attemptHistory`, not just the latest step error. Each failed agent attempt retains
available session, usage, diagnostics, error/stack/category, and response text up to 256 KiB, marked
by `responseTruncated`. Local Zod rejection adds `validationIssues`. Retry and resume append new
attempts; a later success never erases earlier evidence. Missing/abandoned usage remains incomplete.

`AgentResult.diagnostics` and attempt diagnostics are loose JSON records: model/version where
reported, turns, duration, terminal/stop reasons, denied tools/count, selected initial capabilities,
subagent counts, warnings, stderr tail, skipped-line count, and transcript receipt. Full native init
paths/socket details stay out of these selected diagnostics but may appear in the raw file. Claude
`onPermissionDenied: 'fail'` rejects reported denials and names the tools; default `warn` records
them and prints a CLI warning. Per-call policy overrides its profile and changes identity.

**Upgrade boundary:** adding result diagnostics changes agent result-schema fingerprints once.
In-flight runs with older completed agent calls require a new run or fork invalidation of those
calls; accepting source changes alone does not bypass this check. Future diagnostic keys do not
change fingerprints. Existing checkpoints remain readable.
