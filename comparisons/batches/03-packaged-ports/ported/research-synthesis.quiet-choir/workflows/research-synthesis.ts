// research-synthesis: control flow only. Modality sweeps, deep reads and gap hunts are settled
// maps, so each failure is kept beside its modality, lead or gap. A lead's territory is code's (the
// local sweep's leads are local), and it routes each read and hunt: to a web role, or to a local
// role on a snapshot of the commit pinned first. Code deduplicates and ranks the leads, keys the
// sources, checks the answer's citations and derives confidence and status on every return path.
import { defineWorkflow } from 'quiet-choir';
import {
  Critique,
  Hunted,
  Leads,
  Reading,
  ResearchInput,
  ResearchOutput,
  maxFindings,
  maxGaps,
  maxLeads,
} from '../contracts.js';
import {
  citations,
  conclude,
  fold,
  gather,
  huntCap,
  knownFor,
  modalitiesFor,
  rank,
  routed,
  sources,
  withSources,
} from '../lib/policy.js';
import { pinHead, unchanged } from '../lib/snapshot.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

export default defineWorkflow({
  name: 'research-synthesis',
  version: 'packaged-03',
  description:
    'Sweep for leads, deep-read the ranked top, synthesize with checked citations, and run one critic-driven hunt round.',
  roster,
  prompts: [prompts],
  input: ResearchInput,
  output: ResearchOutput,
  async run(ctx, input) {
    const { question, context } = input;
    const commit = context === null ? null : await pinHead(ctx);
    const snapshot = commit === null ? null : { base: { commit } };
    const local = snapshot !== null;
    const swept = modalitiesFor(commit);
    const sweeps = await ctx.map(
      'sweeps',
      swept,
      { concurrency: 4, key: (modality) => modality, onError: 'return', version: 'sweep/1' },
      async (modality) => {
        const prompt = prompts.Sweep({ question, context, modality, commit, maxLeads });
        if (snapshot && modality === 'local')
          return unchanged(
            await ctx.roster.LocalScout.object('sweep', {
              schema: Leads,
              worktree: snapshot,
              prompt,
            }),
            (found) => found.leads.map((lead) => lead.ref),
          );
        return ctx.roster.Scout.value('sweep', { schema: Leads, prompt });
      },
    );
    const { leads, unswept } = gather(swept, sweeps, context !== null && !local);
    const { toRead, deferred } = rank(leads, input.depth);
    const base = { swept, unswept, leadsFound: leads.length, deferred, localCommit: commit };
    const empty = {
      answer: null,
      sources: [],
      gaps: [],
      critic: 'not-run' as const,
      unknownCitations: [],
      uncitedSources: [],
    };
    if (!toRead.length) return conclude({ ...base, ...empty, unread: [] });
    const readings = await ctx.map(
      'reads',
      toRead,
      { concurrency: 4, onError: 'return', version: 'read/1' },
      async (lead) => {
        if (snapshot && lead.territory === 'local')
          return unchanged(
            await ctx.roster.LocalReader.object('read', {
              schema: Reading,
              worktree: snapshot,
              prompt: prompts.Read({ question, context, lead, commit, maxFindings }),
            }),
          );
        return ctx.roster.Reader.value('read', {
          schema: Reading,
          prompt: prompts.Read({ question, context, lead, commit: null, maxFindings }),
        });
      },
    );
    const { found, unread, failed } = sources(toRead, readings);
    const read = { ...base, unread };
    if (!found.length) return conclude({ ...read, ...empty });
    const draft = await ctx.roster.Synthesizer.value('synthesize', {
      prompt: prompts.Synthesize({ question, context, sources: found, gaps: null }),
    });
    const critique = await ctx.roster.Critic.value('critic', {
      schema: Critique,
      onError: 'return',
      prompt: prompts.Critique({
        question,
        context,
        answer: draft,
        sources: found,
        unknown: citations(draft, found).unknownCitations,
        unswept,
        failed,
        deferred,
        local,
        huntCap,
        maxGaps,
      }),
    });
    const critiqued = critique.ok ? routed(critique.value.gaps, commit) : [];
    // One supplementary round by design: critics always find more, and a third round rarely pays.
    const hunts = await ctx.map(
      'hunts',
      critiqued.slice(0, huntCap),
      { concurrency: 3, onError: 'return', version: 'hunt/1' },
      async (gap) => {
        const known = knownFor(found, gap.territory);
        if (snapshot && gap.territory === 'local')
          return unchanged(
            await ctx.roster.LocalHunter.object('hunt', {
              schema: Hunted,
              worktree: snapshot,
              prompt: prompts.Hunt({ question, context, gap, known, commit, maxFindings }),
            }),
            (hunt) => (hunt.source ? [hunt.source.ref] : []),
          );
        return ctx.roster.Hunter.value('hunt', {
          schema: Hunted,
          prompt: prompts.Hunt({ question, context, gap, known, commit: null, maxFindings }),
        });
      },
    );
    const folded = fold(found, critiqued, hunts);
    const answer = folded.gaps.some((gap) => gap.hunt === 'found')
      ? await ctx.roster.Synthesizer.value('resynthesize', {
          prompt: prompts.Synthesize({ question, context, ...folded }),
        })
      : draft;
    return conclude({
      ...read,
      ...folded,
      critic: !critique.ok ? 'failed' : critiqued.length ? 'gaps' : 'adequate',
      answer: withSources(answer, folded.sources),
      ...citations(answer, folded.sources),
    });
  },
});
