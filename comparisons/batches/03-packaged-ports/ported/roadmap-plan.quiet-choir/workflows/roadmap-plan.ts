// roadmap-plan: control flow only. Code reads the spec; one decomposer returns the capability graph,
// which its schema holds acyclic. Three strategists sequence it as a settled map whose plans the
// schemas check against the graph; a judge scores the survivors, a critic stress-tests the winner
// against the critical path code computed, and a finalizer returns the revised plan with every
// problem resolved; code renders the roadmap and creates the document.
import { defineWorkflow } from 'quiet-choir';
import {
  Decomposition,
  Pick,
  Plan,
  Revision,
  RoadmapInput,
  RoadmapOutput,
  Strategy,
  Stress,
} from '../contracts.js';
import { criticalPath, onPlan } from '../lib/graph.js';
import { competed, register, resolved, status } from '../lib/policy.js';
import { render } from '../lib/render.js';
import { readSpec } from '../lib/spec.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

// A reply that breaks a schema rule (the graph rules among them) gets one more attempt.
const retry = { maxAttempts: 2, on: ['schema'] } as const;

export default defineWorkflow({
  name: 'roadmap-plan',
  version: 'packaged-03',
  description:
    'Decompose a spec into a checked capability graph, sequence it under three strategies, pick and stress-test the winner, and render the revised roadmap in code.',
  roster,
  prompts: [prompts],
  input: RoadmapInput,
  output: RoadmapOutput,
  async run(ctx, input) {
    const { horizon, priorities, maxCapabilities } = input;
    const spec = await readSpec(ctx, input.spec, input.maxSpecBytes);
    const report = {
      spec: spec.source,
      capabilities: [],
      failedStrategies: [],
      pick: null,
      strategy: null,
      statement: null,
      milestones: [],
      deferred: [],
      criticalPath: null,
      risks: [],
      graft: null,
      stress: null,
      roadmap: null,
      written: null,
    };
    if (!spec.text.trim()) return { ...report, status: 'empty' };
    const { capabilities } = await ctx.roster.Decomposer.value('decompose', {
      schema: Decomposition(maxCapabilities),
      prompt: prompts.Decompose({ spec: spec.text, path: spec.source.path, maxCapabilities }),
      retry,
    });
    const path = criticalPath(capabilities);
    if (!path) return { ...report, status: 'empty' };
    // `version` names the prompt and schema, which a settled map's fingerprint does not show.
    const settled = await ctx.map(
      'strategies',
      Strategy.options,
      { concurrency: 3, onError: 'return', version: 'sequence/1', key: (strategy) => strategy },
      (strategy) =>
        ctx.roster.Strategist.value('plan', {
          schema: Plan(capabilities),
          prompt: prompts.Sequence({ strategy, horizon, priorities, capabilities }),
          retry,
        }),
    );
    const { plans, failed } = competed(Strategy.options, settled);
    const graph = { ...report, capabilities, failedStrategies: failed, criticalPath: path };
    const [first, ...rivals] = plans;
    if (!first) return { ...graph, status: 'no-strategy' };
    // A sole survivor has no rival to score and no loser to graft from.
    const pick = rivals.length
      ? await ctx.roster.Judge.value('panel', {
          schema: Pick([first.strategy, ...rivals.map((plan) => plan.strategy)]),
          prompt: prompts.Pick({ plans, horizon, priorities, capabilities }),
          retry,
        })
      : null;
    const winner = plans.find((plan) => plan.strategy === pick?.winner) ?? first;
    const facts = {
      strategy: winner.strategy,
      milestones: winner.milestones,
      deferred: winner.deferred,
      capabilities,
      criticalPath: onPlan(path, winner),
    };
    const { problems } = await ctx.roster.Critic.value('critic', {
      schema: Stress,
      prompt: prompts.Stress({ ...facts, spec: spec.text }),
      retry,
    });
    const graft = pick?.graft ?? null;
    const final = await ctx.roster.Finalizer.value('finalize', {
      schema: Revision(capabilities, problems.length, graft !== null),
      prompt: prompts.Finalize({ ...facts, graft, problems }),
      retry,
    });
    const roadmap = {
      ...graph,
      status: status(failed),
      pick: pick && { winner: pick.winner, scores: pick.scores, reasoning: pick.reasoning },
      strategy: winner.strategy,
      statement: final.statement,
      milestones: final.milestones.map(({ capabilityIds, ...milestone }) => ({
        ...milestone,
        capabilities: capabilityIds,
      })),
      deferred: final.deferred,
      risks: register(capabilities, final.milestones),
      graft: graft && final.graft && { ...graft, ...final.graft },
      stress: { sound: !problems.length, problems: resolved(problems, final.resolutions) },
    };
    const document = render(roadmap);
    if (input.out === null) return { ...roadmap, roadmap: document };
    // Exclusive creation keeps an existing roadmap from being silently overwritten.
    const written = await ctx.writeFile('write', input.out, document, { ifMatch: null });
    return { ...roadmap, roadmap: document, written };
  },
});
