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
    codex: { effort: 'medium' },
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
available as `'restricted'` only, since strict profiles own `'inherit'`; `worktree` is not a
capability key, so every checkout selection still compiles. Claude's `addDirs` stays typed only
together with a profile that accepts
[root-bounded call-site directories](#bounded-call-site-directories): one that declares
`claude.addDirRoots`, inherits it through `extends`, or gets it from `defaults.claude`, and, for a
call that omits `profile`, a rooted `defaults.profile`. Under any other profile, including the
implicit `text`, `addDirs` fails typecheck like the other keys, while every profile still compiles
without it. `defineWorkflow` reads this from the literal `profiles` and `defaults`; when it cannot
see their shape (a profiles object typed `Record<string, AgentProfile>`, a non-literal `extends`, or
a generic `P extends AgentProfile` or `D extends AgentDefaults<never>` value that a factory
forwards, which takes a fallback overload reading every profile as rooted) the type stays permissive
and the runtime check decides
([ADR 0062](decisions/0062-type-call-site-adddirs-by-profile-roots.md)). Codex `addDirs` stay
removed. A registered harness's literal `capabilityKeys` are removed the same way. The removed keys
are typed as optional `never` properties, so a pre-built options variable or an explicit `undefined`
is rejected too, not only a fresh object literal. Only a literal `strictProfiles: false` types the
raw keys; a non-literal `boolean` also stays permissive and leaves the decision to the runtime. A
helper typed with a bare `WorkflowContext` stays permissive (the runtime check still applies), while
`WorkflowContext<'scout', BuiltInHarnesses, true>` is a strict helper contract that accepts the
workflow's strict context. Explicit `defineWorkflow` type arguments are all-or-nothing: with a
shorter prefix such as `defineWorkflow<Input, Output>`, the rest take the strict, childless
defaults, so `strictProfiles: false` or a nonempty `children` list fails typecheck; drop the type
arguments (preferred) or spell all seven. Explicit type arguments also leave the `profiles` and
`defaults` shapes uninferred: declared roles then accept call-site Claude `addDirs` at type level,
while built-ins and an omitted `profile` reject them even when `defaults` roots them, so such a
workflow must drop the type arguments.

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

Validation emits `workflow.capabilities`: the `defaultProfile` name, all named and built-in
profiles, provider access, models, tool gates, limits, descriptions, and `requiredGrants`. Explicit
environment values are omitted; per-provider environment names and digests remain available, as a
shared `capabilities.environment` plus each profile's differences (`--harness-schemas` prints the
complete, uncompacted manifest). It imports trusted source but does not evaluate the workflow body.
By default, `strictProfiles: true` rejects raw capability controls at call sites: tools,
allowed/disallowed rules, permission modes, sandbox, MCP/settings, native agents/profiles/config,
dirs, environment, escape args and network access. Native configuration/agent/escape/env controls,
explicit inherited mode, plugins, and enabled network access conservatively require exec grants.
Codex additional directories require write access. Role prompts, model, effort, fallbacks and image
attachments remain available per call. See [harness controls](harness-controls.md). The manifest
bounds declared agent controls; it does not confine workflow JavaScript or arbitrary working
directories. Printed and checkpointed manifests show settings, MCP servers, subagents, system
prompts, Codex config, environment values and the registered harness options a declaration lists in
`sensitiveOptions` (under `redacted.harnesses`) only as names and digests under
`redacted`/`environment`; grant pins and step identity use the raw declaration. Configuration
isolation is a separate [provider-specific boundary](harness-isolation.md).

Every declared or default role with write/exec access requires authorization before the body starts,
even if a branch never uses it. `--grant fixer` authorizes that role; `--grant write` authorizes
write roles; `--grant exec` authorizes both write and exec; `--grant all` authorizes every role.
Multiple `--grant` flags accumulate. Undeclared built-ins are listed in the manifest but an elevated
built-in is disabled until granted; invoking `edit` without a grant fails before that agent call.
Declaring an elevated named role makes this check happen before **any** workflow effects.

Grants persist on resume. Named grants are pinned to exact tools, allowed rules, sandbox, the other
declared capability controls and, when declared, `claude.addDirRoots`; after those change, supply
the grant again, even with `--accept-code-change`. Class/all grants deliberately cover roles within
that class. Forks require fresh grants. Embedded callers use `RunOptions.grants`.

### Bounded call-site directories

A directory known only at runtime, such as a per-PR state directory an earlier step created, can be
made readable to one Claude agent without widening its `cwd`. Declare roots on the profile and pass
`addDirs` at the call:

```ts
profiles: { reader: { extends: 'readonly', claude: { addDirRoots: ['.state/runs'] } } },
// ...
await ctx.claude.text('review', { profile: 'reader', prompt, addDirs: [`.state/runs/${pr}`] });
```

- **Typecheck.** In a strict workflow, `addDirs` on a profile without roots (including the implicit
  `text`) fails typecheck and `workflow validate` (`load.typecheck`); the runtime check below still
  covers what the types cannot see.
