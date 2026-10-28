// Data contracts of merge-down-pr: the input with the native script's defaults, every structured
// agent result, and the ledger record the run returns.
import { z } from 'quiet-choir';

const severity = z.enum(['blocker', 'major', 'minor']);
const complexity = z.enum(['mechanical', 'subtle']);

const rule = z.string().trim().min(1);

/**
 * The repository's toolchain as the agents see it (#735). Absent, the roster's npm rules and the
 * prompts' npm instructions apply; present, `read` and `edit` replace the npm shell rules (the git,
 * gh, `ls` and `wc` rules stay) and `guidance` replaces the npm formatting, focused-check and
 * lockfile instructions.
 */
export const Toolchain = z.object({
  read: z
    .array(rule)
    .default([])
    .describe('allowedTools rules for every role, e.g. "Bash(swift build:*)".'),
  edit: z
    .array(rule)
    .default([])
    .describe('allowedTools rules the editing roles add, e.g. "Bash(just reformat:*)".'),
  guidance: z
    .string()
    .trim()
    .min(1)
    .describe('Markdown: how to format touched files, run focused checks and reconcile lockfiles.'),
});
/** Parsed toolchain. */
export type Toolchain = z.output<typeof Toolchain>;

/**
 * Input. `until` short of `merge` publishes nothing (no push, comment, issue or merge). The native
 * script's `error` status for bad arguments is this schema's refusal before the run starts.
 */
export const MergeDownInput = z.object({
  pr: z.int().positive().describe('The pull request to land.'),
  repo: z
    .string()
    .min(1)
    .optional()
    .describe("OWNER/REPO; default: the current checkout's GitHub repository."),
  root: z
    .string()
    .min(1)
    .optional()
    .describe('Directory for worktree/ and state/; default <main checkout>-merge-down-package.'),
  until: z.enum(['prepare', 'review', 'fix', 'merge']).default('merge'),
  codex: z.enum(['auto', 'always', 'never']).default('auto'),
  codexMode: z.enum(['local', 'github']).default('local'),
  codexModel: z
    .string()
    .regex(/^[\w.:-]+$/)
    .default('gpt-6-astra'),
  codexEffort: z
    .string()
    .regex(/^[\w.:-]+$/)
    .optional(),
  maxCodexRounds: z.int().nonnegative().default(3),
  codexRoundsHardCap: z.int().nonnegative().default(5),
  maxCiRepairs: z.int().nonnegative().default(2),
  followupEpic: z.int().positive().optional(),
  followupEpicTitle: z.string().min(1).default('Epic: initial enhancements, wave 2'),
  parentEpic: z.int().positive().optional(),
  standingNotes: z.array(z.string()).default([]),
  checkCommand: z.string().min(1).default('npm run check'),
  requiredChecks: z.array(z.string().min(1)).default([]),
  toolchain: Toolchain.optional(),
});
/** Parsed input. */
export type MergeDownInput = z.output<typeof MergeDownInput>;

/** A triaged review thread. */
export const Thread = z.object({
  id: z.string(),
  title: z.string(),
  verdict: z.enum(['valid', 'partly-valid', 'invalid', 'obsolete']),
  action: z.enum(['fix', 'defer', 'reject', 'none']),
  severity,
  complexity,
  plan: z.string(),
  reply: z.string(),
});

/** A finding of the merge-down review. */
export const Finding = z.object({
  id: z.string(),
  title: z.string(),
  severity,
  disposition: z.enum(['fix', 'follow-up', 'note']),
  complexity,
  detail: z.string(),
  plan: z.string(),
  files: z.array(z.string()),
});

/** The pre-merge review of a change PR: thread decisions, findings and the issue disposition. */
export const Review = z.object({
  threads: z.array(Thread),
  findings: z.array(Finding),
  alignment: z.object({
    verdict: z.enum(['complete', 'mostly', 'partial', 'misaligned', 'no-issue']),
    notes: z.string(),
  }),
  issueDisposition: z.object({
    action: z.enum(['close', 'keep-open', 'none']),
    remaining: z.array(z.string()),
  }),
  escalate: z.boolean(),
  escalateReason: z.string(),
  summaryNotes: z.array(z.string()),
});
export type Review = z.output<typeof Review>;

/** Decisions on threads that arrived after the first review. */
export const Triage = z.object({ threads: z.array(Thread), notes: z.array(z.string()) });

