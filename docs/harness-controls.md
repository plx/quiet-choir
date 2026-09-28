# Harness controls and contract checks

Both providers accept `effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'`. Claude maps this to
`--effort`; Codex maps it to `model_reasoning_effort`. Codex also accepts
`reasoningEffort: 'none' | 'minimal' | Effort`. Set one effort field, never both, including across
profile defaults and call options. Omission uses native defaults under the selected configuration
mode. Accepted enum values do not guarantee support for every model. Each attempt records
`requested.model` and `requested.effort`, using `"inherited"` for omissions.

## Typed controls

| Provider | Controls                                                                                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both     | `isolation`, `worktree`, `effort`, `addDirs`, `extraArgs`, `env`, alongside existing prompt/model/cwd/deadline                                                                                           |
| Claude   | `disallowedTools`, `permissionMode` (`dontAsk`, `acceptEdits`, `plan`), `systemPrompt`, `appendSystemPrompt`, `agent`, `agents`, `mcpServers`, `strictMcpConfig`, `settings`, `plugins`, `fallbackModel` |
| Codex    | `reasoningEffort`, `networkAccess`, `harnessProfile`, `config`, `images`                                                                                                                                 |

`profile` always selects a quiet-choir role. `harnessProfile` selects Codex's native configuration
profile (`--profile`). Native profile names contain letters, numbers, underscores or hyphens and
start with a letter or number. `networkAccess` requires `workspace-write`, even when false.
`addDirs` resolves against the effect's cwd; Codex makes those directories **writable**.

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
a digest. Keep rotating secrets in the parent environment. Configuration defaults to `restricted`;
`inherit` is an explicit exec-capability opt-out. See [harness isolation](harness-isolation.md) for
provider boundaries, native authentication, protected writes, and verified opt-ins.

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

## Configuration doctor

```sh
quiet-choir configuration doctor --json
quiet-choir configuration doctor --harness codex --codex-home /path/to/.codex --codex-profile review
```

The exported `probeHarnessContracts(options)` runs the same checks for CI. It returns five checks
per requested provider: tested version, exact adapter argv, hidden/plumbing flags, enum drift and
inherited defaults. `testedHarnessVersions` currently certifies only Claude 2.1.283 and Codex
0.157.1, the captured versions; new versions must be verified before widening the bounds.

Exact-argv probes use a nonexistent Claude model (404, zero cost) or an invalid Codex effort (400
with the enum list). They exercise all applicable typed flags through the production argument
builder, with representative permission/effort choices. Codex's probe layers an empty native profile
over temporary private copies of user config/auth files, selects the inspected model (or `gpt-5`
when omitted), and removes those copies afterward. It does not modify user profile files. It reads
selected native or legacy profile defaults separately. Project/managed layers can still change
actual defaults; this inspection is not an effective-config resolver.

The doctor skips exact-argv probes on untested versions or version warnings. Authentication,
transport, unknown flags, any stderr warning, nonzero reported tokens/cost, or an unexpected
response fail the check. No ordinary agent task is used. `zeroInference` means every attempted
exact-argv probe proved a pre-inference rejection; a skipped probe is not a passing check. `--json`
emits the report on pass or drift, with exit 0 or 1 respectively. Configuration get/set remain
stubs. Executable overrides are available as `--claude-binary` and `--codex-binary`.

`CliHarness` also reads `--version` on each provider's first live use in a run invocation. Saved
`harnesses` record binary/version, and inspect shows them. Discovery failures and version changes on
resume are warnings, not identity changes. Completed-only replay does not launch version probes.
Custom harnesses can implement optional `metadata(request, invocation)`; the invocation supplies the
run's discovery signal and process-registration port. Older records remain readable. Discovery is
shared by the run: an aborted map scope stops waiting for it, and the run aborts `invocation.signal`
and awaits it before releasing ownership when no effect still needs the result. See
[process lifecycle](process-lifecycle.md) for adapter migration and orphan recovery.

Doctor probes use the same first/second SIGINT, SIGTERM and SIGHUP cleanup as workflow execution,
but have only in-memory ownership because no resumable workflow run exists.
