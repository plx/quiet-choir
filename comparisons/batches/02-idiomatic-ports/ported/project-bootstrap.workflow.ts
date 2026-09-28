// Idiomatic rewrite of the pinned MIT upstream; see ../LICENSE and ../notes.json.
import { defineWorkflow, z } from 'quiet-choir';
import {
  Argv,
  Digest,
  Path,
  Sha,
  assertClean,
  canonical,
  digest,
  git,
  json,
  profiles,
} from './support.js';

export const Concern = z.enum(['foundation', 'tooling', 'tests', 'ci', 'docs']);
const Plan = z.object({
  concerns: z
    .array(
      z.object({ name: Concern, detail: z.string().min(1), files: z.array(Path).min(1).max(30) }),
    )
    .min(1)
    .max(5),
  verifyCommands: z.array(Argv).min(1).max(8),
});
export default defineWorkflow({
  name: 'project-bootstrap',
  version: 'idiomatic-02',
  description:
    'Approve one saved plan, isolate each setter, and verify its integration with real exit codes.',
  profiles,
  input: z.object({
    spec: z
      .string()
      .min(1)
      .describe('Project specification or a repository-relative specification path'),
    concerns: z
      .array(Concern)
      .min(1)
      .max(5)
      .default(['foundation', 'tooling', 'tests', 'ci', 'docs']),
  }),
  output: z.object({
    status: z.enum(['declined', 'verification-failed', 'applied']),
    plan: Plan,
    approvedDigest: Digest,
    appliedDigest: Digest.nullable(),
    commit: Sha.nullable(),
    verification: z.array(
      z.object({ argv: Argv, code: z.number().int().nullable(), truncated: z.boolean() }),
    ),
  }),
  async run(ctx, input) {
    await assertClean(ctx, 'clean');
    const base = Sha.parse((await git(ctx, 'base', ['rev-parse', 'HEAD'])).trim());
    const inventory = await git(ctx, 'inventory', ['ls-tree', '-r', '--name-only', base]);
    const detected = await ctx.claude.value('detect', {
      profile: 'reader',
      schema: z.object({ existing: z.array(z.string()), missing: z.array(Concern) }),
      prompt: `Inspect existing project setup against the specification.\n${json({ spec: input.spec, inventory })}`,
    });
    const plan = await ctx.claude.value('plan', {
      profile: 'reader',
      schema: Plan.extend({
        concerns: z
          .array(Plan.shape.concerns.element.extend({ name: z.enum(input.concerns) }))
          .min(1)
          .max(input.concerns.length),
      }),
      prompt: `Plan independent setup concerns with disjoint explicit file ownership. Include verification commands as argv arrays. Commands will run with operator privileges after human approval; no shell interpolation.\n${json({ spec: input.spec, allowed: input.concerns, detected })}`,
    });
    const names = plan.concerns.map((concern) => concern.name);
    const paths = plan.concerns.flatMap((concern) => concern.files);
    if (new Set(names).size !== names.length || new Set(paths).size !== paths.length)
      throw new Error('Plan requires unique concerns and disjoint file ownership');
    const approvedDigest = digest(canonical(plan));
    const approval = await ctx.approve('approve-plan', {
      title: 'Bootstrap',
      prompt: 'Apply this exact plan and run its verification commands?',
      subject: { plan, digest: approvedDigest, base },
      details: Buffer.from(json(plan)).subarray(0, 15_000).toString('utf8'),
    });
    if (!approval.approved)
      return {
        status: 'declined',
        plan,
        approvedDigest,
        appliedDigest: null,
        commit: null,
        verification: [],
      };
    const changes = await ctx.map(
      'setters',
      plan.concerns,
      { concurrency: 3, key: (concern) => concern.name },
      async (concern) => {
        const result = await ctx.claude.object('apply', {
          profile: 'writer',
          worktree: { kind: 'worktree', base: { commit: base } },
          schema: z.object({ summary: z.string() }),
          prompt: `Apply only concern ${concern.name}. You own exactly ${json(concern.files)}. Do not run commands or edit other files.\nApproved plan digest: ${approvedDigest}\nApproved plan:\n${json(plan)}`,
        });
        if (!result.worktree) throw new Error('Setter did not produce an isolated receipt');
        const unexpected = result.worktree.files.filter(
          (file) => !concern.files.includes(file.path) || file.status === 'renamed',
        );
        if (unexpected.length)
          throw new Error(`Setter exceeded approved file ownership: ${json(unexpected)}`);
        return result.worktree;
      },
    );
    const merged = await ctx.merge('integrate', changes, { onConflict: 'fail' });
    const tree = await ctx.worktree('verification-tree', { base: { commit: merged.commit } });
    const verification = [];
    for (const [index, argv] of plan.verifyCommands.entries()) {
      const result = await ctx.exec(ctx.id('verify', index), argv, {
        worktree: tree,
        okExitCodes: 'any',
      });
      verification.push({ argv, code: result.code, truncated: result.truncated });
    }
    if (verification.some((check) => check.code !== 0 || check.truncated))
      return {
        status: 'verification-failed',
        plan,
        approvedDigest,
        appliedDigest: digest(canonical(plan)),
        commit: merged.commit,
        verification,
      };
    // Verification commands may create tracked artifacts; publish their managed snapshot too.
    const published = await ctx.merge('publish', [...changes, tree], {
      target: 'checkout',
      onConflict: 'fail',
    });
    return {
      status: 'applied',
      plan,
      approvedDigest,
      appliedDigest: digest(canonical(plan)),
      commit: published.commit,
      verification,
    };
  },
});
