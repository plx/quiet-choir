// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'flaky-test-hunt',
  description:
    'Gather flaky-test suspects from git/CI/code smells, stress-run each for an empirical flake rate, then diagnose mechanisms for confirmed flakes',
  whenToUse:
    'Unexplained CI red streaks, or auditing a test suite with a reputation for randomness',
  phases: [
    { title: 'Suspects', detail: 'git history ∥ smell grep ∥ CI artifacts' },
    { title: 'Stress', detail: 'N repeated runs per suspect' },
    { title: 'Diagnose', detail: 'mechanism + fix per confirmed flake' },
  ],
};
export const input = z.object({
  ...executionInput,
  scope: z.string().optional(),
  runs: z.number().int().nonnegative().optional(),
  maxSuspects: z.number().int().nonnegative().optional(),
  fix: z.boolean().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const SUSPECTS_SCHEMA = z
      .object({
        suspects: z.array(
          z
            .object({
              test: z.string().describe('test name/identifier as the runner sees it'),
              file: z.string(),
              evidence: z.string(),
            })
            .catchall(z.json()),
        ),
        testCommand: z.string().describe('how to run a single test in this repo').optional(),
      })
      .catchall(z.json());

    const STRESS_SCHEMA = z
      .object({
        runs: z.number(),
        failures: z.number(),
        verdict: z.enum(['flaky', 'stable', 'always-fails', 'could-not-run']),
        failureOutput: z.string().describe('representative failure output, truncated').optional(),
        timingNotes: z
          .string()
          .describe('run durations if suggestive (e.g. failures correlate with slow runs)')
          .optional(),
      })
      .catchall(z.json());

    const DIAGNOSIS_SCHEMA = z
      .object({
        mechanism: z.enum([
          'shared-state',
          'timing-timeout',
          'async-race',
          'external-dependency',
          'random-data',
          'resource-exhaustion',
          'test-order-dependence',
          'clock-dependence',
          'unknown',
        ]),
        explanation: z.string().describe('the causal story: WHY it fails only sometimes'),
        proposedFix: z
          .string()
          .describe('a real fix — retry-wrapping only if the flake is genuinely external'),
        confidence: z.enum(['high', 'medium', 'low']).optional(),
      })
      .catchall(z.json());

    const scope = (args && args.scope) || 'the test suite of this repository';
    const runs = (args && args.runs) || 8;
    const maxSuspects = (args && args.maxSuspects) || 10;
    const applyFixes = Boolean(args && args.fix);

    // --------------------------------------------------------------------------
    // Phase 1: Three suspect sweeps, three kinds of evidence. Barrier justified:
    // corroboration (same test flagged by 2+ modalities) drives the stress-run
    // priority order, which needs all sweeps merged.
    // --------------------------------------------------------------------------

    port.phase('Suspects');

    const sweeps = await port.parallel('parallel-1', [
      () =>
        ctx.claude
          .object(port.id('agent-1', 'sweep:git-history'), {
            ...args.$claude,
            prompt: `Find flaky-test SUSPECTS in ${scope} via git history: log/blame for commits
     mentioning flaky/flake/retry/deflake/skip/quarantine/"fix test", tests whose
     files churn without behavior changes, and skip/only markers added then
     removed. Also report how to run a SINGLE test in this repo (exact command
     shape). Suspects only — do not run anything.`,
            schema: SUSPECTS_SCHEMA,
          })
          .then((result) => result.output),
      () =>
        ctx.claude
          .object(port.id('agent-2', 'sweep:smells'), {
            ...args.$claude,
            prompt: `Find flaky-test SUSPECTS in ${scope} by grepping test code for flake smells:
     sleeps/arbitrary waits, real-clock time or "now" comparisons, unseeded
     randomness, real network/filesystem/ports, order-dependent shared fixtures,
     race-prone async patterns (unawaited promises, fire-and-forget), generous
     custom timeouts, and retry annotations already present. Report the specific
     smell per suspect. Do not run anything.`,
            schema: SUSPECTS_SCHEMA,
          })
          .then((result) => result.output),
      () =>
        ctx.claude
          .object(port.id('agent-3', 'sweep:ci-artifacts'), {
            ...args.$claude,
            prompt: `Find flaky-test SUSPECTS from CI/test artifacts in this repo, if any exist:
     CI config with retry settings, junit/report XML, .github workflow logs
     checked into the repo, quarantine lists, test-results directories. If no
     artifacts exist, return an empty suspects list — do not guess.`,
            schema: SUSPECTS_SCHEMA,
          })
          .then((result) => result.output),
    ]);

    const merged = new Map();
    for (const s of sweeps.filter(Boolean)) {
      for (const sus of s.suspects) {
        const key = `${sus.file}::${sus.test}`;
        if (!merged.has(key)) merged.set(key, { ...sus, corroboration: 1 });
        else {
          const prev = merged.get(key);
          merged.set(key, {
            ...prev,
            evidence: `${prev.evidence} | ${sus.evidence}`,
            corroboration: prev.corroboration + 1,
          });
        }
      }
    }
    const testCommand =
      sweeps
        .filter(Boolean)
        .map((s) => s.testCommand)
        .find(Boolean) || "find the repo's single-test command";
    let suspects = [...merged.values()].sort((a, b) => b.corroboration - a.corroboration);

    if (suspects.length === 0)
      return {
        confirmed: [],
        cleared: [],
        skipped: 0,
        notes: 'No flaky-test suspects found by any modality.',
      };
    const skippedCount = Math.max(0, suspects.length - maxSuspects);
    if (skippedCount)
      port.log(
        `Cap: stress-running top ${maxSuspects} of ${suspects.length} suspects (corroboration-ranked)`,
      );
    suspects = suspects.slice(0, maxSuspects);
    port.log(`${suspects.length} suspects to stress-run, ${runs} runs each`);

    // --------------------------------------------------------------------------
    // Phases 2-3 as a pipeline: stress -> diagnose per suspect, independently.
    // A suspect that stress-runs stable short-circuits (returns early from its
    // chain); the diagnostician only ever sees empirical failures — it reasons
    // from evidence, not from the sweep's suspicion.
    // --------------------------------------------------------------------------

    const results = await port.pipeline(
      'pipeline-1',
      suspects,

      (sus) =>
        ctx.claude
          .object(port.id('agent-4', `stress:${sus.test.slice(0, 30)}`), {
            ...args.$claude,
            prompt: `Stress-run this test ${runs} times and report the empirical flake rate.
     Test: ${sus.test}  File: ${sus.file}
     Single-test command shape: ${testCommand}
     Run it ${runs} times sequentially (a shell loop is fine). Count failures.
     Capture one representative failure output if any occur, and note run
     durations if failures correlate with timing. If ALL runs fail it's broken,
     not flaky — verdict "always-fails". If the test can't be run in this
     environment (needs live services), verdict "could-not-run" — do not
     simulate results.`,
            schema: STRESS_SCHEMA,
            // Original phase: 'Stress'; effort: 'low' — no matching ClaudeOptions control.
          })
          .then((result) => result.output)
          .then((r) => ({ suspect: sus, stress: r })),

      (r) => {
        if (!r || !r.stress || r.stress.verdict !== 'flaky') return { ...r, diagnosis: undefined };
        return ctx.claude
          .object(port.id('agent-5', `diagnose:${r.suspect.test.slice(0, 25)}`), {
            ...args.$claude,
            prompt: `Diagnose WHY this test is flaky. It failed ${r.stress.failures}/${r.stress.runs} stress runs.
       Test: ${r.suspect.test}  File: ${r.suspect.file}
       Sweep evidence: ${r.suspect.evidence}
       Failure output: ${r.stress.failureOutput || 'none captured'}
       Timing notes: ${r.stress.timingNotes || 'none'}
       Read the test AND the code under test. Name the mechanism from the schema's
       taxonomy and tell the causal story: what interleaving/state/timing makes it
       fail only sometimes. Propose a real fix targeting the mechanism —
       retry-wrapping is acceptable only for genuinely-external dependencies.
       ${applyFixes ? 'Then APPLY the fix, re-stress 5 runs, and report.' : 'Do not apply the fix.'}`,
            schema: DIAGNOSIS_SCHEMA,
            // Original phase: 'Diagnose'; effort: 'high' — no matching ClaudeOptions control.
          })
          .then((result) => result.output)
          .then((d) => ({ ...r, diagnosis: d }));
      },
    );

    const done = results.filter(Boolean);
    const confirmed = done
      .filter((r) => r.stress && r.stress.verdict === 'flaky')
      .map((r) => ({
        test: r.suspect.test,
        file: r.suspect.file,
        flakeRate: `${r.stress.failures}/${r.stress.runs}`,
        mechanism: r.diagnosis ? r.diagnosis.mechanism : 'undiagnosed',
        explanation: r.diagnosis ? r.diagnosis.explanation : null,
        proposedFix: r.diagnosis ? r.diagnosis.proposedFix : null,
        confidence: r.diagnosis ? r.diagnosis.confidence : null,
      }));
    const cleared = done
      .filter((r) => r.stress && r.stress.verdict === 'stable')
      .map((r) => r.suspect.test);
    const other = done.filter(
      (r) =>
        r.stress && (r.stress.verdict === 'always-fails' || r.stress.verdict === 'could-not-run'),
    );

    port.log(
      `${confirmed.length} empirically flaky, ${cleared.length} cleared, ${other.length} broken/unrunnable`,
    );

    return {
      confirmed,
      cleared,
      skipped: skippedCount,
      notes: other.length
        ? `Also found: ${other.map((r) => `${r.suspect.test} (${r.stress.verdict})`).join('; ')}. ${skippedCount ? `${skippedCount} suspects deferred — re-run with higher maxSuspects.` : ''}`
        : skippedCount
          ? `${skippedCount} suspects deferred — re-run with higher maxSuspects.`
          : 'All suspects processed.',
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
