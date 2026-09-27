// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'incident-investigation',
  description:
    'Hypothesis-free parallel evidence collection, competing root-cause hypotheses, one falsifier per hypothesis, and a survivors-only report',
  whenToUse:
    'Post-incident root-cause analysis from a repo plus symptoms — structured to resist first-plausible-story bias',
  phases: [
    { title: 'Evidence', detail: 'four hypothesis-free collectors' },
    { title: 'Hypothesize', detail: 'generate competing explanations' },
    { title: 'Falsify', detail: 'one dedicated falsifier per hypothesis' },
    { title: 'Report', detail: 'timeline + root cause from survivors' },
  ],
};
export const input = z.object({
  ...executionInput,
  incident: z.string().optional(),
  window: z.string().optional(),
  artifacts: z.string().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const EVIDENCE_SCHEMA = z
      .object({
        facts: z.array(
          z
            .object({
              fact: z.string().describe('one observable fact — no interpretation'),
              source: z.string().describe('sha, file, log line, config path'),
              timestamp: z
                .string()
                .describe('when this fact occurred/changed, best effort; "unknown" allowed'),
              oddity: z
                .boolean()
                .describe('true if this fact is surprising regardless of any hypothesis')
                .optional(),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    const HYPOTHESES_SCHEMA = z
      .object({
        hypotheses: z
          .array(
            z
              .object({
                id: z.string().describe('H1, H2, ...'),
                story: z.string().describe('the causal chain from trigger to symptom'),
                mechanism: z.string().describe('the specific technical mechanism'),
                predictions: z
                  .array(z.string())
                  .describe('checkable facts that MUST hold if true — the falsifier attacks these'),
                priorPlausibility: z.enum(['high', 'medium', 'low']).optional(),
              })
              .catchall(z.json()),
          )
          .describe(
            '3-5 mutually DISTINCT hypotheses; each must differ in mechanism, not phrasing',
          ),
      })
      .catchall(z.json());

    const VERDICT_SCHEMA = z
      .object({
        verdict: z.enum(['falsified', 'survives', 'untestable']),
        reasoning: z.string(),
        checkedPredictions: z
          .array(
            z
              .object({
                prediction: z.string(),
                held: z.boolean(),
                evidence: z.string().optional(),
              })
              .catchall(z.json()),
          )
          .optional(),
      })
      .catchall(z.json());

    if (!args || !args.incident) {
      return {
        error:
          'incident-investigation requires args: { incident } — symptom description, when noticed, impact. Optional: { window, artifacts }',
      };
    }
    const incident = args.incident;
    const window = (args && args.window) || 'the last 7 days of repository history';
    const artifacts = (args && args.artifacts) || null;

    const READ_ONLY =
      'STRICTLY READ-ONLY: run no command that mutates the repo, files, services, or state. You are investigating a crime scene, not cleaning it.';

    // --------------------------------------------------------------------------
    // Phase 1: Evidence — four collectors, four domains, ZERO hypotheses. The
    // prompts deliberately withhold speculation requests: collectors report
    // facts and flag oddities, and the barrier pools everything before any
    // story exists to bias selection.
    // --------------------------------------------------------------------------

    port.phase('Evidence');

    const COLLECTORS = [
      {
        key: 'diffs',
        prompt: `Collect change evidence from ${window}: every commit touching code plausibly related to the symptom, plus any commit that is large, rushed (odd hours, "hotfix"/"revert" messages), or touches shared infrastructure. Read the diffs. Report facts with shas and timestamps.`,
      },
      {
        key: 'logs',
        prompt: `Collect runtime evidence${artifacts ? ` from: ${artifacts}` : ' from any logs, crash dumps, or traces checked into or referenced by this repo'}. Extract error messages, stack traces, timing patterns, and the first-occurrence timestamp of anything anomalous. If no artifacts exist, say so — report zero facts rather than inferring runtime behavior from code.`,
      },
      {
        key: 'config',
        prompt: `Collect configuration/infrastructure evidence from ${window}: changes to config files, environment templates, feature flags, CI/CD definitions, infrastructure-as-code, container/build definitions. Config changes are underrepresented in incident stories precisely because they are quiet — be thorough. Facts with sources and timestamps.`,
      },
      {
        key: 'deps',
        prompt: `Collect dependency evidence from ${window}: lockfile changes, version bumps, new/removed packages, toolchain updates (runtime versions, compiler flags). For each bump note whether it crossed a major version. Facts with sources and timestamps.`,
      },
    ];

    const pools = await port.parallel(
      'parallel-1',
      COLLECTORS.map(
        (c) => () =>
          ctx.claude
            .object(port.id('agent-1', `evidence:${c.key}`), {
              ...args.$claude,
              prompt: `Incident under investigation: ${incident}
     ${READ_ONLY}
     ${c.prompt}
     Report FACTS ONLY — no interpretation, no story, no suspects. Flag as
     oddity anything surprising on its own terms.`,
              schema: EVIDENCE_SCHEMA,
            })
            .then((result) => result.output)
            .then((r) => ({ domain: c.key, facts: r ? r.facts : [] })),
      ),
    );

    const evidence = pools
      .filter(Boolean)
      .flatMap((p) => p.facts.map((f) => ({ ...f, domain: p.domain })));
    const oddities = evidence.filter((f) => f.oddity);
    port.log(
      `${evidence.length} facts collected (${oddities.length} flagged as odd) across ${pools.filter(Boolean).length} domains`,
    );

    if (evidence.length === 0) {
      return {
        rootCause: null,
        confidence: 'none',
        timeline: null,
        survivors: [],
        falsified: [],
        report: 'No evidence collected — check window and artifacts args.',
      };
    }

    // --------------------------------------------------------------------------
    // Phase 2: Hypothesize — one generator, all evidence, MULTIPLE stories. The
    // schema's `predictions` field is the crucial part: a hypothesis without
    // falsifiable predictions is a vibe, and the falsifiers need attack surface.
    // --------------------------------------------------------------------------

    port.phase('Hypothesize');

    const hypo = await ctx.claude
      .object(port.id('agent-2', 'hypothesize'), {
        ...args.$claude,
        prompt: `Generate competing root-cause hypotheses for this incident.
   Incident: ${incident}
   Evidence (facts only, from four independent collectors):
   ${JSON.stringify(evidence, null, 2)}

   Produce 3-5 hypotheses with genuinely DIFFERENT mechanisms (not one story in
   five phrasings). At least one should involve the quiet domains (config/deps)
   and at least one should challenge the obvious suspect. For each: the causal
   story, the mechanism, and 2-4 PREDICTIONS — specific checkable facts that
   must hold if the hypothesis is true ("the error rate started after sha X
   deployed", "the bad output only occurs for inputs over 1MB"). Predictions
   are what the falsifiers will attack; vague predictions make the hypothesis
   untestable, which is a defect.`,
        schema: HYPOTHESES_SCHEMA,
        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (!hypo || hypo.hypotheses.length === 0) {
      return {
        rootCause: null,
        confidence: 'none',
        timeline: null,
        survivors: [],
        falsified: [],
        report: 'Hypothesis generation failed.',
      };
    }
    port.log(
      `${hypo.hypotheses.length} competing hypotheses: ${hypo.hypotheses.map((h) => h.id).join(', ')}`,
    );

    // --------------------------------------------------------------------------
    // Phase 3: Falsify — one dedicated adversary per hypothesis, all concurrent.
    // Note the assignment: each falsifier gets ONE hypothesis to kill and the
    // others only as context. An agent asked to "evaluate all five" reverts to
    // picking a favorite; an agent asked to kill one is thorough about that one.
    // --------------------------------------------------------------------------

    port.phase('Falsify');

    const verdicts = (
      await port.parallel(
        'parallel-2',
        hypo.hypotheses.map(
          (h) => () =>
            ctx.claude
              .object(port.id('agent-3', `falsify:${h.id}`), {
                ...args.$claude,
                prompt: `Your single job: FALSIFY hypothesis ${h.id}.
     ${READ_ONLY}
     Incident: ${incident}
     Hypothesis: ${h.story}
     Mechanism: ${h.mechanism}
     Predictions to attack: ${JSON.stringify(h.predictions)}
     Rival hypotheses (context only — do not evaluate them): ${hypo.hypotheses
       .filter((x) => x.id !== h.id)
       .map((x) => x.story)
       .join(' | ')}

     Check each prediction against the actual repo/logs/config. A prediction
     that fails falsifies the hypothesis. A prediction you cannot check is
     "untestable" — say so rather than assuming it holds. Verdict "survives"
     ONLY if every checkable prediction held under a genuine attempt to break
     it. Falsifying a hypothesis is a success, not a failure.`,
                schema: VERDICT_SCHEMA,
                // Original effort: 'high' — no matching ClaudeOptions control.
              })
              .then((result) => result.output)
              .then((v) => ({ hypothesis: h, verdict: v })),
        ),
      )
    ).filter((r) => r && r.verdict);

    const survivors = verdicts.filter((v) => v.verdict.verdict === 'survives');
    const falsified = verdicts.filter((v) => v.verdict.verdict === 'falsified');
    const untestable = verdicts.filter((v) => v.verdict.verdict === 'untestable');
    port.log(
      `Falsification: ${survivors.length} survive, ${falsified.length} falsified, ${untestable.length} untestable`,
    );

    // --------------------------------------------------------------------------
    // Phase 4: Report. Confidence derives from the STRUCTURE of the outcome, in
    // code — not from a model's self-reported feeling: exactly one survivor with
    // others falsified = high; multiple survivors = the report must say what
    // evidence would discriminate them; zero survivors = honest "unknown".
    // --------------------------------------------------------------------------

    port.phase('Report');

    const confidence =
      survivors.length === 1 && falsified.length >= 1
        ? 'high'
        : survivors.length === 1
          ? 'medium'
          : survivors.length > 1
            ? 'split'
            : 'none';

    const report = await ctx.claude
      .text(port.id('agent-4', 'report'), {
        ...args.$claude,
        prompt: `Write the incident-investigation report in markdown.
   Incident: ${incident}
   Evidence pool (cite facts by source): ${JSON.stringify(evidence, null, 2)}
   Verdicts: ${JSON.stringify(
     verdicts.map((v) => ({
       id: v.hypothesis.id,
       story: v.hypothesis.story,
       verdict: v.verdict.verdict,
       reasoning: v.verdict.reasoning,
       checked: v.verdict.checkedPredictions,
     })),
     null,
     2,
   )}
   Structural confidence: ${confidence}

   Structure: (1) Timeline — merge the evidence timestamps into an ordered
   narrative from first cause to detection; (2) Root cause — ${
     confidence === 'high'
       ? 'the surviving hypothesis, stated as the finding, with its verified predictions as proof'
       : confidence === 'split'
         ? 'the surviving hypotheses AND the specific evidence that would discriminate between them — do not pick a favorite'
         : confidence === 'none'
           ? 'state honestly that all hypotheses were falsified or untestable; list what evidence is missing'
           : 'the surviving hypothesis with the caveat that no rival was affirmatively falsified'
   }; (3) Falsified explanations — each dead hypothesis and what killed it
   (this section prevents the next investigator from re-walking dead ends);
   (4) Prevention — 2-4 concrete changes that would have prevented or caught
   this sooner. Cite evidence sources throughout.`,

        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    return {
      rootCause: survivors.length === 1 ? survivors[0].hypothesis.story : null,
      confidence,
      timeline: 'see report',
      survivors: survivors.map((s) => ({ id: s.hypothesis.id, story: s.hypothesis.story })),
      falsified: falsified.map((f) => ({
        id: f.hypothesis.id,
        story: f.hypothesis.story,
        killedBy: f.verdict.reasoning,
      })),
      report,
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
