/**
 * Complete roster entries for recurring roles: each spreads a capability (`std.claude` or
 * `std.codex`), a model tier (`std.tiers`) and a persona (`std.personas`), in that order, so it is
 * a valid `defineRoster` entry on its own. This is a plain frozen map, not a roster, so a workflow
 * picks the roles it calls and overrides any key by spreading after it.
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * export const roster = defineRoster({
 *   Reviewer: std.roles.Reviewer,
 *   Skeptic: std.roles.Skeptic,
 *   Fixer: { ...std.roles.Mechanic, ...std.limits.Long },
 *   Checker: {
 *     ...std.claude.shell([...std.bash.gitRead, ...std.bash.nodeCheck]),
 *     ...std.tiers.Mechanic,
 *     ...std.personas.Tester,
 *   },
 * });
 * ```
 *
 * | Role            | Composition                                                 | Access  |
 * | --------------- | ----------------------------------------------------------- | ------- |
 * | `Clerk`         | `claude.Text`, `tiers.Clerk`, `personas.Clerk`              | `none`  |
 * | `Writer`        | `claude.Text`, `tiers.Scribe`, `personas.Scribe`            | `none`  |
 * | `Scout`         | `claude.ReadOnly`, `tiers.Copyist`, `personas.Scout`        | `read`  |
 * | `Reader`        | `claude.ReadOnly`                                           | `read`  |
 * | `Researcher`    | `claude.Web`, `tiers.Scribe`, `personas.Researcher`         | `read`  |
 * | `Reviewer`      | `claude.ReadOnly`, opus at high effort, `personas.Reviewer` | `read`  |
 * | `Skeptic`       | `claude.ReadOnly`, `tiers.Skeptic`, `personas.Skeptic`      | `read`  |
 * | `Critic`        | `claude.ReadOnly`, `tiers.Skeptic`, `personas.Critic`       | `read`  |
 * | `Judge`         | `claude.ReadOnly`, `tiers.Judge`, `personas.Judge`          | `read`  |
 * | `Planner`       | `claude.ReadOnly`, `tiers.Planner`, `personas.Planner`      | `read`  |
 * | `Scribe`        | `claude.ReadOnly`, `tiers.Scribe`, `personas.Scribe`        | `read`  |
 * | `Editor`        | `claude.Edit`                                               | `write` |
 * | `Mechanic`      | `claude.Edit`, `tiers.Mechanic`, `personas.Implementer`     | `write` |
 * | `Surgeon`       | `claude.Edit`, `tiers.Surgeon`, `personas.Surgeon`          | `write` |
 * | `CodexReader`   | `codex.ReadOnly`                                            | `read`  |
 * | `CodexReviewer` | `codex.ReadOnly`, high effort                               | `read`  |
 * | `CodexEditor`   | `codex.Edit`                                                | `write` |
 * | `CodexMechanic` | `codex.Edit`, high effort                                   | `write` |
 *
 * The limits are the capability's (`std.limits.Standard` for read-only roles, `Extended` for
 * editing ones); spread a larger `std.limits` fragment for long tasks. No role has a shell, since
 * its allowlist is project-specific: {@link withShell} gives a Claude role one built from
 * `std.bash` rules, keeping its tier and persona, and {@link tester} and {@link fixer} are the
 * common shell roles; or build one by hand with `std.claude.shell` or `std.claude.editShell`, then
 * spread a tier and a persona as in the example. Codex roles carry no persona,
 * because Codex has no standing system prompt: prepend a persona's `appendSystemPrompt` to the
 * prompt instead.
 *
 * ```ts
 * export const roster = defineRoster({
 *   Tester: std.roles.tester([...std.bash.gitRead, ...std.bash.npmRun('lint', 'test')]),
 *   Fixer: std.roles.fixer([...std.bash.nodeCheck, ...std.bash.gitCommit]),
 *   Auditor: std.roles.withShell(std.roles.Reviewer, std.bash.gitRead),
 * });
 * ```
 *
 * | Factory     | Composition                                                  | Access |
 * | ----------- | ------------------------------------------------------------ | ------ |
 * | `withShell` | `claude.shell` or `editShell`, the role's tier and persona   | `exec` |
 * | `tester`    | `claude.shell`, `tiers.Mechanic`, `personas.Tester`          | `exec` |
 * | `fixer`     | `claude.editShell`, `tiers.Mechanic`, `personas.Implementer` | `exec` |
 *
 * `withShell` picks `editShell` for a role that edits. Each factory joins
 * `std.personas.ShellEtiquette` to the persona's `appendSystemPrompt`.
 *
 * Under `requireGrants`, a workflow needs a grant for every `write` or `exec` role in its roster,
 * even one it never calls, so list only the roles a workflow uses (`std.rosters.readers` holds only
 * `none` and `read` roles).
 *
 * @module
 */
