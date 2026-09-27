// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'requirements-to-prd',
  description:
    'Extract raw requirements through four lenses, draft a PRD, attack it with ambiguity/scope/feasibility critics, and surface unknowns as open questions',
  whenToUse:
    'Turning meeting notes, briefs, transcripts, or feedback piles into a PRD honest enough to build from — with unknowns surfaced, not invented',
  phases: [
    { title: 'Extract', detail: 'four lenses over the raw material' },
    { title: 'Draft', detail: 'one writer, PRD structure' },
    { title: 'Attack', detail: 'ambiguity, scope, and feasibility critics' },
    { title: 'Revise', detail: 'apply critiques; unresolvables become questions' },
  ],
};
export const input = z.object({
  ...executionInput,
  input: z.string().optional(),
  product: z.string().optional(),
  answers: z.string().optional(),
  out: z.string().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const EXTRACT_SCHEMA = z
      .object({
        findings: z.array(
          z
            .object({
              point: z.string().describe('one extracted requirement/goal/constraint'),
              source: z
                .string()
                .describe('where in the raw material this comes from — quote or location'),
              confidence: z.enum(['stated', 'implied', 'inferred']).optional(),
            })
            .catchall(z.json()),
        ),
        unknowns: z
          .array(z.string())
          .describe('things the material raises but does not answer')
          .optional(),
        conflicts: z
          .array(z.string())
          .describe('places the material contradicts itself')
          .optional(),
      })
      .catchall(z.json());

    const CRITIQUE_SCHEMA = z
      .object({
        issues: z.array(
          z
            .object({
              problem: z.string().describe('quote the offending PRD text'),
              severity: z.enum(['blocking', 'major', 'minor']),
              fix: z
                .string()
                .describe('concrete rewrite, cut, or question to surface — never "clarify this"'),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    if (!args || !args.input) {
      return {
        error:
          'requirements-to-prd requires args: { input } — path(s) to raw requirement material, or the text itself. Optional: { product, answers, out }',
      };
    }
    const material = args.input.includes('\n')
      ? `this raw material:\n---\n${args.input}\n---`
      : `the raw requirement material at: ${args.input} (read all of it)`;
    const product = (args && args.product) || null;
    const answers = (args && args.answers) || null;

    // ---------------------------------------------------------------------------
    // Phase 1: Extract — four lenses, charters + anti-charters. Confidence tiers
    // matter downstream: "stated" survives critique untouched; "inferred" is what
    // the feasibility critic hunts. Barrier justified: the drafter needs all four.
    // ---------------------------------------------------------------------------

    port.phase('Extract');

    const LENSES = [
      {
        key: 'user-needs',
        charter:
          'What users need to DO and why: jobs, workflows, pains, the moments of truth. Ignore business metrics and technical constraints — other lenses own those.',
      },
      {
        key: 'business',
        charter:
          'Goals, success metrics, pricing/packaging implications, competitive positioning, deadlines with reasons. Ignore feature details unless tied to a goal.',
      },
      {
        key: 'constraints',
        charter:
          'Hard boundaries: technical constraints, compliance/privacy, platform requirements, performance/scale expectations, budget/team limits. Only what the material states or clearly implies — flag vague ones as unknowns.',
      },
      {
        key: 'unknowns',
        charter:
          'Your PRIMARY output is the unknowns and conflicts lists: every decision the material leaves open, every contradiction between sources, every "TBD" hiding in confident prose. Findings only for meta-requirements the other lenses would miss.',
      },
    ];

    const extractions = (
      await port.parallel(
        'parallel-1',
        LENSES.map(
          (l) => () =>
            ctx.claude
              .object(port.id('agent-1', `extract:${l.key}`), {
                ...args.$claude,
                prompt: `Read ${material}
     ${product ? `Product context: ${product}` : ''}
     ${answers ? `The product owner has ANSWERED a previous round of questions — treat these answers as first-class stated requirements:\n---\n${answers}\n---` : ''}
     Your lens: ${l.charter}
     Every finding carries its source and a confidence tier: stated (the material
     says it), implied (a reasonable reader agrees), inferred (you are guessing —
     be sparing). Do not invent requirements to fill gaps; gaps go in unknowns.`,
                schema: EXTRACT_SCHEMA,
              })
              .then((result) => result.output),
        ),
      )
    ).filter(Boolean);

    const findings = extractions.flatMap((e) => e.findings);
    const unknowns = [...new Set(extractions.flatMap((e) => e.unknowns || []))];
    const conflicts = [...new Set(extractions.flatMap((e) => e.conflicts || []))];
    port.log(
      `${findings.length} findings (${findings.filter((f) => f.confidence === 'inferred').length} inferred), ${unknowns.length} unknowns, ${conflicts.length} conflicts`,
    );

    if (findings.length === 0) {
      return {
        prd: null,
        assumptions: [],
        openQuestions: unknowns,
        conflicts,
        critiqueSummary: 'No requirements extracted — is the input readable?',
      };
    }

    // ---------------------------------------------------------------------------
    // Phase 2: Draft.
    // ---------------------------------------------------------------------------

    port.phase('Draft');

    const draft = await ctx.claude
      .text(port.id('agent-2', 'draft'), {
        ...args.$claude,
        prompt: `Draft a PRD from these extracted requirements.
   ${product ? `Product context: ${product}` : ''}
   Findings (with confidence tiers): ${JSON.stringify(findings, null, 2)}
   Known conflicts (present them as decisions-needed, do not silently pick a side): ${JSON.stringify(conflicts)}
   Structure: Problem & context / Goals and success metrics / Users and jobs /
   Requirements (must vs should, each traceable to findings) / Non-functional
   requirements / Explicitly out of scope / Open questions / Assumptions.
   Every "inferred"-tier finding you rely on must appear in Assumptions. The
   Open questions section starts from these unknowns: ${JSON.stringify(unknowns)}.
   Return only the PRD markdown.`,

        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    // ---------------------------------------------------------------------------
    // Phase 3: Attack — three critics, three failure modes of PRDs. Same anti-
    // charter logic as review dimensions: each critic ignores the others' turf.
    // ---------------------------------------------------------------------------

    port.phase('Attack');

    const CRITICS = [
      {
        key: 'ambiguity',
        charter:
          'Hunt text an engineer and a designer would read differently: unquantified adjectives ("fast", "simple"), requirements without acceptance shape, pronouns with unclear referents, "support X" without defining support. Ignore scope and feasibility.',
      },
      {
        key: 'scope',
        charter:
          'Hunt scope failure: requirements that are three features wearing one bullet, missing cut-lines, "phase 2" work hiding in phase 1, and goals no requirement actually serves. Propose concrete cuts. Ignore wording quality.',
      },
      {
        key: 'feasibility',
        charter:
          'Hunt wishful thinking: requirements that contradict the stated constraints, assumptions doing load-bearing work without evidence, success metrics that cannot be measured with what exists, dependencies on unbuilt or unnamed systems. Ignore style.',
      },
    ];

    const critiques = (
      await port.parallel(
        'parallel-2',
        CRITICS.map(
          (c) => () =>
            ctx.claude
              .object(port.id('agent-3', `attack:${c.key}`), {
                ...args.$claude,
                prompt: `Attack this PRD draft. Your charter: ${c.charter}
     Draft:\n---\n${draft}\n---
     Every issue quotes the offending text and gives a concrete fix — a rewrite,
     a cut, or a question to put to the product owner. "Blocking" means building
     from this text as-is would produce the wrong product.`,
                schema: CRITIQUE_SCHEMA,
                // Original effort: 'high' — no matching ClaudeOptions control.
              })
              .then((result) => result.output),
        ),
      )
    ).filter(Boolean);

    const issues = critiques.flatMap((c) => c.issues);
    port.log(
      `Critics raised ${issues.length} issues (${issues.filter((i) => i.severity === 'blocking').length} blocking)`,
    );

    // ---------------------------------------------------------------------------
    // Phase 4: Revise — one pass. Fixes that need the product owner become open
    // questions, not guesses; that is the honesty valve of the whole workflow.
    // ---------------------------------------------------------------------------

    port.phase('Revise');

    const revised = await ctx.claude
      .text(port.id('agent-4', 'revise'), {
        ...args.$claude,
        prompt: `Revise this PRD to address the critics' issues.
   Draft:\n---\n${draft}\n---
   Issues: ${JSON.stringify(issues, null, 2)}
   Apply every fix you can make WITHOUT new information from the product owner.
   Where a fix requires their input, add a precise question to Open Questions
   (with the decision's consequences) instead of guessing. Keep Assumptions
   honest — anything you decided unilaterally goes there.
   ${args.out ? `Write the final PRD to ${args.out} as well.` : ''}
   Return only the final PRD markdown.`,

        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    const finalPrd = revised || draft;
    // Pull the structured lists back out of the document so the session can
    // surface them without re-reading the PRD (checkpoint pattern).
    const section = (title) => {
      const m =
        finalPrd &&
        finalPrd.match(new RegExp(`#+\\s*${title}[^\\n]*\\n([\\s\\S]*?)(?=\\n#+\\s|$)`, 'i'));
      return m
        ? m[1]
            .split('\n')
            .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
            .filter(Boolean)
        : [];
    };

    return {
      prd: finalPrd,
      assumptions: section('Assumptions'),
      openQuestions: section('Open Questions'),
      conflicts,
      critiqueSummary: `${issues.length} issues raised, ${issues.filter((i) => i.severity === 'blocking').length} blocking. Re-run with args.answers to resolve the open questions.`,
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
