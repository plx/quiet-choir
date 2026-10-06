# Restricted harness calls

Agent calls default to `isolation: 'restricted'`. The runtime resolves this mode before computing
the effect fingerprint. Set it on a call, a workflow's `defaults`, a named profile, or the
provider-specific `claude`/`codex` options. Explicit `inherit` loads native configuration and is
classified as exec capability: declare it in a profile and grant that role, or use raw controls with
`strictProfiles: false` and an exec grant. Narrowing a call to `restricted` is allowed.

Configuration mode and Git checkout selection are separate: `isolation` is only the configuration
mode (`'restricted' | 'inherit'`), and `worktree` is the only checkout selector. `worktree: true`
requests a fresh checkout per attempt, `worktree: { base }` pins another ref or commit for it, and a
shared `ctx.worktree` handle serializes the call on that checkout. Checkout selection keeps the
configuration mode from the selected profile; for example, a trusted inherited role can also use
`worktree: true`. See [worktree isolation](worktrees.md).

## Native boundary

| Provider | Restricted invocation                 | Remaining dependencies                                                                                                                                                                                                                                                                                                                                      |
| -------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | `--restricted --strict-mcp-config`    | Authentication, managed settings/policy, built-ins, and explicit opt-ins                                                                                                                                                                                                                                                                                    |
| Codex    | `--ignore-user-config --ignore-rules` | Authentication through `CODEX_HOME`, managed/system layers, user `CODEX_HOME/AGENTS.md` or `AGENTS.override.md`, `CODEX_HOME/skills`, project `AGENTS.md`/`AGENTS.override.md` from the Git root to `cwd`, and explicit config. With `instructions: 'none'`: authentication (a private copy of `auth.json`), managed/system layers and explicit config only |

Claude suppresses user/project/local settings, their hooks, discovered MCP servers, project
instructions, user plugins/skills, and auto-memory. Built-in components can remain. Explicit
`mcpServers`, `settings`, `plugins`, `agents`, `systemPrompt`, and `appendSystemPrompt` opt content
back in. `strictMcpConfig: false` is rejected under restricted mode. Plugin paths are fingerprinted;
their changing filesystem contents are not snapshotted. Settings and MCP configuration are trusted
code/configuration, not inert descriptions.

Claude's file tools are confined to the working directories, including `addDirs`. Naming `Bash` in
`tools` makes it available again; this does not confine arbitrary shell commands. Writes to
protected settings, Git, and tool-configuration files require a human or permission handler;
`dontAsk` does not supply one. A writer may therefore need a different task design. Runtime-owned
worktree snapshotting runs outside the agent and does not require the agent to commit.

`inherit` is an explicit trust decision. `cwd` selects project `.claude`/`.codex` inputs. Headless
Claude skips the workspace trust dialog and can execute project hooks in never-trusted directories.
Do not point inherited calls at untrusted checkouts. `tools: []` alone does not suppress inherited
MCP or hooks. Custom providers normally stored in `config.toml` need explicit `config` or an
inherited role. `harnessProfile` selects a native profile from the same skipped `config.toml`, so
restricted mode rejects it; select `inherit` or configure the equivalent settings through `config`.

Codex instruction boundary. Unlike restricted Claude, restricted Codex still loads instruction
files. `--ignore-user-config` skips `config.toml` and `--ignore-rules` skips execpolicy rules, but
Codex 0.157.1 still reads the user's `CODEX_HOME/AGENTS.md` (or `AGENTS.override.md`, which replaces
it unless empty or whitespace-only; blank files contribute nothing), the descriptions of skills
under `CODEX_HOME/skills`, and project `AGENTS.md` or `AGENTS.override.md` in each directory from
the nearest Git root down to `cwd` (only `cwd` when no `.git` entry exists), as well as managed
layers. Results can therefore depend on who runs the workflow. Codex harness metadata records these
files as paths and SHA-256 digests (`HarnessMetadata.instructionSources`, never contents); the run
warns once about user-level files and again if they change on resume, and `workflow doctor` names
them. Detection runs on the first live Codex call of each run, from that call's `cwd`, so project
files reached from other directories are not re-detected, and inherit-mode config keys such as
`project_doc_max_bytes` are not modelled.

