// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'bug-hunt',
  description:
    'Loop diverse bug-finder rounds until two consecutive rounds find nothing new; majority-vote verify every candidate',
  whenToUse:
    'Exhaustive bug discovery on a codebase or subsystem — when you want the tail of the distribution, not just the obvious top findings',
  phases: [
    { title: 'Hunt', detail: 'rotating-lens finder rounds' },
    { title: 'Verify', detail: 'majority-vote skeptic panel per candidate' },
  ],
};
export const input = z.object({
  ...executionInput,
  scope: z.string().optional(),
  maxRounds: z.number().int().nonnegative().optional(),
  votes: z.number().int().nonnegative().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const BUGS_SCHEMA = z
      .object({
        bugs: z.array(
          z
            .object({
              title: z.string(),
              file: z.string(),
              line: z.number().optional(),
              severity: z.enum(['critical', 'high', 'medium', 'low']),
              evidence: z.string(),
              failureScenario: z
                .string()
                .describe('concrete inputs/state -> wrong output or crash'),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    const VERDICT_SCHEMA = z
      .object({ refuted: z.boolean(), reasoning: z.string() })
      .catchall(z.json());

    // A pool of lenses much larger than any single round uses. Each round takes a
    // rotating slice, so round 2 hunts differently than round 1 even over the same
    // files. Diversity is what makes later rounds productive — three identical
    // finders converge on the same obvious bugs.
    const LENS_POOL = [
      'error handling: swallowed exceptions, catch blocks that hide failures, missing error propagation, errors logged but not handled',
      'boundary conditions: off-by-one, empty collections, zero/negative numbers, unicode and encoding edges, max-size inputs',
      'concurrency: race conditions, shared mutable state, missing locks or atomicity, async ordering assumptions, TOCTOU',
      'resource lifecycle: leaks of handles/connections/subscriptions, missing cleanup on error paths, double-free/double-close',
      'state machines: invalid state transitions, initialization order, stale caches, partial updates that leave inconsistent state',
      'contract violations: callers that break callee assumptions, nullability mismatches, silently-widened types, ignored return values',
      'time and ordering: timezone bugs, DST edges, clock skew assumptions, sort stability, iteration-order dependence',
      'input validation: unvalidated external input reaching logic, type confusion at parse boundaries, injection into shells/queries/paths',
    ];

    const scope = (args && args.scope) || 'the entire repository';
    const maxRounds = (args && args.maxRounds) || 4;
    const votes = (args && args.votes) || 3;
    const majority = Math.floor(votes / 2) + 1;
    const LENSES_PER_ROUND = 3;

    const seen = new Set(); // every candidate ever surfaced (confirmed OR refuted)
    const confirmed = [];
    let refutedCount = 0;
    let dryRounds = 0;
    let round = 0;

    // Key on file + normalized title so re-worded duplicates of the same bug from a
    // later round still collide.
    const keyOf = (b) =>
      `${b.file}::${b.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()}`;

    while (dryRounds < 2 && round < maxRounds) {
      // Budget guard must check budget.total — with no target set, remaining() is
      // Infinity and this loop would run to maxRounds regardless of spend.
      // GAP: no shared token ledger. The original low-budget exit is unavailable.

      // Deterministic lens rotation: round 0 takes lenses 0-2, round 1 takes 3-5...
      const lenses = Array.from(
        { length: LENSES_PER_ROUND },
        (_, i) => LENS_POOL[(round * LENSES_PER_ROUND + i) % LENS_POOL.length],
      );

      // Barrier is deliberate here: the dry-round decision needs the WHOLE round's
      // yield, and dedup-vs-seen must happen before any verifier spends tokens.
      const found = (
        await port.parallel(
          'parallel-1',
          lenses.map(
            (lens, i) => () =>
              ctx.claude
                .object(port.id('agent-1', `find:r${round + 1}:${i}`), {
                  ...args.$claude,
                  prompt: `Hunt for real bugs in ${scope}. Your lens this round: ${lens}.
       Round ${round + 1} of a multi-round hunt — prefer places a first-pass
       reviewer would skim past. Report only defects that produce wrong behavior
       at runtime, each with concrete evidence and a failure scenario. An empty
       list is a valid result.`,
                  schema: BUGS_SCHEMA,
                  // Original phase: 'Hunt' — no matching ClaudeOptions control.
                })
                .then((result) => result.output),
          ),
        )
      )
        .filter(Boolean)
        .flatMap((r) => r.bugs);

      // Dedup against `seen`, never against `confirmed` — a refuted finding that
      // reappears must not get a second trial every round, or the hunt never dries.
      const fresh = found.filter((b) => !seen.has(keyOf(b)));
      fresh.forEach((b) => seen.add(keyOf(b)));

      if (fresh.length === 0) {
        dryRounds++;
        port.log(`Round ${round + 1}: nothing new (${dryRounds}/2 dry rounds)`);
        round++;
        continue;
      }
      dryRounds = 0;
      port.log(`Round ${round + 1}: ${found.length} reported, ${fresh.length} fresh candidates`);

      // Verify each fresh candidate with an independent skeptic panel. Panels for
      // different candidates all run concurrently.
      const judged = await port.parallel(
        'parallel-2',
        fresh.map(
          (b) => () =>
            port
              .parallel(
                'parallel-3',
                Array.from(
                  { length: votes },
                  (_, v) => () =>
                    ctx.claude
                      .object(port.id('agent-2', `verify:${b.file.split('/').pop()}:${v}`), {
                        ...args.$claude,
                        prompt: `Skeptic ${v + 1}/${votes}: try to REFUTE this bug claim by reading the code.
         Claim: ${b.title} (${b.severity}) at ${b.file}${b.line ? ':' + b.line : ''}
         Evidence: ${b.evidence}
         Failure scenario: ${b.failureScenario}
         Look for guards, unreachable paths, caller invariants, or covering tests
         that invalidate it. Default to refuted=true if you cannot confirm the
         failure scenario is reachable.`,
                        schema: VERDICT_SCHEMA,
                        // Original phase: 'Verify'; effort: 'high' — no matching ClaudeOptions control.
                      })
                      .then((result) => result.output),
                ),
              )
              .then((verdicts) => ({ bug: b, verdicts: verdicts.filter(Boolean) })),
        ),
      );

      for (const j of judged.filter(Boolean)) {
        const upheld = j.verdicts.filter((v) => !v.refuted).length;
        if (upheld >= majority)
          confirmed.push({ ...j.bug, votes: `${upheld}/${j.verdicts.length} upheld` });
        else refutedCount++;
      }
      port.log(`Round ${round + 1} verified: ${confirmed.length} total confirmed so far`);
      round++;
    }

    const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
    return {
      confirmed: confirmed.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]),
      refuted: refutedCount,
      rounds: round,
      dry: dryRounds >= 2, // false = stopped on maxRounds/budget; the well may not be empty
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
