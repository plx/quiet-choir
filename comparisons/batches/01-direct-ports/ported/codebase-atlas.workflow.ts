// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'codebase-atlas',
  description:
    'Survey a repo into subsystems, deep-read each in parallel, and synthesize an onboarding atlas with a completeness-critic repair round',
  whenToUse:
    'Onboarding to an unfamiliar codebase, or generating the architecture doc a project never had',
  phases: [
    { title: 'Survey', detail: 'partition the repo into subsystems' },
    { title: 'Deep-read', detail: 'one reader per subsystem' },
    { title: 'Synthesize', detail: 'merge cards into the atlas document' },
    { title: 'Critique', detail: 'completeness check + one repair round' },
  ],
};
export const input = z.object({
  ...executionInput,
  out: z.string().optional(),
  maxSubsystems: z.number().int().nonnegative().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const SURVEY_SCHEMA = z
      .object({
        projectSummary: z.string().describe('3-5 sentences: what this software is and does'),
        subsystems: z.array(
          z
            .object({
              name: z.string(),
              paths: z.array(z.string()),
              importance: z.enum(['core', 'supporting', 'peripheral']),
              hint: z.string().describe('one line on what this subsystem seems to do').optional(),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    const CARD_SCHEMA = z
      .object({
        name: z.string(),
        purpose: z.string().describe('2-4 sentences, written for a new team member'),
        keyFiles: z.array(z.object({ path: z.string(), role: z.string() }).catchall(z.json())),
        entryPoints: z.array(z.string()).describe('where execution enters this subsystem'),
        dependsOn: z.array(z.string()).describe('other subsystems or external services it needs'),
        dataFlows: z.string().describe('how data moves through it, one short paragraph').optional(),
        gotchas: z
          .array(z.string())
          .describe('surprises: non-obvious invariants, footguns, historical scars'),
      })
      .catchall(z.json());

    const CRITIQUE_SCHEMA = z
      .object({
        complete: z.boolean(),
        gaps: z.array(
          z
            .object({
              description: z.string(),
              repairAction: z
                .string()
                .describe('a concrete instruction a reader agent could execute'),
            })
            .catchall(z.json()),
        ),
        verdict: z.string().optional(),
      })
      .catchall(z.json());

    // --------------------------------------------------------------------------
    // Phase 1: Survey — cheap, structural. Its output IS the fan-out work list.
    // --------------------------------------------------------------------------

    port.phase('Survey');

    const outPath = (args && args.out) || 'docs/atlas.md';
    const maxSubsystems = (args && args.maxSubsystems) || 8;

    const survey = await ctx.claude
      .object(port.id('agent-1', 'survey'), {
        ...args.$claude,
        prompt: `Survey this repository and partition it into subsystems for a team of readers.
   Look at directory structure, build config, and entry points — skim, don't
   deep-read. A subsystem is a coherent unit someone could study alone (an API
   layer, a persistence layer, a worker fleet, a CLI, a frontend app...). Rank
   each core/supporting/peripheral. Prefer 4-8 subsystems; merge tiny ones.`,
        schema: SURVEY_SCHEMA,
        // Original effort: 'low' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (!survey || survey.subsystems.length === 0) {
      return {
        atlasPath: null,
        subsystems: [],
        skipped: [],
        critique: 'Survey found no subsystems — is this a code repository?',
      };
    }

    // Cap the fan-out, loudly. Core subsystems win slots first.
    const RANK = { core: 0, supporting: 1, peripheral: 2 };
    const ordered = [...survey.subsystems].sort((a, b) => RANK[a.importance] - RANK[b.importance]);
    const chosen = ordered.slice(0, maxSubsystems);
    const skipped = ordered.slice(maxSubsystems);
    if (skipped.length > 0)
      port.log(
        `Cap: deep-reading ${chosen.length} subsystems, skipping ${skipped.map((s) => s.name).join(', ')}`,
      );
    port.log(`Survey: ${survey.projectSummary}`);

    // --------------------------------------------------------------------------
    // Phase 2: Deep-read — the parallel heart. Readers are independent by
    // construction (the survey partitioned the repo), so no coordination needed.
    // This barrier is justified: synthesis needs every card to draw the
    // cross-subsystem dependency picture.
    // --------------------------------------------------------------------------

    port.phase('Deep-read');

    const cards = (
      await port.parallel(
        'parallel-1',
        chosen.map(
          (sub) => () =>
            ctx.claude
              .object(port.id('agent-2', `read:${sub.name}`), {
                ...args.$claude,
                prompt: `Deep-read the "${sub.name}" subsystem of this repository.
     Its paths: ${sub.paths.join(', ')}. Hint: ${sub.hint || 'none'}.
     Project context: ${survey.projectSummary}

     Read the actual code — not just filenames. Produce a card for a new team
     member: purpose, key files with each file's role, entry points, what it
     depends on, how data flows through it, and gotchas (non-obvious invariants,
     footguns, things that would surprise someone editing this next week).
     Gotchas are the most valuable field — dig for them.`,
                schema: CARD_SCHEMA,
              })
              .then((result) => result.output),
        ),
      )
    ).filter(Boolean);

    port.log(`${cards.length}/${chosen.length} subsystem cards complete`);

    // --------------------------------------------------------------------------
    // Phase 3: Synthesize — one writer, all cards. It also writes the file so the
    // atlas lands on disk even if the session moves on.
    // --------------------------------------------------------------------------

    port.phase('Synthesize');

    await ctx.claude
      .text(port.id('agent-3', 'write-atlas'), {
        ...args.$claude,
        prompt: `Write an onboarding atlas for this repository to the file ${outPath}
   (create parent directories if needed).

   Project summary: ${survey.projectSummary}
   Subsystem cards: ${JSON.stringify(cards, null, 2)}

   Structure: (1) What this is — the project summary, sharpened; (2) System map —
   a mermaid diagram of subsystems and their dependsOn edges; (3) one section per
   subsystem from its card, gotchas rendered prominently; (4) "Start here" — the
   3 files a new engineer should read first, with one line each on why.
   Write the file, then return just the absolute path you wrote.`,

        // Original effort: 'low' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    // --------------------------------------------------------------------------
    // Phase 4: Critique + one repair round. The critic compares the atlas against
    // the repo with fresh eyes. Its gaps are executable repair actions; we run up
    // to 3 of them and ask the synthesizer to weave the results in. One round only
    // — critics can always find more, and the second round's yield rarely pays.
    // --------------------------------------------------------------------------

    port.phase('Critique');

    const critique = await ctx.claude
      .object(port.id('agent-4', 'critic'), {
        ...args.$claude,
        prompt: `Read ${outPath} and audit it for completeness against the actual repository.
   What would a new engineer still be missing? Check: subsystems present in the
   code but absent from the atlas, dependency edges that are wrong, entry points
   that don't match reality, and load-bearing config/infrastructure the atlas
   ignores. For each gap give a repairAction a reader agent could execute.
   Skipped-by-budget subsystems (expected, still worth listing): ${skipped.map((s) => s.name).join(', ') || 'none'}.`,
        schema: CRITIQUE_SCHEMA,
        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (critique && !critique.complete && critique.gaps.length > 0) {
      const repairs = critique.gaps.slice(0, 3);
      if (critique.gaps.length > 3) port.log(`Repairing top 3 of ${critique.gaps.length} gaps`);
      const patches = (
        await port.parallel(
          'parallel-2',
          repairs.map(
            (gap, i) => () =>
              ctx.claude
                .text(port.id('agent-5', `repair:${i}`), {
                  ...args.$claude,
                  prompt: `Repair task for the atlas at ${outPath}: ${gap.repairAction}
       Context — the gap: ${gap.description}
       Research the answer in the repository and return the corrected/additional
       markdown content (not a diff), ready to merge into the atlas.`,

                  // Original phase: 'Critique' — no matching ClaudeOptions control.
                })
                .then((result) => result.output),
          ),
        )
      ).filter(Boolean);

      await ctx.claude
        .text(port.id('agent-6', 'merge-repairs'), {
          ...args.$claude,
          prompt: `Merge these repair patches into the atlas at ${outPath}, keeping its structure
     and voice. Patches: ${JSON.stringify(patches)}. Rewrite the file in place and
     return the path.`,

          // Original phase: 'Critique'; effort: 'low' — no matching ClaudeOptions control.
        })
        .then((result) => result.output);
    }

    return {
      atlasPath: outPath,
      subsystems: cards.map((c) => ({ name: c.name, purpose: c.purpose })),
      skipped: skipped.map((s) => s.name),
      critique: critique
        ? critique.verdict ||
          (critique.complete ? 'complete' : `${critique.gaps.length} gaps found, top 3 repaired`)
        : 'critic unavailable',
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
