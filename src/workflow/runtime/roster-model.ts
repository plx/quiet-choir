import type {
  CapabilitiesOf,
  HarnessCapabilities,
  HarnessDeclaration,
  OptionsOf,
  RegisteredAgentClient,
} from './harness-model.js';
import type {
  Agent,
  AgentClient,
  BindOptions,
  BoundOptionsOf,
  ClaudeOptions,
  CodexOptions,
  EffectResult,
  ErrorMode,
  Prompt,
  SelectBranch,
  Settled,
} from './model.js';
import type { DecideOptions, DecisionAnswers, DecisionQuestions } from './decision-model.js';
import type { NoExtraKeys } from './profiles-model.js';

// ADR 0063 sections 3-4: the roster is the one inventory of concrete, harness-pinned agent
// configurations, and ADR 0066 section 2 adds decider entries that name a decision provider. These
// types are data only; `defineRoster` (roster.ts) validates and freezes.

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
    ? { readonly [K in keyof F]: DeepReadonlyOption<F[K]> }
    : never;

/**
 * `T` made readonly at every depth, so a `defineRoster` literal (inferred readonly under `const`)
 * matches a registered harness whose schema declares mutable arrays, such as `z.array(z.string())`
 * or an object option holding one. Arrays and tuples become readonly with their positions and
 * length kept, plain objects map their properties, and functions and primitives are unchanged. It
 * distributes over unions.
 */
export type DeepReadonlyOption<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonlyOption<T[K]> }
    : T;

/**
 * A decider entry (ADR 0066 section 2): a named decision provider and model, which
 * `ctx.roster.Name` binds to a {@link RosterDecider}. `decider` names one of the workflow's
 * `decisions`, checked when the workflow loads. `model` is the requested model (else the operator
 * configuration's, then the declaration's default), and both are fixed for every call. A decider
 * entry is not an agent or a role: it takes no other key, has no grant, `--profile` override or
 * capability profile, and cannot fill a team slot.
 */
export interface RosterDeciderEntry {
  /** The decision provider's name, as declared in the workflow's `decisions`. */
  readonly decider: string;
  /** The requested model, part of each decision's identity. */
  readonly model?: string;
  /** Human-readable purpose, listed under `workflow.deciders` by `workflow validate`. */
  readonly description?: string;
  /** A decider entry names a decision provider, never a harness. */
  readonly harness?: never;
}

/**
 * One roster entry: an agent pinned to a harness, or a decider ({@link RosterDeciderEntry}). An
 * agent entry is `{ harness, description?, expectsToolUse? }` plus that harness's own option type
 * minus the per-call-only keys and `profile` (ADR 0063 section 3). `harness` is the discriminant:
 * `'claude'` takes {@link ClaudeOptions}, `'codex'` takes {@link CodexOptions}, and a registered
 * harness in `H` takes its declared option schema. There is no cross-harness block and no
 * `extends`; spread a shared entry instead. An entry that sets both `harness` and `decider` fails
 * typecheck.
 */
export type RosterEntry<H extends readonly HarnessDeclaration[] = readonly []> =
  | ({
      /** Claude Code. */
      readonly harness: 'claude';
      /** An agent entry names a harness, never a decision provider. */
      readonly decider?: never;
    } & RosterEntryCommon &
      RosterEntryOptions<ClaudeOptions>)
  | ({
      /** Codex. */
      readonly harness: 'codex';
      /** An agent entry names a harness, never a decision provider. */
      readonly decider?: never;
    } & RosterEntryCommon &
      RosterEntryOptions<CodexOptions>)
  | (H[number] extends infer D
      ? D extends HarnessDeclaration
        ? {
            /** A harness registered with `defineRoster` options and the workflow's `harnesses`. */
            readonly harness: D['name'];
            /** An agent entry names a harness, never a decision provider. */
            readonly decider?: never;
          } & RosterEntryCommon &
            RosterEntryOptions<OptionsOf<D>>
        : never
      : never)
  | RosterDeciderEntry;

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
 * Roster entry `E` as `defineRoster` stores it: a {@link Prompt} in `systemPrompt` or
 * `appendSystemPrompt` reads as `string`, since the roster keeps its rendered text. Every other
 * field keeps its type.
 */
export type StoredRosterEntry<E> = {
  readonly [K in keyof E]: K extends 'systemPrompt' | 'appendSystemPrompt'
    ? E[K] extends infer V
      ? V extends Prompt
        ? string
        : V
      : never
    : E[K];
};

/**
 * A frozen, validated roster returned by `defineRoster`: the entries `E` by name, as stored
 * ({@link StoredRosterEntry}), plus a type-only brand that carries the declared entries and the
 * registered harnesses `H`. `WorkflowDefinition.roster` accepts only this type, so an inline
 * object literal cannot bypass the per-harness entry typing.
 */
