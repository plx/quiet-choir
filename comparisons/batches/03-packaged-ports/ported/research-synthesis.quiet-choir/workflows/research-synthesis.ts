// research-synthesis: control flow only. Modality sweeps, deep reads and gap hunts are settled
// maps, so each failure is kept beside its modality, lead or gap. Each call goes to a web role or,
// for the repository, to a local role on a snapshot of the commit pinned first; code deduplicates
// and ranks the leads, keys the sources, checks the answer's citations and derives confidence and
// status.
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
  confidence,
  fold,
  huntCap,
  merge,
  modalitiesFor,
  rank,
  routed,
  sources,
  verdict,
  withSources,
} from '../lib/policy.js';
import { headCommit, unchanged } from '../lib/snapshot.js';
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
    const commit = context === null ? null : await headCommit(ctx);
    const snapshot = commit === null ? null : { base: { commit } };
    const swept = modalitiesFor(context);
    const sweeps = await ctx.map(
      'sweeps',
      swept,
      { concurrency: 4, onError: 'return' },
      async (modality) => {
        const prompt = prompts.Sweep({ question, context, modality, commit, maxLeads });
        if (snapshot && modality === 'local')
          return unchanged(
            await ctx.roster.LocalScout.object('sweep', {
              schema: Leads,
              worktree: snapshot,
              prompt,
            }),
          );
        return ctx.roster.Scout.value('sweep', { schema: Leads, prompt });
      },
    );
    const unswept = swept.filter((_, index) => !sweeps[index]?.ok);
    const leads = merge(
      swept.flatMap((modality, index) => {
        const result = sweeps[index];
        return result?.ok ? [{ modality, leads: result.value.leads }] : [];
      }),
    );
    const { toRead, deferred } = rank(leads, input.depth);
    const base = { swept, unswept, leadsFound: leads.length, deferred, localCommit: commit };
    const empty = { answer: null, confidence: 'none' as const, sources: [], gaps: [] };
    const unchecked = { critic: 'not-run' as const, unknownCitations: [], uncitedSources: [] };
    if (!toRead.length) return { ...base, ...empty, ...unchecked, status: 'no-leads', unread: [] };
    const readings = await ctx.map(
      'reads',
      toRead,
      { concurrency: 4, onError: 'return' },
      async (lead) => {
        if (snapshot && lead.kind === 'local-code')
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
    const { found, unread } = sources(toRead, readings);
    const read = { ...base, unread };
    if (!found.length) return { ...read, ...empty, ...unchecked, status: 'no-findings' };
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
        deferred,
        huntCap,
        maxGaps,
      }),
    });
    const critiqued = critique.ok ? routed(critique.value.gaps, context) : [];
    const known = found.map((source) => source.ref);
    // One supplementary round by design: critics always find more, and a third round rarely pays.
    const hunts = await ctx.map(
      'hunts',
      critiqued.slice(0, huntCap),
      { concurrency: 3, onError: 'return' },
      async (gap) => {
        if (snapshot && gap.territory === 'local')
          return unchanged(
            await ctx.roster.LocalHunter.object('hunt', {
              schema: Hunted,
              worktree: snapshot,
              prompt: prompts.Hunt({ question, context, gap, known, commit, maxFindings }),
            }),
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
    const critic = !critique.ok ? 'failed' : critiqued.length ? 'gaps' : 'adequate';
    const check = citations(answer, folded.sources);
    return {
      ...read,
      ...folded,
      status: verdict({ unswept, unread, critic, gaps: folded.gaps }, check),
      answer: withSources(answer, folded.sources),
      confidence: confidence(folded.sources, critic, folded.gaps, check),
      critic,
      unknownCitations: check.unknownCitations,
      uncitedSources: check.uncitedSources,
    };
  },
});
