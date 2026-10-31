// The prompt index (ADR 0064): every prompt the native script built from template literals, as a
// markdown template with typed parameters. Situation, standing notes, guidance and the rebase note
// are fragments under prompts/_fragments/ that each stage template includes.
import { definePrompts, z } from 'quiet-choir';

/** Where the PR is and which files describe it; read by the Situation fragment. */
export const Situation = z.object({
  repo: z.string(),
  pr: z.int(),
  title: z.string(),
  url: z.string(),
  issue: z.object({ number: z.int(), title: z.string() }).nullable(),
  base: z.string(),
  worktree: z.string(),
  branch: z.string(),
  dir: z.string(),
  upstreamDelta: z.boolean(),
  /** The run's toolchain (#735): its allowed commands as prose, and its guidance; null for npm. */
  toolchain: z.object({ read: z.string(), edit: z.string(), guidance: z.string() }).nullable(),
  /** The other issues of this repository the PR closes (#736); empty for a one-issue PR. */
  alsoCloses: z.array(z.object({ number: z.int(), title: z.string() })),
});
export type Situation = z.output<typeof Situation>;

/** How the rebase went; read by the RebaseNote fragment. */
export const RebaseNote = z.object({
  status: z.string(),
  upstreamDelta: z.string(),
  resolutions: z.string(),
  concerns: z.string(),
});

const standingNotes = z.array(z.string());
const item = z.object({
  key: z.string(),
  severity: z.string(),
  source: z.string(),
  title: z.string(),
  plan: z.string(),
  detail: z.string(),
  files: z.array(z.string()),
});

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  ResolveConflicts: {
    file: 'ResolveConflicts.md',
    description: 'Finish a conflicted rebase semantically.',
    params: z.object({
      situation: Situation,
      standingNotes,
      forkPoint: z.string(),
      origHead: z.string(),
      conflicted: z.array(z.string()),
    }),
  },
  ReviewChange: {
    file: 'ReviewChange.md',
    description: 'Triage every unresolved thread and review the PR against its issue.',
    params: z.object({
      situation: Situation,
      rebase: RebaseNote,
      standingNotes,
      laterInStack: z.int(),
      parentEpic: z.int().nullable(),
      unresolvedThreads: z.int(),
    }),
  },
  ReviewDependency: {
    file: 'ReviewDependency.md',
    description: 'Review a Dependabot update: merge, fix, close or defer.',
    params: z.object({
      situation: Situation,
      rebase: RebaseNote,
      failedChecks: z.array(z.string()),
    }),
  },
  EscalatedReview: {
    file: 'EscalatedReview.md',
    description: 'Re-examine an escalated first-pass review; the answer replaces it.',
    params: z.object({
      situation: Situation,
      rebase: RebaseNote,
      standingNotes,
      reasons: z.array(z.string()),
      firstReview: z.string(),
    }),
  },
  TriageLocalReview: {
    file: 'TriageLocalReview.md',
    description: 'Turn a local codex review into fixes, follow-ups or recorded rejections.',
    params: z.object({
      situation: Situation,
      standingNotes,
      sha: z.string(),
      file: z.string(),
      findings: z.int(),
      known: z.array(z.string()),
      round: z.int(),
      maxCodexRounds: z.int(),
      hardCap: z.int(),
      shortfall: z.object({ covered: z.int(), ids: z.array(z.string()) }).nullable(),
    }),
  },
  TriageThreads: {
    file: 'TriageThreads.md',
    description: 'Decide the review threads and alerts that arrived during the gate.',
    params: z.object({
      situation: Situation,
      standingNotes,
      codexFindings: z.boolean(),
      settled: z.array(z.string()),
      laterInStack: z.boolean(),
      round: z.int(),
      maxCodexRounds: z.int(),
      hardCap: z.int(),
    }),
  },
  Implement: {
    file: 'Implement.md',
    description: 'Implement the fix decisions, with focused checks and small commits.',
    params: z.object({
      situation: Situation,
      standingNotes,
      items: z.array(item),
      retry: z.boolean(),
      repair: z
        .object({
          notes: z.string(),
          head: z.string(),
          failedStep: z.string().nullable(),
          log: z.string(),
          excerptFile: z.string().nullable(),
        })
        .nullable(),
    }),
  },
  DraftFollowups: {
    file: 'DraftFollowups.md',
    description: 'Draft follow-up issues; the workflow files them.',
    params: z.object({
      situation: Situation,
      epic: z.int().nullable(),
      epicTitle: z.string(),
      items: z.array(item),
    }),
  },
  IssueSummary: {
    file: 'IssueSummary.md',
    description: 'Draft the closing summary comment and the ledger headline.',
    params: z.object({
      issue: z.int(),
      repo: z.string(),
      pr: z.int(),
      title: z.string(),
      base: z.string(),
      mergeCommit: z.string(),
      /** How it landed (#737): `squash`, `merge` or `rebase`. */
      method: z.string(),
      facts: z.string(),
    }),
  },
  FollowupEpicBody: {
    file: 'FollowupEpicBody.md',
    description: 'The body of a new follow-up epic (GitHub text, not an agent prompt).',
    params: z.object({ parentEpic: z.int().nullable() }),
  },
});
