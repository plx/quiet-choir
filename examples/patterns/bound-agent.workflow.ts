import { defineWorkflow, z, type Agent } from '../../src/index.js';

const Finding = z.object({ summary: z.string(), severe: z.boolean() });
const triage = (agent: Agent, repo: string) =>
  agent.value('triage', { schema: Finding, cwd: repo, prompt: `Triage open risks in ${repo}.` });

export default defineWorkflow({
  name: 'bound-agent',
  version: '1',
  input: z.object({ repos: z.array(z.string()).max(8) }),
  output: z.array(Finding),
  async run(ctx, input) {
    // Bound once: the model, effort and tools are fixed for every call below.
    const reviewer = ctx.claude.bind({
      model: 'sonnet',
      effort: 'low',
      tools: ['Read', 'Grep', 'Glob'],
    });
    return ctx.map('repos', input.repos, { concurrency: 2, key: (repo) => ctx.id(repo) }, (repo) =>
      triage(reviewer, repo),
    );
  },
});
