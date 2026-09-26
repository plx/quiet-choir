// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'design-tournament',
  description:
    "Four proposers with forced-diverse design philosophies, an independent judge panel scoring a fixed rubric, and a synthesis that grafts the losers' best ideas",
  whenToUse:
    'Architecture and product decisions with a wide option space, where a single-track designer would anchor on the first workable idea',
  phases: [
    { title: 'Propose', detail: 'four philosophies design independently' },
    { title: 'Judge', detail: 'independent panel scores every proposal' },
    { title: 'Synthesize', detail: 'winner + grafts -> final design doc' },
  ],
};
export const input = z.object({
  ...executionInput,
  brief: z.string().optional(),
  context: z.string().optional(),
  judges: z.number().int().nonnegative().optional(),
  out: z.string().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const PROPOSAL_SCHEMA = z
      .object({
        title: z.string(),
        summary: z.string().describe('the design in one paragraph'),
        components: z.array(
          z
            .object({
              name: z.string(),
              responsibility: z.string(),
              interfaces: z
                .string()
                .describe('what it exposes to / consumes from other components')
                .optional(),
            })
            .catchall(z.json()),
        ),
        dataFlow: z
          .string()
          .describe('how a representative request/interaction moves through the design')
          .optional(),
        tradeoffs: z.array(z.string()).describe('what this design deliberately sacrifices'),
        risks: z.array(z.string()).describe('where this design most likely fails'),
        migrationPath: z
          .string()
          .describe('how to get there from the current state, if context given')
          .optional(),
      })
      .catchall(z.json());

    const SCORES_SCHEMA = z
      .object({
        scores: z.array(
          z
            .object({
              proposal: z.string().describe('the proposal letter: A, B, C, or D'),
              fitness: z
                .number()
                .describe('1-10: solves the actual brief, including its awkward corners'),
              simplicity: z
                .number()
                .describe('1-10: fewest concepts that could work; no speculative generality'),
              evolvability: z.number().describe('1-10: survives the requirements changing'),
              operability: z
                .number()
                .describe('1-10: debuggable, observable, deployable by real humans'),
              rationale: z
                .string()
                .describe('one paragraph; must cite specifics from the proposal'),
              bestIdea: z
                .string()
                .describe('the single strongest idea in this proposal, even if it loses overall')
                .optional(),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    if (!args || !args.brief) {
      return {
        error: 'design-tournament requires args: { brief }. Optional: { context, judges, out }',
      };
    }

    const brief = args.brief;
    const context = (args && args.context) || null;
    const judgeCount = (args && args.judges) || 3;

    // Philosophies are identities, not suggestions. Each one biases every design
    // decision differently — that bias is the diversity mechanism. A "be creative,
    // give me something different" prompt converges; an identity doesn't.
    const PHILOSOPHIES = [
      {
        key: 'A',
        name: 'ship-simplest',
        identity:
          'You believe the best design is the one a mid-level engineer ships correctly in two weeks and anyone can debug at 3am. Boring technology, few moving parts, obvious data flow. You would rather cut scope than add a concept.',
      },
      {
        key: 'B',
        name: 'evolvability',
        identity:
          "You believe requirements always change and the design's job is to make the NEXT change cheap. Strong interfaces, replaceable parts, explicit extension points where change is likely — and you are disciplined about not adding ones where it is not.",
      },
      {
        key: 'C',
        name: 'data-first',
        identity:
          'You believe designs live or die on their data model. Get the schema, ownership, consistency, and lifecycle of every piece of state right and the components fall out of it. You design the data model first and treat code as its custodian.',
      },
      {
        key: 'D',
        name: 'failure-first',
        identity:
          'You believe the design IS its failure modes. You start from what breaks — partial failures, retries, races, bad input, overload — and build the happy path inside whatever structure survives that analysis. Explicit invariants, idempotency, observability.',
      },
    ];

    // --------------------------------------------------------------------------
    // Phase 1: Propose — four independent designs. Proposers never see each
    // other. Barrier justified: judges need all proposals at once.
    // --------------------------------------------------------------------------

    port.phase('Propose');

    const proposals = (
      await port.parallel(
        'parallel-1',
        PHILOSOPHIES.map(
          (p) => () =>
            ctx.claude
              .object(port.id('agent-1', `propose:${p.name}`), {
                ...args.$claude,
                prompt: `${p.identity}

     Design a solution for this brief, in character, as your philosophy demands.
     BRIEF: ${brief}
     ${context ? `CONTEXT — study this first: ${context}` : ''}
     Be concrete: real component names, real interfaces, a walked-through data
     flow. State honestly what your design sacrifices (tradeoffs) and where it
     most likely fails (risks). Do not hedge toward a "balanced" design — the
     panel needs your philosophy expressed, not diluted.`,
                schema: PROPOSAL_SCHEMA,
              })
              .then((result) => result.output)
              .then((prop) => ({ letter: p.key, philosophy: p.name, proposal: prop })),
        ),
      )
    ).filter((r) => r && r.proposal);

    if (proposals.length < 2) {
      return {
        winner: null,
        scoreboard: [],
        design: null,
        grafts: [],
        dissent: 'Fewer than 2 proposals produced — tournament aborted.',
      };
    }
    port.log(
      `${proposals.length} proposals in: ${proposals.map((p) => `${p.letter}=${p.proposal.title}`).join(', ')}`,
    );

    // --------------------------------------------------------------------------
    // Phase 2: Judge — every judge scores EVERY proposal, independently, against
    // the same rubric. Proposals are presented anonymized (letter only, no
    // philosophy name) so judges evaluate the design, not the brand.
    // --------------------------------------------------------------------------

    port.phase('Judge');

    const anonymized = proposals.map((p) => ({ letter: p.letter, ...p.proposal }));

    const panels = (
      await port.parallel(
        'parallel-2',
        Array.from(
          { length: judgeCount },
          (_, j) => () =>
            ctx.claude
              .object(port.id('agent-2', `judge:${j + 1}`), {
                ...args.$claude,
                prompt: `You are judge ${j + 1} of ${judgeCount} on an independent design panel.
     BRIEF: ${brief}
     ${context ? `CONTEXT: ${context}` : ''}
     Score EVERY proposal below on the rubric (1-10 each axis). Judge against the
     brief, not against your personal taste. Your rationale must cite specifics —
     a score without a cited mechanism is invalid. Also name each proposal's
     single best idea, even for proposals you score low overall.
     PROPOSALS: ${JSON.stringify(anonymized, null, 2)}`,
                schema: SCORES_SCHEMA,
                // Original effort: 'high' — no matching ClaudeOptions control.
              })
              .then((result) => result.output),
        ),
      )
    ).filter(Boolean);

    // Tally in plain code — aggregation is arithmetic, not judgment.
    const tally = new Map(
      proposals.map((p) => [
        p.letter,
        {
          letter: p.letter,
          philosophy: p.philosophy,
          title: p.proposal.title,
          total: 0,
          votes: 0,
          bestIdeas: [],
        },
      ]),
    );
    for (const panel of panels) {
      for (const s of panel.scores) {
        const t = tally.get(s.proposal);
        if (!t) continue;
        t.total += s.fitness + s.simplicity + s.evolvability + s.operability;
        t.votes++;
        if (s.bestIdea) t.bestIdeas.push(s.bestIdea);
      }
    }
    const scoreboard = [...tally.values()]
      .map((t) => ({ ...t, avg: t.votes ? Math.round((t.total / t.votes) * 10) / 10 : 0 }))
      .sort((a, b) => b.avg - a.avg);
    const winner = scoreboard[0];
    port.log(
      `Scoreboard: ${scoreboard.map((s) => `${s.letter}(${s.philosophy})=${s.avg}`).join('  ')}`,
    );

    // --------------------------------------------------------------------------
    // Phase 3: Synthesize — the winner is the SKELETON, not the whole answer.
    // The synthesizer must consider every losing proposal's best ideas (as named
    // by the judges) and graft the compatible ones, recording what it grafted
    // and what it rejected. Dissent (a judge who scored the winner low) is
    // surfaced, not averaged away.
    // --------------------------------------------------------------------------

    port.phase('Synthesize');

    const winnerProposal = proposals.find((p) => p.letter === winner.letter);
    const losers = proposals.filter((p) => p.letter !== winner.letter);

    const design = await ctx.claude
      .text(port.id('agent-3', 'synthesize'), {
        ...args.$claude,
        prompt: `Synthesize the final design document.
   BRIEF: ${brief}
   ${context ? `CONTEXT: ${context}` : ''}

   WINNING proposal (${winner.avg}/40 avg) — use as the skeleton:
   ${JSON.stringify(winnerProposal.proposal, null, 2)}

   LOSING proposals' best ideas, as identified by independent judges:
   ${JSON.stringify(
     losers.map((l) => ({ from: l.proposal.title, ideas: (tally.get(l.letter) || {}).bestIdeas })),
     null,
     2,
   )}

   For each losing idea: graft it into the design if compatible, or explicitly
   reject it with one sentence of why. Produce a markdown design doc: decision
   summary, component architecture, data flow, failure handling, tradeoffs
   accepted, rejected alternatives (with the scoreboard), and open questions.
   ${args.out ? `Write the doc to ${args.out} and return the markdown as well.` : 'Return the markdown.'}`,

        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    // Surface dissent: a judge who scored the winner far below the panel mean is
    // signal about a real weakness, not noise to average away.
    const dissent = [];
    for (let j = 0; j < panels.length; j++) {
      const s = panels[j].scores.find((x) => x.proposal === winner.letter);
      if (s) {
        const judgeTotal = s.fitness + s.simplicity + s.evolvability + s.operability;
        if (judgeTotal <= winner.avg - 6)
          dissent.push(
            `Judge ${j + 1} scored the winner ${judgeTotal}/40 (panel avg ${winner.avg}): ${s.rationale}`,
          );
      }
    }

    return {
      winner: {
        letter: winner.letter,
        philosophy: winner.philosophy,
        title: winner.title,
        avg: winner.avg,
      },
      scoreboard: scoreboard.map((s) => ({
        letter: s.letter,
        philosophy: s.philosophy,
        title: s.title,
        avg: s.avg,
      })),
      design,
      grafts: losers.map((l) => ({
        from: l.proposal.title,
        judgesLiked: (tally.get(l.letter) || {}).bestIdeas,
      })),
      dissent: dissent.length ? dissent : 'No strong dissent — panel was aligned on the winner.',
    };
  }
}
export default defineWorkflow({
  name: meta.name,
  version: 'ultracode-direct-01',
  input,
  output: z.json() as unknown as z.ZodType<Awaited<ReturnType<typeof run>>>,
  run,
});
