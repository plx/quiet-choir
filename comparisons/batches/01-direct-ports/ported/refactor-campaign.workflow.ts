// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'refactor-campaign',
  description:
    "Find refactoring targets by measurable pressure, pin each target's behavior with characterization tests, refactor only behind a green net, and verify preservation",
  whenToUse:
    'Behavior-preserving technical-debt paydown — where the safety net is the point, not an afterthought',
  phases: [
    { title: 'Survey', detail: 'find targets by complexity/duplication/coupling' },
    { title: 'Rank', detail: 'prioritize by payoff vs. risk' },
    { title: 'Refactor', detail: 'net -> refactor -> verify, per target' },
  ],
};
export const input = z.object({
  ...executionInput,
  scope: z.string().optional(),
  goal: z.string().optional(),
  maxTargets: z.number().int().nonnegative().optional(),
  apply: z.boolean().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const TARGETS_SCHEMA = z
      .object({
        targets: z.array(
          z
            .object({
              location: z.string().describe('file or file:function'),
              pressure: z.enum([
                'complexity',
                'duplication',
                'coupling',
                'long-method',
                'primitive-obsession',
                'god-object',
              ]),
              evidence: z
                .string()
                .describe(
                  'the measurable signal — cyclomatic count, N duplicate sites, fan-in/out',
                ),
              testability: z
                .enum(['well-tested', 'thinly-tested', 'untested'])
                .describe('current test coverage of this code')
                .optional(),
            })
            .catchall(z.json()),
        ),
        testCommand: z.string().optional(),
      })
      .catchall(z.json());

    const RANK_SCHEMA = z
      .object({
        ranked: z.array(
          z
            .object({
              location: z.string(),
              refactoring: z
                .string()
                .describe(
                  'the specific named refactoring (extract method, replace conditional with polymorphism...)',
                ),
              payoff: z.enum(['high', 'medium', 'low']),
              risk: z.enum(['high', 'medium', 'low']),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    const NET_SCHEMA = z
      .object({
        status: z.enum(['green', 'cannot-pin']),
        netFile: z.string(),
        behaviorsPinned: z
          .array(z.string())
          .describe('observable behaviors now locked by characterization tests'),
        notes: z.string().optional(),
      })
      .catchall(z.json());

    const REFACTOR_SCHEMA = z
      .object({
        status: z.enum(['refactored', 'net-held-reverted', 'skipped']),
        summary: z.string(),
        netStillGreen: z.boolean().optional(),
      })
      .catchall(z.json());

    const scope = (args && args.scope) || 'the repository';
    const goal =
      (args && args.goal) || 'reduce complexity and duplication without changing behavior';
    const maxTargets = (args && args.maxTargets) || 4;
    const apply = Boolean(args && args.apply);

    // ---------------------------------------------------------------------------
    // Phase 1: Survey — targets chosen by MEASURABLE pressure, not taste. Also
    // records current testability, which gates the strategy per target later.
    // ---------------------------------------------------------------------------

    port.phase('Survey');

    const survey = await ctx.claude
      .object(port.id('agent-1', 'survey'), {
        ...args.$claude,
        prompt: `Find refactoring targets in ${scope}. Goal: ${goal}.
   Choose targets by MEASURABLE pressure — cyclomatic complexity, duplication
   (N near-identical sites), coupling (fan-in/out), method length, primitive
   obsession, god objects — not by aesthetic preference. For each, record the
   evidence (the actual number/count) and how well-tested it currently is.
   Also report the repo's test command. Report up to 12 targets.`,
        schema: TARGETS_SCHEMA,
      })
      .then((result) => result.output);

    if (!survey || survey.targets.length === 0) {
      return {
        refactored: [],
        netOnly: [],
        skipped: [],
        summary: 'No measurable refactoring targets found.',
      };
    }
    const testCommand = survey.testCommand || 'the repo test command';
    port.log(
      `${survey.targets.length} targets by pressure (${survey.targets.filter((t) => t.testability === 'untested').length} untested)`,
    );

    // ---------------------------------------------------------------------------
    // Phase 2: Rank by payoff vs. risk; pick top N.
    // ---------------------------------------------------------------------------

    port.phase('Rank');

    const ranking = await ctx.claude
      .object(port.id('agent-2', 'rank'), {
        ...args.$claude,
        prompt: `Rank these refactoring targets by payoff-vs-risk and name the SPECIFIC
   refactoring for each (a named technique, not "clean up"). Untested code is
   higher risk — weight accordingly. Pick the top ${maxTargets}.
   Targets: ${JSON.stringify(survey.targets, null, 2)}`,
        schema: RANK_SCHEMA,
        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (!ranking || ranking.ranked.length === 0) {
      return { refactored: [], netOnly: [], skipped: [], summary: 'Ranking failed.' };
    }
    const chosen = ranking.ranked.slice(0, maxTargets);
    const byLoc = new Map(survey.targets.map((t) => [t.location, t]));
    port.log(
      `Refactoring top ${chosen.length} targets${apply ? '' : ' (net + plan only — apply:false)'}`,
    );

    // ---------------------------------------------------------------------------
    // Phase 3: Per-target pipeline — net FIRST, then refactor only if the net is
    // green, then verify the net still holds. The safety gate is the whole point:
    // a target we cannot pin does not get refactored blind.
    // ---------------------------------------------------------------------------

    const results = await port.pipeline(
      'pipeline-1',
      chosen,

      // Stage 1: characterization net against the CURRENT code.
      (t) =>
        ctx.claude
          .object(port.id('agent-3', `net:${t.location.split('/').pop()}`), {
            ...args.$claude,
            prompt: `Pin the CURRENT observable behavior of ${t.location} with characterization
     tests — tests that capture what the code does NOW (bugs included; we are
     preserving behavior, not fixing it). These must PASS against the current,
     un-refactored code. Cover the real input/output pairs, edge cases, and side
     effects you can observe. Test command: ${testCommand}. Run them green before
     returning. If the behavior genuinely cannot be pinned (e.g. it needs live
     external systems), status "cannot-pin" — do not fake a net.`,
            schema: NET_SCHEMA,
            // Original phase: 'Refactor'; effort: 'high' — no matching ClaudeOptions control.
          })
          .then((result) => result.output)
          .then((net) => ({
            target: t,
            ranked: chosen.find((c) => c.location === t.location),
            net,
          })),

      // Stage 2: refactor behind the net — gated. No green net => no refactor.
      (r) => {
        if (!r) return { ...r, refactor: undefined };
        const info = byLoc.get(r.target.location) || {};
        if (!r.net || r.net.status !== 'green') {
          return {
            ...r,
            refactor: {
              status: 'skipped' as const,
              summary: `No safety net (${r.net ? r.net.notes : 'net failed'}) — not refactored blind.`,
              netStillGreen: false,
            },
          };
        }
        if (!apply) {
          return {
            ...r,
            refactor: {
              status: 'net-held-reverted' as const,
              summary: `Net green (${r.net.behaviorsPinned.length} behaviors pinned). Planned: ${r.ranked ? r.ranked.refactoring : 'refactoring'}. apply:false — not performed.`,
              netStillGreen: true,
            },
          };
        }
        return ctx.claude
          .object(port.id('agent-4', `refactor:${r.target.location.split('/').pop()}`), {
            ...args.$claude,
            prompt: `Apply this refactoring to ${r.target.location}: ${r.ranked ? r.ranked.refactoring : 'the planned refactoring'}.
       Goal: ${goal}. A characterization net pins current behavior — file ${r.net.netFile},
       pinning: ${JSON.stringify(r.net.behaviorsPinned)}.
       Refactor WITHOUT changing behavior; the net must stay green. Run the net
       (${testCommand}) after refactoring. If it goes red, your change altered
       behavior — REVERT the refactor (keep the net) and report status
       "net-held-reverted". Preserving behavior beats completing the refactor.`,
            schema: REFACTOR_SCHEMA,
            // Original phase: 'Refactor'; effort: 'high' — no matching ClaudeOptions control.
          })
          .then((result) => result.output)
          .then((ref) => ({ ...r, refactor: ref }));
      },

      // Stage 3: independent verification that the net still holds.
      (r) => {
        if (!r || !r.refactor || r.refactor.status !== 'refactored') return r;
        return ctx.claude
          .object(port.id('agent-5', `verify:${r.target.location.split('/').pop()}`), {
            ...args.$claude,
            prompt: `Independently confirm the refactoring of ${r.target.location} preserved
       behavior: run the characterization net ${r.net.netFile} (${testCommand})
       and confirm green, then read the diff and confirm the changes are
       structural, not behavioral. If either fails, report netStillGreen=false.`,
            schema: REFACTOR_SCHEMA,
            // Original phase: 'Refactor'; effort: 'high' — no matching ClaudeOptions control.
          })
          .then((result) => result.output)
          .then((v) => ({
            ...r,
            refactor: { ...r.refactor, netStillGreen: v ? v.netStillGreen : false, verified: true },
          }));
      },
    );

    const done = results.filter(Boolean);
    const refactored = done.filter(
      (r) => r.refactor && r.refactor.status === 'refactored' && r.refactor.netStillGreen,
    );
    const netOnly = done.filter((r) => r.refactor && r.refactor.status === 'net-held-reverted');
    const skipped = done.filter(
      (r) =>
        !r.refactor ||
        r.refactor.status === 'skipped' ||
        (r.refactor.status === 'refactored' && !r.refactor.netStillGreen),
    );

    return {
      refactored: refactored.map((r) => ({
        location: r.target.location,
        refactoring: r.ranked ? r.ranked.refactoring : null,
        behaviorsPinned: r.net.behaviorsPinned.length,
      })),
      netOnly: netOnly.map((r) => ({
        location: r.target.location,
        planned: r.ranked ? r.ranked.refactoring : null,
        behaviorsPinned: r.net.behaviorsPinned.length,
      })),
      skipped: skipped.map((r) => ({
        location: r.target.location,
        why: r.refactor ? r.refactor.summary : 'pipeline error',
      })),
      summary: apply
        ? `${refactored.length} refactored behind green nets, ${skipped.length} skipped (no net or behavior changed). Characterization tests were added and left in place.`
        : `${netOnly.length} targets pinned with characterization nets and planned; re-run with apply:true to refactor behind them. ${skipped.length} could not be pinned.`,
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
