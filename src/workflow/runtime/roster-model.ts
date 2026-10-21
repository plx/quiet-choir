import type {
  CapabilitiesOf,
  HarnessCapabilities,
  HarnessDeclaration,
  OptionsOf,
} from './harness-model.js';
import type {
  Agent,
  AgentClient,
  BindOptions,
  BoundOptionsOf,
  ClaudeOptions,
  CodexOptions,
} from './model.js';
import type { NoExtraKeys } from './profiles-model.js';

// ADR 0063 sections 3-4: the roster is the one inventory of concrete, harness-pinned agent
// configurations. These types are data only; `defineRoster` (roster.ts) validates and freezes.

/** Type-only marker that only `defineRoster` results carry; it never exists at runtime. */
declare const rosterBrand: unique symbol;

/** Fields every roster entry may set, whatever its harness. */
export interface RosterEntryCommon {
  /** Human-readable purpose, shown in the capability manifest of `workflow validate`. */
  readonly description?: string;
  /**
   * Whether this entry expects tools. A completed attempt with a known zero tool count then
   * records a `no-tool-use` step warning. Defaults to true when the pinned harness grants more
   * than the text baseline: any Claude tool, a Codex sandbox beyond read-only, or a registered
   * harness whose access is above `none`.
   */
  readonly expectsToolUse?: boolean;
}

/**
 * The options one entry pinned to a harness with call options `O` may set: everything `bind`
 * accepts ({@link BindOptions}, so no per-call-only key), minus `profile`. The both-sides keys
 * (`addDirs`, `timeoutMs`, `idleTimeoutMs`) are defaults a call may extend or replace.
 */
export type RosterEntryOptions<O> =
  Omit<BindOptions<O>, 'profile'> extends infer F
    ? { readonly [K in keyof F]: ReadonlyArrayOf<F[K]> }
    : never;

/**
 * `T` with a mutable array type made readonly, so a `defineRoster` literal (inferred readonly
 * under `const`) matches a registered harness whose schema declares a mutable array, such as
 * `z.array(z.string())`. Other types are unchanged. It distributes over unions.
 */
export type ReadonlyArrayOf<T> = T extends readonly (infer U)[] ? readonly U[] : T;

/**
 * One roster entry: `{ harness, description?, expectsToolUse? }` plus that harness's own option
 * type minus the per-call-only keys and `profile` (ADR 0063 section 3). `harness` is the
 * discriminant: `'claude'` takes {@link ClaudeOptions}, `'codex'` takes {@link CodexOptions}, and a
 * registered harness in `H` takes its declared option schema. There is no cross-harness block and
 * no `extends`; spread a shared entry instead.
 */
export type RosterEntry<H extends readonly HarnessDeclaration[] = readonly []> =
  | ({
      /** Claude Code. */
      readonly harness: 'claude';
    } & RosterEntryCommon &
      RosterEntryOptions<ClaudeOptions>)
  | ({
      /** Codex. */
      readonly harness: 'codex';
    } & RosterEntryCommon &
      RosterEntryOptions<CodexOptions>)
  | (H[number] extends infer D
      ? D extends HarnessDeclaration
        ? {
            /** A harness registered with `defineRoster` options and the workflow's `harnesses`. */
            readonly harness: D['name'];
          } & RosterEntryCommon &
            RosterEntryOptions<OptionsOf<D>>
        : never
      : never);

/** The entry map `defineRoster` accepts: identifier keys to {@link RosterEntry} values. */
export type RosterEntries<H extends readonly HarnessDeclaration[] = readonly []> = Readonly<
  Record<string, RosterEntry<H>>
>;

/** Options of `defineRoster`. */
export interface RosterOptions<H extends readonly HarnessDeclaration[]> {
  /**
   * Registered harness definitions whose names entries may use, which also type those entries.
   * The workflow must still list each one in its own `harnesses`.
   */
  readonly harnesses?: H;
}

/**
 * A frozen, validated roster returned by `defineRoster`: the entries `E` by name, plus a
 * type-only brand that carries the registered harnesses `H`. `WorkflowDefinition.roster` accepts
 * only this type, so an inline object literal cannot bypass the per-harness entry typing.
 */
