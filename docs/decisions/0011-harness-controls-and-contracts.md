# 0011: Own typed harness arguments and verify native contracts

## Status

Accepted.

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
