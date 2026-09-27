// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'release-notes',
  description:
    'Shard a commit range across diff-reading summarizers, draft audience-aware notes, and bidirectionally fact-check claims against commits',
  whenToUse:
    'Cutting a release or backfilling a changelog — when the notes must be both readable and provably true to the range',
  phases: [
    { title: 'Collect', detail: 'resolve the range into a commit manifest' },
    { title: 'Summarize', detail: 'parallel diff-readers over commit slices' },
    { title: 'Draft', detail: 'audience-aware notes from the summaries' },
    { title: 'Fact-check', detail: 'claims<->commits in both directions' },
  ],
};
export const input = z.object({
  ...executionInput,
  since: z.string().optional(),
  until: z.string().optional(),
  audience: z.string().optional(),
  out: z.string().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const MANIFEST_SCHEMA = z
      .object({
        commitCount: z.number(),
        range: z.string().describe('the exact resolved git range'),
        firstShas: z
          .array(z.string())
          .describe('oldest-first list of all shas (short) in the range')
          .optional(),
        versionHint: z
          .string()
          .describe('current version from tags/manifest, if determinable')
          .optional(),
      })
      .catchall(z.json());

    const CHANGES_SCHEMA = z
      .object({
        commitsRead: z.number(),
        changes: z.array(
          z
            .object({
              kind: z.enum([
                'feature',
                'fix',
                'breaking',
                'performance',
                'deprecation',
                'internal',
              ]),
              description: z.string().describe('what changed, from reading the DIFF'),
              shas: z.array(z.string()),
              userVisible: z.boolean(),
              migrationNote: z
                .string()
                .describe('for breaking/deprecation: what a user must do')
                .optional(),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    const FACTCHECK_SCHEMA = z
      .object({
        passed: z.boolean(),
        problems: z.array(
          z
            .object({
              direction: z.enum(['unsupported-claim', 'omitted-change', 'wrong-emphasis']),
              detail: z.string(),
              fix: z.string().optional(),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    if (!args || !args.since) {
      return {
        error:
          'release-notes requires args: { since } — a tag, sha, or ref. Optional: { until, audience, out }',
      };
    }
    const until = (args && args.until) || 'HEAD';
    const audience = (args && args.audience) || 'developers using this project as a dependency';

    // --------------------------------------------------------------------------
    // Phase 1: Collect — resolve the range once, get the sha manifest. Slicing
    // happens in code so shards are provably disjoint and complete.
    // --------------------------------------------------------------------------

    port.phase('Collect');

    const manifest = await ctx.claude
      .object(port.id('agent-1', 'collect'), {
        ...args.$claude,
        prompt: `Resolve the git range ${args.since}..${until} in this repository.
   Report: the exact range, total commit count, ALL short shas oldest-first
   (merge commits excluded if the repo squash-merges; included otherwise —
   match how this repo actually integrates changes), and the current version
   from tags or the package manifest if determinable. Do not summarize commits.`,
        schema: MANIFEST_SCHEMA,
        // Original effort: 'low' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (!manifest || !manifest.firstShas || manifest.firstShas.length === 0) {
      return {
        notes: null,
        factCheck: 'n/a',
        coverage: 'Empty range — nothing to release.',
        breaking: [],
      };
    }
    port.log(`${manifest.firstShas.length} commits in ${manifest.range}`);

    // --------------------------------------------------------------------------
    // Phase 2: Summarize — slice the manifest in code, one diff-reader per slice.
    // The prompt's core rule: judge each commit by its DIFF; the message is a
    // hint, not evidence. Barrier justified: the drafter needs all summaries.
    // --------------------------------------------------------------------------

    port.phase('Summarize');

    const SLICE = 25;
    const slices = [];
    for (let i = 0; i < manifest.firstShas.length; i += SLICE)
      slices.push(manifest.firstShas.slice(i, i + SLICE));

    const summaries = (
      await port.parallel(
        'parallel-1',
        slices.map(
          (shas, i) => () =>
            ctx.claude
              .object(port.id('agent-2', `summarize:${i + 1}/${slices.length}`), {
                ...args.$claude,
                prompt: `Summarize these ${shas.length} commits for release notes. Shas (oldest first):
     ${shas.join(' ')}
     For each commit read the DIFF (git show), not just the message — messages
     lie, drift, and say "fix typo" on 400-line changes. Group related commits
     into single changes (a feature + its 3 fixups = one change carrying all
     shas). Classify each change; mark userVisible honestly — internal refactors
     are not release-notes material for most audiences. For breaking changes and
     deprecations, write the migration note from the diff. Report commitsRead.`,
                schema: CHANGES_SCHEMA,
                // Original effort: 'low' — no matching ClaudeOptions control.
              })
              .then((result) => result.output),
        ),
      )
    ).filter(Boolean);

    const changes = summaries.flatMap((s) => s.changes);
    const commitsRead = summaries.reduce((n, s) => n + s.commitsRead, 0);
    const breaking = changes.filter((c) => c.kind === 'breaking' || c.kind === 'deprecation');
    const coverage = `${commitsRead}/${manifest.firstShas.length} commits read`;
    port.log(
      `${changes.length} changes (${breaking.length} breaking/deprecation); coverage ${coverage}`,
    );

    // --------------------------------------------------------------------------
    // Phase 3: Draft.
    // --------------------------------------------------------------------------

    port.phase('Draft');

    let notes = await ctx.claude
      .text(port.id('agent-3', 'draft'), {
        ...args.$claude,
        prompt: `Draft release notes for the audience: ${audience}.
   Version context: ${manifest.versionHint || 'unknown — omit the version header'}
   Range: ${manifest.range}
   Changes: ${JSON.stringify(changes, null, 2)}
   Rules: breaking changes first with migration notes, then highlights (the 3-5
   changes this audience most cares about, one short paragraph each), then
   categorized lists (Features / Fixes / Performance / Deprecations). Skip
   non-userVisible changes unless the audience is "contributors". Every line
   must trace to the provided changes — add nothing, embellish nothing. Include
   sha references in parentheses. Return only markdown.`,
      })
      .then((result) => result.output);

    // --------------------------------------------------------------------------
    // Phase 4: Fact-check, both directions, against the RANGE — not against the
    // summaries (the summarizers could have erred too). One repair round.
    // --------------------------------------------------------------------------

    port.phase('Fact-check');

    const check = await ctx.claude
      .object(port.id('agent-4', 'fact-check'), {
        ...args.$claude,
        prompt: `Fact-check these release notes against the actual git range ${manifest.range}.
   NOTES:\n---\n${notes}\n---
   Direction 1 — every claim in the notes must be supported by a commit in the
   range: spot-check each claim's cited shas (git show), flag unsupported or
   exaggerated claims ("rewrote" for a rename, "fixed" for a partial fix).
   Direction 2 — every breaking change in the RANGE must appear in the notes:
   scan the range's diffs for removed/renamed public API, changed defaults,
   schema migrations; flag omissions. Also flag wrong-emphasis (a data-loss fix
   buried under a color tweak).`,
        schema: FACTCHECK_SCHEMA,
        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (check && !check.passed && check.problems.length > 0) {
      port.log(`Fact-check found ${check.problems.length} problems — one repair round`);
      notes = await ctx.claude
        .text(port.id('agent-5', 'repair'), {
          ...args.$claude,
          prompt: `Repair these release notes. Problems from fact-check: ${JSON.stringify(check.problems, null, 2)}
     NOTES:\n---\n${notes}\n---
     Apply each problem's fix, verifying against the repo (git show) where the
     fix involves a factual claim. Change nothing else. Return only the markdown.`,

          // Original phase: 'Fact-check' — no matching ClaudeOptions control.
        })
        .then((result) => result.output);
    }

    if (args && args.out) {
      await ctx.claude
        .text(port.id('agent-6', 'write'), {
          ...args.$claude,
          prompt: `Add these release notes to ${args.out}. If the file exists and is a
     changelog, prepend the new entry after any title heading, preserving the
     existing format conventions; otherwise create it. Notes:\n${notes}
     Return the path written.`,

          // Original phase: 'Fact-check'; effort: 'low' — no matching ClaudeOptions control.
        })
        .then((result) => result.output);
    }

    return {
      notes,
      factCheck: check
        ? check.passed
          ? 'passed'
          : `${check.problems.length} problems found and repaired`
        : 'fact-checker unavailable',
      coverage,
      breaking: breaking.map((b) => ({
        description: b.description,
        migrationNote: b.migrationNote,
      })),
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
