# Agent profiles and launch grants

Declare roles on the workflow instead of passing a shared tools/budget object through input:

```ts
export default defineWorkflow({
  name: 'review',
  version: '1',
  input,
  output,
  defaults: {
    profile: 'text',
    claude: { model: 'sonnet' },
    codex: { reasoningEffort: 'medium' },
  },
  profiles: {
    scout: { extends: 'readonly', maxTurns: 30, description: 'Maps the repository' },
    skeptic: { extends: 'readonly', maxBudgetUsd: 1 },
    fixer: {
      extends: 'edit',
      access: 'exec',
      claude: {
        tools: ['Read', 'Grep', 'Glob', 'Edit', 'Bash'],
        allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Bash(npm test:*)'],
      },
    },
  },
  async run(ctx, input) {
    const result = await ctx.claude.object('map', {
      profile: 'scout',
      prompt: input.request,
      schema: output,
    });
    return result.output;
  },
});
```

`profile` is a union of declared names and `text | readonly | edit`; a misspelling fails typecheck,
including through `ctx.within` and `ctx.agent(name)` for Claude, Codex and registered harnesses.
Helpers accepting an unparameterized `WorkflowContext` accept any string name, which is still
checked at runtime. Use `WorkflowContext<'scout'>` to retain a narrow helper contract. Names may
contain letters, digits, underscores and hyphens, start with a letter, and have at most 64
characters. Built-in names and grant class names cannot be redeclared.

Call-site option types follow `strictProfiles`. `defineWorkflow` infers its literal: omitted or
`true` removes the capability keys that strict profiles own from `ctx.claude`, `ctx.codex` and
`ctx.agent(name)` options, so `ctx.claude.text('t', { prompt, tools: ['Read'] })` fails typecheck
and `workflow validate` with `load.typecheck` instead of failing when the call runs. Claude's keys
are tools, allowedTools, disallowedTools, permissionMode, agent, agents, plugins, mcpServers,
strictMcpConfig, settings, addDirs, extraArgs, env and isolation; Codex's are sandbox,
networkAccess, config, harnessProfile, addDirs, extraArgs, env and isolation. The same exported
lists (`claudeCapabilityKeys`, `codexCapabilityKeys`) drive the runtime check. `isolation` stays
available with every value except `'inherit'`, so `'restricted'` and the worktree shorthands still
compile. A registered harness's literal `capabilityKeys` are removed the same way. Only a literal
`strictProfiles: false` types the raw keys; a non-literal `boolean` also stays permissive and leaves
the decision to the runtime. A helper typed with a bare `WorkflowContext` stays permissive (the
runtime check still applies), while `WorkflowContext<'scout', BuiltInHarnesses, true>` is a strict
helper contract that accepts the workflow's strict context.

| Preset            | Claude tools                  | Codex sandbox   | Claude turns | Claude USD | Deadline     |
| ----------------- | ----------------------------- | --------------- | ------------ | ---------- | ------------ |
| `text` (implicit) | none                          | read-only       | 10           | 0.50       | 300,000 ms   |
| `readonly`        | Read, Grep, Glob              | read-only       | 25           | 2          | 900,000 ms   |
| `edit`            | Read, Grep, Glob, Edit, Write | workspace-write | 40           | 5          | 1,800,000 ms |

Resolution is the root built-in preset, workflow defaults, the custom `extends` chain, the selected
role, per-call options, ordered `--profile` overrides, then existing step-targeted `--policy` rules.
Nested provider objects merge field by field; arrays replace. A custom role without `extends` starts
from `text`. Configuration mode defaults to `restricted`; shared `isolation` on defaults/profiles
can be overridden in provider-specific options. Model and effort omissions use that mode’s native
defaults; set them explicitly in defaults or profiles to avoid that dependency. Codex ignores
profile turn/budget limits because its adapter has no corresponding enforcement flags. Custom
harnesses receive the resolved options and are responsible for enforcing them.

`tools` implies `allowedTools`. An explicit allowed list may select exposed tools or narrow a bare
tool to a rule such as `Bash(npm test:*)`. Replacing the tool list without a new allowed list
re-infers permissions from that replacement, rather than retaining the parent's permissions. The
exposure list determines the access class conservatively, even when the allowed list narrows it.
Read/Grep/Glob/WebSearch/WebFetch imply `read`; Edit/Write/NotebookEdit imply `write`; Bash and
unknown/MCP tools imply `exec`. Codex read-only implies `read`, workspace-write implies `write`. The
manifest shows both provider classes and their maximum; thus even `text` has aggregate access `read`
(Claude alone is `none`). An explicit `access` must equal the role's inferred aggregate class.

