import { defineWorkflow, z } from '../../src/index.js';
import { github } from '../../src/integrations/github.js';

const text = z.string();
const summary = z.object({ head: text, ci: text, scanning: text, issue: text.nullable() });
export default defineWorkflow({
  name: 'github-snapshot',
  version: '2',
  input: z.object({ repo: text, pr: z.int().positive() }),
  output: summary.extend({ unresolved: z.int(), stacked: z.array(z.int()) }),
  async run(ctx, { repo, pr: number }) {
    const gh = github(ctx, { repo });
    const { nameWithOwner } = await gh.repo.info('repo');
    const pr = await gh.pr.view(ctx.id('pr', number), { number });
    // Keyed by head SHA: after a push, a new run reads fresh state under fresh IDs.
    const at = (read: string) => ctx.id(read, number, pr.headRefOid);
    const threads = await gh.pr.reviewThreads(at('threads'), { number });
    const ref = `refs/pull/${String(number)}/merge`;
    const scan = await gh.codeScanning.alerts(at('alerts'), { ref });
    // Only this repository's closing issue; another needs its own github(ctx, { repo }).
    const linked = pr.closingIssues.find((issue) => issue.repository === nameWithOwner);
    const view = (n: number) => gh.issue.view(ctx.id('issue', n), { number: n, comments: true });
    const issue = linked ? (await view(linked.number)).title : null;
    const stacked = await gh.pr.list(at('stacked'), { base: pr.headRefName });
    const unresolved = threads.filter((thread) => !thread.isResolved).length;
    const scanning = `${scan.status}: ${String(scan.alerts.length)} alerts`;
    const [head, ci] = [pr.headRefOid, pr.checks.state];
    return { head, ci, scanning, issue, unresolved, stacked: stacked.map((row) => row.number) };
  },
});
