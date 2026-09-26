// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'deep-code-review',
  description:
    'Review a change set across five dimensions, adversarially verify every finding, and synthesize a ranked report',
  whenToUse:
    'Pre-merge review of a branch, PR, or uncommitted change set when you want findings you can trust without re-reviewing them yourself',
  phases: [
    { title: 'Scope', detail: 'resolve the diff and summarize what changed' },
    { title: 'Review', detail: 'one dedicated reviewer per dimension' },
    { title: 'Verify', detail: 'adversarial skeptic per deduped finding' },
    { title: 'Synthesize', detail: 'rank confirmed findings into a report' },
  ],
};
export const input = z.object({
  ...executionInput,
  target: z.string().optional(),
  dimensions: z.array(z.string()).optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    // ---------------------------------------------------------------------------
    // Schemas — every agent boundary returns validated structure, never free text
    // that downstream stages would have to re-parse.
    // ---------------------------------------------------------------------------

    const SCOPE_SCHEMA = z
      .object({
        diffCommand: z.string().describe('exact git command that reproduces the reviewed diff'),
        files: z.array(z.string()),
        summary: z.string().describe('2-4 sentences on what the change does'),
        riskNotes: z
          .string()
          .describe('anything unusually risky a reviewer should weight')
          .optional(),
      })
      .catchall(z.json());

    const FINDINGS_SCHEMA = z
      .object({
        findings: z.array(
          z
            .object({
              title: z.string(),
              file: z.string(),
              line: z.number().optional(),
              severity: z.enum(['critical', 'high', 'medium', 'low']),
              evidence: z.string().describe('the exact code and reasoning that supports the claim'),
              failureScenario: z.string().describe('concrete inputs/state -> wrong outcome'),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    const VERDICT_SCHEMA = z
      .object({
        refuted: z.boolean(),
        reasoning: z.string(),
        adjustedSeverity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      })
      .catchall(z.json());

    // ---------------------------------------------------------------------------
    // Dimensions — each reviewer sees the same diff through a different lens.
    // Prompts state what to IGNORE as much as what to find: a security reviewer
    // that also reports style nits duplicates the other reviewers' work.
    // ---------------------------------------------------------------------------

    const ALL_DIMENSIONS = [
      {
        key: 'correctness',
        charter:
          'Logic errors, off-by-ones, broken edge cases, race conditions, wrong assumptions about inputs or state. Ignore style, naming, and anything that cannot produce a wrong result at runtime.',
      },
      {
        key: 'security',
        charter:
          'Injection, authn/authz gaps, secrets in code, unsafe deserialization, path traversal, SSRF, missing input validation at trust boundaries. Ignore theoretical issues with no reachable attack path in this codebase.',
      },
      {
        key: 'performance',
        charter:
          'N+1 queries, accidental O(n^2), unbounded memory growth, sync work on hot paths, missing pagination or caching where the data size clearly demands it. Ignore micro-optimizations with no measurable impact.',
      },
      {
        key: 'tests',
        charter:
          'Changed behavior with no covering test, tests that assert the wrong thing, tests deleted or weakened by this change, missing failure-path coverage. Ignore coverage gaps in code this diff does not touch.',
      },
      {
        key: 'api-design',
        charter:
          'Breaking changes to public interfaces, confusing or inconsistent naming versus the surrounding codebase, leaky abstractions, error contracts that silently changed. Ignore internals with no external consumers.',
      },
    ];

    // ---------------------------------------------------------------------------
    // Phase 1: Scope — one cheap agent resolves "what are we reviewing" once, so
    // five reviewers don't each burn tokens rediscovering the diff.
    // ---------------------------------------------------------------------------

    port.phase('Scope');

    const target =
      (args && args.target) ||
      'the uncommitted working-tree changes (staged and unstaged); if the working tree is clean, review the most recent commit instead';

    const scope = await ctx.claude
      .object(port.id('agent-1', 'scope'), {
        ...args.$claude,
        prompt: `You are scoping a code review. Target: ${target}.
   Resolve this to a concrete git diff, read it, and report: the exact diff command,
   the list of changed files, a 2-4 sentence summary of what the change does, and
   any notes on unusually risky areas. Do not review the code itself.`,
        schema: SCOPE_SCHEMA,
        // Original effort: 'low' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (!scope || scope.files.length === 0) {
      return {
        target,
        confirmed: [],
        rejected: [],
        report: 'Nothing to review: no diff found for the given target.',
      };
    }
    port.log(`Reviewing ${scope.files.length} files: ${scope.summary}`);

    // ---------------------------------------------------------------------------
    // Phase 2: Review — dimension fan-out. This is a deliberate BARRIER, not a
    // pipeline: correctness and security reviewers frequently surface the same
    // underlying defect, and verifying a duplicate costs a whole agent. Deduping
    // requires every dimension's findings at once, so we wait for all of them.
    // ---------------------------------------------------------------------------

    port.phase('Review');

    const wanted =
      args && args.dimensions
        ? ALL_DIMENSIONS.filter((d) => args.dimensions.includes(d.key))
        : ALL_DIMENSIONS;

    const reviews = await port.parallel(
      'parallel-1',
      wanted.map(
        (dim) => () =>
          ctx.claude
            .object(port.id('agent-2', `review:${dim.key}`), {
              ...args.$claude,
              prompt: `You are the ${dim.key} reviewer for a code change.
     Reproduce the diff with: ${scope.diffCommand}
     Change summary: ${scope.summary}
     Risk notes: ${scope.riskNotes || 'none'}

     Your charter: ${dim.charter}

     Read the diff and enough surrounding code to judge it in context. Report only
     findings inside your charter, each with concrete evidence and a failure
     scenario. An empty findings list is a perfectly good answer — do not invent
     findings to seem thorough.`,
              schema: FINDINGS_SCHEMA,
            })
            .then((result) => result.output),
      ),
    );

    // Dedupe by (file, line-bucket) in plain code — no agent needed for a merge
    // this mechanical. Same file within ~5 lines = same underlying issue; keep the
    // higher-severity copy.
    const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
    const byKey = new Map();
    for (const review of reviews.filter(Boolean)) {
      for (const f of review.findings) {
        const key = `${f.file}:${Math.floor((f.line || 0) / 5)}`;
        const existing = byKey.get(key);
        if (!existing || SEV_RANK[f.severity] < SEV_RANK[existing.severity]) byKey.set(key, f);
      }
    }
    const deduped = [...byKey.values()];
    port.log(
      `${reviews.filter(Boolean).flatMap((r) => r.findings).length} raw findings -> ${deduped.length} after dedupe`,
    );

    if (deduped.length === 0) {
      return {
        target,
        confirmed: [],
        rejected: [],
        report: `Reviewed ${scope.files.length} files across ${wanted.length} dimensions. No findings.`,
      };
    }

    // ---------------------------------------------------------------------------
    // Phase 3: Verify — one adversarial skeptic per finding, all concurrent.
    // The skeptic's job is to REFUTE, with a default-to-refuted bias: a finding
    // survives only if it withstands someone actively trying to kill it. This is
    // what keeps plausible-but-wrong findings out of the report.
    // ---------------------------------------------------------------------------

    port.phase('Verify');

    const verified = await port.parallel(
      'parallel-2',
      deduped.map(
        (f) => () =>
          ctx.claude
            .object(port.id('agent-3', `verify:${f.file.split('/').pop()}`), {
              ...args.$claude,
              prompt: `A code reviewer claims this defect exists. Your job is to REFUTE it.

     Claim: ${f.title} (${f.severity})
     Location: ${f.file}${f.line ? ':' + f.line : ''}
     Evidence: ${f.evidence}
     Failure scenario: ${f.failureScenario}
     Diff under review: ${scope.diffCommand}

     Read the actual code. Check whether the failure scenario can really occur:
     look for guards the reviewer missed, callers that make the input impossible,
     tests that already cover it. If you cannot demonstrate the claim holds
     against your best refutation attempt, mark it refuted — when uncertain,
     refute. If it survives, you may adjust the severity in either direction.`,
              schema: VERDICT_SCHEMA,
              // Original effort: 'high' — no matching ClaudeOptions control.
            })
            .then((result) => result.output)
            .then((v) => ({ ...f, verdict: v })),
      ),
    );

    const survivors = verified
      .filter(Boolean)
      .filter((f) => f.verdict && !f.verdict.refuted)
      .map((f) => ({ ...f, severity: f.verdict.adjustedSeverity || f.severity }));
    const rejected = verified.filter(Boolean).filter((f) => f.verdict && f.verdict.refuted);
    port.log(`${survivors.length} findings confirmed, ${rejected.length} refuted`);

    // ---------------------------------------------------------------------------
    // Phase 4: Synthesize — one agent turns confirmed findings into a report a
    // human can act on. It sees only survivors, so it cannot resurrect refuted
    // claims.
    // ---------------------------------------------------------------------------

    port.phase('Synthesize');

    const report =
      survivors.length === 0
        ? `Reviewed ${scope.files.length} files across ${wanted.length} dimensions. ${deduped.length} candidate findings were all refuted under adversarial verification.`
        : await ctx.claude
            .text(port.id('agent-4', 'report'), {
              ...args.$claude,
              prompt: `Write a code-review report in markdown for this change: ${scope.summary}
       Confirmed findings (already adversarially verified — do not re-litigate):
       ${JSON.stringify(survivors, null, 2)}
       Order by severity. For each: what is wrong, why it matters, and a concrete
       suggested fix. End with a one-paragraph overall assessment. Return only the
       markdown.`,

              // Original effort: 'low' — no matching ClaudeOptions control.
            })
            .then((result) => result.output);

    return {
      target,
      confirmed: survivors.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]),
      rejected: rejected.map((f) => ({ title: f.title, file: f.file, why: f.verdict.reasoning })),
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
