// Data contracts of execute-epic-ticket: the input with the native script's arguments and
// defaults, every structured agent result, the results of the package's durable steps, and the
// record the run returns.
import { z } from 'quiet-choir';
import { MergeDownInput, MergeDownResult } from '../merge-down.quiet-choir/contracts.js';

/** The stages `until` can stop after, in order. */
export const STAGES = ['survey', 'plan', 'implement', 'pr', 'land'] as const;
/** A stage `until` names. */
export type Stage = (typeof STAGES)[number];

const md = MergeDownInput.shape;

/**
 * Arguments for the merge-down child that a run may override. The child's `pr`, `repo`,
 * `parentEpic`, `followupEpic`, `followupEpicTitle` and `standingNotes` come from this run; the
 * fields here carry no defaults, so an omitted one takes the child's own default.
 */
export const MergeDownOverrides = z.object({
  root: md.root,
  until: md.until.unwrap().optional(),
  codex: md.codex.unwrap().optional(),
  codexMode: md.codexMode.unwrap().optional(),
  codexModel: md.codexModel.unwrap().optional(),
  codexEffort: md.codexEffort,
  maxCodexRounds: md.maxCodexRounds.unwrap().optional(),
  codexRoundsHardCap: md.codexRoundsHardCap.unwrap().optional(),
  maxCiRepairs: md.maxCiRepairs.unwrap().optional(),
  checkCommand: md.checkCommand.unwrap().optional(),
  requiredChecks: md.requiredChecks.unwrap().optional(),
  mergeMethod: md.mergeMethod.unwrap().optional(),
});
/** Parsed overrides. */
export type MergeDownOverrides = z.output<typeof MergeDownOverrides>;

/**
 * Input. The native arguments with their defaults, less `tools`, `mergeDownTools` and
 * `mergeDownScript` (the child is imported statically and fingerprinted with this package), plus
 * `repo` and `checkCommand`. `until` short of `pr` publishes nothing. The native `error` status for
 * bad arguments is this schema's refusal before the run starts.
 */
export const EpicTicketInput = z
  .object({
    epic: z.int().positive().describe('The epic whose checklist and sub-issues are the tickets.'),
    ticket: z
      .int()
      .positive()
      .optional()
      .describe("Work on this ticket instead of the survey's choice."),
    decision: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("The maintainer's answer to a needs-decision question on `ticket`."),
    until: z.enum(STAGES).default('land'),
    followupEpic: z.int().positive().optional(),
    followupEpicTitle: z.string().min(1).default('Epic: enhancements, wave 3'),
    standingNotes: z.array(z.string()).default([]),
    maxCandidates: z.int().positive().default(3),
    implementer: z.enum(['auto', 'mechanic', 'surgeon']).default('auto'),
    mergeDown: MergeDownOverrides.default({}),
    commitTrailer: z.string().default(''),
    prFooter: z.string().default('🤖 Generated with [Claude Code](https://claude.com/claude-code)'),
    root: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Directory for worktree/ and state/; default <main checkout>-epic-burndown-package.',
      ),
    repo: z
      .string()
      .min(1)
      .optional()
      .describe("OWNER/REPO; default: the current checkout's GitHub repository."),
    checkCommand: z.string().min(1).default('npm run check'),
    toolchain: md.toolchain.describe(
      "The agents' toolchain (#735): shell rules and guidance in place of npm's; passed to the landing child.",
    ),
  })
  .superRefine((input, ctx) => {
    if (input.decision !== undefined && input.ticket === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['decision'],
        message: 'decision needs ticket (the ticket it answers)',
      });
  });
/** Parsed input. */
export type EpicTicketInput = z.output<typeof EpicTicketInput>;

const str = z.string();
const strings = z.array(z.string());

/** The body of a ready plan: what the implementer follows and the landing review judges. */
export const PlanBody = z.object({
  title: str,
  approach: str,
  steps: z.array(z.object({ id: str, description: str, files: strings })),
  acceptance: z.array(z.object({ id: str, criterion: str, how: str })),
  tests: strings,
  docs: strings,
  risks: strings,
  outOfScope: strings,
  complexity: z.enum(['mechanical', 'subtle']),
  size: z.enum(['small', 'medium', 'large']),
});
export type PlanBody = z.output<typeof PlanBody>;

