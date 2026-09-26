# Codex calls

These are quiet-choir's `CodexOptions`. The installed Codex CLI may expose more settings, but this
adapter accepts only the subset below. Any agent host can author a workflow that invokes
`ctx.codex`; installing the general-agent plugin does not replace the harness executable.

## Options and result

Both `ctx.codex.text(id, options)` and `ctx.codex.object(id, { schema, ...options })` return
`{ output, sessionId, usage }`. `output` is text or the locally validated structured value.

| Option             | Meaning and default                                                          |
| ------------------ | ---------------------------------------------------------------------------- |
| `prompt`           | Required instructions, sent over stdin                                       |
| `model`            | Model name; omitted means the installed harness default                      |
| `cwd`              | Relative to the workflow working directory; defaults to that directory       |
| `timeoutMs`        | Per-call wall-clock limit, default 120,000                                   |
| `sandbox`          | `read-only` (default) or `workspace-write`                                   |
| `reasoningEffort`  | `minimal`, `low`, `medium`, or `high`; omitted means inherited configuration |
| `skipGitRepoCheck` | Set true to permit execution outside a Git repo; omitted by default          |

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

Each effect is a fresh ephemeral call. The native thread ID is returned as `sessionId` for
diagnostics; it cannot be used as a quiet-choir resume token. Pass previous results explicitly in
subsequent prompts.

## Structured output and protocol

Object calls write JSON Schema to a private temporary file, pass it via `--output-schema`, and
remove the file after the call. Use required JSON-compatible object properties for portability; the
runtime parses the returned text as JSON and validates it with Zod.

The adapter reads Codex JSONL: `thread.started` supplies the thread ID, `item.completed` with
`agent_message` supplies final text, and `turn.completed` is required for success. `turn.failed`,
`error`, missing final text, or truncated output without `turn.completed` fails the step even if the
process exits zero. Agent stdout is parsed after the process finishes; there is no token/tool event
stream exposed through quiet-choir's progress observer.

Usage reports input/output tokens when available. `costUsd` is null for this adapter, and there is
no Codex per-call USD cap. The default wall-clock and 8 MiB combined output limits bound the
process, not its dollar spend. `CliHarnessOptions` can override the output limit when embedding.

## Diagnosing a failure

Inspect the saved step error and verify the installed CLI's authentication and supported options.
Use `skipGitRepoCheck` only when the task belongs outside Git; changing options changes the
checkpoint fingerprint and calls for a new run. A credentials-only repair can usually resume the
same run. See [durability](durability.md) for compatibility and duplicate-effect risks.

quiet-choir does not automatically retry agent calls. Timeout/cancellation terminates process groups
on macOS/Linux, with only immediate-child cleanup on Windows. After hard-killing the runner, check
for surviving children before resuming. The prototype records a small live structured-output test
with Codex 0.153.4; that is evidence of that test, not a version guarantee.