import { noPush } from './bash.js';
import * as claude from './claude.js';
import * as codex from './codex.js';
import * as personas from './personas.js';
import * as tiers from './tiers.js';

/** Mechanical text work on Haiku at low effort, with no tools. */
export const Clerk: typeof claude.Text & typeof tiers.Clerk & typeof personas.Clerk = Object.freeze(
  {
    ...claude.Text,
    ...tiers.Clerk,
    ...personas.Clerk,
  },
);

/**
 * Prose from the prompt alone on Sonnet at medium effort, with no tools: drafts and rewrites text,
 * such as the actor of a prose review loop.
 */
export const Writer: typeof claude.Text &
  typeof tiers.Scribe &
  typeof personas.Scribe & {
    /** Writing from the prompt alone uses no tools, so no `no-tool-use` warning is recorded. */
    readonly expectsToolUse: false;
  } = Object.freeze({
  ...claude.Text,
  ...tiers.Scribe,
  ...personas.Scribe,
  expectsToolUse: false,
});

/** A quick, broad read-only survey on Sonnet at low effort, returning leads. */
export const Scout: typeof claude.ReadOnly & typeof tiers.Copyist & typeof personas.Scout =
  Object.freeze({
    ...claude.ReadOnly,
    ...tiers.Copyist,
    ...personas.Scout,
  });

/**
 * `std.claude.ReadOnly` under a role name: a read-only agent with no model, effort or persona, so
 * the workflow's defaults choose them.
 */
export const Reader: typeof claude.ReadOnly = Object.freeze({ ...claude.ReadOnly });

/** Web and file research on Sonnet at medium effort, citing primary sources. */
export const Researcher: typeof claude.Web & typeof tiers.Scribe & typeof personas.Researcher =
  Object.freeze({
    ...claude.Web,
    ...tiers.Scribe,
    ...personas.Researcher,
  });

/** Read-only code review on Opus at high effort, correctness first. */
export const Reviewer: typeof claude.ReadOnly &
  Pick<tiers.Tier<'opus', 'high'>, 'model' | 'effort'> &
  typeof personas.Reviewer = Object.freeze({
  ...claude.ReadOnly,
  model: 'opus',
  effort: 'high',
  ...personas.Reviewer,
});

/** Read-only refutation of a claim on Opus at medium effort, defaulting safe when unsure. */
export const Skeptic: typeof claude.ReadOnly & typeof tiers.Skeptic & typeof personas.Skeptic =
  Object.freeze({
    ...claude.ReadOnly,
    ...tiers.Skeptic,
    ...personas.Skeptic,
  });

/** Read-only critique of a draft against its brief on Opus at medium effort. */
export const Critic: typeof claude.ReadOnly & typeof tiers.Skeptic & typeof personas.Critic =
  Object.freeze({
    ...claude.ReadOnly,
    ...tiers.Skeptic,
    ...personas.Critic,
  });

/** Read-only, final judgement on Opus at extra-high effort. */
export const Judge: typeof claude.ReadOnly & typeof tiers.Judge & typeof personas.Judge =
  Object.freeze({
    ...claude.ReadOnly,
    ...tiers.Judge,
    ...personas.Judge,
  });

/** Read-only implementation planning on Opus at high effort. */
export const Planner: typeof claude.ReadOnly & typeof tiers.Planner & typeof personas.Planner =
  Object.freeze({
    ...claude.ReadOnly,
    ...tiers.Planner,
    ...personas.Planner,
  });