- **Claude only.** Codex `addDirs` are writable sandbox roots, so Codex cannot take a bounded
  call-site directory; `codex.addDirRoots` (on a profile or on `defaults`) fails validation with
  that reason. List Codex directories statically in `codex.addDirs`.
- **Path policy.** `addDirRoots` is profile-only (never a call option) and is published verbatim in
  `workflow.capabilities`. Roots resolve against the run's working directory; call entries resolve
  against the call's `cwd`. An entry containing a `..` segment is refused before resolution. Both
  sides are canonicalized: the real path of the deepest existing ancestor (symlinks followed) plus
  any not-yet-created segments, so a directory a later step creates can still be named, while a
  symlink that leaves a root, or a dangling symlink, is refused. An entry must equal or sit inside a
  root. Errors name the entry, its canonical path, the profile and the canonical roots.
- **Append.** Accepted entries are appended, as canonical absolute paths, to the profile's own
  `addDirs` (exact duplicates dropped), so a call cannot drop a declared directory. Those canonical
  paths reach `--add-dir`, step identity and the attempt's request summary (`request.addDirs`). A
  profile without roots, a Codex call, or any other raw key keeps the existing
  `strictProfiles forbids call-site …` error.
- **Grants.** Access classification is unchanged: a Claude directory is `read`, so a call-site
  directory never raises a role above what its tools give, and a write-capable role still needs its
  grant. A tool-less rooted role is `read`. Roots are part of the named grant pin.
- **Children.** A child's `addDirRoots` must lie inside the parent role's roots, and a child call's
  canonical directories inside the parent's roots; otherwise delegation fails with
  `Child profile … exceeds parent profile …: claude.addDirRoots` (or `claude.addDirs`).
- **Limits.** The check runs when the call is resolved, not when the CLI opens the directory, so a
  concurrent writer that swaps a path component for a symlink in between is not caught. Resolution
  also runs on replay: a completed step whose directory is now outside its roots (a retargeted
  symlink) fails to resolve on resume. Restricted mode is unchanged; only `--add-dir` is added, and
  restricted Claude loads no instructions or skills from those directories (see
  [harness isolation](harness-isolation.md#native-boundary)). See
  [ADR 0054](decisions/0054-bounded-call-site-adddirs.md).

`strictProfiles: false` keeps its earlier behavior: a call's `addDirs` replace the profile's list
without canonicalization, and roots are not enforced.

`strictProfiles: false` is an explicit migration escape hatch. Raw capabilities still require
class/all grants; a named grant cannot authorize arbitrary call-site replacements. The manifest then
reports that it cannot bound those replacements. The historical direct-port experiments retain this
escape hatch to preserve their input-based API; new workflows should use named roles.

## Recovery and diagnostics

```sh
quiet-choir workflow execute review.workflow.ts --run-id review-1 --resume \
  --profile scout.maxTurns=60 --profile '*.timeoutMs=1800000'
```

The four overridable limits are `maxTurns`, `maxBudgetUsd`, `timeoutMs` and `idleTimeoutMs` (for
example `--profile scout.idleTimeoutMs=120000`). The selector is an exact profile name or `*`;
semantic overrides and unknown names fail before effects. Rules are sticky on resume, later values
win, and `--policy-reset` clears both saved step rules and profile rules. Embedded callers pass
`profileOverrides: [{ profile: 'scout', maxTurns: 60 }]`. Attempts record their role, effective
limits, model/effort and value sources. Profile names and limits are outside step identity; resolved
models, tools, sandbox, effort and permission-failure behavior are identity. Changing workflow
source still requires the usual explicit code acceptance or fork.

Turn/budget errors report the configured cap, role, reported turns and cost (or `unknown`), and a
suggested resume override. If a matching step `--policy` rule also sets the cap, update or reset
that rule: it takes precedence over `--profile`. Inspect `steps[id].warnings` for permission-denial
counts. A role can set `onPermissionDenied: 'fail'` to reject an otherwise successful response with
kind `permission`; usage/session metadata remains available. Only reported denials are diagnosed,
and the runtime does not save their tool-input payloads.

`expectsToolUse` defaults to true when a role grants more than the text baseline: any Claude tool,
or a Codex sandbox beyond `read-only`. So `text` is false, `readonly` and `edit` are true, and a
role that only adds Codex `workspace-write` is true; set it explicitly to override. When it is true
and a completed attempt reports zero tool calls, the step gets the warning
`no-tool-use: Profile <name> expects tool use, but the <harness> attempt completed without a tool call.`
The count comes from the attempt's stream (`attemptHistory[].diagnostics.toolUses`); a Claude call
with an empty tool list, or an adapter that reports no count, never warns. The warning never fails
the attempt.

`idleTimeoutMs` (a profile, `defaults` or call limit, off by default) ends an agent attempt whose
CLI writes nothing to stdout or stderr for that long, with error kind `idle-timeout`. Like
`timeoutMs` it is policy outside identity, so raise it on resume with
`--profile name.idleTimeoutMs=N`. Size it above the longest silent tool run or reasoning stretch;
see
[idle deadline and tool-use diagnostics](harness-controls.md#idle-deadline-and-tool-use-diagnostics).
These profiles are not the hermetic harness isolation proposed in #60, and there is no total run
spending cap.
