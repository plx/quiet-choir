import { defineWorkflow, z } from '../../src/index.js';
import { github } from '../../src/integrations/github.js';

const verdict = z.enum(['success', 'failure', 'no-checks', 'head-moved', 'closed', 'timeout']);
const commit = "(git diff --quiet || git commit -qam 'Fix CI') && git push && git rev-parse HEAD";
export default defineWorkflow({
  name: 'ci-gate',
  version: '1',
  input: z.object({ repo: z.string(), pr: z.int().positive(), rounds: z.int().min(0).max(5) }),
  output: z.object({ status: verdict.or(z.literal('stuck')), sha: z.string(), fixes: z.int() }),
  async run(ctx, { repo, pr, rounds }) {
    const gh = github(ctx, { repo });
    let sha = (await gh.pr.view('head', { number: pr })).headRefOid;
    for (let fixes = 0; ; fixes++) {
      // Keyed by head SHA: a resume replays this verdict, and a pushed fix waits under a new ID.
      const bound = { pr, sha, timeoutMs: 3_600_000, staleGraceMs: 120_000 };
      const ci = await gh.waitChecks(ctx.id('ci', sha), bound);
      if (ci.status !== 'failure' || fixes === rounds) return { status: ci.status, sha, fixes };
      const failed = ci.failed.map((check) => check.name).join(', ');
      const prompt = `CI failed on ${sha}: ${failed}. Fix the cause. Do not commit.`;
      await ctx.claude.text(ctx.id('fix', sha), { profile: 'edit', prompt });
      // The new head comes from git, never from the model.
      const pushed = await ctx.exec(ctx.id('push', sha), { shell: commit });
      const next = pushed.stdout.trim();
      // An unchanged head would reuse this wait's ID; return instead of waiting again.
      if (next === sha) return { status: 'stuck', sha, fixes: fixes + 1 };
      sha = next;
    }
  },
});
