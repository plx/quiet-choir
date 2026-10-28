// The prompt index: every agent prompt as a markdown template with typed parameters. Every prompt
// includes _fragments/Migration.md, which reads from, to and notes.
import { definePrompts, z } from 'quiet-choir';
import { Cluster, Failure, GroupOutcome, Planned } from './contracts.js';

const migration = { from: z.string(), to: z.string(), notes: z.string().nullable() };
const approved = {
  digest: z.string(),
  plan: z.string().describe('The approved plan as indented JSON'),
};
const record = GroupOutcome.pick({ files: true, status: true, summary: true });

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Discover: {
    file: 'Discover.md',
    description: 'Find every call site and group the sites into disjoint file groups.',
    params: z.object({
      ...migration,
      paths: z.array(z.string()),
      terms: z.array(z.string()),
      hits: z.array(z.string()).describe('Tracked files code found the search terms in'),
    }),
  },
  Migrate: {
    file: 'Migrate.md',
    description: 'Migrate one approved file group; the approved plan JSON comes last.',
    params: z.object({ ...migration, group: Planned, ...approved }),
  },
  Triage: {
    file: 'Triage.md',
    description: 'Cluster the code-run verification failures by root cause.',
    params: z.object({
      ...migration,
      migrated: z.array(record),
      unmigrated: z.array(record),
      leftovers: z.array(z.string()),
      failures: z.array(Failure),
    }),
  },
  Repair: {
    file: 'Repair.md',
    description: 'Fix one failure cluster within the approved files; the plan JSON comes last.',
    params: z.object({
      ...migration,
      cluster: Cluster,
      allowed: z.array(z.string()),
      leftovers: z.array(z.string()),
      failures: z.array(Failure),
      ...approved,
    }),
  },
});