/** Decisions on a local `codex review`'s findings: fixes, follow-ups or recorded rejections. */
export const CodexTriage = z.object({
  findings: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      verdict: z.enum(['valid', 'partly-valid', 'invalid', 'duplicate']),
      disposition: z.enum(['fix', 'follow-up', 'note']),
      severity,
      complexity,
      detail: z.string(),
      plan: z.string(),
      files: z.array(z.string()),
    }),
  ),
  notes: z.array(z.string()),
});

/** The review of a Dependabot pull request. */
export const DependencyReview = z.object({
  decision: z.enum(['merge', 'fix', 'close', 'defer']),
  rationale: z.string(),
  fixes: z.array(z.object({ id: z.string(), title: z.string(), plan: z.string(), complexity })),
  closeComment: z.string(),
  followups: z.array(
    z.object({ id: z.string(), title: z.string(), detail: z.string(), plan: z.string() }),
  ),
  headline: z.string(),
});
export type DependencyReview = z.output<typeof DependencyReview>;

/** The conflict resolver's report. */
export const Resolve = z.object({
  completed: z.boolean(),
  head: z.string(),
  resolutions: z.array(z.object({ file: z.string(), how: z.string() })),
  concerns: z.array(z.string()),
});

const fixStatus = z.enum(['fixed', 'partly', 'not-fixed']);

/** What {@link Fix} parses. */
export interface FixResult {
  readonly items: {
    readonly key: string;
    readonly status: 'fixed' | 'partly' | 'not-fixed';
    readonly commit: string;
    readonly summary: string;
  }[];
  readonly head: string;
  readonly notes: string[];
}

/** What {@link FollowupDrafts} parses. */
export interface FollowupDraftsResult {
  readonly items: {
    readonly key: string;
    readonly title: string;
    readonly body: string;
    readonly label: 'bug' | 'enhancement' | 'documentation';
    readonly duplicateOf: number | null;
    readonly duplicateComment: string;
  }[];
}

/**
 * The fixer's report. Keys are constrained to the items it was given, so a mistyped key is a schema
 * retry rather than "not reported". There is no `checkPassed`: the workflow runs the suite itself.
 */
export function Fix(keys: readonly [string, ...string[]]): z.ZodType<FixResult> {
  return z.object({
    items: z.array(
      z.object({ key: z.enum(keys), status: fixStatus, commit: z.string(), summary: z.string() }),
    ),
    head: z.string(),
    notes: z.array(z.string()),
  });
}

/**
 * The scribe's follow-up drafts, one per item key. The workflow files each one with `issue.create`
 * under the follow-up epic, or comments on `duplicateOf` with `duplicateComment`.
 */
export function FollowupDrafts(
  keys: readonly [string, ...string[]],
): z.ZodType<FollowupDraftsResult> {
  return z.object({
    items: z.array(
      z.object({
        key: z.enum(keys),
        title: z.string(),
        body: z.string(),
        label: z.enum(['bug', 'enhancement', 'documentation']),
        duplicateOf: z.int().positive().nullable(),
        duplicateComment: z.string(),
      }),
    ),
  });
}

/** The report scribe's answer: whether to post the summary, its body and the ledger headline. */
export const Report = z.object({ post: z.boolean(), body: z.string(), headline: z.string() });

const sync = z.object({
  status: z.enum(['up-to-date', 'rebased', 'conflict', 'error', 'blocked']),
  reason: z.string().nullable(),
  worktreeCreated: z.boolean(),
  localBranch: z.string(),
  headRef: z.string(),
  origHead: z.string().nullable(),
  target: z.string().nullable(),
  forkPoint: z.string().nullable(),
  forkSource: z.enum(['recorded', 'base-branch', 'merge-base']).nullable(),
  conflictedFiles: z.array(z.string()),
  forkPointsRecorded: z.array(z.int()),
  upstreamDelta: z.string().nullable(),
  originalCommits: z.int().nullable(),
  newHead: z.string().nullable(),
  ownCommits: z.int().nullable(),
  stat: z.string().nullable(),
  log: z.string().nullable(),
});
/** What the sync step reports. */
export const Sync = sync;
export type Sync = z.output<typeof Sync>;

/** A local check run. */
export const Check = z.object({
  passed: z.boolean(),
  head: z.string().nullable(),
  failedStep: z.string().nullable(),
  exitCode: z.int().nullable(),
  seconds: z.number(),
  installedDependencies: z.boolean(),
  maxWorkers: z.string().nullable(),
  log: z.string().nullable(),
  excerptFile: z.string().nullable(),
  error: z.string().nullable(),
});
export type Check = z.output<typeof Check>;

