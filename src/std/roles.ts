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
 * its allowlist is project-specific: build one with `std.claude.shell` or `std.claude.editShell`
 * and `std.bash`, then spread a tier and a persona as in the example. Codex roles carry no persona,
 * because Codex has no standing system prompt: prepend a persona's `appendSystemPrompt` to the
 * prompt instead.
 *
 * Under `requireGrants`, a workflow needs a grant for every `write` role in its roster, even one it
 * never calls, so list only the roles a workflow uses (`std.rosters.readers` holds only `none` and
 * `read` roles).
 *
 * @module
 */
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
