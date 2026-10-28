// incident-investigation: control flow only. Collectors and falsifiers are settled maps, so a
// failed member is recorded and accounted for; the confidence is derived in lib/policy.ts.
import { defineWorkflow } from 'quiet-choir';
import { Facts, Hypotheses, IncidentInput, IncidentOutput, Verdict } from '../contracts.js';
import { assertClean, changeLog, gitWindow } from '../lib/git.js';
import { rootCause, structuralConfidence } from '../lib/policy.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'incident-investigation',
  version: 'packaged-03',
  description:
    'Investigate an incident with a pinned Git window, read-only Codex roles and a structural confidence.',
  roster,
  prompts: [prompts],
  input: IncidentInput,
  output: IncidentOutput,
  async run(ctx, input) {
    await assertClean(ctx, 'before');
    const window = await gitWindow(ctx.within('range'), input.since, input.until);
    const log = await changeLog(ctx, window.start, window.end);
    const { incident, artifacts } = input;
    const domains = [...new Set(input.domains)];
    const collected = await ctx.map(
      'collectors',
      domains,
      { concurrency: 3, onError: 'return' },
      (domain) =>
        ctx.roster.Collector.value('collect', {
          schema: Facts,
          prompt: prompts.Collect({ incident, domain, artifacts, log }),
        }),
    );
    // Check immediately after collection as well as after the remaining read-only calls.
    await assertClean(ctx, 'after-collection');
    const evidence = domains.flatMap((domain, index) => {
      const result = collected[index];
      return result?.ok ? result.value.facts.map((fact) => ({ ...fact, domain })) : [];
    });
    const uncollected = domains.filter((_, index) => !collected[index]?.ok);
    const base = { ...window, clean: true as const, evidence, uncollected };
    if (!evidence.length)
      return {
        ...base,
        hypotheses: [],
        confidence: 'none' as const,
        rootCause: null,
        report: 'No evidence was collected; check the window, the artifacts and failed collectors.',
      };
    const { hypotheses } = await ctx.roster.Theorist.value('hypotheses', {
      schema: Hypotheses,
      prompt: prompts.Hypothesize({ incident, evidence }),
    });
    const verdicts = await ctx.map(
      'falsifiers',
      hypotheses,
      { concurrency: 3, onError: 'return' },
      (hypothesis, index) =>
        ctx.roster.Falsifier.value('falsify', {
          schema: Verdict,
          prompt: prompts.Falsify({
            incident,
            hypothesis,
            rivals: hypotheses.filter((_, other) => other !== index).map((rival) => rival.story),
            evidence,
          }),
        }),
    );
    const judged = hypotheses.map((hypothesis, index) => {
      const result = verdicts[index];
      return { ...hypothesis, verdict: result?.ok ? result.value : null };
    });
    const confidence = structuralConfidence(judged);
    const report = await ctx.roster.Reporter.value('report', {
      prompt: prompts.Report({ incident, evidence, judged, confidence }),
    });
    await assertClean(ctx, 'after-investigation');
    return { ...base, hypotheses: judged, confidence, rootCause: rootCause(judged), report };
  },
});
