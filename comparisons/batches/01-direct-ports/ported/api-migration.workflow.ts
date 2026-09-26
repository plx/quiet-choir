// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'api-migration',
  description:
    'Discover every call site of an old API, migrate file groups in parallel, then build/test once and repair fallout',
  whenToUse:
    'Library swaps, API renames, and contract changes with many call sites needing contextual judgment — the long tail codemods cannot handle',
  phases: [
    { title: 'Discover', detail: 'find and group every call site' },
    { title: 'Transform', detail: 'one migrator per file group, in waves' },
    { title: 'Verify', detail: 'single build/test pass + repair round' },
  ],
};
export const input = z.object({
  ...executionInput,
  from: z.string().optional(),
  to: z.string().optional(),
  notes: z.string().optional(),
  paths: z.string().optional(),
  batchSize: z.number().int().nonnegative().optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const SITES_SCHEMA = z
      .object({
        totalSites: z.number(),
        groups: z.array(
          z
            .object({
              files: z
                .array(z.string())
                .describe('files migrated together (usually 1; more if tightly coupled)'),
              siteCount: z.number(),
              notes: z.string().describe('anything unusual about these sites').optional(),
            })
            .catchall(z.json()),
        ),
        buildCommand: z
          .string()
          .describe('command that compiles/typechecks the repo, if any')
          .optional(),
        testCommand: z.string().describe('command that runs the test suite, if any').optional(),
      })
      .catchall(z.json());

    const TRANSFORM_SCHEMA = z
      .object({
        status: z.enum(['migrated', 'partial', 'blocked']),
        summary: z.string(),
        blockers: z.array(z.string()).describe('sites left unmigrated and why').optional(),
      })
      .catchall(z.json());

    const VERIFY_SCHEMA = z
      .object({
        passed: z.boolean(),
        summary: z.string(),
        failures: z
          .array(
            z
              .object({ description: z.string(), files: z.array(z.string()).optional() })
              .catchall(z.json()),
          )
          .describe('distinct failure clusters, not one entry per failing test')
          .optional(),
      })
      .catchall(z.json());

    if (!args || !args.from || !args.to) {
      return {
        error:
          'api-migration requires args: { from, to }. Example: { from: "moment(x).format(...)", to: "date-fns format(x, ...)" }',
      };
    }

    // --------------------------------------------------------------------------
    // Phase 1: Discover. One agent finds every call site and — critically —
    // groups them into disjoint file sets. Disjointness is what lets Phase 2 run
    // concurrent editors in the SAME working tree safely.
    // --------------------------------------------------------------------------

    port.phase('Discover');

    const discovery = await ctx.claude
      .object(port.id('agent-1', 'discover'), {
        ...args.$claude,
        prompt: `Find every call site that must change for this migration:
   FROM: ${args.from}
   TO:   ${args.to}
   ${args.notes ? `Migration notes: ${args.notes}` : ''}
   Search ${args.paths || 'the whole repository'} (grep for identifiers, imports,
   type references — include indirect uses like re-exports and mocks in tests).
   Group sites into DISJOINT file groups: normally one file per group, but if two
   files must change atomically (e.g. a module and its inseparable test), put
   them in one group. No file may appear in two groups. Also report the repo's
   build/typecheck command and test command if they exist.`,
        schema: SITES_SCHEMA,
      })
      .then((result) => result.output);

    if (!discovery || discovery.groups.length === 0) {
      return {
        migrated: [],
        failed: [],
        verification: 'nothing to do',
        notes: 'Discovery found no call sites.',
      };
    }
    port.log(`${discovery.totalSites} call sites across ${discovery.groups.length} file groups`);

    // --------------------------------------------------------------------------
    // Phase 2: Transform in waves.
    //
    // Why NO worktree isolation: worktrees exist for agents that would conflict
    // editing the same files. These groups are disjoint by construction, so
    // concurrent editors in one tree cannot collide — and worktrees would each pay
    // setup cost plus a merge problem at the end. Decision rule: shared files ->
    // worktrees; disjoint files -> same tree.
    //
    // Waves (batchSize at a time) keep failures visible early: if wave 1 comes
    // back all-blocked, the migration notes are probably wrong — better to see
    // that after 8 files than after 80.
    // --------------------------------------------------------------------------

    port.phase('Transform');

    const batchSize = (args && args.batchSize) || 8;
    const migrated = [];
    const failed = [];

    for (let w = 0; w * batchSize < discovery.groups.length; w++) {
      const wave = discovery.groups.slice(w * batchSize, (w + 1) * batchSize);
      port.log(`Wave ${w + 1}: migrating ${wave.length} file groups`);

      const results = await port.parallel(
        'parallel-1',
        wave.map(
          (group) => () =>
            ctx.claude
              .object(port.id('agent-2', `migrate:${group.files[0].split('/').pop()}`), {
                ...args.$claude,
                prompt: `Migrate these files from the old API to the new one. Edit files in place.
       FROM: ${args.from}
       TO:   ${args.to}
       ${args.notes ? `Migration notes: ${args.notes}` : ''}
       Files (yours alone — no other agent touches them): ${group.files.join(', ')}
       Expected sites: ~${group.siteCount}. ${group.notes || ''}

       Read each file fully before editing; match the surrounding style. Migrate
       every site. Update imports. Do NOT run the repo's build or tests — a
       dedicated verifier does that globally afterwards. If a site cannot be
       migrated mechanically, leave it working on the old API, mark status
       "partial", and list it in blockers with the reason.`,
                schema: TRANSFORM_SCHEMA,
                // Original phase: 'Transform' — no matching ClaudeOptions control.
              })
              .then((result) => result.output)
              .then((r) => ({ group, result: r })),
        ),
      );

      for (const r of results.filter(Boolean)) {
        if (r.result && r.result.status !== 'blocked')
          migrated.push({ files: r.group.files, ...r.result });
        else
          failed.push({
            files: r.group.files,
            ...(r.result || { status: 'error', summary: 'agent failed' }),
          });
      }

      // Early abort if the wave face-planted — don't burn the remaining waves on
      // instructions that demonstrably don't work.
      if (results.filter(Boolean).every((r) => r.result && r.result.status === 'blocked')) {
        port.log(
          'Entire wave blocked — aborting remaining waves; migration notes likely need revision',
        );
        break;
      }
    }

    // --------------------------------------------------------------------------
    // Phase 3: Verify once, globally. Build + tests are shared state: one runner.
    // Failure clusters get one repair round (max 3 repairers), then re-verify.
    // --------------------------------------------------------------------------

    port.phase('Verify');

    const verifyPrompt = (attempt) =>
      `Verify the ${args.from} -> ${args.to} migration (attempt ${attempt}).
   ${discovery.buildCommand ? `Build/typecheck: ${discovery.buildCommand}` : 'Find and run the build/typecheck command if one exists.'}
   ${discovery.testCommand ? `Tests: ${discovery.testCommand}` : 'Find and run the test suite if one exists.'}
   Also grep for leftover references to the OLD API outside the known blockers.
   Report pass/fail with distinct failure clusters (group by root cause).`;

    let verification = await ctx.claude
      .object(port.id('agent-3', 'verify'), {
        ...args.$claude,
        prompt: verifyPrompt(1),
        schema: VERIFY_SCHEMA,
      })
      .then((result) => result.output);

    if (
      verification &&
      !verification.passed &&
      verification.failures &&
      verification.failures.length > 0
    ) {
      const clusters = verification.failures.slice(0, 3);
      if (verification.failures.length > 3)
        port.log(`Repairing top 3 of ${verification.failures.length} failure clusters`);
      await port.parallel(
        'parallel-2',
        clusters.map(
          (f, i) => () =>
            ctx.claude
              .text(port.id('agent-4', `repair:${i}`), {
                ...args.$claude,
                prompt: `Fix this failure cluster from the ${args.from} -> ${args.to} migration:
       ${f.description}
       Files involved: ${(f.files || []).join(', ') || 'identify from the failure'}
       Edit in place; run only the narrow check for this cluster, not the full suite.`,

                // Original phase: 'Verify' — no matching ClaudeOptions control.
              })
              .then((result) => result.output),
        ),
      );
      verification = await ctx.claude
        .object(port.id('agent-5', 're-verify'), {
          ...args.$claude,
          prompt: verifyPrompt(2),
          schema: VERIFY_SCHEMA,
          // Original phase: 'Verify' — no matching ClaudeOptions control.
        })
        .then((result) => result.output);
    }

    return {
      migrated,
      failed,
      verification: verification ? verification.summary : 'verifier unavailable',
      notes:
        failed.length > 0
          ? 'Some groups were blocked — see failed[].blockers; they still work on the old API.'
          : 'All discovered groups migrated.',
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