/** A slice of a ticket too large for one pull request. */
export const Slice = z.object({
  title: str,
  summary: str,
  acceptance: strings,
  dependsOnPrevious: z.boolean(),
});
export type Slice = z.output<typeof Slice>;

/**
 * The planner's verdict, in the native flat shape: every field is required, and one that does not
 * apply to the readiness is '' or [] ('n/a' for obsoleteKind). Flat rather than a discriminated
 * union, which structured-output providers handle poorly (#100).
 */
export const Plan = z.object({
  readiness: z.enum(['ready', 'obsolete', 'needs-decision', 'blocked', 'split']),
  rationale: str,
  issueComment: str,
  obsoleteKind: z.enum(['already-done', 'no-longer-applies', 'n/a']),
  decision: z.object({
    question: str,
    options: z.array(z.object({ label: str, consequence: str })),
    recommendation: str,
  }),
  blockedBy: z.array(z.int()),
  slices: z.array(Slice),
  plan: PlanBody,
});
export type Plan = z.output<typeof Plan>;

/** The skeptic's check of an obsolete verdict. */
export const Skeptic = z.object({ agree: z.boolean(), evidence: str, remaining: strings });
export type Skeptic = z.output<typeof Skeptic>;

/** A criterion status an implementer may report. */
export const CriterionStatus = z.enum(['done', 'verify-on-pr', 'deviation', 'partial', 'not-done']);
export type CriterionStatus = z.output<typeof CriterionStatus>;

/** A follow-up an implementer lists. */
export const Followup = z.object({ title: str, detail: str });

/** What {@link Implemented} parses. */
export interface ImplementedResult {
  readonly criteria: {
    readonly id: string;
    readonly status: CriterionStatus;
    readonly commit: string;
    readonly evidence: string;
  }[];
  readonly deviations: string[];
  readonly followups: { readonly title: string; readonly detail: string }[];
  readonly notes: string[];
}

/**
 * The implementer's report: one entry per plan acceptance id, constrained to those ids so a
 * mistyped one is a schema retry rather than an unreported criterion. There is no `checkPassed` or
 * `head`: the workflow verifies the branch and runs the suite itself.
 */
export function Implemented(ids: readonly [string, ...string[]]): z.ZodType<ImplementedResult> {
  return z.object({
    criteria: z.array(
      z.object({ id: z.enum(ids), status: CriterionStatus, commit: str, evidence: str }),
    ),
    deviations: strings,
    followups: z.array(Followup),
    notes: strings,
  });
}

/** The pull request text the scribe writes. */
export const PrText = z.object({ title: str, body: str });
export type PrText = z.output<typeof PrText>;

/** What {@link Writeups} parses. */
export interface WriteupsResult {
  readonly issues: {
    readonly key: string;
    readonly duplicateOf: number;
    readonly title: string;
    readonly label: 'bug' | 'enhancement' | 'documentation';
    readonly body: string;
  }[];
}

/**
 * Issue write-ups (slices or follow-ups), one per key. `duplicateOf` is an open issue that already
 * covers the item, or 0 when there is none, as natively.
 */
export function Writeups(keys: readonly [string, ...string[]]): z.ZodType<WriteupsResult> {
  return z.object({
    issues: z.array(
      z.object({
        key: z.enum(keys),
        duplicateOf: z.int().nonnegative(),
        title: str,
        label: z.enum(['bug', 'enhancement', 'documentation']),
        body: str,
      }),
    ),
  });
}

/** What the start step reports, or why it refused. */
export const Started = z.object({
  refused: z.string().nullable(),
  worktreeCreated: z.boolean(),
  branch: z.string(),
  source: z.enum(['local', 'remote', 'new']),
  resumed: z.boolean(),
  ahead: z.int(),
  behind: z.int(),
  dirty: strings,
  rebase: z.enum(['up-to-date', 'rebased', 'skipped-dirty', 'conflict']),
  baseSha: z.string(),
  remoteSha: z.string().nullable(),
  planFile: z.string().nullable(),
});
export type Started = z.output<typeof Started>;

