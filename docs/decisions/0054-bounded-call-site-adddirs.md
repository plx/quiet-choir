# 0054: Bound call-site Claude directories by declared profile roots

- Status: accepted
- Issue: #171
- Builds on: [0010](0010-agent-profiles-and-grants.md) (profiles and grants),
  [0026](0026-inline-children-and-definition-registry.md) (child delegation),
  [0033](0033-redact-free-form-controls-from-public-manifests.md) (public manifests) and
  [0052](0052-run-record-schema-revision.md) (schema revision)

## Context

Under the default `strictProfiles: true` a call cannot pass `addDirs`, and profiles are static. A
directory known only at runtime, such as a per-PR state directory an earlier step creates, could be
made readable to one agent only by widening its `cwd` or by `strictProfiles: false`, which lifts the
bound for every capability. Claude's access class comes from its tools (`addDirs` with no tools is
`read`), so a directory does not raise a Claude role's class. Codex is different: its `addDirs` are
writable sandbox roots, so any Codex directory makes the call `write`.

## Decision

1. **Profile-only roots.** A Claude profile (or `defaults.claude`) may declare `addDirRoots`, a
   nonempty list of nonempty strings. It is not a call option and is stripped from resolved call
   options, so the option validator, the harness and step identity never see it. The declared
   strings are kept verbatim in the manifest, `workflow validate --json` and `profileGrantDigest`,
   so digests do not depend on the machine or checkout. Provider arrays replace across `extends` and
   defaults layers, as before. Roots are trusted author declarations pinned by grants; at call time
   they resolve against the run's working directory and are canonicalized.
2. **Path policy.** A call entry with a `..` segment is refused before resolution, because a lexical
   normalize of `root/link/../x` would hide a symlink escape. Entries resolve against the call's
   effective cwd (`resolve(runCwd, options.cwd ?? '.')`, the base the invocation uses). Both sides
   are canonicalized: the real path of the deepest existing ancestor plus the remaining, nonexistent
   segments, so a directory a later step creates can still be named while an existing symlink that
   leaves a root is followed and caught. A dangling symlink on the path is refused, since its target
   could later be created outside the root. An entry is accepted when its canonical path equals or
   sits inside a canonical root (`path.relative`). Accepted entries are replaced by their canonical
   absolute paths, which reach `--add-dir`, step identity and the request summary; a
   worktree-isolated call therefore cannot re-resolve a relative entry somewhere other than where it
   was checked.
3. **Append.** On the strict-plus-roots path, the resolved `addDirs` are the profile's own `addDirs`
   followed by the canonical call entries, with exact duplicates removed, so a call cannot drop a
   declared directory. Under `strictProfiles: false` nothing changes: the call replaces the list,
   without canonicalization or root enforcement. A profile without roots, a Codex call, and any
   other raw key keep the existing `strictProfiles forbids call-site …` error.
4. **Grants and access.** On the strict-plus-roots path, call-site `addDirs` are not treated as a
   raw capability, so a named grant still authorizes the call; this is safe because the roots are
   pinned. `profileGrantDigest` includes `claude.addDirRoots` only when it is declared, so every
   existing pin is unchanged. A tool-less rooted Claude role is classified `read`, which matches
   what it may be given; a write-capable role still needs its write grant.
5. **Codex.** `codex.addDirRoots`, on a profile or on defaults, fails validation before the schema
   parse with a message that Codex directories are writable roots and must be listed statically in
   `codex.addDirs`. The authoring type declares it as `never`.
6. **Child delegation.** The runner hands the run cwd to `delegateCapabilities`. A child's Claude
   directory is delegated when the parent role lists it literally or, when absolute, when it lies
   canonically inside one of the parent's roots; relative entries still need literal membership,
   because they resolve against an effect cwd that is unknown at delegation. Each child root must
   lie canonically inside some parent root, otherwise
   `Child profile … exceeds parent profile …: claude.addDirRoots`. Codex directories keep literal
   membership. Without a run cwd (direct callers), only literal membership delegates.
7. **Types.** Under strict profiles, Claude `addDirs` stays a permitted call-site key, with the
   runtime check as the backstop; Codex `addDirs` and every other capability key stay `never`.
8. **Records.** Attempt and step request summaries record `addDirs` as passed to the harness, only
   when nonempty: profile entries as declared (a worktree attempt resolves them against its own cwd)
   and call-site entries canonical. Together with the manifest's nested `addDirRoots` this makes
   schema revision 4. A revision-3 build cannot read a record whose manifest declares roots, since
   its manifest parse is strict.

Restricted mode is untouched: the bounded path only adds `--add-dir`;
`--restricted --strict-mcp-config` stays, and no setting that loads instructions from added
directories is enabled.

## Alternatives

- **A lexical check only** (`path.normalize` and a prefix test). Rejected: a symlink inside a root
  can point anywhere, and a lexical `..` collapse hides a symlinked component.
- **Roots under Codex.** Rejected: Codex has no read-only additional directory, so a bounded opt-in
  would hand out writable roots at the call site.
- **Precise per-profile typing,** allowing call-site Claude `addDirs` only for profiles that declare
  roots. It needs a new `WorkflowDefinition` type parameter in `model.ts`, the Workflow Lab API
  snapshot contract; deferred to a follow-up.

## Consequences

- A strict workflow can give one Claude role read access to a runtime-chosen directory without
  widening its cwd or turning off strict profiles, and the grant pin covers the roots.
- The check runs when the call is resolved, not when the CLI opens the directory, so a concurrent
  writer that swaps a path component for a symlink in between is not caught. Closing that race would
  need a file descriptor handoff the CLIs do not offer.
- Resolution also runs on replay. If a symlink under a root is retargeted outside it after the step
  completed, resume fails that step's resolution; a retargeted ancestor also changes the canonical
  path and therefore the identity. Both are deliberate, conservative outcomes.
- A strict Claude call with `addDirs` on a profile without roots now compiles and fails at run time
  instead of at typecheck.
- Profiles that declare no roots produce byte-identical requests, identities and grant digests.
