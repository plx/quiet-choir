# 0031: Private CODEX_HOME for instruction-free Codex calls

- Status: accepted
- Issue: #130
- Builds on [ADR 0023](0023-restricted-harness-configuration.md) (resolve restricted configuration
  before identity) and the instruction detection added by #129.

## Context

Restricted Codex calls pass `--ignore-user-config --ignore-rules`, yet codex-cli 0.157.1 still reads
the user's `CODEX_HOME/AGENTS.md` (or `AGENTS.override.md`), the descriptions of
`CODEX_HOME/skills`, and project `AGENTS.md` files from the Git root down to `cwd`. Results
therefore depend on who runs a workflow. There is no Codex flag that skips user-level files, and
`CODEX_HOME` also holds the credentials (`auth.json`) that Codex may refresh during a call. The
doctor already probes with a private copy of the home, but it never writes back, so a token
refreshed during an ordinary call would be lost.

A zero-cost probe against the local fake Responses API showed that `project_doc_max_bytes=0`
(spelled `--config` or `-c`) removes the project canary but not the user `AGENTS.md` or skill, and
that a private home holding only `auth.json` removes those as well.

## Decision

Codex calls accept `instructions: 'native' | 'none'`. `'native'` is the default and changes nothing.

**Plan and materialization.** `planInvocation` stays pure. For `'none'` it adds
`--config project_doc_max_bytes=0` after the isolation flags and marks the plan with
`codexHome: 'private'`, which dry-run and rehearsal plans show next to the argv.
`materializeInvocation(plan, request, { codexHome })` creates the private home and returns an `env`
override (`CODEX_HOME`) that the native adapter applies after the scrubbed and edited child
environment. `codexHome` is the real home the child would otherwise use, so `env.set.CODEX_HOME`
still chooses where authentication comes from. A private plan without a source home is refused
rather than falling back to the inherited home.

**The private home.** A fresh `mkdtemp` directory (0700) holds only a 0600 copy of the real
`auth.json`, read through a symlink if there is one. Nothing else is copied. A missing `auth.json`
gives an empty home and no write-back. The bytes read at creation are kept in memory as the
snapshot. `dispose` settles if needed and removes the home on success, failure and cancellation.

**Write-back.** `settle()` runs once the child has exited and is idempotent. A pure function decides
what happens, from the snapshot, the private copy and the real file read under the lock:

- skip when the original was absent (never create or delete a real `auth.json`), the private copy is
  missing, unchanged, already equal to the real file, or not a JSON object (a write torn by a killed
  child);
- replace the real file when it still equals the snapshot;
- when the real file changed meanwhile, keep the one with the later top-level `last_refresh`; if
  either timestamp is missing or the real file was deleted, keep the real file. Both of these record
  a warning naming the path, never contents.

A replacement writes a temporary file in the target's directory with the original mode, fsyncs it,
renames it over `auth.json` and fsyncs the directory. The lock is a file in `os.tmpdir()` named from
a SHA-256 prefix of the real home's path, published complete by `link` from a private draft and
holding the owner PID, OS birth identity and a nonce. A lock whose owner is dead, or whose PID now
has a different birth identity, is moved aside and reclaimed (and put back if a live owner replaced
it meanwhile). Acquisition waits about 10 s with backoff; on timeout the call records a warning that
the refreshed credentials could not be saved and leaves the real file alone. The only change to the
real home is the atomic replacement of `auth.json`. Settle warnings join `response.warnings` on
success and the `HarnessError` message (`Cleanup:`) on failure; they never fail a valid result.

**Validation and identity.** `'none'` is rejected under `isolation: 'inherit'`: inherit loads
`config.toml`, which can carry instructions of its own, and copying it would not mean `'none'` while
dropping it would silently turn inherit into restricted. Under `'none'`, the `project_doc_max_bytes`
config key (and its parent-table aliases) is owned by the mode. Explicit config such as
`developer_instructions` stays allowed and is the deliberate way back in. `instructions` is not a
capability field: it removes context and never grants access, so it does not change the access
class, call sites may set it under `strictProfiles`, and Claude rejects it. `legacyAgentIdentity`
filters `instructions: 'native'` like `sandbox: 'read-only'`, so unset and `'native'` produce the
same digests as before and `'none'` adds one `option.instructions` component.
`RequestSummary.instructions` records the resolved value for Codex; the additive field needs no
`formatVersion` bump.

## Consequences

- A workflow author can get reproducible, instruction-free Codex calls without editing the user's
  home. The restricted default is unchanged; making `'none'` the default is a separate decision.
- The lock coordinates quiet-choir processes that share a temporary directory. A plain `codex` run
  refreshing the same `auth.json` concurrently is covered only by the compare-and-swap re-read, and
  processes with different `TMPDIR` values do not share the lock. A general interprocess lock helper
  may replace it later.
- When two calls both refresh, only one credential set survives; the later `last_refresh` heuristic
  picks it and the other call warns instead of losing silently.
- Credentials stored in the OS keyring rather than `auth.json` are not copied; that setup is
  unverified.
- Each `'none'` call pays for a fresh home, and Codex writes its own state there, so every call has
  a new installation ID.
- Run metadata detection still describes the real home from the first Codex call; per-call truth is
  `RequestSummary.instructions`.
