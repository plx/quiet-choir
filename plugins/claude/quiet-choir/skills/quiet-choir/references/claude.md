# Claude Code calls

These are quiet-choir's `ClaudeOptions`, not the full Claude Code CLI surface or Claude's native
workflow API. Any agent host can use `ctx.claude`. This plugin does not install Claude Code;
`CliHarness` runs the first `claude` on PATH unless an embedding caller overrides the binary.

## Options and result

Both `ctx.claude.text(id, options)` and `ctx.claude.object(id, { schema, ...options })` return
`{ output, sessionId, usage }`. `output` is text or the locally validated structured value. The
defaults below come from `CliHarness`, not the core or custom harnesses.

| Option         | Meaning and CliHarness default                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`       | Required instructions, delivered on stdin without a shell                                                                                 |
| `model`        | Claude model name/alias; omitted means the installed harness default                                                                      |
| `cwd`          | Resolved against the run's working directory; defaults to it. Absolute paths are accepted and are not confined. The directory must exist. |
| `timeoutMs`    | Per-call wall-clock limit, default 900,000 (15 minutes)                                                                                   |
| `tools`        | Built-in tools exposed to the call; default empty                                                                                         |
| `allowedTools` | Tools pre-approved in addition to settings allow rules; omitted by default                                                                |
| `maxTurns`     | Positive integer, default 25                                                                                                              |
| `maxBudgetUsd` | Positive finite per-call USD limit, default 0.25                                                                                          |

The adapter uses `claude --print --output-format json --permission-mode dontAsk` and
`--no-session-persistence`. Each effect starts fresh; `sessionId` is for correlation only. The
no-persistence flag disables the local session transcript. Pass relevant earlier output explicitly
in later prompts.

`tools` decides which built-in tools exist; the default is none. MCP tools from configuration still
load. `allowedTools` pre-approves tools on top of settings allow rules, and `dontAsk` denies the
rest. To read source files, expose and allow the needed tools explicitly, for example inside `run`:

```ts
const result = await ctx.claude.object('review', {
  prompt: 'Read src/index.ts and summarize the public API. Do not edit files.',
  tools: ['Read'],
  allowedTools: ['Read'],
  maxTurns: 5,
  maxBudgetUsd: 0.25,
  schema: z.object({ summary: z.string() }),
});
```

Keep permissions appropriate to the task. quiet-choir exposes no permission-bypass mode. Limits
apply per call, not across the workflow; bounded concurrency does not impose a total spending cap.

## Structured output and errors

Object calls require an object-root schema and pass its JSON Schema through `--json-schema`.
Successful terminal `result` envelopes have `subtype: success` and no `is_error: true`. Text calls
read `result`; object calls require `structured_output`. The runtime parses and validates output
against the original Zod schema.

The adapter parses stdout on both zero and nonzero normal exits. Saved errors retain reported
reasons, subtype, terminal reason, and API status when available, plus the exit code and bounded
stderr. Auth, API, turn-limit, and budget failures normally exit 1. Exit zero cannot override a
reported failure. A bare exit error means no usable protocol reason was recovered: check
`claude auth status`, the schema, and the same invocation's flags when reproducing manually. This is
the current behavior after issue [#33](https://github.com/plx/quiet-choir/issues/33), replacing the
earlier exit-code-only warning.

`usage.costUsd` is Claude's `total_cost_usd`; in the recorded 2.1.283 call it matched per-model cost
totals. `inputTokens` is the top-level `usage.input_tokens`, excluding cache reads/writes and not
summing `modelUsage`: one captured call reported 19 versus about 22.6k inputs in the per-model
uncached/cache totals. Do not compare this field directly with Codex input counts. Unavailable
measurements are null. Since [#33](https://github.com/plx/quiet-choir/issues/33), failed protocol
attempts can retain session/usage metadata in `steps[id].failedAttempts`; successful usage remains
in the completed result. Missing failure metadata and partial calls still make this an incomplete
spending ledger.

Agent calls accept `retry: { maxAttempts, delayMs? }`; the default remains one attempt. Only retry
calls safe to repeat, since earlier attempts may already have edited files. Fix authentication
externally and resume. Limits (`timeoutMs`, `maxTurns`, `maxBudgetUsd`) and retry policy are
excluded from identity. Raise them with a sticky CLI `--policy` rule or embedded `RunOptions.policy`
without rerunning completed steps; see the
[timeout recovery recipe](durability.md#recovering-a-timeout-or-turn-limit). Completed prompts,
schemas, model, cwd, and capabilities still must match. Embedded callers may redefine unfinished
steps with history retained. CLI source edits still change the run fingerprint. A model override
requires explicit `--allow-model-override`; it affects unfinished attempts only. `attemptHistory`
records resolved limits, requested model, provenance, timestamps, and outcome.

## Configuration and cancellation

The CLI inherits Claude authentication, configuration, hooks, and MCP setup. The call's `cwd`
selects project `.claude/` settings and hooks. `claude -p` skips the trust dialog, so project hooks
can run even in never-trusted directories. Disabling built-in tools does not isolate this
configuration; explicit MCP controls remain deferred to
[#60](https://github.com/plx/quiet-choir/issues/60).

The default 8 MiB limit counts combined stdout/stderr; embedding callers can override it through
`CliHarnessOptions`. CLI executions cannot raise it. Timeout/cancellation terminates process groups
on macOS/Linux; Windows cleanup reaches the immediate child only. A stopped call may already have
edited files.

One Ctrl-C or SIGTERM requests cancellation, terminates harness processes, drains work, and
exits 130. A second Ctrl-C kills the runner mid-drain and can leave its lock and a `running`
checkpoint. SIGKILL, SIGHUP (closed terminal or dropped SSH), or a crash can leave detached harness
children running and editing. Before resuming, check `pgrep -fl 'claude --print|codex exec'` and
identify any children belonging to the interrupted run. See [durability](durability.md).

Structured-output success paths for both adapters completed live with claude 2.1.283 and codex-cli
0.157.1. That is evidence for those versions and captures, not a guarantee for other versions or the
current credentials.