## Validation and authorization

```sh
quiet-choir workflow validate review.workflow.ts --json
quiet-choir workflow execute review.workflow.ts --run-id review-1 --grant fixer
```

Validation emits `workflow.capabilities`: resolved defaults, all named and built-in profiles,
provider access, models, tool gates, limits, descriptions, and `requiredGrants`. Explicit
environment values are omitted; per-provider environment names and digests remain available. It
imports trusted source but does not evaluate the workflow body. By default, `strictProfiles: true`
rejects raw capability controls at call sites: tools, allowed/disallowed rules, permission modes,
sandbox, MCP/settings, native agents/profiles/config, dirs, environment, escape args and network
access. Native configuration/agent/escape/env controls, explicit inherited mode, plugins, and
enabled network access conservatively require exec grants. Codex additional directories require
write access. Role prompts, model, effort, fallbacks and image attachments remain available per
call. See [harness controls](harness-controls.md). The manifest bounds declared agent controls; it
does not confine workflow JavaScript or arbitrary working directories. Printed and checkpointed
manifests show settings, MCP servers, subagents, system prompts, Codex config and environment values
only as names and digests under `redacted`/`environment`; grant pins use the raw declaration.
Configuration isolation is a separate [provider-specific boundary](harness-isolation.md).

Every declared or default role with write/exec access requires authorization before the body starts,
even if a branch never uses it. `--grant fixer` authorizes that role; `--grant write` authorizes
write roles; `--grant exec` authorizes both write and exec; `--grant all` authorizes every role.
Multiple `--grant` flags accumulate. Undeclared built-ins are listed in the manifest but an elevated
built-in is disabled until granted; invoking `edit` without a grant fails before that agent call.
Declaring an elevated named role makes this check happen before **any** workflow effects.

Grants persist on resume. Named grants are pinned to exact tools, allowed rules, and sandbox; after
those change, supply the grant again, even with `--accept-code-change`. Class/all grants
deliberately cover roles within that class. Forks require fresh grants. Embedded callers use
`RunOptions.grants`.

`strictProfiles: false` is an explicit migration escape hatch. Raw capabilities still require
class/all grants; a named grant cannot authorize arbitrary call-site replacements. The manifest then
reports that it cannot bound those replacements. The historical direct-port experiments retain this
escape hatch to preserve their input-based API; new workflows should use named roles.

## Recovery and diagnostics

```sh
quiet-choir workflow execute review.workflow.ts --run-id review-1 --resume \
  --profile scout.maxTurns=60 --profile '*.timeoutMs=1800000'
```

The three overridable limits are `maxTurns`, `maxBudgetUsd`, and `timeoutMs`. The selector is an
exact profile name or `*`; semantic overrides and unknown names fail before effects. Rules are
sticky on resume, later values win, and `--policy-reset` clears both saved step rules and profile
rules. Embedded callers pass `profileOverrides: [{ profile: 'scout', maxTurns: 60 }]`. Attempts
record their role, effective limits, model/effort and value sources. Profile names and limits are
outside step identity; resolved models, tools, sandbox, effort and permission-failure behavior are
identity. Changing workflow source still requires the usual explicit code acceptance or fork.

Turn/budget errors report the configured cap, role, reported turns and cost (or `unknown`), and a
suggested resume override. If a matching step `--policy` rule also sets the cap, update or reset
that rule: it takes precedence over `--profile`. Inspect `steps[id].warnings` for permission-denial
counts. A role can set `onPermissionDenied: 'fail'` to reject an otherwise successful response with
kind `permission`; usage/session metadata remains available. Only reported denials are diagnosed,
and the runtime does not save their tool-input payloads.

`expectsToolUse` defaults to true for aggregate access read or higher. Zero-tool-use warnings and
`idleTimeoutMs` await streaming/tool-count support in #61/#62; idle timeout is currently rejected,
not accepted as an unenforced limit. These profiles are not the hermetic harness isolation proposed
in #60, and there is no total run spending cap.
