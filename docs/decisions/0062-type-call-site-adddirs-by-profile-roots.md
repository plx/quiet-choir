# 0062: Type call-site Claude addDirs by profile roots

- Status: accepted
- Issue: #385 (found while implementing #171)
- Amends: [0054](0054-bounded-call-site-adddirs.md) §7 (types)
- Builds on: [0010](0010-agent-profiles-and-grants.md) (profiles and grants) and
  [0026](0026-inline-children-and-definition-registry.md) (typed children)

## Context

ADR 0054 lets a strict Claude call pass `addDirs` when its profile declares `claude.addDirRoots`.
The types could not tell rooted profiles from the rest, so `CallOptions` admitted Claude `addDirs`
under every profile. A call on a profile without roots compiled and then failed when the call ran
with `strictProfiles forbids call-site addDirs`. Every other strict key already fails at typecheck
and in `workflow validate` (`load.typecheck`).

Narrowing the type per profile needs a new type parameter on `WorkflowDefinition` in
`src/workflow/runtime/model.ts`. That file is the Workflow Lab `apiSnapshot` contract, so the change
is a deliberate API decision. ADR 0054 deferred it.

## Decision

Adopt precise typing, under one rule: **a type rejects call-site Claude `addDirs` only when the
types prove the runtime would reject them.** Where inference cannot see a profile's shape, the type
stays permissive and the runtime check remains the backstop. Runtime behavior is unchanged.

1. **One trailing, defaulted parameter.** `WorkflowDefinition` gains an eighth parameter,
   `TAddDirProfile extends string | undefined = string | undefined`. `WorkflowContext` (fifth) and
   `CallOptions` (fifth) carry it too. It is the set of `profile` values under which a strict Claude
   call may pass `addDirs`; `undefined` stands for a call that omits `profile` when the default
   profile is rooted. The default `string | undefined` admits every profile, so
   `WorkflowDefinition<I, O>`, a bare `WorkflowContext` helper and erased declarations behave as
   before, and existing positional spellings stay valid.
2. **Call options.** In the strict Claude branch, `addDirs` joins the other forbidden keys, and
   `ClaudeAddDirSelection` adds it back as a union: any profile without `addDirs`; a profile in the
   set with `addDirs`; and, when `undefined` is in the set, an omitted profile with `addDirs`. A
   union-typed profile variable therefore still compiles without `addDirs`, while a pre-built
   options variable or an explicit `addDirs: undefined` on an unrooted profile is rejected like the
   other keys. Codex `addDirs`, the non-strict branch and registered harnesses are unchanged.
3. **Inference.** Only `defineWorkflow` infers. It gains two trailing type parameters,
   `const TProfiles` and `const TDefaults` (both defaulting to `{}`, meaning "none declared"), read
   from the `profiles` and `defaults` properties, and computes
   `AddDirProfilesOf<TProfile, TProfiles, TDefaults>`. That mirrors profile resolution, where
   provider arrays replace but never remove roots:
   - `defaults.claude.addDirRoots` roots every built-in and declared profile, and the omitted case.
   - Otherwise a built-in is unrooted, because declared roles cannot reuse its name.
   - A declared role is rooted when it, or a profile on its `extends` chain, declares roots. A role
     without `extends` starts from `text` and is unrooted. A cycle is unrooted; the runtime rejects
     it.
   - The omitted case is rooted when `defaults.profile` (or `text` when absent) is rooted.

   An inferred literal is checked against itself, so inference alone would drop the excess-property
   checks on `profiles` and `defaults`. `defineWorkflow` therefore intersects them with
   `NoExtraKeys`, which maps every key that `AgentProfile` or `AgentDefaults` does not declare to
   `never`, at the top level and recursively inside nested objects such as the `claude` and `codex`
   blocks and structured `env` edits. Arrays and index-signature shapes (`harnesses`, native
   settings, MCP servers, subagents, the flat `env` overlay) stay open, and a union field type
   accepts a value that matches one member, so `env: { FOO: 'bar' }` still compiles.

   `TProfiles` is constrained only to `object`, not to `Record<string, AgentProfile>`: an interface
   has no string index signature and would fail that constraint, although it is a valid finite
   profile map. The `WorkflowDefinition` `profiles` property and the `NoExtraKeys` intersection
   still validate the values.

