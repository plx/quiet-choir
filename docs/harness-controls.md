# Harness controls and contract checks

Both providers accept `effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'`. Claude maps this to
`--effort`; Codex maps it to `model_reasoning_effort`. Codex also accepts
`reasoningEffort: 'none' | 'minimal' | Effort`. Set one effort field, never both, including across
profile defaults and call options. Omission uses native defaults under the selected configuration
mode. Accepted enum values do not guarantee support for every model. Each attempt records
`requested.model` and `requested.effort`, using `"inherited"` for omissions.

## Typed controls

| Provider | Controls                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Both     | `isolation`, `worktree`, `effort`, `addDirs`, `extraArgs`, `env`, alongside existing prompt/model/cwd/deadline                                                                                                                 |
| Claude   | `disallowedTools`, `permissionMode` (`dontAsk`, `acceptEdits`, `plan`), `systemPrompt`, `appendSystemPrompt`, `agent`, `agents`, `mcpServers`, `strictMcpConfig`, `settings`, `plugins`, `fallbackModel`, `onPermissionDenied` |
| Codex    | `reasoningEffort`, `networkAccess`, `harnessProfile`, `config`, `images`, `instructions`                                                                                                                                       |

`profile` always selects a quiet-choir role. `harnessProfile` selects Codex's native configuration
profile (`--profile`). Native profile names contain letters, numbers, underscores or hyphens and
start with a letter or number. `networkAccess` requires `workspace-write`, even when false.
`addDirs` resolves against the effect's cwd; Codex makes those directories **writable**. Codex
`instructions: 'none'` runs the child against a private temporary `CODEX_HOME` holding only a copy
of `auth.json`, adds `--config project_doc_max_bytes=0`, and writes a refreshed `auth.json` back
under a lock; it requires restricted isolation and owns the `project_doc_max_bytes` config key. It
removes context and grants nothing, so it is not a capability control. See
[harness isolation](harness-isolation.md).

Declare capability controls in [agent profiles](agent-profiles.md), including tools, permissions,
MCP/settings, native agents/profiles/config, additional directories, environment and escape args.
Default `strictProfiles` rejects those fields at call sites. Role prompts, models, effort, fallbacks
and image attachments can be supplied per call. Native configuration/agent/escape/env controls and
enabled network access conservatively require an **exec** grant. Codex additional writable
directories require write access; Claude directories alone grant no tools. Named grants pin these
declared controls and require renewal when they change.

```ts
// Fields on defineWorkflow:
profiles: {
  reviewer: {
    extends: 'readonly',
    claude: {
      appendSystemPrompt: 'Review for correctness. Explain evidence.',
      effort: 'high',
      disallowedTools: ['Bash(git push:*)'],
    },
  },
},
// Inside run:
await ctx.claude.text('review', { profile: 'reviewer', prompt: 'Review src/index.ts.' });
```

`agents` is a record of native Claude agent definitions, each with required `description` and
`prompt` strings and optional JSON fields. `mcpServers` is the server-name mapping, without the
outer `mcpServers` wrapper. `settings` accepts native JSON settings except aliases of typed model,
agent, permission and MCP controls. Bypass modes are rejected. `fallbackModel` accepts one model or
a nonempty array, serialized as the native comma-separated fallback chain. Fallback changes are
semantic, not raisable limit policy.

Task prompts use stdin. Claude role prompts, agent definitions, MCP and settings use private 0600
files under a private temporary directory, removed after success, failure, timeout or cancellation.
Codex schemas and image snapshots use the same lifetime. Process arguments contain paths, not these
values. Claude's JSON Schema flag has no file variant and remains inline.

## Escape args, environment and identity

`extraArgs` accepts only `--flag` and `--flag=value`. Use attached values; positional arguments,
subcommands and short flags are rejected. A denylist rejects output/session/cwd/bypass plumbing and
every typed flag, including equals, short aliases/clusters and kebab spellings. Errors name the
owning option. Codex args precede `-- -`, which protects its stdin marker from variadic image
arguments. There is no harness-wide default-args escape hatch.

Codex `config` maps unquoted dotted keys to JSON values rendered as TOML literals. Nested objects,
arrays, booleans, numbers and strings work; `null` does not. Owned config keys (and their parent or
child tables) are rejected: approval policy, sandbox, model, effort, writable roots, network access
and native profile selection belong to typed controls.

`env` accepts `{ set, unset }` edits after host-session scrubbing; the original flat set-only
overlay also works. Explicit edits are fingerprinted, while saved diagnostics retain only names and
a digest. Keep rotating secrets in the parent environment.

