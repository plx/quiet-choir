# Restricted harness calls

Agent calls default to `isolation: 'restricted'`. The runtime resolves this mode before computing
the effect fingerprint. Set it on a call, a workflow's `defaults`, a named profile, or the
provider-specific `claude`/`codex` options. Explicit `inherit` loads native configuration and is
classified as exec capability: declare it in a profile and grant that role, or use raw controls with
`strictProfiles: false` and an exec grant. Narrowing a call to `restricted` is allowed.

Configuration mode and Git checkout selection are separate. `worktree: true` requests a fresh
checkout; a shared handle or `{ kind: 'worktree', base }` selects other managed checkout behavior.
The existing `isolation: 'worktree'`/handle shorthand still works and preserves the configuration
mode from the selected profile. For example, a trusted inherited role can also use `worktree: true`.
See [worktree isolation](worktrees.md).

## Native boundary

| Provider | Restricted invocation                 | Remaining dependencies                                                                                                                                                                                                         |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude   | `--restricted --strict-mcp-config`    | Authentication, managed settings/policy, built-ins, and explicit opt-ins                                                                                                                                                       |
| Codex    | `--ignore-user-config --ignore-rules` | Authentication through `CODEX_HOME`, managed/system layers, user `CODEX_HOME/AGENTS.md` or `AGENTS.override.md`, `CODEX_HOME/skills`, project `AGENTS.md`/`AGENTS.override.md` from the Git root to `cwd`, and explicit config |

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
it unless empty), the descriptions of skills under `CODEX_HOME/skills`, and project `AGENTS.md` or
`AGENTS.override.md` in each directory from the nearest Git root down to `cwd` (only `cwd` when no
`.git` entry exists), as well as managed layers. Results can therefore depend on who runs the
workflow. Codex harness metadata records these files as paths and SHA-256 digests
(`HarnessMetadata.instructionSources`, never contents); the run warns once about user-level files
and again if they change on resume, and `workflow doctor` names them. Detection runs on the first
live Codex call of each run, from that call's `cwd`, so project files reached from other directories
are not re-detected, and inherit-mode config keys such as `project_doc_max_bytes` are not modelled.
Removing these files is a possible opt-in mode, tracked in issue #130.

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
Keep rotating secrets in the inherited environment.

Both modes scrub `CLAUDECODE`, Claude child/session/entrypoint/attended/messaging/executable
variables, `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`, `TRACEPARENT`, and the experimental
agent-teams toggle. Codex thread/session/turn IDs and its internal originator override are also
removed. Native authentication variables and config-home paths remain available.
`CliHarnessOptions.scrubEnv` extends the list with an array, or explicitly disables it with `false`;
`--harness-config` accepts the same option.

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

`npm run test:contract:isolation` after a build is an opt-in local fake-API regression for installed
Claude 2.1.283 and Codex 0.157.1. It uses fresh homes and dummy keys. It confirms hook and
project-instruction suppression, explicit settings/MCP/plugin/prompt/tool opt-ins, outside-read
denial and `addDirs` restoration, protected settings-write denial, and Codex's explicit provider
override. For restricted Codex it also records, without asserting, whether canaries in a user
`AGENTS.md`, a user skill description and a project `AGENTS.md` reach the request body
(`userInstructionsReachedRequest`, `projectInstructionsReachedRequest` and
`userSkillReachedRequest`, all true on 0.157.1), how `AGENTS.override.md` replaces `AGENTS.md`, that
discovery runs from the Git root down to `cwd`, and that an empty user-level override falls back to
`AGENTS.md` while an empty project-level one does not. A change in Codex then shows as a fixture
diff. No upstream inference occurs. The sanitized report is in
[`test/fixtures/harness-isolation-results.json`](../test/fixtures/harness-isolation-results.json).

Earlier zero-cost OAuth probes on the same Claude version reached invalid-model responses with
`apiKeySource: none`, no tools/MCP/hooks or memory field, and zero usage/cost. That evidence
supports retaining subscription authentication; it is not a successful inference test or a fresh
account availability check. Managed policy and future CLI versions can change the effective
boundary.
