// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'docs-drift-audit',
  description:
    'Decompose every doc into checkable claims, verify each against the code, and report or fix the drift',
  whenToUse:
    'Pre-release doc truthfulness check, or after refactors that likely invalidated READMEs and guides',
  phases: [
    { title: 'Inventory', detail: 'find and prioritize doc files' },
    { title: 'Extract', detail: 'decompose docs into checkable claims' },
    { title: 'Check', detail: 'verify claims against the actual code' },
    { title: 'Fix', detail: 'patch drifted docs in place (opt-in)' },
  ],
};
export const input = z.object({
  ...executionInput,
  fix: z.boolean().optional(),
  maxDocs: z.number().int().nonnegative().optional(),
  paths: z.string().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const INVENTORY_SCHEMA = z
      .object({
        docs: z.array(
          z
            .object({
              path: z.string(),
              audience: z
                .string()
                .describe('who reads this: end users, contributors, operators...'),
              priority: z
                .enum(['high', 'medium', 'low'])
                .describe('high = wrong claims here actively hurt people'),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    const CLAIMS_SCHEMA = z
      .object({
        claims: z.array(
          z
            .object({
              claim: z.string().describe('one atomic, checkable assertion the doc makes'),
              kind: z.enum(['command', 'path', 'api', 'config', 'behavior', 'example', 'version']),
              checkHint: z.string().describe('how a checker would verify this against the repo'),
              quote: z.string().describe('the doc text making this claim').optional(),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    const CHECKED_SCHEMA = z
      .object({
        results: z.array(
          z
            .object({
              claim: z.string(),
              status: z.enum(['true', 'drifted', 'unverifiable']),
              reality: z.string().describe('what the code actually does/has, with file evidence'),
              suggestedText: z.string().describe('replacement doc text if drifted').optional(),
            })
            .catchall(z.json()),
        ),
      })
      .catchall(z.json());

    const fix = Boolean(args && args.fix);
    const maxDocs = (args && args.maxDocs) || 10;

    // --------------------------------------------------------------------------
    // Phase 1: Inventory — cheap, structural.
    // --------------------------------------------------------------------------

    port.phase('Inventory');

    const inventory = await ctx.claude
      .object(port.id('agent-1', 'inventory'), {
        ...args.$claude,
        prompt: `Inventory the documentation in ${(args && args.paths) || 'this repository: README files, docs/, *.md anywhere, plus doc-comments-as-docs like a CLI --help template if present'}.
   For each doc file: its audience and a priority (high = wrong claims actively
   hurt readers, e.g. install instructions; low = design notes). Skip generated
   files and changelogs — history doesn't drift.`,
        schema: INVENTORY_SCHEMA,
        // Original effort: 'low' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    if (!inventory || inventory.docs.length === 0) {
      return { docs: [], totals: { docs: 0, claims: 0, drifted: 0, fixed: 0 }, skipped: [] };
    }

    const PRI = { high: 0, medium: 1, low: 2 };
    const ordered = [...inventory.docs].sort((a, b) => PRI[a.priority] - PRI[b.priority]);
    const chosen = ordered.slice(0, maxDocs);
    const skipped = ordered.slice(maxDocs).map((d) => d.path);
    if (skipped.length)
      port.log(
        `Cap: auditing ${chosen.length} docs, skipping ${skipped.length} lower-priority (${skipped.join(', ')})`,
      );

    // --------------------------------------------------------------------------
    // Phases 2-4 as ONE pipeline: extract -> check -> fix per doc, no barriers.
    // Nothing downstream needs cross-doc context, so this is the pure pipeline
    // case — the README can be getting fixed while docs/deploy.md is still in
    // extraction. Wall-clock = slowest single doc, not sum of slowest stages.
    // --------------------------------------------------------------------------

    const results = await port.pipeline(
      'pipeline-1',
      chosen,

      // Stage 1: Extract claims. effort:low — decomposition is mechanical reading.
      (doc) =>
        ctx.claude
          .object(port.id('agent-2', `extract:${doc.path.split('/').pop()}`), {
            ...args.$claude,
            prompt: `Read ${doc.path} (audience: ${doc.audience}) and decompose it into atomic,
     CHECKABLE claims about this repository. A claim is checkable if a person
     with the repo could verify it true/false: commands and flags that should
     exist, file paths, API names and signatures, config keys and defaults,
     described behaviors, code examples that should run, version statements.
     Skip pure opinion and marketing ("blazing fast"). Include the doc text
     (quote) for each claim and a checkHint for the verifier.`,
            schema: CLAIMS_SCHEMA,
            // Original phase: 'Extract'; effort: 'low' — no matching ClaudeOptions control.
          })
          .then((result) => result.output),

      // Stage 2: Check ALL of this doc's claims in one agent. One-agent-per-claim
      // would explode cost for no accuracy gain — claims from the same doc are
      // verified against the same neighborhoods of code.
      (extracted, doc) => {
        if (!extracted || extracted.claims.length === 0) return { doc: doc.path, results: [] };
        return ctx.claude
          .object(port.id('agent-3', `check:${doc.path.split('/').pop()}`), {
            ...args.$claude,
            prompt: `Verify these documentation claims against the ACTUAL code of this repo.
       Doc: ${doc.path}
       Claims: ${JSON.stringify(extracted.claims, null, 2)}
       For each: status "true" (code agrees), "drifted" (code disagrees — say what
       the reality is, with file evidence, and draft replacement doc text), or
       "unverifiable" (requires running external systems). Actually check —
       run --help for command claims, read the config parser for config claims,
       compile/run examples where cheap.`,
            schema: CHECKED_SCHEMA,
            // Original phase: 'Check' — no matching ClaudeOptions control.
          })
          .then((result) => result.output)
          .then((checked) => ({ doc: doc.path, results: checked ? checked.results : [] }));
      },

      // Stage 3: Fix (opt-in). Only runs for docs with drift; patches in place
      // using the checker's suggested text plus the checker's evidence.
      (checked, doc) => {
        const drifted = (checked.results || []).filter((r) => r.status === 'drifted');
        if (!fix || drifted.length === 0) return { ...checked, fixed: 0 };
        return ctx.claude
          .text(port.id('agent-4', `fix:${doc.path.split('/').pop()}`), {
            ...args.$claude,
            prompt: `Update ${doc.path} to match reality. Drifted claims with verified reality
       and suggested replacement text: ${JSON.stringify(drifted, null, 2)}
       Edit the file in place. Keep the doc's voice and structure; change only
       what's wrong. Do not add new sections. Return a one-line summary per edit.`,

            // Original phase: 'Fix'; effort: 'low' — no matching ClaudeOptions control.
          })
          .then((result) => result.output)
          .then(() => ({ ...checked, fixed: drifted.length }));
      },
    );

    const docs = results.filter(Boolean).map((r) => ({
      doc: r.doc,
      claims: (r.results || []).length,
      drifted: (r.results || [])
        .filter((x) => x.status === 'drifted')
        .map((x) => ({ claim: x.claim, reality: x.reality })),
      fixed: r.fixed || 0,
    }));

    const totals = {
      docs: docs.length,
      claims: docs.reduce((n, d) => n + d.claims, 0),
      drifted: docs.reduce((n, d) => n + d.drifted.length, 0),
      fixed: docs.reduce((n, d) => n + d.fixed, 0),
    };
    port.log(
      `${totals.claims} claims checked across ${totals.docs} docs: ${totals.drifted} drifted${fix ? `, ${totals.fixed} fixed` : ' (report-only mode)'}`,
    );

    return { docs, totals, skipped };
  }
}
export default defineWorkflow({
  name: meta.name,
  version: 'ultracode-direct-01',
  input,
  output: z.json() as unknown as z.ZodType<Awaited<ReturnType<typeof run>>>,
  run,
});