export type Roster<
  E extends object = RosterEntries<readonly HarnessDeclaration[]>,
  H extends readonly HarnessDeclaration[] = readonly HarnessDeclaration[],
> = { readonly [K in keyof E]: StoredRosterEntry<E[K]> } & {
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
 * The options of one `ctx.roster.Name.decide` call: those of `ctx.decide` ({@link DecideOptions})
 * without `provider` and `model`, which the decider entry fixes.
 */
export type RosterDecideOptions<Q extends DecisionQuestions = DecisionQuestions> = Omit<
  DecideOptions<Q>,
  'provider' | 'model'
> & {
  /** Fixed by the decider entry; a call cannot set it. */
  readonly provider?: never;
  /** Fixed by the decider entry; a call cannot set it. */
  readonly model?: never;
};

/**
 * What `ctx.roster.Name` gives for a decider entry ({@link RosterDeciderEntry}): `decide`, which is
 * `ctx.decide` with the entry's provider and model preset. A call records the same step, with the
 * same `decision/2` identity, as `ctx.decide(id, { provider, model, ... })` spelling them, and adds
 * the entry name as the step's `meta.roster` label, which is never identity. It is not an
 * {@link Agent}.
 */
export interface RosterDecider {
  /**
   * Ask the entry's decision provider typed questions about a JSON state, as `ctx.decide` does;
   * with `onError: 'return'`, a final failure is saved and returned as `Settled`. A call that sets
   * `provider` or `model` fails typecheck and, untyped, fails the step before any request.
   */
  decide<const Q extends DecisionQuestions>(
    id: string,
    options: RosterDecideOptions<Q> & { readonly onError: 'return' },
  ): Promise<Settled<DecisionAnswers<Q>>>;
  /** Ask the entry's decision provider with an inferred or dynamic error mode. */
  decide<const Q extends DecisionQuestions, TMode extends ErrorMode = 'throw'>(
    id: string,
    options: RosterDecideOptions<Q> & { readonly onError?: TMode | undefined },
  ): Promise<EffectResult<DecisionAnswers<Q>, TMode>>;
}

/**
 * What `ctx.roster.Name` gives for entry `E`, typed against the registered harnesses `H`. A decider
 * entry gives a {@link RosterDecider}. An agent entry gives the type `bind` gives for the entry's
 * options ({@link RosterEntryBindOptions}). That is an {@link Agent} for Claude, the Codex bound
 * client (an `Agent` that also takes per-call `images`) for Codex, and for a registered harness `D` a
 * `RegisteredAgentClient` over `D`'s own bound call options and capabilities. A both-sides key the
 * schema requires stays required on calls unless the entry sets it, and a text-only registration
 * yields a text-only agent without `object` or a schema-bearing `value`. An entry whose harness is
 * not in `H` gives `Agent<HarnessCapabilities>`.
 */
export type RosterAgentOf<E, H extends readonly HarnessDeclaration[]> = E extends {
  /** The decision provider of a decider entry. */
  readonly decider: string;
}
  ? RosterDecider
  : E extends {
        /** The pinned harness. */
        readonly harness: infer N;
      }
    ? N extends 'claude'
      ? Agent
      : N extends 'codex'
        ? AgentClient<
            BoundOptionsOf<
              SelectBranch<CodexOptions, RosterEntryBindOptions<E>>,
              RosterEntryBindOptions<E>
            >
          >
        : [Extract<H[number], NamedHarness<N>>] extends [never]
          ? Agent<HarnessCapabilities>
          : Extract<H[number], NamedHarness<N>> extends infer D
            ? RegisteredAgentClient<
                BoundOptionsOf<
                  SelectBranch<OptionsOf<D>, RosterEntryBindOptions<E>>,
                  RosterEntryBindOptions<E>
                >,
                CapabilitiesOf<D>
              >
            : Agent<HarnessCapabilities>
    : never;

/** The options of roster entry `E` that `bind` receives: the entry minus its roster-only fields. */
export type RosterEntryBindOptions<E> = Omit<
  E,
  'harness' | 'decider' | 'description' | 'expectsToolUse'
>;

/** A harness declaration named `N`: what {@link RosterAgentOf} selects an entry's harness by. */
export interface NamedHarness<N> {
  /** The registered harness name. */
  readonly name: N;
}

/**
 * The type of `ctx.roster` for a workflow whose roster is `TRoster`: one readonly agent, or
 * {@link RosterDecider} for a decider entry, per entry name ({@link RosterAgentOf}), so a
 * misspelled name fails typecheck. An unparameterized context
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
