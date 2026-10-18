# 0067: Declare team structures as typed slots filled from the roster

- Status: proposed
- Issue: to be filed (the packaged-workflows epic)
- Builds on: [0063](0063-bound-agents-and-typed-rosters.md) (`Agent` and the roster)

## Context

A higher-order pattern such as actor-critic, review-revise, a tolerant panel or loop-until-dry names
roles independently of which configured agent fills them. Today a helper can only take positional
`Agent` parameters or constrain a context to profile names. Child delegation's same-name role
matching looks like slot filling but is an authorization ceiling, and ADR 0063 moves it behind
`requireGrants`.

Two roster-like concepts must stay distinct: the inventory of configurations that exist (ADR 0063),
and the team structure a pattern needs. A team must not encode minimum capability levels, least of
all across harnesses; the slot names and the pattern's documentation carry that intent. The system
is not yet dog-fooded, so this record is deliberately small.

## Decision

1. **A team is a type of named `Agent` slots.**

   ```ts
   export const ReviewTeam = defineTeam({
     actor: 'Produces the artifact under review.',
     critic: 'Judges the artifact against the brief and returns findings.',
   });
   export type ReviewTeam = TeamOf<typeof ReviewTeam>; // { readonly actor: Agent; readonly critic: Agent }
   ```

   `defineTeam` takes slot names with one-line descriptions and returns a value carrying `slots`
   (for documentation and `validate` output) and a `from` helper. `TeamOf` derives the record type.
   Nothing is registered with the runtime and no runtime check compares a slot to the agent that
   fills it.

2. **Filling is explicit at the call site.**

   ```ts
   await reviewRevise(ctx, {
     team: { actor: ctx.roster.Mechanic, critic: ctx.roster.Reviewer },
     brief,
     rounds: 3,
   });
   ```

   A team value is a plain object of `Agent` values. `ReviewTeam.from(record)` is the one
   convenience: it picks the slot keys from any record that has them, so
   `ReviewTeam.from(ctx.roster)` fills a team whose roster uses the slot names, and
   `ReviewTeam.from({ ...ctx.roster, critic: ctx.roster.Skeptic })` overrides one slot. Matching
   lives in that helper, typechecked, and never in the runtime.

3. **Scope: in-process patterns only.** A pattern is a function over a context that takes a team
   among its parameters. The standard library's higher-order pieces take teams this way. Child
   workflows parameterized by a team are deferred: a child would declare slots on its definition and
   the parent would pass roster entry data rather than bound agents, because a child binds against
   its own context. That design waits for a ported package to need it; the two native scripts being
   ported are flat.

4. **Where it lives.** `defineTeam`, `TeamOf` and `Team<K>` are exported from the root entry point
   from a module outside `model.ts`, so the Workflow Lab `apiSnapshot` does not change.

## Alternatives

- **Fill slots by name in the runtime.** Rejected: roster names describe configurations (Reviewer)
  and slot names describe roles (critic), so they rarely coincide, and explicit filling is what
  makes the pattern's intent legible in the workflow body.
- **Minimum capability per slot.** Rejected: it recreates the cross-harness lattice ADR 0063
  retires. Expectations go in the slot description.
- **Positional `Agent` parameters.** Rejected: names carry intent and positional actor-critic order
  is error-prone.
- **Teams as a `defineWorkflow` field now.** Deferred: see §3.

## Consequences

- One small public module and no runtime change.
- Standard-library patterns gain a uniform parameterization, and a pattern's `slots` appear in
  package validation output beside its roster.
- A later record covers child workflows that take teams, once a port shows the need.