/**
 * Prose from given facts on Sonnet at medium effort, with the read tools to check a detail. It
 * often writes from the prompt alone, so it does not expect tool use.
 */
export const Scribe: typeof claude.ReadOnly &
  typeof tiers.Scribe &
  typeof personas.Scribe & {
    /** Writing from inline facts may use no tools, so no `no-tool-use` warning is recorded. */
    readonly expectsToolUse: false;
  } = Object.freeze({
  ...claude.ReadOnly,
  ...tiers.Scribe,
  ...personas.Scribe,
  expectsToolUse: false,
});

/**
 * `std.claude.Edit` under a role name: an editing agent with no model, effort or persona, so the
 * workflow's defaults choose them.
 */
export const Editor: typeof claude.Edit = Object.freeze({ ...claude.Edit });

/** Mechanical implementation on Sonnet at high effort, following a plan within its scope. */
export const Mechanic: typeof claude.Edit & typeof tiers.Mechanic & typeof personas.Implementer =
  Object.freeze({
    ...claude.Edit,
    ...tiers.Mechanic,
    ...personas.Implementer,
  });

/** Subtle implementation on Opus at high effort; the escalation when a mechanic fails. */
export const Surgeon: typeof claude.Edit & typeof tiers.Surgeon & typeof personas.Surgeon =
  Object.freeze({
    ...claude.Edit,
    ...tiers.Surgeon,
    ...personas.Surgeon,
  });

/** `std.codex.ReadOnly` under a role name: a Codex agent in a read-only sandbox. */
export const CodexReader: typeof codex.ReadOnly = Object.freeze({ ...codex.ReadOnly });

/**
 * A Codex reviewer: a read-only sandbox at high effort. Codex has no persona; prepend
 * `std.personas.Reviewer.appendSystemPrompt` to the prompt for the reviewer's stance.
 */
export const CodexReviewer: typeof codex.ReadOnly & {
  /** Codex reasoning effort. */
  readonly effort: 'high';
} = Object.freeze({
  ...codex.ReadOnly,
  effort: 'high',
  description: 'Reviews through a read-only Codex sandbox at high effort; never edits.',
});

/** `std.codex.Edit` under a role name: a Codex agent in a workspace-write sandbox. */
export const CodexEditor: typeof codex.Edit = Object.freeze({ ...codex.Edit });

/**
 * A Codex implementer: a workspace-write sandbox at high effort. Prepend
 * `std.personas.Implementer.appendSystemPrompt` to the prompt for the implementer's stance.
 */
export const CodexMechanic: typeof codex.Edit & {
  /** Codex reasoning effort. */
  readonly effort: 'high';
} = Object.freeze({
  ...codex.Edit,
  effort: 'high',
  description: 'Implements changes in a workspace-write Codex sandbox at high effort.',
});

// ---------------------------------------------------------------------------------------------
// Shell roles
// ---------------------------------------------------------------------------------------------

/**
 * A Claude role {@link withShell} accepts: one built on `std.claude.Text`, `ReadOnly` or `Edit`,
 * such as `std.roles.Reviewer`, so its tools are among Read, Grep, Glob, Edit and Write.
 */
export interface ShellableRole {
  /** Claude only: a Codex sandbox has no command allowlist. */
  readonly harness: 'claude';
  /** What the role does. */
  readonly description: string;
  /** The role's built-in tools, which the shell's replace. */
  readonly tools: readonly string[];
  /** The role's standing prompt, if it has a persona. */
  readonly appendSystemPrompt?: string | undefined;
}

/**
 * The shell fragment {@link withShell} uses for a role with `tools`: `std.claude.EditShellEntry`
 * when they include Edit or Write, `std.claude.ShellEntry` when they do not, and either when the
 * tools are only known as `string[]`.
 *
 * @typeParam T - The role's `tools` type.
 */
export type ShellFragment<T extends readonly string[]> = string extends T[number]
  ? claude.ShellEntry | claude.EditShellEntry
  : 'Edit' extends T[number]
    ? claude.EditShellEntry
    : 'Write' extends T[number]
      ? claude.EditShellEntry
      : claude.ShellEntry;