/** What the land step reports: the merge, or why a guard or GitHub refused it. */
export const Landed = z.discriminatedUnion('merged', [
  z.object({ merged: z.literal(true), mergeCommit: z.string().nullable(), acted: z.boolean() }),
  z.object({ merged: z.literal(false), reason: z.string() }),
]);
export type Landed = z.output<typeof Landed>;

const workItem = z.object({
  key: z.string(),
  source: z.string(),
  title: z.string(),
  severity,
  complexity,
  plan: z.string(),
  detail: z.string(),
  files: z.array(z.string()),
});

const fixReport = z.object({
  key: z.string(),
  status: fixStatus,
  commit: z.string(),
  summary: z.string(),
});

const reviewRecord = z.object({
  escalated: z.boolean(),
  alignment: Review.shape.alignment.nullable(),
  findings: z.array(
    z.object({ id: z.string(), title: z.string(), severity, disposition: z.string() }),
  ),
  issueDisposition: Review.shape.issueDisposition.optional(),
  summaryNotes: z.array(z.string()).optional(),
});

/**
 * The ledger record, in the native script's shape (its README lists it), without the relay's
 * `agents.clerkRuns`. A stop short of `merge` carries the native extras (`prepared`; `review` with
 * `check` and `plannedWork`; `review` with `plannedReplies`; `plannedClose`), and there `review` is
 * the reviewer's whole assessment rather than the summary.
 */
export const MergeDownResult = z.object({
  pr: z.int(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  kind: z.enum(['change', 'dependency']).nullable(),
  status: z.enum(['merged', 'closed', 'deferred', 'blocked', 'stopped', 'skipped']),
  issue: z
    .object({
      number: z.int(),
      url: z.string(),
      title: z.string(),
      state: z.string(),
      closedManually: z.boolean().optional(),
    })
    .nullable(),
  mergeCommit: z.string().nullable(),
  rebase: z
    .object({
      status: z.string(),
      forkSource: z.string().nullable(),
      conflicts: z.array(z.string()),
      resolutions: z.array(z.object({ file: z.string(), how: z.string() })).optional(),
      concerns: z.array(z.string()).optional(),
    })
    .nullable(),
  review: z.union([reviewRecord, Review, DependencyReview]),
  threads: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      verdict: z.string(),
      action: z.string(),
      severity: z.string(),
      round: z.int(),
      reply: z.string(),
    }),
  ),
  codexReviewsRequested: z.int(),
  codexMode: z.enum(['local', 'github']),
  localReviews: z.array(
    z.object({
      round: z.int(),
      sha: z.string().nullable(),
      findings: z.int(),
      priorities: z.record(z.string(), z.int()).nullable(),
      elapsedSeconds: z.number().nullable(),
      file: z.string().nullable(),
      deps: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
  codexFindings: z.array(
    z.object({
      id: z.string(),
      round: z.int(),
      title: z.string(),
      verdict: z.string(),
      severity: z.string(),
      disposition: z.string(),
      detail: z.string(),
      plan: z.string(),
    }),
  ),
  rounds: z.int(),
  ciRepairs: z.int(),
  followups: z.array(
    z.object({
      key: z.string(),
      number: z.int(),
      url: z.string(),
      title: z.string(),
      action: z.enum(['created', 'commented-existing']),
    }),
  ),
  followupEpic: z.int().nullable(),
  summaryCommentUrl: z.string().nullable(),
  headline: z.string().nullable(),
  notes: z.array(z.string()),
  blocked: z.object({ stage: z.string(), reason: z.string() }).nullable(),
  children: z.array(z.object({ pr: z.int(), state: z.string(), base: z.string() })).optional(),
  dependency: z.object({ decision: z.string(), rationale: z.string() }).optional(),
  fixes: z.array(fixReport).optional(),
  fixNotes: z.array(z.string()).optional(),
  triageNotes: z.array(z.string()).optional(),
  deferredFindings: z
    .array(
      z.object({
        key: z.string(),
        status: fixStatus,
        summary: z.string(),
        issue: z.int().nullable(),
      }),
    )
    .optional(),
  flakyChecks: z.array(z.string()).optional(),
  prepared: z.json().optional(),
  check: Check.optional(),
  plannedWork: z.object({ fix: z.array(workItem), followup: z.array(workItem) }).optional(),
  plannedReplies: z
    .array(
      z.object({
        threadId: z.string(),
        body: z.string(),
        dismiss: z.enum(['reject', 'defer']).optional(),
      }),
    )
    .optional(),
  plannedClose: z.string().optional(),
});
export type MergeDownResult = z.output<typeof MergeDownResult>;
