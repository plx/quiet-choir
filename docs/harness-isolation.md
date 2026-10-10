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

| Provider | Restricted invocation                 | Remaining dependencies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude   | `--restricted --strict-mcp-config`    | Authentication, managed settings/policy, built-ins, and explicit opt-ins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Codex    | `--ignore-user-config --ignore-rules` | Authentication through `CODEX_HOME`, managed/system layers, user `CODEX_HOME/AGENTS.md` or `AGENTS.override.md`, skills under `CODEX_HOME/skills` and `$HOME/.agents/skills`, project `AGENTS.md`/`AGENTS.override.md` and `.agents/skills` from the Git root to `cwd`, skills under `<cwd>/.codex/skills`, and explicit config. With `instructions: 'none'`: authentication (a private copy of `auth.json`), managed/system layers, explicit config, and the `$HOME/.agents/skills`, project `.agents/skills` and `<cwd>/.codex/skills` skill roots, which it does not remove |

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
Codex 0.160.0 still reads the user's `CODEX_HOME/AGENTS.md` (or `AGENTS.override.md`, which replaces
it unless empty or whitespace-only; blank files contribute nothing), the descriptions of skills
under `CODEX_HOME/skills` and `$HOME/.agents/skills`, project `AGENTS.md` or `AGENTS.override.md`
and the skills under `.agents/skills` in each directory from the nearest Git root down to `cwd`
(only `cwd` when no `.git` entry exists), and the skills under `cwd`'s own `.codex/skills` (not
those of its parents), as well as managed layers. A skill is a `SKILL.md` file anywhere up to six
directory levels below a skill root, skipping names that start with a dot, including one nested
inside another skill's directory. Results can therefore depend on who runs the workflow. The run
records these files as paths and SHA-256 digests, never contents. User-level files, including
`$HOME/.agents/skills` (`HOME` from the child environment), are detected once per run invocation and
recorded under `harnesses.<name>.instructionSources`; the run warns once about them and again if
they change on resume. Project files are detected once per distinct resolved `cwd`, isolation mode
and env edits (including each runtime-owned worktree), before the first live call there, and
recorded in the run's `projectInstructions` list (at most 128 entries, oldest dropped; the first
detection for a harness and `cwd` in a run invocation replaces its entry, so a resume refreshes it,
and later detections there add their files to it). Up to 64 skill files are listed per detection;
the rest are counted, in the user-level warning or in a run warning for project skills.
`workflow doctor` names both. None of it enters step identity or replay. Codex memories
(`CODEX_HOME/memories/memory_summary.md`) do not load by default; they load only when
`features.memories` is enabled through explicit `config` or an inherited `config.toml`, so they are
not detected. That key, like other inherit-mode config keys such as `project_doc_max_bytes`, is not
modelled.

Claude instruction boundary. Restricted Claude loads no user or project instruction files, so it
records nothing. An `inherit` call loads the user `CLAUDE.md` from Claude's configuration directory:
`CLAUDE_CONFIG_DIR` when set (from the child environment, so `env.set` counts), otherwise
`~/.claude`; a configured `CLAUDE_CONFIG_DIR` replaces `~/.claude` rather than adding to it.
`CliHarness` detects that file for each distinct `cwd`, isolation mode and env edits and records it
in `projectInstructions` as `{ scope: 'user', kind: 'claude-md' }`, by path and digest, even when it
is blank. When `HOME` is the `cwd` or one of its ancestors, `~/.claude/CLAUDE.md` also loads as that
ancestor's project file even with `CLAUDE_CONFIG_DIR` set, and is recorded the same way. Inherit is
an explicit trust decision, so the run adds no warning for it; `workflow doctor` names the file.
Other inherit-mode inputs are not detected: project `CLAUDE.md` files (including other
`<ancestor>/.claude/CLAUDE.md` files), `CLAUDE.local.md`, rules directories, `@imports` and
auto-memory.