Set Codex `instructions: 'none'` (on a call, a profile's `codex` options or `defaults.codex`) to run
without these files. The adapter adds `--config project_doc_max_bytes=0`, which stops project
`AGENTS.md` loading, and runs the child against a private temporary `CODEX_HOME` holding only a 0600
copy of the real `auth.json`, removed after every outcome. A token refreshed during the call is
written back to the real `auth.json` atomically under a lock, and only if the real file is
unchanged; when another process changed it meanwhile, the later `last_refresh` wins and the call
warns (paths, never contents). The trade-off: results stop depending on who runs the workflow, but
calls lose guidance users may expect from their own or the project's `AGENTS.md`, skills and
memories. Supply instructions deliberately through the prompt or explicit `config` such as
`developer_instructions`. `'none'` requires restricted isolation and is rejected with `inherit`,
whose `config.toml` can carry instructions of its own; it also owns the `project_doc_max_bytes`
config key. Custom providers still need explicit `config`. It grants nothing, so call sites may set
it under `strictProfiles`. `'none'` enters step identity; `'native'` (the default) and unset
fingerprint identically. Steps record `request.instructions`, inspect shows
`no native instructions`, and dry-run plans show `codexHome: 'private'`. The restricted default is
unchanged; making `'none'` the default is a separate decision. The lock covers quiet-choir processes
sharing a temporary directory, not a concurrent plain `codex` run, and keyring-stored credentials
are not copied.

Neither mode confines the workflow's TypeScript, local callbacks, or `ctx.exec`. OS sandbox
selection and tool grants remain separate controls. Custom harnesses must enforce the resolved mode
themselves. The native contracts are documented in the
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference),
[Codex non-interactive guide](https://learn.chatgpt.com/docs/non-interactive-mode), and
[Codex configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic).

## Environment and diagnostics

Use `env: { set: { NAME: 'stable-value' }, unset: ['REMOVE_ME'] }`. Existing flat set-only overlays
remain supported. Edits are applied after host-session scrubbing; explicit `set` can intentionally
restore a scrubbed name. A name cannot be both set and unset; `__proto__` assignments are rejected
before parsing. `QUIET_CHOIR_RUN_ID`, `QUIET_CHOIR_STEP_ID`, `QUIET_CHOIR_ATTEMPT`, and
`QUIET_CHOIR_IDEMPOTENCY_KEY` are reserved for engine call metadata. Normalized edits enter
identity; diagnostics and saved capability manifests contain only their names and SHA-256 digest.
Settings, MCP servers, agents, system prompts and Codex config are likewise reduced to digests and
names. Keep rotating secrets in the inherited environment.

Both modes scrub host agent-session variables by pattern: `CLAUDECODE`, `CLAUDE_PID`,
`CLAUDE_EFFORT`, `AI_AGENT`, `TRACEPARENT`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_TURN_ID`,
and every `CLAUDE_PLUGIN_*`, `CODEX_INTERNAL_*`, `CODEX_COMPANION_*` and `CLAUDE_CODE_*` name. Four
`CLAUDE_CODE_*` forms select authentication or behavior and are kept: `CLAUDE_CODE_USE_*`,
`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_CODE_SUBAGENT_MODEL`. Native
authentication variables (`ANTHROPIC_*`, `OPENAI_*`, `CODEX_API_KEY`) and config-home paths
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) remain available. Other host `CLAUDE_CODE_*` settings, such as
`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, are removed too; restore one deliberately with `env.set`.
`CliHarnessOptions.scrubEnv` adds exact names with an array, or explicitly disables scrubbing with
`false`; `--harness-config` accepts the same option. Custom adapters get the same scrub from
`childEnvironment` in `quiet-choir/harness-kit`.

Harness metadata records observed names for `ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_CODE_USE_*`, Claude
effort/subagent-model/OAuth/config-home variables, `MAX_THINKING_TOKENS`, `CODEX_HOME`, and
`CODEX_API_KEY`. It also records names actually removed by scrubbing. Resume warns if these name
sets change on the first live call; credential rotation under the same name is not fingerprinted.
Completed-only replay does not probe the environment. Values may still appear if workflow code or an
agent deliberately returns or logs them; old checkpoints are not retroactively scrubbed.

Changing the resolved mode is a semantic change, not a raisable execution policy. Runs from before
this default was introduced have incompatible completed agent fingerprints, including original
format-one migrations. Start a new run or explicitly invalidate affected work in a fork; accepting
source edits does not bypass completed effect checks. The runtime never silently falls back to
inherited mode if a CLI rejects the flags.

## Verified native behavior

Claude 2.1.283 and Codex 0.157.1 were checked using fresh homes, dummy credentials, and local fake
APIs. The tests verified inherited hook suppression, explicit opt-ins, file boundaries, and Codex
provider configuration. For restricted Codex they also recorded that user and project `AGENTS.md`
and user skill descriptions reach the request, how `AGENTS.override.md` takes precedence, and that
discovery runs from the Git root down to `cwd`. With `instructions: 'none'` none of them reached the
request and the real `CODEX_HOME` stayed unchanged. Earlier zero-cost invalid-model probes support
retained Claude subscription authentication; they are not successful inference or fresh
account-availability checks. Managed policy and future native versions can change the effective
boundary.
