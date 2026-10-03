# 0011: Own typed harness arguments and verify native contracts

## Status

Accepted. Amended by [ADR 0040](0040-grade-harness-versions-against-a-tested-range.md) (#143):
exact-argv probes now run on any version the binary reports, and versions are graded against a
range. Amended below (#341): Codex has one `effort` option.

## Context

The installed CLIs evolve independently. Omitted effort can inherit expensive defaults; fixed
adapter arguments prevent workflows from expressing native controls. Unchecked passthrough can
replace protocol, permission or session plumbing. File attachments can change between hashing and
launch. Durable replay needs the requested semantics and observed CLI version to remain inspectable.

## Decision

Expose shared effort, typed provider controls and per-call/profile args/env/config. Validate enums
and owned flags/config aliases before spawn. Keep `profile` as the engine role and call Codex's
native selector `harnessProfile`. Strict profiles and pinned grants cover capability controls;
opaque native configuration and escape controls conservatively require exec authorization.

Use one argument builder for execution and diagnostic contract probes. Place large role/config
values and immutable image snapshots in private 0600 files with finally cleanup. Fingerprint image
bytes and other semantic options; preserve limits/retry as execution policy. Protect Codex's stdin
marker with an option separator. Require attached long escape-arg values to prevent prompt and
subcommand injection through positional/variadic parsing.

Export the five-part doctor report and retain a thin CLI plan/executor boundary. Only tested
versions run exact-argv probes, using pre-inference rejection sentinels. Require zero spend and the
expected protocol error; warnings and uncertain responses fail. Read selected user/profile TOML
values with a parser rather than regexes. Report native CLI versions on first live provider use;
version drift warns on resume instead of changing semantic identity.

## Consequences

Control changes reliably invalidate completed effects while limit recovery remains available.
Workflows can set effort on the historical ports without changing provider/model. File snapshots
cost memory proportional to attached bytes. External native configuration, parent environment and
files referenced only by escape strings remain outside identity. Private doctor config/auth copies
are removed on every normal completion/failure/cancellation path; abrupt process death can leave
temporary files. This change does not implement hermetic execution, native session resumption or
streaming. Supported version bounds must be deliberately refreshed with contract evidence.

## Amendment: Codex has one `effort` option (#341, 2026-10)

Codex took both the shared `effort` and its own `reasoningEffort`, which typechecked together and
then failed at runtime with "never both". At 0.0.0 one spelling per concept (#158) wins:
`CodexOptions.effort` accepts `'none' | 'minimal' | Effort` and `reasoningEffort` is removed, along
with the "never both" check. Claude's `effort` stays `Effort`. `PolicyOverride.reasoningEffort` and
`AttemptPolicy.reasoningEffort` are renamed to `effort`; an effort policy rule still applies to
Codex steps only. A live `reasoningEffort` on a call, profile, defaults block or incoming policy
rule fails with a message naming `effort`. Persisted attempts, saved policy rules and capability
manifests read the old key as `effort`; the checkpoint format stays 7 (ADR 0018's additive prototype
rule), and new writes carry `effort`.

Identity keeps the `reasoningEffort` slot that sat beside `model`: the built-in legacy identity now
feeds it from Codex `effort` and leaves Codex `effort` out of `option.*`, while Claude's effort
stays `option.effort`. Codex calls recorded with `reasoningEffort` therefore keep their fingerprints
and resume after a source migration. Codex calls recorded with the old shared `effort`
(`option.effort`) change identity once; the replay check refuses them even under
`--accept-code-change` and points to a fork that invalidates the step. Golden digests computed
before the change pin both outcomes.