Public manifests (the checkpoint's `capabilities`, `workflow validate --json` and the record
`check-resume` prints) reduce every free-form native control to a digest. Claude `settings`,
`mcpServers`, `agents` (descriptions and prompts), `systemPrompt`, `appendSystemPrompt` and Codex
`config` are removed from the profile's `claude`/`codex` and listed under `redacted` as
`{ sha256, keys? }`: `keys` are the top-level settings keys, MCP server names, subagent names or
dotted config keys, and the two prompts have only `sha256`. A profile that sets none of them has no
`redacted` member. Live calls, grant pins and step identity still use the raw values, so a changed
value invalidates a pin or a completed step even though the manifest shows only a new digest.
Reviewable controls stay plaintext: tools, permission mode, `agent`, plugins, `addDirs`,
`extraArgs`, models, limits, isolation and sandbox. Never put secret values in `extraArgs`; use
`env`. A digest of a short value can be confirmed by guessing. Checkpoints written before this
change keep what they saved until the run next executes, which rewrites them. Prompts and previews
in step records are plaintext state, outside the manifest. See
[ADR 0033](decisions/0033-redact-free-form-controls-from-public-manifests.md). Configuration
defaults to `restricted`; `inherit` is an explicit exec-capability opt-out. See
[harness isolation](harness-isolation.md) for provider boundaries, native authentication, protected
writes, and verified opt-ins.

All new semantic controls participate in completed-step identity. Images use **file contents**, not
paths: the runtime snapshots bytes before fingerprinting and passes those exact bytes to the
adapter, so a later file edit cannot change the attached image. Renaming an unchanged image can
replay; changing its contents cannot. `extraArgs` fingerprints literal strings only, so a path
inside an escape arg does not fingerprint its target. Native profile/config dependencies and the
parent environment are likewise external to identity; explicit `config` values are fingerprinted.
Custom harnesses must honor `HarnessRequest.imageAttachments` rather than reopening source paths.
Attached images must be regular files that are still readable when a run resumes, because their
bytes are re-hashed for step identity; a missing, unreadable, or non-regular image (such as a FIFO)
fails that step and names it by id; the step's other image reads are cancelled first. Run
interruption cancels a pending snapshot as ordinary cancellation. Either way, an open, stat, or read
stuck on a stalled mount is abandoned rather than awaited, and its handle is closed in the
background if the operation ever returns.

## Idle deadline and tool-use diagnostics

`idleTimeoutMs` ends an agent attempt whose CLI writes nothing to stdout or stderr for that many
milliseconds. It is off by default. Set it like `timeoutMs`: in workflow `defaults`, on a profile,
on a call, with `--profile name.idleTimeoutMs=N` (`RunOptions.profileOverrides`), or with an agent
`--policy` rule (later sources win in the same order as `timeoutMs`; `kind: 'step'` and `'exec'`
rules reject it). It is execution policy, never step identity, so a resume can raise it without a
code change; child workflows inherit the parent's value as a ceiling. The attempt records the
effective value and its source in `attemptHistory[].policy` and `sources`, and `inspect` shows it as
`idle timeout`.

