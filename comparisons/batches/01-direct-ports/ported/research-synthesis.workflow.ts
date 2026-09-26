// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'research-synthesis',
  description:
    'Multi-modal lead sweep, ranked deep-reads with per-claim citations, synthesis, and one critic-driven supplementary round',
  whenToUse:
    'Technology decisions, state-of-the-art surveys, and due diligence questions that deserve cited evidence over a single search pass',
  phases: [
    { title: 'Sweep', detail: 'four modalities hunt for leads' },
    { title: 'Deep-read', detail: 'ranked leads get full readings' },
    { title: 'Synthesize', detail: 'cited answer from the readings' },
    { title: 'Critique', detail: 'gap check + one targeted extra round' },
  ],
};
export const input = z.object({
  ...executionInput,
  question: z.string().optional(),
  context: z.string().optional(),
  depth: z.string().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const LEADS_SCHEMA = z
      .object({
        leads: z.array(
          z
            .object({
              ref: z
                .string()
                .describe(
                  'URL, package name, file path, or issue link — enough for a reader to find it',
                ),
              kind: z.enum([
                'official-docs',
                'source-code',
                'issue-thread',
                'benchmark',
                'writeup',
                'discussion',
                'paper',
                'local-code',
              ]),
              promise: z
                .string()
                .describe('what this lead likely contains that answers the question'),
              credibility: z.enum(['primary', 'secondary', 'anecdotal']).optional(),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    const READING_SCHEMA = z
      .object({
        ref: z.string(),
        useful: z.boolean(),
        findings: z.array(
          z
            .object({
              claim: z.string().describe('one specific fact/result relevant to the question'),
              support: z
                .string()
                .describe(
                  'where in the source this comes from — section, code location, data point',
                ),
              caveat: z
                .string()
                .describe('scope limits: version, scale, age of the info')
                .optional(),
            })
            .catchall(z.json()),
        ),
        contradicts: z
          .string()
          .describe('anything here that contradicts common belief or other likely sources')
          .optional(),
      })
      .catchall(z.json());

    const CRITIQUE_SCHEMA = z
      .object({
        adequate: z.boolean(),
        gaps: z.array(
          z
            .object({
              gap: z.string().describe('what the answer is missing or asserting without evidence'),
              huntInstruction: z
                .string()
                .describe('a TARGETED search/read instruction — not "search more"'),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    if (!args || !args.question) {
      return {
        error:
          'research-synthesis requires args: { question }. Optional: { context, depth: quick|standard|deep }',
      };
    }
    const question = args.question;
    const context = (args && args.context) || null;
    const READS = { quick: 4, standard: 8, deep: 14 }[(args && args.depth) || 'standard'] || 8;

    // --------------------------------------------------------------------------
    // Phase 1: Sweep — four modalities, each charter naming what the OTHERS miss.
    // Sweepers return leads, not answers: discovery is cheap, reading is not,
    // and the ranking between them is where the token budget gets protected.
    // --------------------------------------------------------------------------

    port.phase('Sweep');

    const MODALITIES = [
      {
        key: 'web',
        charter: `Web search (load WebSearch/WebFetch via ToolSearch). Hunt official docs, engineering blog writeups, benchmarks, and papers. Your blind spot is recency-vs-SEO: a 2019 blog post outranks last month's changelog — check dates, prefer primary sources, and note versions.`,
      },
      {
        key: 'source',
        charter: `Source code and releases. For any library/tool the question involves: its repo, changelog, release cadence, open-vs-closed issue ratio, test quality. Code doesn't lie about capabilities the way marketing pages do. Use web fetch (via ToolSearch) for remote repos.`,
      },
      {
        key: 'practitioners',
        charter: `Practitioner discussions: issue threads, forum/HN/SO discussions, postmortems mentioning the topic. This is where "works great until 10k QPS" lives — the failure modes official docs omit. Mark everything here anecdotal unless corroborated.`,
      },
      {
        key: 'local',
        charter: context
          ? `The local context: ${context}. Search the local repository/environment for current usage, constraints, and integration points that would make general advice inapplicable. This modality grounds the answer in OUR reality.`
          : `Skip — no local context provided. Return an empty leads list.`,
      },
    ];

    const sweeps = await port.parallel(
      'parallel-1',
      MODALITIES.map(
        (m) => () =>
          ctx.claude
            .object(port.id('agent-1', `sweep:${m.key}`), {
              ...args.$claude,
              prompt: `Research question: ${question}
     ${context ? `Context: ${context}` : ''}
     Your modality: ${m.charter}
     Return LEADS ONLY — refs a deep-reader can follow, each with what it
     promises and a credibility tier. Do not read anything in depth; 8-12 good
     leads beat 30 mediocre ones.`,
              schema: LEADS_SCHEMA,
              // Original effort: 'low' — no matching ClaudeOptions control.
            })
            .then((result) => result.output),
      ),
    );

    const seenRefs = new Set();
    const leads = [];
    for (const s of sweeps.filter(Boolean)) {
      for (const l of s.leads) {
        const norm = l.ref.toLowerCase().replace(/\/+$/, '');
        if (!seenRefs.has(norm)) {
          seenRefs.add(norm);
          leads.push(l);
        }
      }
    }
    // Rank: primary sources first, then secondary; anecdotal reads last and only
    // at deep depth. Mechanical rule, so it lives in code.
    const CRED = { primary: 0, secondary: 1, anecdotal: 2 };
    leads.sort((a, b) => CRED[a.credibility] - CRED[b.credibility]);
    const toRead = leads.slice(0, READS);
    port.log(
      `${leads.length} unique leads; deep-reading top ${toRead.length} (${leads.length - toRead.length} deferred)`,
    );

    if (toRead.length === 0) {
      return {
        answer:
          'No leads found — the question may need rephrasing or the modalities lack the required tools.',
        sources: [],
        confidence: 'none',
        gaps: [],
      };
    }

    // --------------------------------------------------------------------------
    // Phase 2: Deep-read — one reader per lead. The schema forces claim+support
    // pairs: a reading that returns prose without per-claim anchors is useless
    // to a synthesizer that must cite.
    // --------------------------------------------------------------------------

    port.phase('Deep-read');

    const readLead = (l) =>
      ctx.claude
        .object(port.id('agent-2', `read:${l.ref.slice(0, 40)}`), {
          ...args.$claude,
          prompt: `Deep-read this source for the research question: ${question}
   Source: ${l.ref} (${l.kind}; expected: ${l.promise})
   Load web tools via ToolSearch if the ref is remote. Extract every finding
   relevant to the question as claim+support pairs — support says exactly where
   in the source the claim comes from. Note caveats (version, scale, age).
   Flag anything contradicting common belief. If the source turns out to be
   useless or inaccessible, say useful=false — do not pad.`,
          schema: READING_SCHEMA,
          // Original phase: 'Deep-read'; effort: 'low' — no matching ClaudeOptions control.
        })
        .then((result) => result.output);

    const readings = (
      await port.parallel(
        'parallel-2',
        toRead.map((l) => () => readLead(l)),
      )
    )
      .filter(Boolean)
      .filter((r) => r.useful);
    port.log(`${readings.length}/${toRead.length} sources yielded findings`);

    // --------------------------------------------------------------------------
    // Phase 3: Synthesize — every substantive claim in the answer must carry a
    // [ref] citation drawn from the readings. Contradictions between sources are
    // surfaced as contradictions, never silently averaged.
    // --------------------------------------------------------------------------

    port.phase('Synthesize');

    const synthesize = (extraReadings = []) =>
      ctx.claude
        .text(port.id('agent-3', 'synthesize'), {
          ...args.$claude,
          prompt: `Synthesize an evidence-based answer.
   Question: ${question}
   ${context ? `Context (the answer must fit this reality): ${context}` : ''}
   Readings: ${JSON.stringify([...readings, ...(extraReadings || [])], null, 2)}

   Rules: every substantive claim carries a citation [ref]. Where sources
   disagree, present the disagreement and which source is better-placed to be
   right (primary beats secondary beats anecdotal; recent beats stale for
   fast-moving topics) — do not average contradictions into mush. Distinguish
   "the evidence shows" from "the evidence suggests" from "no evidence found".
   Structure: direct answer first (one paragraph), then the evidence, then
   caveats and what we could not determine. Return markdown.`,

          // Original phase: 'Synthesize'; effort: 'high' — no matching ClaudeOptions control.
        })
        .then((result) => result.output);

    let answer = await synthesize();

    // --------------------------------------------------------------------------
    // Phase 4: Critique -> ONE targeted supplementary round. The critic's gaps
    // come with hunt instructions; up to 3 hunters run them, and the synthesizer
    // revises once. One round is a design choice: critics always find more, and
    // the second round's marginal yield rarely justifies a third.
    // --------------------------------------------------------------------------

    port.phase('Critique');

    const critique = await ctx.claude
      .object(port.id('agent-4', 'critic'), {
        ...args.$claude,
        prompt: `Critique this research answer for completeness and evidential honesty.
   Question: ${question}
   Answer:\n---\n${answer}\n---
   Sources consulted: ${readings.map((r) => r.ref).join(', ')}
   Hunt for: claims with no citation, obvious source types never consulted
   (e.g. the official changelog for a version-sensitive claim), the question's
   sub-parts left unanswered, and one-source claims that need corroboration.
   For each gap write a TARGETED huntInstruction — a specific search or a
   specific document to read, not "do more research".`,
        schema: CRITIQUE_SCHEMA,
        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    let gaps = [];
    if (critique && !critique.adequate && critique.gaps.length > 0) {
      gaps = critique.gaps.map((g) => g.gap);
      const hunts = critique.gaps.slice(0, 3);
      if (critique.gaps.length > 3) port.log(`Hunting top 3 of ${critique.gaps.length} gaps`);
      const extra = (
        await port.parallel(
          'parallel-3',
          hunts.map(
            (g, i) => () =>
              ctx.claude
                .object(port.id('agent-5', `hunt:${i + 1}`), {
                  ...args.$claude,
                  prompt: `Targeted research hunt for a gap in an answer to: ${question}
       Gap: ${g.gap}
       Instruction: ${g.huntInstruction}
       Load web tools via ToolSearch if needed. Return claim+support findings
       for exactly this gap; useful=false if the hunt comes up genuinely empty.`,
                  schema: READING_SCHEMA,
                  // Original phase: 'Critique' — no matching ClaudeOptions control.
                })
                .then((result) => result.output),
          ),
        )
      )
        .filter(Boolean)
        .filter((r) => r.useful);

      if (extra.length > 0) {
        answer = await synthesize(extra);
        readings.push(...extra);
      }
    }

    const primaryCount = toRead.filter((l) => l.credibility === 'primary').length;
    return {
      answer,
      sources: readings.map((r) => r.ref),
      confidence:
        primaryCount >= 3 && (!critique || critique.adequate || gaps.length <= 1)
          ? 'high'
          : readings.length >= 4
            ? 'moderate'
            : 'low',
      gaps,
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
