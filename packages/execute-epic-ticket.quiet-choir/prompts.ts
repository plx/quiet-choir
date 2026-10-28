// The prompt index (ADR 0064): every prompt the native script built from template literals, and
// every multi-line GitHub text the workflow posts, as a markdown template with typed parameters.
// Situation, guidance and standing notes are fragments under prompts/_fragments/ that the agent
// templates include.
import { definePrompts, z } from 'quiet-choir';

/** Where the ticket is and which files describe it; read by the Situation fragment. */
export const Situation = z.object({
  repo: z.string(),
  epic: z.object({ number: z.int(), title: z.string() }),
  ticket: z.object({ number: z.int(), title: z.string() }),
  branch: z.string(),
  worktree: z.string(),
  base: z.string(),
  dir: z.string(),
  planFile: z.string().nullable(),
  /** The run's toolchain (#735): its allowed commands as prose, and its guidance; null for npm. */
  toolchain: z.object({ read: z.string(), edit: z.string(), guidance: z.string() }).nullable(),
});
export type Situation = z.output<typeof Situation>;

const standingNotes = z.array(z.string());
const numbers = z.array(z.int());

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Plan: {
    file: 'Plan.md',
    description: 'Decide whether the ticket is ready, and plan it.',
    params: z.object({
      situation: Situation,
      standingNotes,
      checkCommand: z.string(),
      earlier: z
        .object({ ahead: z.int(), planFile: z.string().nullable(), dirty: z.int() })
        .nullable(),
      decision: z.string().nullable(),
      replan: z.object({ kind: z.string(), check: z.string() }).nullable(),
    }),
  },
  Skeptic: {
    file: 'Skeptic.md',
    description: 'Try to prove an obsolete verdict wrong.',
    params: z.object({ situation: Situation, kind: z.string(), rationale: z.string() }),
  },
  WriteSlices: {
    file: 'WriteSlices.md',
    description: 'Write the slices of a split ticket up as issues; the workflow files them.',
    params: z.object({ situation: Situation, rationale: z.string(), slices: z.string() }),
  },
  Implement: {
    file: 'Implement.md',
    description: 'Implement the plan with focused checks and small commits.',
    params: z.object({
      situation: Situation,
      standingNotes,
      plan: z.string(),
      planFile: z.string(),
      commitTrailer: z.string(),
      checkCommand: z.string(),
      retry: z.boolean(),
      followup: z
        .object({
          escalated: z.boolean(),
          problems: z.string(),
          checkLog: z.string().nullable(),
          excerpt: z.string().nullable(),
          previous: z.string().nullable(),
        })
        .nullable(),
    }),
  },
  WritePr: {
    file: 'WritePr.md',
    description: 'Write the pull request title and description.',
    params: z.object({
      situation: Situation,
      plan: z.string(),
      report: z.string(),
      stat: z.string(),
      commitsFile: z.string(),
      diffFile: z.string(),
      checkCommand: z.string(),
      head: z.string(),
      footer: z.string(),
      title: z.string(),
    }),
  },
  WriteFollowups: {
    file: 'WriteFollowups.md',
    description: 'Write follow-up issues up; the workflow files them.',
    params: z.object({
      situation: Situation,
      followupEpic: z.int().nullable(),
      followupEpicTitle: z.string(),
      items: z.array(z.object({ key: z.string(), title: z.string(), detail: z.string() })),
      keys: z.array(z.string()),
    }),
  },
  FollowupEpicBody: {
    file: 'FollowupEpicBody.md',
    description: 'The body of a new follow-up epic (GitHub text, not an agent prompt).',
    params: z.object({ epic: z.int(), epicTitle: z.string() }),
  },
  DecisionComment: {
    file: 'DecisionComment.md',
    description: "The maintainer's decision, recorded on the ticket (GitHub text).",
    params: z.object({ decision: z.string() }),
  },
  SplitComment: {
    file: 'SplitComment.md',
    description: 'The split announcement with its slices and the split marker (GitHub text).',
    params: z.object({ issueComment: z.string(), slices: numbers, rationale: z.string() }),
  },
  CloseSplitComment: {
    file: 'CloseSplitComment.md',
    description: 'The comment that closes a ticket whose slices all landed (GitHub text).',
    params: z.object({ slices: numbers }),
  },
  FollowupsSection: {
    file: 'FollowupsSection.md',
    description: 'The filed follow-ups, listed in the PR description (GitHub text).',
    params: z.object({
      epic: z.int(),
      items: z.array(z.object({ number: z.int(), title: z.string().nullable() })),
    }),
  },
});
