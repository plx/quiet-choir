# Claude Code calls

These are quiet-choir's `ClaudeOptions`, not the full Claude Code CLI surface or Claude's native
workflow API. Any agent host can use `ctx.claude`. This plugin does not install Claude Code;
`CliHarness` runs the first `claude` on PATH unless an embedding caller overrides the binary.

## Options and result

Both `ctx.claude.text(id, options)` and `ctx.claude.object(id, { schema, ...options })` return
`{ output, sessionId, usage }`. `output` is text or the locally validated structured value. The
defaults below come from the core's implicit `text` profile; custom harnesses must enforce them.

| Option         | Meaning and CliHarness default                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`       | Required instructions, delivered on stdin without a shell                                                                                 |
| `model`        | Claude model name/alias; omitted means the installed harness default                                                                      |
| `cwd`          | Resolved against the run's working directory; defaults to it. Absolute paths are accepted and are not confined. The directory must exist. |
| `timeoutMs`    | Per-call wall-clock limit, default 300,000 (5 minutes)                                                                                    |
| `tools`        | Built-in tools exposed to the call; default empty                                                                                         |
| `allowedTools` | Narrower permissions; omission copies tools. Declare these gates in a profile                                                             |
| `maxTurns`     | Positive integer, default 10                                                                                                              |
| `maxBudgetUsd` | Positive finite per-call USD limit, default 0.50                                                                                          |

Additional controls:

| Option                               | Meaning                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `effort`                             | `low`, `medium`, `high`, `xhigh`, `max`; omission inherits configuration            |
| `disallowedTools`                    | Denied tool rules, e.g. `Bash(git push:*)`                                          |
| `permissionMode`                     | `dontAsk` (default), `acceptEdits`, or `plan`; bypass is unsupported                |
| `systemPrompt`, `appendSystemPrompt` | Role text supplied through private temporary files                                  |
| `agent`, `agents`                    | Native agent name and definitions with required description/prompt                  |
| `mcpServers`, `strictMcpConfig`      | Server-name mapping and exclusive explicit MCP configuration                        |
| `settings`                           | JSON native settings; typed model/agent/permission/MCP aliases are rejected         |
| `fallbackModel`                      | Model string or nonempty array, passed as a comma-separated chain                   |
| `addDirs`                            | Additional access directories relative to effect cwd                                |
| `extraArgs`                          | Fingerprinted `--flag` or `--flag=value`; owned flags/aliases are rejected          |
| `env`                                | Fingerprinted overlay on inherited environment; keep rotating secrets in the parent |

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

`text` is tool-less (10 turns/$0.50/300s), `readonly` exposes Read/Grep/Glob (25 turns/$2/900s), and
`edit` adds Edit/Write (40 turns/$5/1800s). Workflow defaults apply after the built-in preset;
custom extends ancestors, selected role and call options follow. `tools` implies `allowedTools`; an
explicit allowed list can narrow, e.g. Bash to `Bash(npm test:*)`. Replacing tools re-infers the
allowed list unless explicitly supplied. MCP configuration and settings permissions still apply.

`strictProfiles: true` is the default: declare capability controls in profiles, including
permissions, MCP/settings, native agents, dirs, escape args and environment.
`workflow validate file.ts --json` lists `workflow.capabilities` without executing the body. Every
declared/default write/exec role requires a launch grant, e.g. `--grant fixer`; class grants
`--grant write`, `--grant exec` (includes write), and `--grant all` are also available. Grants
persist on resume; named grants must be renewed if declared capability controls change. The built-in
`edit` can be selected directly but requires a grant before that call. Declaring a role makes
preflight happen before any workflow effects. Unknown/MCP tools conservatively require exec.

Recover with `--resume --run-id r1 --profile scout.maxTurns=60` or
`--profile '*.timeoutMs=1800000'`. The three profile override fields are maxTurns, maxBudgetUsd and
timeoutMs. Rules persist; `--policy-reset` clears both profile and step rules. Existing step
`--policy` rules take precedence. Embedders use
`profileOverrides: [{ profile: 'scout', maxTurns: 60 }]` and `grants: ['fixer']`. Profile
names/limits stay outside identity; resolved semantic fields stay inside. Cap failures include
configured limit, role, reported turns/cost and the recovery flag. Permission denials appear in
saved step warnings; `onPermissionDenied: 'fail'` makes them permission-kind failures while
retaining usage. Tool-count warnings and idle timeouts await #61/#62; idleTimeoutMs is not
supported.

Use `strictProfiles: false` only to migrate legacy raw capability calls; elevated raw calls require
class/all grants, and the manifest no longer bounds those call-site replacements.

Keep permissions appropriate to the task. quiet-choir exposes no permission-bypass mode. Limits
apply per call, not across the workflow; the run-wide agent admission cap does not impose a total
spending cap.

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

Agent calls accept `retry: { maxAttempts, delayMs?, on? }`; the default remains one attempt. Only
retry calls safe to repeat, since earlier attempts may already have edited files. Fix authentication
externally and resume. Limits (`timeoutMs`, `maxTurns`, `maxBudgetUsd`) and retry policy are
excluded from identity. Raise them with a sticky CLI `--policy` rule or embedded `RunOptions.policy`
without rerunning completed steps; see the
[timeout recovery recipe](durability.md#recovering-a-timeout-or-turn-limit). Completed prompts,
schemas, model, cwd, and capabilities still must match. Embedded callers may redefine unfinished
steps with history retained. CLI source edits require explicit code acceptance or a fork, as
described in [durability](durability.md#choose-a-recovery-path). A model override requires explicit
`--allow-model-override`; it affects unfinished attempts only. `attemptHistory` records resolved
limits, requested model, provenance, timestamps, and outcome.

## Configuration and cancellation

The CLI inherits Claude authentication, configuration, hooks, and MCP setup. The call's `cwd`
selects project `.claude/` settings and hooks. `claude -p` skips the trust dialog, so project hooks
can run even in never-trusted directories. Disabling built-in tools does not isolate this
configuration. Explicit MCP controls are available; hermetic isolation remains deferred to
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

Use `onError: 'return'` to persist final failures before branching to a fallback. Cancellation still
rejects; replay never retries a saved `settled-failed` outcome. `retry.on` filters structured error
categories. See [failure handling](workflow-authoring.md#failure-handling).
