# Codex calls

These are quiet-choir's `CodexOptions`. The installed Codex CLI may expose more settings, but this
adapter provides typed controls and a fingerprinted escape hatch. Any agent host can author a
workflow that invokes `ctx.codex`. This plugin does not install Codex; `CliHarness` runs the first
`codex` on PATH unless an embedding caller overrides the binary.

Read [agent calls](agent-calls.md) for result methods, shared options/defaults, profiles, grants,
usage, retries, identity, and process recovery.

## Codex controls

`reasoningEffort` accepts none/minimal/low/medium/high/xhigh/max; set it or shared `effort`, never
both. `sandbox` is read-only or workspace-write. `skipGitRepoCheck: true` permits calls outside Git.
These are resolved through the shared profile/grant rules.

| Additional option | Meaning                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `networkAccess`   | Explicit boolean under workspace-write; requires that sandbox even when false                                                        |
| `harnessProfile`  | Native Codex profile (`--profile`); `profile` still selects a quiet-choir role                                                       |
| `config`          | JSON values rendered as TOML per dotted key; rejects null and aliases of owned controls                                              |
| `images`          | Regular files resolved against effect cwd; contents fingerprinted, snapshotted before launch and re-hashed on resume (keep readable) |

Effort omission inherits native configuration, potentially an expensive level. Model-specific
support remains native CLI behavior. Capability controls belong in profiles under strict mode.
Native profiles/config/escape/env and enabled network access conservatively require exec grants;
additional writable directories require write access. Explicit config values enter identity;
external native config files do not. `images` snapshots use 0600 files cleaned on every outcome;
renaming unchanged bytes can replay, changing bytes cannot. Escape args fingerprint strings only,
not files at paths embedded in them. Record model/effort selections under each attempt's
`requested`, with `"inherited"` for omissions.

Declare shared roles on `defineWorkflow`, for example
`defaults: { codex: { reasoningEffort: 'medium' } }` and
`profiles: { skeptic: { extends: 'readonly', codex: { reasoningEffort: 'high' } } }`. See
[profiles and grants](agent-calls.md#select-a-role-and-grant-its-capabilities).

Inside a workflow whose input includes `topic`:

<!-- skills-check: fragment; reason: Inside a workflow with ctx, input.topic, and z in scope. -->

```ts
const result = await ctx.codex.object('review', {
  prompt: `Assess the clarity of this topic: ${input.topic}. Do not use tools.`,
  profile: 'readonly',
  reasoningEffort: 'low',
  schema: z.object({ accepted: z.boolean(), reason: z.string() }),
});
```

The adapter runs
`codex exec --json --sandbox read-only --config approval_policy="never" --ephemeral --color never -- -`
by default. It does not expose interactive approvals or an unrestricted sandbox. Declare an
`edit`-based role with `codex: { sandbox: 'workspace-write' }` for authorized editing tasks and
launch with `--grant role`. Add `isolation: 'worktree'` for a fresh checkout on every attempt, or
pass a `ctx.worktree` handle for serialized write/test/fix effects. Shard structurally disjoint
files; isolate overlapping targets, concurrent runners, and retries unsafe on partial edits. See
[worktrees](worktrees.md) for snapshots and explicit integration. Hooks, MCP servers, and inherited
configuration still matter, and the workflow's own TypeScript runs outside these harness sandbox
controls.

Calls use `--ephemeral`, so the native thread ID is correlation metadata and no local session
transcript is persisted.

## Structured output and protocol

Object calls write JSON Schema to a private temporary file, pass it via `--output-schema`, and
remove the file after the call. The default `structuredOutput: 'compat'` encodes ordinary Zod:

- Optional properties become required and nullable on the wire. Decoding removes null only when the
  original property was optional and did not allow null.
- Arrays, primitives, and unions at the root are wrapped in `{ value }` and unwrapped afterward.
- String-keyed records use arrays of `{ key, value }`; enum-keyed records (`z.record`) require every
  key, and enum-keyed partial records (`z.partialRecord`) send every key nullable and drop nulls on
  decode. A union that mixes a string-keyed record with an array fails before launch because both
  encode as arrays; wrap the variants in discriminated `z.object`s instead.
- Discriminated unions use `anyOf`; loose objects are closed on the wire (no extra keys requested).
- Tuples fail before launch in both modes; use a named object or a homogeneous array.

The original Zod schema validates decoded output. Refinements run only locally; state them in the
prompt. With `structuredOutput: 'strict'`, use an object root, required properties (use
`.nullable()` for missing values), and avoid records, loose objects, discriminated unions, and
tuples. Exported `checkCodexSchema(schema)` returns incompatible JSON paths and fixes without
launching a process. `workflow validate` does not execute the body and cannot inspect these
call-site schemas. Codex enforces strict wire schemas; raw `.optional()` properties were rejected
before inference in the captured 0.157.1 probes. The default compat encoding handles `.optional()`
and the other shapes above; use strict mode only with native Codex schemas. An explicit mode is part
of identity; keep it stable for terminal-step replay. Claude requires an object root and receives
the original JSON Schema. Other Codex restrictions and compatibility transforms do not apply to it.

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
observer.

Usage reports top-level `input_tokens` and `output_tokens` when available. The interpretation of
Codex inputs as including cached input is inferred from OpenAI semantics, not verified by a live
cache comparison; it is not comparable with Claude's top-level field. `costUsd` is null and there is
no Codex per-call USD cap. Failed protocol attempts can retain available usage/session metadata in
`steps[id].failedAttempts`, with nulls when absent.

## Diagnosing a failure

Inspect the saved step error and verify authentication with `codex login status`. Protocol reasons
from stdout survive nonzero normal exits; a bare exit error means no usable reason was recovered.
Check the object schema and reproduce with the same flags when needed. Credentials-only repairs can
resume compatible runs.

For limit changes, retry policy, output caps, cancellation, and orphan recovery, use
[agent calls](agent-calls.md) and [operating a run](operating-runs.md). A noisy editing call can hit
the combined output cap after making file changes. Use `skipGitRepoCheck` only for work outside Git.
