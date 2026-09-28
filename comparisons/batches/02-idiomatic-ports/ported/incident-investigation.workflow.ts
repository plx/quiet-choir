// Idiomatic rewrite of the pinned MIT upstream; see ../LICENSE and ../notes.json.
import { defineWorkflow, z } from 'quiet-choir';
import { Sha, assertClean, git, gitWindow, json, profiles } from './support.js';

export default defineWorkflow({
  name: 'incident-investigation',
  version: 'idiomatic-02',
  description: 'Investigate an incident with a pinned Git window and read-only Codex collectors.',
  profiles: { reader: profiles.reader },
  input: z.object({
    incident: z.string().min(1).describe('Observed symptoms, impact and incident timeline'),
    since: z.string().min(1).describe('Exclusive starting Git revision for the investigation'),
    until: z.string().min(1).default('HEAD'),
    artifacts: z.array(z.string().min(1)).max(20).default([]),
    lenses: z.array(z.string().min(1)).min(1).max(6).default(['changes', 'logs', 'dependencies']),
  }),
  output: z.object({
    start: Sha,
    end: Sha,
    manifest: z.array(Sha),
    clean: z.literal(true),
    hypotheses: z.array(
      z.object({
        cause: z.string(),
        evidence: z.array(z.string()),
        counterEvidence: z.array(z.string()),
      }),
    ),
    conclusion: z.string(),
    uncertainties: z.array(z.string()),
  }),
  async run(ctx, input) {
    await assertClean(ctx, 'before');
    const window = await gitWindow(ctx.within('range'), input.since, input.until);
    const changes = await git(ctx, 'changes', [
      'log',
      '--format=fuller',
      '--stat',
      `${window.start}..${window.end}`,
      '--',
    ]);
    const evidence = await ctx.map('collectors', input.lenses, { concurrency: 3 }, (lens) =>
      ctx.codex.value('collect', {
        profile: 'reader',
        schema: z.object({ observations: z.array(z.string()), unknowns: z.array(z.string()) }),
        prompt: `Collect evidence for this incident through the ${lens} lens. Do not change files. Cite artifacts and distinguish observations from guesses.\n${json({ incident: input.incident, artifacts: input.artifacts, changes })}`,
      }),
    );
    // Check immediately after collection as well as after the remaining read-only calls.
    await assertClean(ctx, 'after-collection');
    const hypotheses = await ctx.codex.value('hypotheses', {
      profile: 'reader',
      schema: z.object({
        items: z
          .array(z.object({ cause: z.string().min(1), evidence: z.array(z.string()) }))
          .max(8),
      }),
      prompt: `Rank falsifiable root-cause hypotheses.\n${json({ incident: input.incident, evidence })}`,
    });
    const challenged = await ctx.map(
      'skeptics',
      hypotheses.items,
      { concurrency: 3 },
      async (hypothesis) => ({
        ...hypothesis,
        ...(await ctx.codex.value('challenge', {
          profile: 'reader',
          schema: z.object({ counterEvidence: z.array(z.string()) }),
          prompt: `Try to disprove this hypothesis using the repository and supplied evidence.\n${json({ hypothesis, evidence })}`,
        })),
      }),
    );
    const report = await ctx.codex.value('report', {
      profile: 'reader',
      schema: z.object({ conclusion: z.string(), uncertainties: z.array(z.string()) }),
      prompt: `Write a grounded incident conclusion, including uncertainty, from these challenged hypotheses.\n${json(challenged)}`,
    });
    await assertClean(ctx, 'after-investigation');
    return { ...window, clean: true, hypotheses: challenged, ...report };
  },
});
