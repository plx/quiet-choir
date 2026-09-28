# Agent calls

Use `ctx.claude` or `ctx.codex` from any agent host. `value(id, options)` returns just the answer:
text without `schema`, or a locally validated value with `schema`. `text` and `object` return
`{ output, sessionId, usage, diagnostics }`. All three checkpoint the same full result and effect
identity. Use `onError: 'return'` for a durable `Settled` outcome; cancellation, checkpoint, and
pre-launch configuration failures still reject. See
[failure handling](workflow-authoring.md#failure-handling).

## Shared options and enforcement

These are quiet-choir options. The core resolves profile defaults and validates requests;
`CliHarness` translates them to native flags and enforces process limits. A custom harness must
honor the resolved request itself. Native binaries/configuration still determine model support.

| Option                   | Claude                          | Codex                                   | Default                                      | Enforced by                                                    |
| ------------------------ | ------------------------------- | --------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| `prompt`                 | stdin                           | stdin                                   | Required                                     | Core validates; adapter supplies without a shell               |
| `schema`                 | Object root                     | Compat accepts common Zod shapes        | No schema for text                           | Core validates output; provider adapter prepares wire schema   |
| `profile`                | Declared role/preset            | Same                                    | Workflow default, otherwise `text`           | Core resolves capabilities and grants                          |
| `model`                  | Name/alias                      | Name/alias                              | Inherited native model                       | Adapter passes; native CLI selects                             |
| `effort`                 | low/medium/high/xhigh/max       | Same; cannot also set `reasoningEffort` | Inherited                                    | Core validates; native CLI applies                             |
| `cwd`                    | Relative to run cwd or absolute | Same                                    | Run cwd                                      | Core resolves absolute path; adapter must use `request.cwd`    |
| `timeoutMs`              | Wall-clock                      | Wall-clock                              | Text 300,000 ms                              | Profile supplies; adapter times and terminates                 |
| `maxTurns`               | Positive integer                | Unsupported                             | Text 10                                      | Profile supplies; Claude enforces                              |
| `maxBudgetUsd`           | Positive finite USD             | Unsupported                             | Text $0.50                                   | Profile supplies; Claude enforces                              |
| `tools` / `allowedTools` | Exposed / permitted tools       | Unsupported                             | Text empty; allowed copies tools             | Core grants; Claude enforces                                   |
| `sandbox`                | Unsupported                     | read-only/workspace-write               | read-only                                    | Core grants; Codex enforces                                    |
| `addDirs`                | Extra access directories        | Extra writable directories              | None                                         | Core resolves/grants; native CLI enforces                      |
| `extraArgs`              | `--flag` or `--flag=value`      | Same                                    | None                                         | Adapter rejects owned flags/aliases; core fingerprints strings |
| `env`                    | Environment overlay             | Same                                    | Inherit parent environment                   | Adapter overlays; core fingerprints explicit values            |
| `retry`                  | Safe-to-repeat calls only       | Same                                    | One attempt; opted-in delay starts at 100 ms | Core owns retry, removes it from adapter request               |
| `onError`                | throw/return                    | Same                                    | throw                                        | Core journals final outcomes                                   |

See [Claude controls/protocol](claude.md) and [Codex controls/protocol](codex.md) for
native-specific fields. Keep rotating secrets in the inherited environment; explicit `env` values
affect replay. Escape-argument paths fingerprint their strings, not file contents.

## Select a role and grant its capabilities

`text` is tool-less for Claude and read-only for Codex (300s, 10 Claude turns, $0.50). `readonly`
exposes Claude Read/Grep/Glob and Codex read-only (900s, 25 turns, $2). `edit` adds Claude
Edit/Write and Codex workspace-write (1800s, 40 turns, $5). Codex text still has read access; Claude
turn/USD limits do not apply to Codex.

Merge order is built-in preset, workflow defaults, custom ancestors, selected role, then call
options. Replacing Claude tools re-infers allowedTools unless supplied explicitly. Under default
`strictProfiles: true`, declare capability controls in profiles, including permissions, MCP, native
config/agents, dirs, escape args, and environment. `workflow validate FILE --json` lists resolved
`workflow.capabilities` without running the body. Unknown tools/native config controls
conservatively require exec capability. Configuration loading defaults to restricted mode;
[harness isolation](harness-isolation.md) explains inherited roles, environment edits, and provider
boundaries.

Every declared/default write or exec role needs a launch grant: `--grant fixer`, `--grant write`,
`--grant exec` (includes write), or `--grant all`. Declared roles preflight before effects;
selecting built-in `edit` directly needs a grant before that call. Grants persist on resume. Named
grants pin capability declarations and must be renewed if those change. Use `strictProfiles: false`
only for a legacy migration; elevated raw calls still need class/all grants.

Raise execution limits without source edits using `--resume --run-id ID --profile scout.maxTurns=60`
or `--profile '*.timeoutMs=1800000'`. Profile override fields are maxTurns, maxBudgetUsd, timeoutMs.
Rules persist; `--policy-reset` clears profile and step rules. Matching step `--policy` rules win.
Embedders use `profileOverrides` and `grants` in `RunOptions`. Permission denials are warnings
unless `onPermissionDenied: 'fail'` makes them permission-kind failures while retaining usage.
Tool-count warnings and idle timeouts remain proposals (#61/#62); `idleTimeoutMs` is unsupported.

## Replay, retry, and usage

Prompts, schemas, resolved models/effort, cwd, and capabilities must match completed effects.
Profile names, execution limits, retry policy, and run concurrency stay outside identity.
`attemptHistory` records resolved limits, provenance, requested model/effort (or inherited), timing,
and outcome. Model/effort policy replacements require `--allow-model-override` and affect unfinished
attempts only. Source edits require [acceptance or a fork](durability.md#choose-a-recovery-path).
Default retry is one attempt; an explicit `retry.on` filters error categories. Earlier attempts may
already have mutated files. A saved `settled-failed` outcome replays without retrying.

Each native effect creates a fresh session. Its `sessionId` is diagnostic, not a workflow resume
token. Pass earlier answers explicitly in later prompts. `HarnessRequest.call` supplies `runId`,
full `stepId`, cumulative `attempt`, and stable `idempotencyKey` (`runId/stepId`) outside identity.
Native CLIs do not use that key to deduplicate edits.

Unknown usage and native IDs are `null`. Success stores usage with the full result; failed protocol
attempts can save available usage/session metadata in `failedAttempts`. Attempt histories also
retain response usage when local schema validation fails. Dashboard totals exclude copied fork
history and mark incomplete coverage. Replay is not a new charge. Provider token counters differ;
read their references before comparing them. Missing/abandoned work makes this an incomplete
spending ledger, and per-call limits do not impose a run-wide spend cap.

## Process lifecycle

`CliHarness` independently caps retained protocol state/lines at 8 MiB, combined raw output at 1
GiB, and private attempt transcripts at 64 MiB. CLI flags `--max-retained-bytes`,
`--max-stream-bytes`, `--max-transcript-bytes`, and `--transcripts` are sticky execution policy.
`maxOutputBytes` is now a legacy alias for agent retention, not the whole trace. See
[streaming and attempt evidence](agent-streaming.md). The per-call timeout starts on agent
admission, not while queued. `--max-agents` and `--provider-limit` share slots across nested maps;
each map's mapper concurrency remains a separate local limit.

Every leader exit reaps owned process groups on macOS/Linux; Windows cleanup reaches the immediate
child only. First SIGINT/SIGTERM/SIGHUP cancels, drains, and exits 130. A second signal force-kills
tracked groups; SIGKILL/crashes can leave survivors and older checkpoints. Default TERM-to-KILL
grace is 3000 ms (`--kill-grace-ms`). Use the
[ownership/recovery procedure](operating-runs.md#stalls-and-orphan-recovery) before replacement
work. Unknown identities are never signaled. Escaped groups and the spawn-to-record crash gap
require separate investigation; stopped calls may already have edited files.

## Usage and run caps

Current native usage includes token categories, requested/effective model evidence and raw usage.
Use [usage and budgets](usage-budgets.md) to interpret nulls, count failures once, inspect totals,
and set sticky run-wide cost/attempt gates. These are operator stops outside effect identity;
per-call retries or settled error handling cannot bypass a latched run gate.

## Child profile delegation

Inline child roles map to parent roles of the same name, or `ctx.workflow` options map them
explicitly. Missing/insufficient grants fail before child effects. Child tool exposure cannot grow;
mapped parent model/effort defaults and limit overrides pass down, and limits are bounded by the
parent. A parent `onPermissionDenied: 'fail'` passes down too; a child cannot weaken it to `warn`.
Root concurrency and budgets span every frame. See [child workflows](child-workflows.md).
