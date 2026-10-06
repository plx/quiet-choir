# 0033: Redact free-form controls from public capability manifests

- Status: accepted
- Issue: #103
- Extends the environment precedent of [ADR 0023](0023-restricted-harness-configuration.md) and the
  grant pins of [ADR 0010](0010-agent-profiles-and-grants.md).
- Amended by #247: registered harnesses declare sensitive option keys (see the amendment below).

## Context

Since #93, `publicCapabilityManifest` omits `env` values and keeps only names and a digest. Every
other profile control still reached disk and stdout verbatim: Claude `settings`, `mcpServers`
(commands, URLs, tokens in their own `env` or `headers`), `agents` (descriptions and prompts),
`systemPrompt`, `appendSystemPrompt`, and Codex `config`. Checkpoints (`record.capabilities`),
`workflow validate --json`, and the record that `check-resume` prints on `run.incompatible` all
carried them, so a credential or an internal role prompt placed in a profile was written to disk and
printed to CI logs.

Grant pins (`profileGrantDigest`), completed-step identity and child delegation read the live
manifest, never the public one. They must keep doing so, or every existing pin and resume would
change.

## Decision

The public projection reduces these fields to a digest and, for objects, their top-level names:

- Redacted: `claude.settings`, `claude.mcpServers`, `claude.agents` (descriptions and prompts both),
  `claude.systemPrompt`, `claude.appendSystemPrompt`, `codex.config`, and `env` (unchanged).
- Plaintext on purpose, because an operator reviews them before granting: `tools`, `allowedTools`,
  `disallowedTools`, `permissionMode`, `agent`, `plugins`, `addDirs`, `extraArgs`, `harnessProfile`,
  `model`, `effort`, `isolation`, `sandbox`, `networkAccess`, `strictMcpConfig`, `fallbackModel`,
  limits and the profile description. `extraArgs` reshapes argv, so it must stay reviewable; never
  put secret values in it, use `env`.
- Registered harness option values other than `env` stay visible unless the harness declaration
  lists the key in `sensitiveOptions` (#247, see the amendment below).

The removed fields move to an optional sibling, `ResolvedProfile.redacted`, shaped
`{ claude?: {...}, codex?: { config? } }` where each entry is `RedactedControl { sha256, keys? }`.
`sha256` is the canonical-JSON digest of the raw value (the helper used for env and grant pins);
`keys` holds sorted top-level names: settings keys, MCP server names, subagent names, Codex dotted
config keys. The two prompts are strings and get `sha256` only. A profile that sets none of these
fields gets no `redacted` member, so built-in profiles print as before. A sibling is used rather
than an in-place replacement because `ResolvedProfile.claude` and `.codex` keep their declared types
(an `agents` entry needs `description` and `prompt`).

The live manifest from `resolveCapabilities` is unchanged. The projection runs only at the
boundaries that leave the process: the checkpoint's `record.capabilities`, `validate`, and the
registry's cached validate result. It does not mutate its input and is idempotent on its own output.

No migration. The runner rewrites `record.capabilities` on every execution, including resume, so an
existing run is scrubbed the next time it executes; a checkpoint nothing executes again keeps what
it saved. No storage format bump: the new field is optional, like `environment`. The definition
registry cache envelope moves from version 2 to 3, so cached validate results written before this
change are never served and are rewritten once.

## Consequences

- Grant pins, step identity and child delegation are unchanged; a golden test pins the digest of a
  profile with every redacted field. A change to a redacted value still invalidates a named-grant
  pin and, for completed steps, identity, even though the public manifest shows it only as a
  different `sha256`.
- Operators see which settings keys, servers, subagents and config keys exist, and whether they
  changed, but not their values.
- A digest of a short or guessable value (a one-line system prompt) can be confirmed by guessing.
  This is the same accepted trade-off as the environment digest.
- `extraArgs`, and registered harness option values that are neither `env` nor listed in the
  declaration's `sensitiveOptions`, remain visible in manifests.
- Prompts and previews in step records, and argv, are outside capability manifests and stay
  documented as plaintext state.

## Amendment: declared sensitive options of registered harnesses (#247)

A registered harness's profile options reach the manifest twice: the parsed options under
`harnesses.<name>`, and their `capabilityKeys` subset under `harnessCapabilities.<name>`. Until #247
only `env` was dropped there, so a token, header or connection string in a custom harness's profile
options was saved and printed like any other value.

A harness declaration may now list option keys in `sensitiveOptions` (typed as keys of its option
schema, like `policy` and `capabilityKeys`):

- `defineHarness`, which also runs for every registration a workflow declares, rejects an unknown
  key with the same "refers to unknown option" error as the other lists, a duplicate entry, and
  every key that can never appear in a capability manifest: `prompt`, `profile`, `cwd`, `onError`,
  `retry`, `worktree`, `timeoutMs`, `idleTimeoutMs`, `maxTurns` and `maxBudgetUsd` (profiles cannot
  set them; one shared constant backs both checks), `model` (kept reviewable, as above; attempt
  request summaries record it anyway) and `env` (its values are always dropped). Accepting them
  would promise a redaction that changes nothing.
- The projection moves each listed key out of both copies into one entry,
  `redacted.harnesses.<name>.<key>`, a `RedactedControl` built by the same helper as the built-in
  controls. Both copies hold the same value, so one entry per harness and key suffices. An object
  gets sorted top-level `keys`; strings, numbers, booleans and arrays get `sha256` only, because
  array indexes are not names. As for the built-in controls, the entries live in the `redacted`
  sibling rather than replacing the value in place, so a raw value that looks like a digest cannot
  be confused with one and a second pass leaves these entries unchanged (the registered `env` digest
  is not yet idempotent; #248).
- The projection learns the declarations explicitly: `publicCapabilityManifest(manifest, harnesses)`
  takes them as a required parameter, so a new call site cannot silently skip them.
  `capabilityManifest` passes the definition's registrations, and the runner passes the root
  definition's, because a run record holds the root manifest. Hidden metadata on the manifest or a
  new field on the live `ResolvedProfile` were rejected: either would change the live or persisted
  shape for every caller.
- Grant pins, step identity and child delegation keep reading the live manifest, so declaring a key
  sensitive changes no pin and no completed step's identity, and rotating a sensitive value still
  invalidates both.
- `redacted.harnesses` changes the nested `capabilities` shape, so the record schema revision moves
  to 9 ([ADR 0052](0052-run-record-schema-revision.md)): a revision-8 build refuses to rewrite such
  a record instead of failing its parse. There is still no migration; an older checkpoint is
  scrubbed the next time it executes. The definition registry cache envelope moves from version 3 to
  4, so a cached validate result that printed a now-sensitive option is never served.

Step records, attempt request summaries, prompts, events and argv stay outside the projection; an
adapter that puts an option into argv or a prompt still exposes it there. The digest trade-off above
applies unchanged: a short or guessable sensitive value can be confirmed by guessing.