Instruction-free Codex calls. Set `instructions: 'none'` on a Codex call, in a profile's `codex`
options or in `defaults.codex` to run without these files. The adapter adds
`--config project_doc_max_bytes=0`, which stops project `AGENTS.md`/`AGENTS.override.md` loading,
and runs the child against a private temporary `CODEX_HOME` (mode 0700) that holds only a 0600 copy
of the real `auth.json`. Nothing else is copied: no `AGENTS.md`, skills, plugins, memories or
`config.toml`. Skill roots outside `CODEX_HOME` are not affected: Codex 0.160.0 still loads the
skills under `$HOME/.agents/skills`, the project's `.agents/skills` from the Git root to `cwd` and
`<cwd>/.codex/skills` in a `'none'` call. The directory is removed after success, failure and
cancellation. The real home is the one the child would otherwise use, so `env.set.CODEX_HOME` still
selects where authentication comes from. When Codex refreshes its token during the call, the
refreshed `auth.json` is written back to the real home atomically (temporary file in the same
directory, fsync, rename, original mode) under a lock file in `os.tmpdir()`, and only while the real
file still equals the copy. If another process changed it meanwhile, the file with the later
`last_refresh` wins and the call records a warning that names the path, never the contents. A
missing `auth.json` (API-key or `env_key` providers) gives an empty private home and nothing is
written back; a torn copy left by a killed child is never written back.

The trade-off: calls lose guidance users may expect from their own or the project's `AGENTS.md` and
their `CODEX_HOME` skills, but `'none'` removes only the `AGENTS` files and `CODEX_HOME` skills. It
no longer guarantees that results are independent of who runs the workflow, because
`$HOME/.agents/skills` and the project skill roots still load. Supply instructions deliberately
through the prompt or explicit, fingerprinted `config` such as `developer_instructions`. `'none'`
requires restricted isolation and is rejected with `inherit`: inherit loads `config.toml`, which can
carry instructions of its own and which the private home deliberately omits. The mode also owns the
`project_doc_max_bytes` config key. Custom providers still need explicit `config`, as in any
restricted call. `instructions` is not a capability control: it removes context and grants nothing,
so call sites may set it under `strictProfiles`. `'none'` enters step identity, while `'native'`
(the default) and unset fingerprint identically, so existing runs keep their identities. Codex steps
record the resolved value as `request.instructions`, `workflow inspect` lists
`no native instructions` among a step's limits, and dry-run call plans carry `codexHome: 'private'`
next to the argv. The restricted default is unchanged; making `'none'` the default is a separate
decision. See [ADR 0031](decisions/0031-private-codex-home-for-instruction-free-calls.md).

