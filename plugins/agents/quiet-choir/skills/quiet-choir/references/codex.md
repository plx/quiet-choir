# Codex calls

These are quiet-choir's `CodexOptions`. The installed Codex CLI may expose more settings, but this
adapter accepts only the subset below. Any agent host can author a workflow that invokes
`ctx.codex`. This plugin does not install Codex; `CliHarness` runs the first `codex` on PATH unless
an embedding caller overrides the binary.

## Options and result

Both `ctx.codex.text(id, options)` and `ctx.codex.object(id, { schema, ...options })` return
`{ output, sessionId, usage }`. `output` is text or the locally validated structured value. These
defaults belong to `CliHarness`; the core adds none.

| Option             | Meaning and default                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`           | Required instructions, sent over stdin                                                                                                    |
| `model`            | Model name; omitted means the installed harness default                                                                                   |
| `cwd`              | Resolved against the run's working directory; defaults to it. Absolute paths are accepted and are not confined. The directory must exist. |
| `timeoutMs`        | Per-call wall-clock limit, default 900,000 (15 minutes)                                                                                   |
| `sandbox`          | `read-only` (default) or `workspace-write`                                                                                                |
| `reasoningEffort`  | `minimal`, `low`, `medium`, or `high`; omitted means inherited configuration                                                              |
| `skipGitRepoCheck` | Set true to permit execution outside a Git repo; omitted by default                                                                       |

Codex 0.157.1 also accepts effort names `none`, `xhigh`, and `max`, which this adapter cannot pass
through `reasoningEffort`; support for particular models is unverified. Omitting the option inherits
user configuration, which may select an expensive level such as `xhigh`. Expanding the typed surface
is deferred to [#46](https://github.com/plx/quiet-choir/issues/46).

Inside a workflow whose input includes `topic`:

```ts
const result = await ctx.codex.object('review', {
  prompt: `Assess the clarity of this topic: ${input.topic}. Do not use tools.`,
  sandbox: 'read-only',
  reasoningEffort: 'low',
  schema: z.object({ accepted: z.boolean(), reason: z.string() }),
});
```

The adapter runs
`codex exec --json --sandbox read-only --config approval_policy="never" --ephemeral --color never -`
by default. It does not expose interactive approvals or an unrestricted sandbox. Select
`workspace-write` for authorized editing tasks; the effect's working directory is not automatically
isolated in a worktree. Hooks, MCP servers, and inherited configuration still matter, and the
workflow's own TypeScript runs outside these harness sandbox controls.

Each effect is a fresh call with `--ephemeral`, so there is no persisted local session transcript.
The native thread ID is returned as `sessionId` for correlation only, not as a workflow resume
token. Pass previous results explicitly in subsequent prompts.

## Structured output and protocol

Object calls write JSON Schema to a private temporary file, pass it via `--output-schema`, and
remove the file after the call. The default `structuredOutput: 'compat'` encodes ordinary Zod:

- Optional properties become required and nullable on the wire. Decoding removes null only when the
  original property was optional and did not allow null.
- Arrays, primitives, and unions at the root are wrapped in `{ value }` and unwrapped afterward.
- String-keyed records use arrays of `{ key, value }`; enum-keyed records require every key.
- Discriminated unions use `anyOf`; loose objects are closed on the wire (no extra keys requested).
- Tuples fail before launch in both modes; use a named object or a homogeneous array.

The original Zod schema validates decoded output. Refinements run only locally; state them in the
prompt. With `structuredOutput: 'strict'`, use an object root, required properties (use
`.nullable()` for missing values), and avoid records, loose objects, discriminated unions, and
tuples. Exported `checkCodexSchema(schema)` returns incompatible JSON paths and fixes without
launching a process. `workflow validate` does not execute the body and cannot inspect these
call-site schemas. Codex enforces strict wire schemas; raw `.optional()` properties were rejected
before inference in the captured 0.157.1 probes. Issue
[#35](https://github.com/plx/quiet-choir/issues/35) added the default compat encoding and local
strict-mode diagnostics, so the old blanket warning against `.optional()` no longer applies. An
explicit mode is part of identity; keep it stable for completed-step replay. Claude requires an
object root and receives the original JSON Schema. Other Codex restrictions and compatibility
transforms do not apply to it.

The adapter reads Codex JSONL: `thread.started` supplies the thread ID, `item.completed` with
`agent_message` supplies final text, and `turn.completed` is required for success. Exit zero plus
both final events and no `turn.failed` completes the step. Top-level `error` events (including
reconnect notices and notices after completion) are warnings when the turn succeeds. Inspect
`steps.<id>.warnings` in the saved run; the adapter retains the last 32 notices, each bounded to
2048 characters. They do not change the result shape or replay fingerprint. `turn.failed` always
fails with its own reason. Without `turn.completed`, the last non-reconnect error is the reason, or
the error explains the interrupted turn; bounded earlier notices are appended. Nonzero exits,
missing final text, and malformed protocol output also fail. Agent stdout is parsed after the
process finishes; there is no token/tool event stream exposed through quiet-choir's progress
observer. This reflects the stdout diagnostics and recoverable-error fixes in
[#33](https://github.com/plx/quiet-choir/issues/33)/#34; the earlier exit-code-only and
fatal-on-any-error guidance is obsolete.

Usage reports top-level `input_tokens` and `output_tokens` when available. The interpretation of
Codex inputs as including cached input is inferred from OpenAI semantics, not verified by a live
cache comparison; it is not comparable with Claude's top-level field. `costUsd` is null and there is
no Codex per-call USD cap. Failed protocol attempts can retain available usage/session metadata in
`steps[id].failedAttempts`, with nulls when absent.

The default 15-minute wall-clock and 8 MiB combined stdout/stderr limits bound the process, not
dollar spend. The byte limit counts the whole JSONL stream, including command output. CLI runs
cannot raise it; embedding callers can set `CliHarnessOptions.maxOutputBytes`. A noisy editing call
may hit that limit after making file changes even though its result is not saved.

## Diagnosing a failure

Inspect the saved step error and verify authentication with `codex login status`. Protocol reasons
from stdout survive nonzero normal exits; a bare exit error means no usable reason was recovered.
Check the object schema and reproduce with the same flags when needed. Credentials-only repairs can
resume compatible runs.

Timeout and explicit retry policy are excluded from step identity. Raise `timeoutMs` through a
sticky `--policy` rule without editing source or rerunning completed calls. A model or effort
override requires `--allow-model-override` and affects unfinished attempts only. Completed prompts,
schemas, model/effort, cwd, sandbox, and other capabilities still must match. Embedded callers may
redefine unfinished steps with history; CLI source edits require explicit code acceptance or a fork.
See [durability](durability.md#recovering-a-timeout-or-turn-limit) for the recovery recipe and
`attemptHistory` fields. Use `skipGitRepoCheck` only for work outside Git.

Agent calls accept `retry: { maxAttempts, delayMs? }` for explicitly repeatable work; the default
remains one attempt. Timeout/cancellation terminates process groups on macOS/Linux, with only
immediate-child cleanup on Windows. One Ctrl-C or SIGTERM cancels, drains, and exits 130. A second
Ctrl-C kills the runner mid-drain and can leave its lock and a `running` record. SIGKILL, SIGHUP
(closed terminal or dropped SSH), or a crash can leave detached children running and editing. Before
resuming, check `pgrep -fl 'claude --print|codex exec'` and identify any children belonging to the
interrupted run.

Structured-output success paths for both adapters completed live with claude 2.1.283 and codex-cli
0.157.1. That is evidence for those versions and captures, not a guarantee.