/**
 * What {@link withShell} returns for role `R`: the role without its capability keys, the shell
 * fragment's keys, and a standing prompt that ends with `std.personas.ShellEtiquette`.
 *
 * @typeParam R - The role.
 */
export type ShellRole<R extends ShellableRole> = Omit<
  R,
  keyof claude.ShellEntry | 'appendSystemPrompt'
> &
  ShellFragment<R['tools']> & {
    /** The role's standing prompt joined with `std.personas.ShellEtiquette`. */
    readonly appendSystemPrompt: string;
  };

/** The keys a capability fragment sets, which {@link withShell} replaces with the shell's. */
const CAPABILITY_KEYS: ReadonlySet<string> = new Set([
  'harness',
  'description',
  'tools',
  'allowedTools',
  'disallowedTools',
  'maxTurns',
  'maxBudgetUsd',
  'timeoutMs',
]);

/** The tools a role may have for {@link withShell}: those of `std.claude.Edit`. */
const SHELLABLE_TOOLS: ReadonlySet<string> = new Set(claude.Edit.tools);

/** The capability descriptions a role keeps when it has no tier or persona of its own. */
const CAPABILITY_DESCRIPTIONS: ReadonlySet<string> = new Set([
  claude.Text.description,
  claude.ReadOnly.description,
  claude.Edit.description,
]);

/**
 * Give a Claude role an allowlisted shell, keeping its tier and persona: its capability (tools,
 * `allowedTools`, `disallowedTools` and the turn, spend and time limits) is replaced by
 * `std.claude.editShell(rules, deny)` when its tools include Edit or Write, else by
 * `std.claude.shell(rules, deny)`, and `std.personas.ShellEtiquette` is joined to its
 * `appendSystemPrompt` (or becomes it). Every other key, such as `model`, `effort` and
 * `expectsToolUse`, is kept. The description is the role's, unless it is the description of
 * `std.claude.Text`, `ReadOnly` or `Edit` (as for `std.roles.Reader` and `Editor`), which the
 * shell's replaces. The result equals spreading the shell fragment, the tier and the persona by
 * hand, and is `exec` access, so it needs a grant under `requireGrants`.
 *
 * ```ts
 * // Equal to { ...std.claude.shell(rules), model: 'opus', effort: 'high',
 * //   ...std.personas.Reviewer, appendSystemPrompt: std.personas.join(
 * //     std.personas.Reviewer.appendSystemPrompt, std.personas.ShellEtiquette) }
 * Auditor: std.roles.withShell(std.roles.Reviewer, [...std.bash.gitRead, ...std.bash.nodeCheck]),
 * ```
 *
 * Spread a larger `std.limits` fragment after it for long tasks.
 *
 * @typeParam R - The role.
 * @param role - A Claude role whose tools are among Read, Grep, Glob, Edit and Write, such as a
 *   `std.roles` entry built on `std.claude.Text`, `ReadOnly` or `Edit`.
 * @param rules - The `Bash(...)` rules the agent may run, such as `std.bash.gitRead`.
 * @param deny - Rules denied even when an allowed rule matches. Default: `std.bash.noPush`.
 * @returns A frozen roster entry.
 * @throws TypeError - The role is not a Claude role, has no `tools` list, already has `Bash`, or
 *   has another tool outside Read, Grep, Glob, Edit and Write (a Web role, whose web tools the
 *   shell would drop); and the errors of `std.claude.shell` for `rules` and `deny`.
 */