export type Roster<
  E extends object = RosterEntries<readonly HarnessDeclaration[]>,
  H extends readonly HarnessDeclaration[] = readonly HarnessDeclaration[],
> = { readonly [K in keyof E]: E[K] } & {
  /** Type-only brand; absent at runtime. */
  readonly [rosterBrand]: {
    /** The entries, by name. */
    readonly entries: E;
    /** The registered harnesses the entries were typed against. */
    readonly harnesses: H;
  };
};

/** Any {@link Roster}: the constraint of the `roster` field of a workflow definition. */
export interface AnyRoster {
  /** Type-only brand; absent at runtime. */
  readonly [rosterBrand]: {
    /** The entries, by name. */
    readonly entries: object;
    /** The registered harnesses the entries were typed against. */
    readonly harnesses: readonly HarnessDeclaration[];
  };
}

/** The empty roster: what a workflow without `roster` has. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- no entries.
export type EmptyRoster = Roster<{}, readonly []>;

/**
 * The agent `ctx.roster.Name` gives for entry `E`, typed against the registered harnesses `H`: an
 * {@link Agent} for Claude, the Codex bound client (an `Agent` that also takes per-call `images`)
 * for Codex, and `Agent<CapabilitiesOf<D>>` for a registered harness `D`, so a text-only
 * registration yields a text-only agent without `object` or a schema-bearing `value`.
 */
export type RosterAgentOf<E, H extends readonly HarnessDeclaration[]> = E extends {
  /** The pinned harness. */
  readonly harness: infer N;
}
  ? N extends 'claude'
    ? Agent
    : N extends 'codex'
      ? AgentClient<BoundOptionsOf<CodexOptions>>
      : [Extract<H[number], NamedHarness<N>>] extends [never]
        ? Agent<HarnessCapabilities>
        : CapabilitiesOf<Extract<H[number], NamedHarness<N>>> extends infer C extends
              HarnessCapabilities
          ? Agent<C>
          : Agent<HarnessCapabilities>
  : never;

/** A harness declaration named `N`: what {@link RosterAgentOf} selects an entry's harness by. */
export interface NamedHarness<N> {
  /** The registered harness name. */
  readonly name: N;
}

/**
 * The type of `ctx.roster` for a workflow whose roster is `TRoster`: one readonly agent per entry
 * name ({@link RosterAgentOf}), so a misspelled name fails typecheck. An unparameterized context
 * (`any`) gives every name a possibly-text-only agent, so a bare `WorkflowContext` helper stays
 * permissive; take an `Agent` parameter instead of reading `ctx.roster` in a helper.
 */
export type RosterAgents<TRoster> = 0 extends 1 & TRoster
  ? Readonly<Record<string, Agent<HarnessCapabilities>>>
  : TRoster extends {
        /** Type-only brand. */
        readonly [rosterBrand]: {
          /** The entries, by name. */
          readonly entries: infer E;
          /** The registered harnesses. */
          readonly harnesses: infer H extends readonly HarnessDeclaration[];
        };
      }
    ? { readonly [K in keyof E]: RosterAgentOf<E[K], H> }
    : // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- no roster, no agents.
      {};

/**
 * The parameter type `defineRoster` checks entries against: each entry must match a
 * {@link RosterEntry} member, and {@link NoExtraKeys} rejects keys that member does not declare,
 * which a generic parameter would otherwise accept. This is what rejects a `codex` block or
 * `sandbox` on a Claude entry. An entry map whose names did not infer as literals (such as a
 * value typed `Record<string, RosterEntry>`) is refused, since it cannot type `ctx.roster`.
 */
export type CheckedRosterEntries<
  E,
  H extends readonly HarnessDeclaration[],
> = string extends keyof E
  ? // The entry map did not infer literally (an entry matched no harness): refuse it, rather than
    // silently typing `ctx.roster` with an index signature.
    never
  : E & {
      readonly [K in keyof E]: NoExtraKeys<E[K], RosterEntry<H>>;
    };
