# 0033: Redact free-form controls from public capability manifests

- Status: accepted
- Issue: #103
- Extends the environment precedent of [ADR 0023](0023-restricted-harness-configuration.md) and the
  grant pins of [ADR 0010](0010-agent-profiles-and-grants.md).

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
- Custom harness option values other than `env` keep their current behavior. Adapter-declared
  sensitive keys are a follow-up.

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
- `extraArgs` and custom-harness option values other than `env` remain visible in manifests.
- Prompts and previews in step records, and argv, are outside capability manifests and stay
  documented as plaintext state.