export function withShell<R extends ShellableRole>(
  role: R,
  rules: readonly string[],
  deny: readonly string[] = noPush,
  // NoInfer: a call written inside `defineRoster` infers `R` from `role` alone. Inferring it from
  // the roster's contextual entry type too would expand that type past the compiler's depth limit.
): NoInfer<ShellRole<R>> {
  // Checked as unknown: an untyped caller may pass a Codex role or a partial entry.
  const { harness, tools } = role as { readonly harness?: unknown; readonly tools?: unknown };
  if (harness !== 'claude')
    throw new TypeError(
      `std.roles.withShell takes a Claude role; got harness ${JSON.stringify(harness)}. A Codex sandbox has no command allowlist.`,
    );
  if (!Array.isArray(tools))
    throw new TypeError(
      'std.roles.withShell needs a role with a tools list, such as one built on std.claude.ReadOnly or Edit.',
    );
  if (tools.includes('Bash'))
    throw new TypeError(
      'std.roles.withShell takes a role without a shell, and this one already has Bash; pass the role it was built from.',
    );
  const extra = (tools as readonly unknown[]).filter(
    (tool) => typeof tool !== 'string' || !SHELLABLE_TOOLS.has(tool),
  );
  if (extra.length > 0)
    throw new TypeError(
      `std.roles.withShell would drop the tools ${JSON.stringify(extra)}: it takes a role whose tools are among Read, Grep, Glob, Edit and Write.`,
    );
  const writes = tools.includes('Edit') || tools.includes('Write');
  const fragment = writes ? claude.editShell(rules, deny) : claude.shell(rules, deny);
  const kept = Object.fromEntries(
    Object.entries(role).filter(([key]) => !CAPABILITY_KEYS.has(key)),
  );
  return Object.freeze({
    ...fragment,
    ...kept,
    description: CAPABILITY_DESCRIPTIONS.has(role.description)
      ? fragment.description
      : role.description,
    appendSystemPrompt: personas.join(role.appendSystemPrompt ?? '', personas.ShellEtiquette),
  }) as unknown as ShellRole<R>;
}

/** What {@link tester} returns: a shell on Sonnet at high effort with the tester's persona. */
export type TesterRole = claude.ShellEntry &
  Pick<tiers.Tier<'sonnet', 'high'>, 'model' | 'effort'> & {
    /** `std.personas.Tester`'s standing prompt joined with `std.personas.ShellEtiquette`. */
    readonly appendSystemPrompt: string;
  };

/** The base of {@link tester}: a read-only checker on Sonnet at high effort. */
const TesterBase: typeof claude.ReadOnly & typeof tiers.Mechanic & typeof personas.Tester =
  Object.freeze({
    ...claude.ReadOnly,
    ...tiers.Mechanic,
    ...personas.Tester,
  });

/**
 * A Claude agent that runs allowlisted checks and reports their results exactly, without fixing
 * anything: `std.claude.shell(rules, deny)`, `std.tiers.Mechanic` and `std.personas.Tester`, with
 * `std.personas.ShellEtiquette` joined to the persona. It is `exec` access, so it needs a grant
 * under `requireGrants`.
 *
 * ```ts
 * Tester: std.roles.tester([...std.bash.gitRead, ...std.bash.npmRun('lint', 'test')]),
 * ```
 *
 * @param rules - The `Bash(...)` rules of the checks it may run, such as `std.bash.nodeCheck`.
 * @param deny - Rules denied even when an allowed rule matches. Default: `std.bash.noPush`.
 * @returns A frozen roster entry.
 * @throws TypeError - The errors of `std.claude.shell` for `rules` and `deny`.
 */
export function tester(rules: readonly string[], deny: readonly string[] = noPush): TesterRole {
  return withShell(TesterBase, rules, deny);
}

/**
 * {@link Mechanic} with an edit shell: a Claude agent that implements a change on Sonnet at high
 * effort and runs allowlisted commands, such as the checks that prove its fix, as
 * `withShell(std.roles.Mechanic, rules, deny)`. It is `exec` access, so it needs a grant under
 * `requireGrants`.
 *
 * ```ts
 * Fixer: std.roles.fixer([...std.bash.nodeCheck, ...std.bash.gitCommit], std.bash.noRewrite),
 * ```
 *
 * @param rules - The `Bash(...)` rules it may run, such as `std.bash.nodeCheck`.
 * @param deny - Rules denied even when an allowed rule matches. Default: `std.bash.noPush`; pass
 *   `std.bash.noRewrite` to also forbid resets, rebases and other history rewrites.
 * @returns A frozen roster entry.
 * @throws TypeError - The errors of `std.claude.editShell` for `rules` and `deny`.
 */
export function fixer(
  rules: readonly string[],
  deny: readonly string[] = noPush,
): ShellRole<typeof Mechanic> {
  return withShell(Mechanic, rules, deny);
}