4. **Permissive fallbacks.** These count as rooted: a `claude` block whose `addDirRoots` key is
   possibly present (a widened `AgentProfile` or `AgentDefaults`), a non-literal `extends` or
   `defaults.profile`, a union-typed profile or defaults any member of which is rooted (a member
   that omits `extends` or `profile` contributes `text`), a non-literal role name, and a role that
   `TProfiles` does not describe.
5. **Variance.** The parameter appears only as the checked type of conditional types, never in an
   `extends` clause, so TypeScript does not measure contexts as invariant in it. Typed definitions
   stay assignable to `WorkflowDefinition<I, O>`, `WorkflowDeclaration`, `runWorkflow` and
   `ctx.workflow` parameters through the default, and a narrowed context still reaches a helper
   typed `WorkflowContext<'role', BuiltInHarnesses, true>`. A draft that tested the parameter in an
   `extends` clause measured as invariant, and the structural fallback then failed on the typed
   by-name `ctx.workflow` overloads.
6. **Unchanged sites.** `runWorkflow` and the typed-child `ctx.workflow` overloads keep inferring
   seven parameters and accept narrow definitions through the default. A child stays typed by its
   own definition; delegation is not narrowed at type level.

The new public types are `AddDirProfilesOf`, its helpers `AddDirRootedName`, `HasAddDirRoots` and
`ProfileReferenceOf`, `ClaudeAddDirSelection`, and `NoExtraKeys`. They are public rather than
`@internal` because `stripInternal` would remove them from the emitted declarations that
`CallOptions` and `defineWorkflow` reference.

## Alternatives

- **Keep the check runtime-only and document it.** Rejected: it leaves the one strict key that
  compiles and fails late, and `workflow validate` cannot report it.
- **Infer on `WorkflowDefinition` itself,** with profile and defaults shape parameters. Rejected: it
  would add two parameters to the snapshot contract instead of one, and every helper and overload
  that spells the definition would have to carry them.
- **Infer only a projection of the profiles** (`extends` and the presence of roots) through a mapped
  inference site. Not needed: `const` inference of the whole object keeps array-valued controls
  assignable, because TypeScript falls back to mutable arrays where the constraint is mutable
  (`JsonValue[]` in `settings`). A test pins this.

## Consequences

- A strict Claude call that passes `addDirs` under a profile without `claude.addDirRoots`, including
  the implicit default `text`, fails typecheck and `workflow validate` (`load.typecheck`). A rooted
  profile, a role inheriting roots, a rooted `defaults.profile`, and rooted `defaults.claude` still
  accept it.
- Explicit `defineWorkflow` type arguments, the documented all-or-nothing prefix form, leave
  `TProfiles` and `TDefaults` empty. Declared names then stay permissive, while built-ins and the
  omitted profile read as unrooted. A workflow written that way that relies on
  `defaults.claude.addDirRoots` or a rooted `defaults.profile` must drop the type arguments, which
  the docs already recommend. Omitted `profiles` or `defaults` must mean "none", so their defaults
  have to be `{}`, and that case cannot be told apart.
- **apiSnapshot.** `model.ts` changes: `WorkflowDefinition` and `WorkflowContext` gain a trailing
  defaulted parameter and `defineWorkflow` two trailing inferred ones. The `apiSnapshot.sha256`
  value in both `comparisons/batches/*/batch.json` files is bumped to the new hash in the same
  change. No port changes: both batches compile unchanged, their imported `satisfies`-typed profiles
  have a non-literal `extends` and stay permissive.
- Union-typed options can make some error messages name the `addDirs` selection instead of the
  offending key. Schema inference in `value` and `object` is unaffected.