Limitations: the lock coordinates quiet-choir processes that share a temporary directory. A plain
`codex` run refreshing the same `auth.json` at the same moment is covered only by the
compare-and-swap re-read. A lock file that is not a quiet-choir owner record (corrupt, or another
user's file in a shared `/tmp`) is moved aside with a warning once it is older than 60 s; one that
cannot be moved aside makes write-back warn at once with the lock path to remove. Credentials Codex
keeps in the OS keyring instead of `auth.json` are not copied, and that setup is unverified. Codex
writes its own state files into each private home, so every call starts with a fresh installation
ID. Detection still describes what Codex would load without the opt-out: user-level detection reads
the real home, so a workflow that uses only `'none'` still gets the user-level warning, and `'none'`
calls still get a `projectInstructions` entry for their `cwd`. `request.instructions` records what
each call actually did.

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
`childEnvironment` in `quiet-choir/harness-kit`. Commands are not scrubbed by default: a `ctx.exec`
or `context.exec` that launches an agent CLI opts in with `scrubEnv`
([commands](command-effects.md)).

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
Claude 2.1.283 and Codex 0.157.1, last run on Claude 2.1.290 and Codex 0.160.0. It uses fresh homes
and dummy keys. It confirms hook and project-instruction suppression, explicit
settings/MCP/plugin/prompt/tool opt-ins, outside-read denial and `addDirs` restoration, protected
settings-write denial, and Codex's explicit provider override. For restricted Codex it also records,
without asserting, whether canaries in a user `AGENTS.md`, a user skill description and a project
`AGENTS.md` reach the request body (`userInstructionsReachedRequest`,
`projectInstructionsReachedRequest` and `userSkillReachedRequest`, all true on 0.157.1, and the same
with an explicit `instructions: 'native'`), how `AGENTS.override.md` replaces `AGENTS.md`, that
discovery runs from the Git root down to `cwd`, and that an empty user-level override falls back to
`AGENTS.md` while an empty project-level one does not. Whitespace-only files (spaces, tabs,
newlines) behave the same on 0.157.1: a whitespace-only user override falls back to `AGENTS.md`, a
whitespace-only project override still replaces `AGENTS.md`, and a blank `AGENTS.md` at either level
sends no instructions message (`instructionsMessageReachedRequest`, recorded true on the plain
restricted case so a reworded header shows as a diff). Instruction detection treats blank files
accordingly, following Rust's `trim` (Unicode White_Space). A change in Codex then shows as a
fixture diff. It asserts that with `instructions: 'none'` none of the three canaries reaches the
request, the call still reaches the explicit provider, and the real `CODEX_HOME` listing and
`auth.json` stay unchanged. A probe on 0.157.1 showed that `project_doc_max_bytes=0` (spelled
`--config` or `-c`) removes only the project canary; the private home removes the user file and
skill.

On Codex 0.160.0 the probe also records skill roots and memories. In the plain restricted call, a
skill under the project's `.agents/skills`, one under `$HOME/.agents/skills`, one under the
project's `.codex/skills` and a nested `CODEX_HOME/skills/group/nested` skill all reach the request,
and neither `CODEX_HOME/memories/memory_summary.md` nor `MEMORY.md` does. With
`instructions: 'none'` the three skills outside `CODEX_HOME` still reach the request; the nested
`CODEX_HOME` skill does not. `codex-restricted-skill-layout` (Git root `project/pkg`, `cwd`
`project/pkg/mid/leaf`) shows `.agents/skills` loading at the root, an intermediate directory and
`cwd` but not above the root, `.codex/skills` loading only in `cwd`, `$HOME/.agents/skills` loading,
dot-directories skipped, skills six levels below a root loading but not seven, and a skill nested
inside another loading. `codex-restricted-skill-no-git` shows only `cwd` contributing without a
`.git` entry, and `$HOME/.agents/skills` loading when `HOME` is not an ancestor of `cwd`.
`codex-restricted-memories-enabled` shows `memory_summary.md` (not `MEMORY.md`) loading with
`features.memories` set. For Claude 2.1.290, `claude-user-instructions` asserts that an inherit call
loads `<CLAUDE_CONFIG_DIR>/CLAUDE.md` and a restricted one does not, that `HOME/.claude/CLAUDE.md`
does not load when `CLAUDE_CONFIG_DIR` is set and `HOME` is not an ancestor of `cwd`, and that it
loads when `CLAUDE_CONFIG_DIR` is unset; it also records that `HOME/.claude/CLAUDE.md` loads as an
ancestor's file when `HOME` is an ancestor of `cwd`. Every case asserts that the native CLI reached
the local fake API; an explicit Codex `config` is merged over the fixture provider, and a negative
case confirms that a call steered away from it fails the contract. No upstream inference occurs. The
sanitized report is in
[`test/fixtures/harness-isolation-results.json`](../test/fixtures/harness-isolation-results.json).

Earlier zero-cost OAuth probes on the same Claude version reached invalid-model responses with
`apiKeySource: none`, no tools/MCP/hooks or memory field, and zero usage/cost. That evidence
supports retaining subscription authentication; it is not a successful inference test or a fresh
account availability check. Managed policy and future CLI versions can change the effective
boundary.
