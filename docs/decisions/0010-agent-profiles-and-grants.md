# 0010: Resolve named agent capabilities before effects

## Status

Accepted. Extends [0005](0005-step-identity-and-policy.md) and its policy defaults.

Amended by #109: `expectsToolUse` defaults to roles that grant more than the text baseline and
drives a `no-tool-use` warning, and `idleTimeoutMs` is a profile limit; see
[0042](0042-idle-deadlines-and-tool-use-diagnostics.md).

Amended by #155: call-site option types mirror `strictProfiles`. `defineWorkflow` infers its literal
(omitted means `true`) into the context, which then omits the profile-owned capability keys (and
`isolation: 'inherit'`) from `ctx.claude`, `ctx.codex` and `ctx.agent(name)` options; a literal
`false` or a non-literal `boolean` keeps them. One key list per built-in harness drives both the
types and the runtime check, which remains the backstop for untyped code and bare-context helpers.
`ctx.agent(name)` profiles are typed like `ctx.claude` profiles.

## Context

Shared per-call settings hide role capabilities and place operator controls in workflow input.
Supervisors need a declaration without running the body, and a way to raise limits on resume without
changing completed effects. Tool exposure and permission gates must agree under Claude's dontAsk
mode. Harness configuration and workflow JavaScript remain outside those gates.

## Decision

Use plain-data defaults and named profiles, built-in text/readonly/edit presets, strict call-site
capability checks by default, a public capabilityManifest resolver, and grants enforced in the core.
The CLI only parses flags into plain-data plans. Provider semantics remain separate within a shared
role. Infer access conservatively, treating unknown tools as exec and Codex read-only as read.

Preflight every declared/default elevated role before the body. Built-ins remain callable without
being declared; an elevated built-in requires a grant at the invocation boundary. Thus a text-only
workflow need not obtain a blanket edit grant, and the manifest still lists every available preset.
Strict false explicitly relinquishes the manifest's call-site bound; raw calls require class/all
grants. Grants are operator policy rather than a sandbox for untrusted workflow code.

Pin named grants to the exact tools, allowed rules and sandbox. Resume reuses pins, but changed
capabilities require a fresh named grant. Class/all grants intentionally authorize future roles
within their scope. A fork does not inherit source grants or policy.

Apply presets, defaults, custom ancestors, role, call options, profile launch rules, then existing
step launch rules. Profile rules are sticky and reset with policyReset. Profile names/limits are not
semantic identity; resolved semantic fields and onPermissionDenied:fail are. Default empty tool
gates and read-only sandbox have canonical omitted identity components, preserving pre-profile
implicit no-tool format-5 fingerprints. Older explicitly spelled default components may require a
new run/fork rather than silently relaxing completed-step checks. Other formats remain read-only.

## Consequences

The implicit text preset raises structured-output headroom to 10 turns/$0.50/300s. Tools now imply
pre-approvals unless explicitly narrowed: this is a deliberate 0.0.0 privilege change, gated in
workflow execution by declarations and grants. Direct CliHarness users own their authorization.
Existing workflows with raw capability options must migrate or explicitly opt out of strict mode.
Historical comparison ports preserve their input API using that explicit opt-out.

Permission denials produce bounded count warnings and optionally permission-kind failures with usage
preserved. Turn/budget errors add cap/role/turns/cost and an actionable override. Tool counts, the
`no-tool-use` warning, the `expectsToolUse` default and the `idleTimeoutMs` limit are now decided in
[ADR 0042](0042-idle-deadlines-and-tool-use-diagnostics.md) (#109). Input-schema publication is #63.
Hooks/MCP isolation is #60. No paid harness probes are required to verify deterministic profile
resolution or launch authorization.