The process layer enforces it. The timer starts once the prompt is written to stdin (after durable
process registration; CLI startup counts as idle time) and restarts on every output chunk, so a call
that keeps streaming is never ended by it, however long it runs. While quiet-choir's own transcript
or parser still holds a chunk, that backpressure is not counted. On expiry the group receives
SIGTERM, then SIGKILL after the cleanup grace, as for `timeoutMs`
([process lifecycle](process-lifecycle.md#deadlines-and-cleanup)). The failure has kind
`idle-timeout`, distinct from `timeout`, and its message suggests
`--resume --profile <role>.idleTimeoutMs=<double>`. `retry.on: ['idle-timeout']` retries only
stalls, and `'transient'` includes them. Size the deadline above the longest silent stretch: a long
command under Codex, a quiet tool, or long silent reasoning ends the same way on every retry, so a
too-small deadline turns `'transient'` retries into repeated failures.

Each attempt's `diagnostics.toolUses` counts tool calls from the parsed stream (not from the lossy
progress events): Claude assistant `tool_use` blocks by ID, without the `StructuredOutput` tool that
carries structured output, and distinct Codex `command_execution`, `file_change`, `mcp_tool_call`
and `web_search` items. When the profile's `expectsToolUse` is true and a completed attempt reports
`toolUses: 0`, the step records a `no-tool-use` warning, which the completed `agent.finished` event
carries in `warnings` and the CLI logs at warn level ([agent profiles](agent-profiles.md)). The
warning never fails the attempt.

Custom adapters own both features. A `HarnessRequest` carries the resolved `idleTimeoutMs` in its
options when the adapter's option schema has that key (`defineHarness` adds it); pass it to
`runProcess` from `harness-kit` to get the same enforcement, and throw an error with code
`QUIET_CHOIR_IDLE_TIMEOUT` (or a `HarnessError` of kind `idle-timeout`) for a stall detected another
way. Report `toolUses` in the response diagnostics to enable the warning; without it the count is
unknown and nothing warns. See
[ADR 0042](decisions/0042-idle-deadlines-and-tool-use-diagnostics.md).

## Configuration doctor

```sh
quiet-choir configuration doctor --json
quiet-choir configuration doctor --harness codex --codex-home /path/to/.codex --codex-profile review
```

The exported `probeHarnessContracts(options)` runs the same checks for CI. It returns five checks
per requested provider: tested version, exact adapter argv, hidden/plumbing flags, enum drift and
inherited defaults. `testedHarnessVersions` is the contract-tested range, currently Claude 2.1.283
and Codex 0.157.1 (minimum and maximum are inclusive and may differ).

The version check grades what `--version` reports. Inside the range is `PASS`. Outside it but on the
same major.minor as a bound (an untested patch such as 2.1.285) is `WARN`. Another major.minor, an
unparseable or prerelease/build-suffixed version, a nonzero exit and process or stderr warnings are
`FAIL`. Each check has `status` `pass`, `warn` or `fail` (`ok` is `status !== 'fail'`); only the
version check can warn. See
[ADR 0040](decisions/0040-grade-harness-versions-against-a-tested-range.md).

Exact-argv probes use a nonexistent Claude model (404, zero cost) or an invalid Codex effort (400
with the enum list). They exercise all applicable typed flags through the production argument
builder, with representative permission/effort choices. Codex's probe layers an empty native profile
over temporary private copies of user config/auth files, selects the inspected model (or `gpt-5`
when omitted), and removes those copies afterward. It does not modify user profile files. It reads
selected native or legacy profile defaults separately. Project/managed layers can still change
actual defaults; this inspection is not an effective-config resolver.

The exact-argv probe runs whenever the binary answered `--version`, whatever the version grade, and
is reported independently of it. Authentication, transport, unknown flags, any stderr warning,
nonzero reported tokens/cost, or an unexpected response fail the check. No ordinary agent task is
used. `zeroInference` means every attempted exact-argv probe proved a pre-inference rejection; a
probe skipped because the binary never answered `--version` is not a passing check.

Text output ends with a verdict line: `ok`; `usable with warnings: ...` naming the untested version
and the next step; or `blocked: ...`. `--json` adds `verdict` (`ok`, `usable-with-warnings` or
`blocked`) and `warnings` (one `<harness> <check>: <message>` per warning) to the report, and `ok`
is `verdict !== 'blocked'`. The exit code is 1 only when the verdict is `blocked`, so a warning
exits 0. `--strict` (`DoctorOptions.strict`) turns an untested patch version into a failure, so
scripts that want the old behavior exit 1. Configuration get/set remain stubs. Executable overrides
are available as `--claude-binary` and `--codex-binary`.

Probing an untested CLI carries a small cost risk. The Claude probe caps spend with
`maxBudgetUsd: 0.01` and a nonexistent model. The Codex probe sends `model_reasoning_effort="bogus"`
with no cost cap, and `zeroInference` is judged after the call, so a CLI that stopped rejecting bad
input could run one tiny inference before the doctor notices.

To widen the range after a CLI update, run `npm run build && npm run test:contract` from a
quiet-choir checkout, review the captures, then raise `testedHarnessVersions` `maximum` (or lower
`minimum`) in `src/harnesses/tested-versions.ts`.

`CliHarness` also reads `--version` on each provider's first live use in a run invocation. Saved
`harnesses` record binary/version, and inspect shows them. Discovery failures and version changes on
resume are warnings, not identity changes. So is a discovered version outside the tested range: the
run records one `harnessWarnings` entry naming `quiet-choir configuration doctor --harness <name>`,
once per run. Completed-only replay does not launch version probes. Custom harnesses can implement
optional `metadata(request, invocation)`; the invocation supplies the run's discovery signal and
process-registration port. Older records remain readable. Discovery is shared by the run: an aborted
map scope stops waiting for it, and the run aborts `invocation.signal` and awaits it before
releasing ownership when no effect still needs the result. See
[process lifecycle](process-lifecycle.md) for adapter migration and orphan recovery.

Doctor probes use the same first/second SIGINT, SIGTERM and SIGHUP cleanup as workflow execution,
but have only in-memory ownership because no resumable workflow run exists.

Native calls now stream bounded progress and retain private attempt evidence; see
[streaming controls](agent-streaming.md) for CLI caps, retention, and permission-denial behavior.
