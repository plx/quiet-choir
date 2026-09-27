# Claude Code calls

These are quiet-choir's `ClaudeOptions`, not the full Claude Code CLI surface or Claude's native
workflow API. Any agent host can use `ctx.claude`. This plugin does not install Claude Code;
`CliHarness` runs the first `claude` on PATH unless an embedding caller overrides the binary.

Read [agent calls](agent-calls.md) for result methods, shared options/defaults, profiles, grants,
usage, retries, identity, and process recovery.

## Claude controls

| Option                               | Meaning                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `disallowedTools`                    | Denied tool rules, e.g. `Bash(git push:*)`                                  |
| `permissionMode`                     | `dontAsk` (default), `acceptEdits`, or `plan`; bypass is unsupported        |
| `systemPrompt`, `appendSystemPrompt` | Role text supplied through private temporary files                          |
| `agent`, `agents`                    | Native agent name and definitions with required description/prompt          |
| `mcpServers`, `strictMcpConfig`      | Server-name mapping and exclusive explicit MCP configuration                |
| `settings`                           | JSON native settings; typed model/agent/permission/MCP aliases are rejected |
| `fallbackModel`                      | Model string or nonempty array, passed as a comma-separated chain           |

Agents, MCP and settings also use 0600 temporary files, removed in finally. Capability controls
belong in profiles under default strict mode; native agent/config/MCP/settings/escape/env controls
conservatively need exec grants. Role prompts and effort may be supplied per call. Each attempt
records requested model/effort or `"inherited"`. All these semantic values, including fallback
models, must match for completed replay. Escape-arg paths fingerprint the path string only.

The adapter defaults to `claude --print --output-format json --permission-mode dontAsk` and
`--no-session-persistence`. Each effect starts fresh; `sessionId` is for correlation only. The
no-persistence flag disables the local session transcript. Pass relevant earlier output explicitly
in later prompts.

Declare roles on `defineWorkflow` and choose them per call:

<!-- skills-check: fragment; reason: Definition fields and workflow body shown separately. -->

```ts
// Definition fields, alongside name/version/input/output/run:
profiles: {
  scout: { extends: 'readonly', maxTurns: 30, description: 'Reads source' },
  fixer: { extends: 'edit', onPermissionDenied: 'fail' },
},

// Inside run:
const result = await ctx.claude.object('review', {
  profile: 'scout',
  prompt: 'Read src/index.ts and summarize the public API.',
  schema: z.object({ summary: z.string() }),
});
```

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
the current behavior after issue [#33](https://github.com/plx/quiet-choir/issues/33).

`usage.costUsd` is Claude's `total_cost_usd`; in the recorded 2.1.283 call it matched per-model cost
totals. `inputTokens` is the top-level `usage.input_tokens`, excluding cache reads/writes and not
summing `modelUsage`: one captured call reported 19 versus about 22.6k inputs in the per-model
uncached/cache totals. Do not compare this field directly with Codex input counts. Unavailable
measurements are null. Since [#33](https://github.com/plx/quiet-choir/issues/33), failed protocol
attempts can retain session/usage metadata in `steps[id].failedAttempts`; successful usage remains
in the completed result. Missing failure metadata and partial calls still make this an incomplete
spending ledger.

## Configuration and cancellation

The CLI retains native authentication and defaults to `--restricted --strict-mcp-config`.
User/project hooks, discovered MCP, project instructions, and user plugins/memory do not load
implicitly. Typed settings/MCP/plugin/prompt options opt content back in; managed policy remains. An
explicit inherited role selects project `.claude/` settings from `cwd`; headless Claude skips trust
prompts, so never use it on an untrusted checkout. See [harness isolation](harness-isolation.md) for
environment scrubbing, protected-write limits, and verified native behavior.

See [process lifecycle](agent-calls.md#process-lifecycle) for deadlines, output caps, signals, and
orphan recovery. A stopped call may already have edited files.
