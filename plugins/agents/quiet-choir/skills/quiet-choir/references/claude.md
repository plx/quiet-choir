# Claude Code calls

These are quiet-choir's `ClaudeOptions`, not the full Claude Code CLI surface or Claude's native
workflow API. A caller in any agent host can use `ctx.claude`; the host running the skill does not
determine which harness a workflow invokes.

## Options and result

Both `ctx.claude.text(id, options)` and `ctx.claude.object(id, { schema, ...options })` return
`{ output, sessionId, usage }`. `output` is text or the locally validated structured value.

| Option         | Meaning and default                                                              |
| -------------- | -------------------------------------------------------------------------------- |
| `prompt`       | Required instructions, delivered on stdin without a shell                        |
| `model`        | Claude model name/alias; omitted means the installed harness default             |
| `cwd`          | Directory relative to the workflow working directory; defaults to that directory |
| `timeoutMs`    | Per-call wall-clock limit, default 120,000                                       |
| `tools`        | Built-in tools exposed to the call; default empty                                |
| `allowedTools` | Explicit tool permissions for this call; omitted by default                      |
| `maxTurns`     | Positive integer, default 3                                                      |
| `maxBudgetUsd` | Positive finite per-call USD limit, default 0.25                                 |

The adapter uses `claude --print --output-format json --permission-mode dontAsk` and
`--no-session-persistence`. Each effect starts fresh; `sessionId` is diagnostic metadata. If a later
step needs context from an earlier call, pass relevant output in its prompt.

To read source files, expose and allow the needed tools explicitly, for example inside `run`:

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

Keep tool permissions appropriate to the requested task. `dontAsk` denies tools that lack permission
instead of presenting an interactive approval prompt. quiet-choir does not expose a
permission-bypass mode. The limits apply per call, not across the workflow; bounded concurrency does
not impose a total spending cap.

## Structured output and errors

Object calls pass converted JSON Schema through `--json-schema`. The adapter requires a terminal
`result` with `subtype: success` and no `is_error: true`. Text calls read `result`; object calls
require `structured_output`. A process exiting zero with a reported agent failure still fails the
step. The runtime then parses and validates output against the original Zod schema.

Usage includes reported input/output tokens and `total_cost_usd` when available; missing
measurements become null. Inspect the step's saved error for authentication, turn/budget limits,
missing structured output, invalid JSON, or schema mismatch. quiet-choir does not automatically
retry failed Claude calls. Fix authentication externally and resume compatible runs; changing call
options/code generally requires a new run. See [recovery](durability.md).

The CLI inherits local Claude authentication, configuration, hooks, and MCP setup. Disabling
built-in tools is not complete isolation of the harness environment. Both adapters enforce an 8 MiB
combined stdout/stderr limit by default; the embedding caller can change it through
`CliHarnessOptions`. Timeouts and cancellation terminate the process group on macOS/Linux; Windows
cleanup reaches the immediate child only.

The prototype's recorded successful Claude protocol tests use fixtures; its initial live check
stopped at expired OAuth before inference. Do not treat fixture coverage as proof of a successful
call with the current credentials or CLI version.
