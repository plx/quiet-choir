# 0068: Scope the standard library as typed inventories and team-typed patterns

- Status: proposed
- Issue: to be filed (the standard-library epic)
- Builds on: [0063](0063-bound-agents-and-typed-rosters.md) §3 (entries to spread),
  [0065](0065-workflow-packages.md) (packages) and [0067](0067-teams-as-typed-slots.md) §3 (patterns
  take teams)

## Context

`quiet-choir/std` was seeded (#588) with the roster fragments, tiers, exec helpers and two patterns
the first package ports needed, and ADRs 0063, 0065 and 0067 deferred its scope to a record written
once the ports showed what recurs. The 26 direct and 6 idiomatic Workflow Lab ports, the two
packages and the cookbook now show it:

- **Data.** A located finding appears in 15 variants across 13 files, a refutation verdict in 10, an
  implementer report in 9 and a critique with fixes in 8. Most direct-port schemas use
  `.catchall(z.json())` and unbounded numbers. A rank table for an enum is copied 7 times, a dedupe
  key 9 times and majority arithmetic 4 times.
- **Shapes.** Find, dedupe and adversarially verify recurs in 9 originals; a multi-lens fan-out in
  12; critique and repair in 8; a command-checked fix loop in 6; and an escalation ladder from a
  mechanic to a surgeon in both packages. The originals drop failed agents with `.filter(Boolean)`
  53 times; the direct ports throw instead. Only one idiomatic port journals failures and reports a
  degraded status.
- **Roles.** Both package rosters spell the same allowlisted reader and editor blocks by hand, the
  name `Reviewer` has seven configurations, and stance text such as "you do not edit code" or
  "default to refuted" is repeated in per-call prompts instead of standing on the entry.

A port therefore spends most of its 200 to 340 lines on plumbing, and its schemas and failure
handling drift from port to port.

## Decision

1. **Scope: three inventories and the helpers they need, on the public entry point.** The library
   holds a roster inventory (`std.claude`, `std.codex`, `std.tiers`, `std.limits`, `std.personas`,
   `std.roles`, `std.rosters` and `std.bash`), data (`std.types` and `std.lenses`), helpers
   (`std.data`, `std.text` and `std.exec`), team-free control flow (`std.flow`) and team-typed
   patterns (`std.patterns`). Every module imports only the public entry point, its siblings and
   Node built-ins, and the directory stays flat, as the ESLint rule requires. Nothing is registered
   with the runtime; every piece is an ordinary composition of public context methods.

2. **The roster inventory composes along independent axes.** A capability fragment (tools or
   sandbox), a model tier, a limits fragment and a persona (a Claude `appendSystemPrompt`) compose
   by spread, in that order, so each later `description` wins. `std.roles` names the useful
   combinations as complete entries, and `std.rosters.readers` (every role without write or exec
   access, so it needs no grant under `requireGrants`) and `std.rosters.standard` declare them. A
   shell is an allowlist: `std.claude.shell(rules)` exposes `Bash` narrowed to `std.bash` rule sets
   and denies `git push`, so it is `exec`. Tiers, limits and personas are Claude-only; Codex has no
   standing prompt, so a Codex call prepends the persona text instead.

3. **Agent-output types are strict, bounded and rehearsable.** Every schema an agent answers has an
   object root and required properties (`.nullable()` for absence), uses no record, tuple,
   discriminated union or loose object, so it passes Codex's strict check, and uses no regex or
   format validator, so fixture rehearsal can synthesize it. Text is non-empty, lists are bounded,
   and each field's `.describe()` text tells the agent what to return. Input-side primitives (`Sha`,
   `Key`, `Argv`, `limit`) may use regexes and tuples.

4. **A pattern is a function over the context, a team and an options object, with a fixed
   contract.**
   - It takes a required `id` and runs under `ctx.scope(id, ...)`; its TSDoc lists the exact step
     IDs it records.
   - Every decision that tolerates a failed agent (a vote, a quorum, a fallback) goes through a
     settled map or an `onError: 'return'` call, so the failure is journaled and replays the same
     way. Results report failure counts and a `status` instead of filtering failures out.
   - A settled map's items carry the rendered prompt text, so a prompt change is detected by the
     map's fingerprint; the caller's `version` revises what items do not show, such as a schema.
   - `calls` (a `CallDefaults`) supplies placement, retry and deadlines for every agent call.
   - Default prompts are built with `std.text.brief`, and a skeptical slot's prompt names the safe
     default its persona falls back to.
   - `std.flow` helpers that run a caller callback in a settled map pass the callback itself as the
     mapper, so its source is fingerprinted.

5. **Released text is identity.** Default prompts, schemas and their descriptions, persona and lens
   text, and role options are part of the step identity of the calls that use them. They change only
   by adding a new name or revising a pattern's documented version; the tests pin their digests so a
   change is deliberate.

6. **Out of scope.** Patterns stay in-process: a child workflow that takes a team is still deferred
   (ADR 0067 §3), and a pattern that called `ctx.workflow` would force every caller to declare std
   definitions in its `children`. Deciders cannot fill a team slot. Packages refuse `.js` modules,
   so the library ships no runnable package; one-screen recipes in `examples/patterns` show each
   pattern instead.

## Alternatives

- **Keep the seed and let packages grow their own helpers.** Rejected: the ports show the same
  shapes, schemas and roles copied with drift, and the drift is in failure handling, where it costs
  most.
- **Ship patterns as child workflows.** Rejected for now: children cannot take bound agents, and
  declaring std definitions in every caller's `children` is worse than a function call.
- **Lenient output types (optional fields, `catchall`).** Rejected: they fail Codex's strict mode,
  hide drift in field names, and cannot be rehearsed reliably.
- **One module per pattern under `src/std/patterns/`.** Rejected: the import rule keeps std flat;
  related patterns share a module and `std.patterns` re-exports them.

## Consequences

- A workflow that uses the library spends its lines on what is specific to it; the cookbook's
  `std-*` recipes are complete workflows of at most 30 lines.
- Changing a released prompt, schema, persona or lens breaks replay of completed calls that used it,
  as any prompt change does; the library evolves by addition.
- The packages can replace their hand-spelled shell blocks with `std.claude.shell` and
  `std.claude.editShell` without changing identity, since the values are equal.
- `model.ts`, the API snapshot and the record schema revision are unchanged.
