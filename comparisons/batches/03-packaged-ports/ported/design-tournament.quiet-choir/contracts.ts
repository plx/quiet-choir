// Data contracts: the input and output schemas and the structured agent results.
import { z } from 'quiet-choir';

export const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const Path = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value
        .split('/')
        .every((part) => part !== '..' && part !== '.' && part !== '' && part !== '.git') &&
      !value.includes('\0'),
    'Use a repository-relative path without dot segments or .git',
  );
export const Receipt = z.object({
  path: z.string(),
  sha256: Digest,
  bytes: z.number().int().nonnegative(),
  previousSha256: Digest.nullable(),
});

/** The four design philosophies, in the order that assigns the letters A to D. */
export const Philosophy = z.enum(['ship-simplest', 'evolvability', 'data-first', 'failure-first']);
export type Philosophy = z.infer<typeof Philosophy>;
export const Letter = z.enum(['A', 'B', 'C', 'D']);
export type Letter = z.infer<typeof Letter>;

export const Proposal = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).describe('The design in one paragraph'),
  components: z
    .array(
      z.object({
        name: z.string().min(1),
        responsibility: z.string().min(1),
        interfaces: z
          .string()
          .nullable()
          .describe('What it exposes to and consumes from other components'),
      }),
    )
    .min(1)
    .max(16),
  dataFlow: z
    .string()
    .nullable()
    .describe('How a representative request or interaction moves through the design'),
  tradeoffs: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .describe('What this design deliberately sacrifices'),
  risks: z.array(z.string().min(1)).min(1).max(10).describe('Where this design most likely fails'),
  migrationPath: z
    .string()
    .nullable()
    .describe('How to get there from the current state, when the context describes one'),
});
/** A proposal under its anonymous letter, as the judges and the synthesizer read it. */
export const Lettered = Proposal.extend({ letter: Letter });
export type Lettered = z.infer<typeof Lettered>;
/** A proposal with its letter and the philosophy that produced it. */
export const Entry = Lettered.extend({ philosophy: Philosophy });
export type Entry = z.infer<typeof Entry>;

const axis = (meaning: string) => z.number().min(1).max(10).describe(`1-10: ${meaning}`);
const axes = {
  fitness: axis('solves the actual brief, including its awkward corners'),
  simplicity: axis('fewest concepts that could work; no speculative generality'),
  evolvability: axis('survives the requirements changing'),
  operability: axis('debuggable, observable, deployable by real humans'),
};
export const Axis = z.enum(['fitness', 'simplicity', 'evolvability', 'operability']);
export type Axis = z.infer<typeof Axis>;
const Score = z.object({
  proposal: Letter.describe('The proposal letter'),
  ...axes,
  rationale: z.string().min(1).describe('One paragraph; must cite specifics from the proposal'),
  bestIdea: z
    .string()
    .min(1)
    .nullable()
    .describe('The single strongest idea in this proposal, even if it loses overall'),
});
export type Score = z.infer<typeof Score>;
/** One judge's scorecard: every presented letter scored exactly once, each axis from 1 to 10. */
export const Scorecard = (letters: readonly [Letter, ...Letter[]]) =>
  z
    .object({
      scores: z
        .array(Score.extend({ proposal: z.enum(letters).describe('The proposal letter') }))
        .min(letters.length)
        .max(letters.length),
    })
    .refine(
      (card) => new Set(card.scores.map((score) => score.proposal)).size === card.scores.length,
      'Score every proposal exactly once',
    );

export const Seat = z.object({
  seat: z.number().int().min(1),
  harness: z.enum(['claude', 'codex']),
});
export type Seat = z.infer<typeof Seat>;

export const Standing = z.object({
  letter: Letter,
  philosophy: Philosophy,
  title: z.string(),
  avg: z.number().describe('Mean judge total out of 40, to one decimal'),
  votes: z.number().int().nonnegative().describe('Judges whose scorecard counted'),
  axes: z
    .object({
      fitness: z.number(),
      simplicity: z.number(),
      evolvability: z.number(),
      operability: z.number(),
    })
    .describe('Mean score per axis out of 10, to one decimal'),
});
export type Standing = z.infer<typeof Standing>;
export const Winner = Standing.extend({
  tiedWith: z.array(Letter).describe('Letters with the same average that lost the tie-break'),
});
export type Winner = z.infer<typeof Winner>;

/**
 * A losing proposal's best idea as the judges named it, merged across judges by text, ignoring
 * case and whitespace.
 */
export const Idea = z.object({
  id: z.string().regex(/^[A-D]\d+$/u),
  from: Letter,
  title: z.string(),
  idea: z.string(),
  judges: z.array(z.number().int().min(1)).min(1).describe('The judge seats that named it'),
});
export type Idea = z.infer<typeof Idea>;
export const Decision = z.enum(['grafted', 'rejected']);
export const Graft = Idea.extend({
  decision: Decision.nullable().describe('Null when the synthesizer left the idea undecided'),
  reason: z.string().nullable(),
});
export type Graft = z.infer<typeof Graft>;

/** The synthesizer's design and one decision per idea ID it was given. */
export const Synthesis = (ids: readonly string[]) =>
  z.object({
    design: z.string().min(1).describe('The design document as markdown'),
    grafts: z
      .array(
        z.object({
          idea: (ids.length ? z.enum(ids as [string, ...string[]]) : z.string()).describe(
            'The idea ID',
          ),
          decision: Decision,
          reason: z.string().min(1).describe('One sentence of why'),
        }),
      )
      .max(ids.length),
  });

export const Dissent = z.object({
  judge: z.number().int().min(1),
  total: z.number().describe("This judge's total for the winner out of 40"),
  avg: z.number().describe("The winner's panel average"),
  rationale: z.string(),
});
export type Dissent = z.infer<typeof Dissent>;

export const DesignTournamentInput = z.object({
  brief: z.string().min(1).describe('The design problem, its constraints and its success criteria'),
  context: z
    .string()
    .min(1)
    .nullable()
    .default(null)
    .describe('Repository paths or background the proposers study first'),
  judges: z.number().int().min(1).max(7).default(3).describe('Independent judge panel size'),
  crossHarness: z
    .boolean()
    .default(false)
    .describe('Seat every second judge on Codex, so panel agreement spans two harnesses'),
  out: Path.nullable()
    .default(null)
    .describe(
      'Create the design document here (an existing file refuses the run); when null, return it only',
    ),
  publication: z
    .enum(['file', 'commit'])
    .default('file')
    .describe('Create out as a file, or publish it as a managed commit for later stages'),
});

export const DesignTournamentOutput = z.object({
  status: z
    .enum(['complete', 'degraded', 'aborted', 'unjudged', 'refused'])
    .describe(
      'aborted: fewer than two proposals; unjudged: no scorecard survived; refused: out already exists, so nothing ran',
    ),
  winner: Winner.nullable(),
  scoreboard: z.array(Standing),
  design: z.string().nullable().describe('The synthesized document with the tournament record'),
  grafts: z.array(Graft),
  dissent: z.array(Dissent).describe('Judges who scored the winner at least 6 below its average'),
  proposals: z.array(Entry),
  failedProposals: z.array(Philosophy),
  failedJudges: z.array(z.number().int().min(1)),
  written: Receipt.nullable(),
});
export type DesignTournamentOutput = z.infer<typeof DesignTournamentOutput>;