/** What the verify step reports about the ticket branch. */
export const Verified = z.object({
  head: z.string(),
  branch: z.string().nullable(),
  ahead: z.int(),
  missingCommits: strings,
  dirty: strings,
});
export type Verified = z.output<typeof Verified>;

/** The diff snapshot the PR writer reads. */
export const Snapshot = z.object({
  head: z.string(),
  ahead: z.int(),
  stat: z.string(),
  files: z.object({ diff: z.string(), stat: z.string(), commits: z.string() }),
});
export type Snapshot = z.output<typeof Snapshot>;

/** What the publish step reports. */
export const Published = z.object({ head: z.string(), pushed: z.boolean() });
export type Published = z.output<typeof Published>;

/** What an epic-body edit (a tick or a checklist insert) reports. */
export const BodyEdit = z.object({ changed: z.boolean() });

const ticketRef = z.object({ number: z.int(), title: z.string(), status: z.string() });

/** Item counts of an epic survey, in the native shape. */
export const Counts = z.object({
  total: z.int(),
  open: z.int(),
  closed: z.int(),
  ready: z.int(),
  inFlight: z.int(),
  waiting: z.int(),
  held: z.int(),
  split: z.int(),
});
export type Counts = z.output<typeof Counts>;

const filedFollowup = z.object({
  key: z.string(),
  number: z.int().nullable(),
  title: z.string().nullable(),
  action: z.enum(['created', 'existing', 'duplicate', 'failed']),
  error: z.string().nullable(),
});

/** The record's statuses, the native set. */
export const STATUSES = [
  'landed',
  'pr-open',
  'closed-obsolete',
  'closed-split',
  'needs-decision',
  'split',
  'held',
  'epic-done',
  'stalled',
  'blocked',
  'stopped',
] as const;

/**
 * The record a run returns, in the native script's shape (its README lists it), without the
 * relay's `agents.clerkRuns`. A stop short of `land` carries the native extras: `plannedClose`,
 * `plannedSlices` or `plannedWork`.
 */
export const EpicTicketResult = z.object({
  epic: z.int(),
  epicTitle: z.string().nullable(),
  status: z.enum(STATUSES),
  ticket: ticketRef.nullable(),
  candidates: z.array(z.int()).optional(),
  pr: z.object({ number: z.int(), url: z.string(), mergeCommit: z.string().nullable() }).nullable(),
  plan: z
    .object({
      readiness: z.string(),
      rationale: z.string(),
      title: z.string().optional(),
      complexity: z.string().optional(),
      size: z.string().optional(),
      criteria: z.int().optional(),
    })
    .nullable(),
  implementer: z
    .object({
      tier: z.enum(['mechanic', 'surgeon']),
      rounds: z.int(),
      head: z.string().optional(),
      commits: z.int().optional(),
      deviations: strings.optional(),
      notes: strings.optional(),
    })
    .nullable(),
  landing: z
    .object({
      status: MergeDownResult.shape.status,
      mergeCommit: z.string().nullable(),
      threads: z.int(),
      fixes: z.int(),
      followups: MergeDownResult.shape.followups,
      summaryCommentUrl: z.string().nullable(),
      headline: z.string().nullable(),
      blocked: MergeDownResult.shape.blocked,
    })
    .nullable(),
  followups: z.array(filedFollowup),
  followupEpic: z.int().nullable(),
  slices: z.array(z.object({ title: z.string(), number: z.int().optional() })),
  decision: z
    .object({
      ticket: z.int(),
      question: z.string(),
      options: z.array(z.object({ label: z.string(), consequence: z.string() })),
      recommendation: z.string(),
    })
    .nullable(),
  skipped: z.array(z.object({ number: z.int(), blockedBy: z.array(z.int()), why: z.string() })),
  remaining: Counts.nullable(),
  next: ticketRef.nullable(),
  headline: z.string().nullable(),
  notes: strings,
  blocked: z.object({ stage: z.string(), reason: z.string() }).nullable(),
  verifyOnPr: z.array(z.object({ id: z.string(), check: z.string() })).optional(),
  deviations: z.array(z.object({ id: z.string(), reason: z.string() })).optional(),
  plannedClose: z.string().optional(),
  plannedSlices: z.array(Slice).optional(),
  plannedWork: PlanBody.optional(),
});
export type EpicTicketResult = z.output<typeof EpicTicketResult>;
