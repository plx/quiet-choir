// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'acceptance-qa-deep',
  description:
    "Decompose a ticket's acceptance criteria into concrete checks, verify each against the actual delivered code, and adversarially re-check the passes for letter-vs-spirit",
  whenToUse:
    'Gating whether finished work truly satisfies its ticket — the check "tests pass" does not make, including the criteria the developer forgot',
  phases: [
    { title: 'Decompose', detail: 'each AC -> binary-checkable sub-checks' },
    { title: 'Check', detail: 'verify each criterion against real code' },
    { title: 'Adversarial', detail: 'spirit-vs-letter re-check on passes' },
    { title: 'Verdict', detail: 'done / not-done with must-fixes' },
  ],
};
export const input = z.object({
  ...executionInput,
  criteria: z.string().optional(),
  target: z.string().optional(),
  ticket: z.string().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const DECOMP_SCHEMA = z
      .object({
        criteria: z.array(
          z
            .object({
              criterion: z.string().describe('one acceptance criterion, verbatim or normalized'),
              checks: z
                .array(z.string())
                .describe('binary, verifiable sub-checks that together prove the criterion'),
              kind: z
                .enum(['behavior', 'ui', 'api', 'data', 'performance', 'error-handling'])
                .optional(),
            })
            .catchall(z.json()),
        ),
        impliedCriteria: z
          .array(z.string())
          .describe(
            'criteria the ticket clearly intends but did not spell out (empty states, error paths, permissions)',
          )
          .optional(),
      })
      .catchall(z.json());

    const CHECK_SCHEMA = z
      .object({
        criterion: z.string(),
        status: z.enum(['pass', 'fail', 'partial', 'cannot-verify']),
        evidence: z
          .string()
          .describe(
            'what in the ACTUAL code/behavior proves this — file:line, command output, not the PR description',
          ),
        failingChecks: z.array(z.string()).optional(),
      })
      .catchall(z.json());

    const SPIRIT_SCHEMA = z
      .object({
        honest: z
          .boolean()
          .describe("true if the pass satisfies the criterion's INTENT, not just its letter"),
        reasoning: z.string(),
        gotcha: z
          .string()
          .describe('the narrow/cheating way it passes, if honest=false')
          .optional(),
      })
      .catchall(z.json());

    if (!args || !args.criteria) {
      return {
        error:
          'acceptance-qa-deep requires args: { criteria } — the acceptance criteria text or ticket path. Optional: { target, ticket }',
      };
    }
    const criteriaRef = args.criteria.includes('\n')
      ? `these acceptance criteria:\n---\n${args.criteria}\n---`
      : `the acceptance criteria in ${args.criteria}`;
    const target =
      (args && args.target) || 'the uncommitted working-tree changes; if clean, the latest commit';

    // ---------------------------------------------------------------------------
    // Phase 1: Decompose — vague ACs into binary checks, AND surface the implied
    // criteria the ticket meant but didn't write (the forgotten error path).
    // ---------------------------------------------------------------------------

    port.phase('Decompose');

    const decomp = await ctx.claude
      .object(port.id('agent-1', 'decompose'), {
        ...args.$claude,
        prompt: `Decompose ${criteriaRef} into verifiable checks.
   ${args.ticket ? `Fuller ticket context: ${args.ticket}` : ''}
   For each acceptance criterion, break it into binary sub-checks a QA engineer
   could each mark pass/fail by inspecting or running the code. Then add
   impliedCriteria: things this ticket clearly INTENDS but didn't spell out —
   the empty state, the permission check, the error path — because "done" means
   the intent, not just the bullet points.`,
        schema: DECOMP_SCHEMA,
        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (!decomp || decomp.criteria.length === 0) {
      return {
        verdict: 'no-criteria',
        criteria: [],
        mustFix: [],
        summary: 'No acceptance criteria could be decomposed.',
      };
    }
    // Implied criteria join the checklist (flagged), so the forgotten ones count.
    const allCriteria = [
      ...decomp.criteria,
      ...(decomp.impliedCriteria || []).map((c) => ({
        criterion: `(implied) ${c}`,
        checks: [c],
        kind: 'behavior',
      })),
    ];
    port.log(
      `${decomp.criteria.length} stated + ${(decomp.impliedCriteria || []).length} implied criteria to verify`,
    );

    // ---------------------------------------------------------------------------
    // Phases 2-3 as a pipeline: check -> adversarial-on-pass, per criterion.
    // The adversarial stage runs ONLY on passes (fails are already actionable);
    // it catches the "technically satisfies the words, misses the point" pass.
    // ---------------------------------------------------------------------------

    const results = await port.pipeline(
      'pipeline-1',
      allCriteria,

      (c) =>
        ctx.claude
          .object(port.id('agent-2', `check:${c.criterion.slice(0, 30)}`), {
            ...args.$claude,
            prompt: `Verify this acceptance criterion against the ACTUAL delivered work (${target}).
     Criterion: ${c.criterion}
     Sub-checks: ${JSON.stringify(c.checks)}
     Read the real code and run it where cheap. Ground your verdict in evidence
     from the code/behavior — file:line, command output — NOT in any PR
     description or commit message (those describe intent, not delivery). Status:
     pass (all sub-checks hold), fail, partial (some hold), or cannot-verify
     (needs a running environment you lack — say so, don't guess).`,
            schema: CHECK_SCHEMA,
            // Original phase: 'Check'; effort: 'high' — no matching ClaudeOptions control.
          })
          .then((result) => result.output)
          .then((v) => ({ criterion: c, verdict: v })),

      (r) => {
        if (!r || !r.verdict || r.verdict.status !== 'pass') return { ...r, spirit: undefined };
        return ctx.claude
          .object(port.id('agent-3', `spirit:${r.criterion.criterion.slice(0, 25)}`), {
            ...args.$claude,
            prompt: `A criterion was marked PASS. Check whether it passes in SPIRIT or only in
       letter. Criterion: ${r.criterion.criterion}
       Claimed-passing evidence: ${r.verdict.evidence}
       Look for the narrow pass: hardcoded to satisfy the check, works only for
       the happy example, satisfies the words while missing the intent, passes
       because a guard is disabled. honest=true only if a user relying on this
       criterion would actually be served.`,
            schema: SPIRIT_SCHEMA,
            // Original phase: 'Adversarial'; effort: 'high' — no matching ClaudeOptions control.
          })
          .then((result) => result.output)
          .then((s) => ({ ...r, spirit: s }));
      },
    );

    // ---------------------------------------------------------------------------
    // Phase 4: Verdict — computed in code from the checks, then narrated. A pass
    // downgraded by the spirit skeptic counts as a fail for the gate.
    // ---------------------------------------------------------------------------

    port.phase('Verdict');

    const graded = results.filter(Boolean).map((r) => {
      let status: string = r.verdict ? r.verdict.status : 'cannot-verify';
      if (status === 'pass' && r.spirit && !r.spirit.honest) status = 'fail-spirit';
      return {
        criterion: r.criterion.criterion,
        status,
        evidence: r.verdict ? r.verdict.evidence : null,
        gotcha: r.spirit && !r.spirit.honest ? r.spirit.gotcha : null,
      };
    });

    const failed = graded.filter(
      (g) => g.status === 'fail' || g.status === 'fail-spirit' || g.status === 'partial',
    );
    const unverifiable = graded.filter((g) => g.status === 'cannot-verify');
    const verdict =
      failed.length === 0 && unverifiable.length === 0
        ? 'done'
        : failed.length === 0
          ? 'done-pending-manual' // only cannot-verify items remain
          : 'not-done';

    port.log(
      `Verdict: ${verdict} — ${graded.filter((g) => g.status === 'pass').length}/${graded.length} clean pass, ${failed.length} failing, ${unverifiable.length} unverifiable`,
    );

    const summary = await ctx.claude
      .text(port.id('agent-4', 'summary'), {
        ...args.$claude,
        prompt: `Write a one-paragraph QA verdict for stakeholders.
   Overall: ${verdict}. Criteria results: ${JSON.stringify(graded, null, 2)}
   Lead with the verdict and why. If not-done, the must-fixes are the failing
   criteria — be specific and actionable. If done-pending-manual, name exactly
   what needs a human/environment to confirm. Return only the paragraph.`,

        // Original effort: 'low' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    return {
      verdict,
      criteria: graded,
      mustFix: failed.map((f) => ({
        criterion: f.criterion,
        why: f.gotcha || 'failing checks — see evidence',
        evidence: f.evidence,
      })),
      summary: summary || `${verdict}: ${failed.length} criteria failing.`,
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
