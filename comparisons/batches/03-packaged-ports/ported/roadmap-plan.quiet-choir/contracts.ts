// Data contracts: the input and output schemas and the structured agent results. The strategist,
// judge and finalizer schemas are built from the decomposition and the plans that survived, so a
// reply cannot name an unknown capability or strategy, and their refinements hold the dependency
// graph, the score rule and the problem accounting in code.
import { z } from 'quiet-choir';
import { graphProblems, pickProblems, planProblems, resolutionProblems } from './lib/graph.js';

export const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const isPath = (value: string) =>
  value.length > 0 &&
  value.length <= 500 &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  value
    .split('/')
    .every((part) => part !== '..' && part !== '.' && part !== '' && part !== '.git') &&
  !value.includes('\0');
export const Path = z
  .string()
  .min(1)
  .max(500)
  .refine(isPath, 'Use a repository-relative path without dot segments or .git');
export const Receipt = z.object({
  path: z.string(),
  sha256: Digest,
  bytes: z.number().int().nonnegative(),
  previousSha256: Digest.nullable(),
});

export const Strategy = z.enum(['de-risk-first', 'value-first', 'foundation-first']);
export type Strategy = z.infer<typeof Strategy>;
export const CapabilityId = z.string().regex(/^C[1-9][0-9]?$/u);
export const Size = z.enum(['S', 'M', 'L', 'XL']);
export type Size = z.infer<typeof Size>;
export const Level = z.enum(['high', 'medium', 'low']);

export const Capability = z.object({
  id: CapabilityId.describe('C1, C2, ... in list order'),
  name: z.string().min(1).max(120),
  summary: z.string().min(1).max(600).describe('What the capability delivers'),
  size: Size,
  dependsOn: z
    .array(CapabilityId)
    .max(20)
    .describe('Capabilities that must finish before this one can start'),
  risk: Level.describe('Technical or unknown risk, not business importance'),
  value: Level.describe('User or business value delivered'),
});
export type Capability = z.infer<typeof Capability>;

const report = (check: z.RefinementCtx, problems: string[]) => {
  for (const message of problems) check.addIssue({ code: 'custom', message });
};

/** The decomposer's reply: numbered capabilities whose dependencies form an acyclic graph. */
export const Decomposition = (max: number) =>
  z
    .object({ capabilities: z.array(Capability).max(max) })
    .superRefine((reply, check) => report(check, graphProblems(reply.capabilities)));

const milestoneText = {
  name: z.string().min(1).max(120),
  goal: z.string().min(1).describe('The shippable or demoable thing this milestone achieves'),
  gate: z.string().min(1).describe('The measurable exit criterion that says it is done'),
};
export const Milestone = z.object({
  ...milestoneText,
  capabilityIds: z.array(CapabilityId).min(1),
});
export type Milestone = z.infer<typeof Milestone>;
const ids = (capabilities: readonly Capability[]) =>
  capabilities.map((capability) => capability.id) as [string, ...string[]];
const placement = (capabilities: readonly Capability[]) => {
  const known = z.enum(ids(capabilities));
  return {
    milestone: z.object({
      ...milestoneText,
      capabilityIds: z.array(known).min(1).max(capabilities.length),
    }),
    deferred: z
      .array(known)
      .max(capabilities.length)
      .describe('Capabilities left outside the horizon; nothing scheduled may depend on one'),
  };
};

/** A strategist's reply: every capability placed once, in dependency order. */
export const Plan = (capabilities: readonly Capability[]) => {
  const { milestone, deferred } = placement(capabilities);
  return z
    .object({
      milestones: z.array(milestone).min(1).max(12),
      deferred,
      rationale: z.string().min(1).describe('Why this order, and what it buys and costs'),
    })
    .superRefine((plan, check) => report(check, planProblems(capabilities, plan)));
};
/** A plan with the strategy that produced it. */
export const StrategyPlan = z.object({
  strategy: Strategy,
  milestones: z.array(Milestone).min(1),
  deferred: z.array(CapabilityId),
  rationale: z.string(),
});
export type StrategyPlan = z.infer<typeof StrategyPlan>;

/** The judge's reply over the strategies that competed: the winner holds the top score. */
export const Pick = (keys: readonly [Strategy, ...Strategy[]]) =>
  z
    .object({
      scores: z
        .array(
          z.object({
            strategy: z.enum(keys),
            score: z.number().int().min(1).max(10),
            why: z.string().min(1),
          }),
        )
        .length(keys.length)
        .describe('One score per strategy: its fit to the priorities and the horizon'),
      winner: z.enum(keys),
      reasoning: z.string().min(1),
      graft: z
        .object({ from: z.enum(keys), idea: z.string().min(1) })
        .nullable()
        .describe('The one idea from a losing strategy worth grafting into the winner'),
    })
    .superRefine((pick, check) => report(check, pickProblems(keys, pick)));
export type Pick = z.infer<ReturnType<typeof Pick>>;

export const ProblemKind = z.enum([
  'hidden-dependency',
  'unbalanced-critical-path',
  'risk-piled-late',
  'milestone-not-shippable',
  'gate-unmeasurable',
]);
export const Problem = z.object({
  kind: ProblemKind,
  detail: z.string().min(1).describe('What fails, naming the milestones or capabilities'),
  fix: z.string().min(1).describe('A concrete change to the plan'),
});
export type Problem = z.infer<typeof Problem>;
/** The critic's reply; the plan is sound exactly when it is empty. */
export const Stress = z.object({ problems: z.array(Problem).max(12) });

const Action = z.enum(['applied', 'declined']);
/** The critical path on a plan: each capability with its milestone number, null when deferred. */
export const OnPlan = z.object({
  steps: z
    .array(z.object({ id: CapabilityId, milestone: z.number().int().min(1).nullable() }))
    .min(1),
  points: z.number().int().min(1),
});

/** The finalizer's reply: the revised plan, every problem resolved once, the graft answered. */
export const Revision = (capabilities: readonly Capability[], problems: number, graft: boolean) => {
  const { milestone, deferred } = placement(capabilities);
  return z
    .object({
      statement: z
        .string()
        .min(1)
        .describe('One paragraph: the sequencing strategy and why it fits'),
      milestones: z
        .array(milestone.extend({ keyRisks: z.array(z.string().min(1)).max(6) }))
        .min(1)
        .max(12),
      deferred,
      resolutions: z
        .array(
          z.object({
            problem: z
              .number()
              .int()
              .min(1)
              .max(Math.max(1, problems))
              .describe('The stress-test problem number'),
            action: Action,
            note: z.string().min(1).describe('What changed, or why it was declined'),
          }),
        )
        .length(problems),
      graft: graft ? z.object({ action: Action, note: z.string().min(1) }) : z.null(),
    })
    .superRefine((revision, check) =>
      report(check, [
        ...planProblems(capabilities, revision),
        ...resolutionProblems(problems, revision.resolutions),
      ]),
    );
};

export const RoadmapInput = z
  .object({
    spec: z
      .string()
      .min(1)
      .refine(
        (value) => value.includes('\n') || isPath(value),
        'A single-line spec must be a repository-relative path; spec text spans lines',
      )
      .describe(
        'The spec text itself when it spans lines, else the repository-relative path of the spec file',
      ),
    horizon: z
      .string()
      .min(1)
      .max(500)
      .nullable()
      .default(null)
      .describe(
        'How to shape the milestones ("3 two-week sprints", "MVP then GA"); null lets the strategists choose',
      ),
    priorities: z
      .string()
      .min(1)
      .max(2_000)
      .nullable()
      .default(null)
      .describe(
        'The business steer the plans are judged against; null judges risk and value evenly',
      ),
    out: Path.nullable()
      .default(null)
      .describe('Create the roadmap markdown at this new path; null writes nothing'),
    maxCapabilities: z
      .number()
      .int()
      .min(2)
      .max(40)
      .default(25)
      .describe('The most capabilities the decomposition may return; more fails its schema'),
    maxSpecBytes: z
      .number()
      .int()
      .min(1_000)
      .max(500_000)
      .default(200_000)
      .describe('The largest spec file or inline text the workflow reads'),
  })
  .refine(
    (input) => !input.spec.includes('\n') || Buffer.byteLength(input.spec) <= input.maxSpecBytes,
    'Inline spec text exceeds maxSpecBytes',
  );

const Resolved = Problem.extend({ action: Action, note: z.string() });
export const RoadmapOutput = z.object({
  status: z
    .enum(['complete', 'degraded', 'no-strategy', 'empty'])
    .describe(
      'complete: three strategies competed; degraded: a strategist failed, so fewer competed; no-strategy: none produced a valid plan; empty: no capability',
    ),
  spec: z.object({
    source: z.enum(['file', 'text']),
    path: Path.nullable(),
    sha256: Digest,
    bytes: z.number().int().nonnegative(),
  }),
  capabilities: z.array(Capability),
  failedStrategies: z.array(
    z.object({ strategy: Strategy, kind: z.string(), message: z.string() }),
  ),
  pick: z
    .object({
      winner: Strategy,
      scores: z.array(z.object({ strategy: Strategy, score: z.number().int(), why: z.string() })),
      reasoning: z.string(),
    })
    .nullable()
    .describe('The judge’s scores; null when fewer than two strategies competed'),
  strategy: Strategy.nullable(),
  statement: z.string().nullable().describe('The finalizer’s one-paragraph strategy statement'),
  milestones: z.array(
    z.object({
      name: z.string(),
      goal: z.string(),
      gate: z.string(),
      capabilities: z.array(CapabilityId),
      keyRisks: z.array(z.string()),
    }),
  ),
  deferred: z.array(CapabilityId),
  criticalPath: z
    .object({ capabilities: z.array(CapabilityId), points: z.number().int() })
    .nullable()
    .describe('The longest dependency chain by size (S 1, M 2, L 3, XL 5 points)'),
  risks: z
    .array(
      z.object({ capability: CapabilityId, name: z.string(), milestone: z.string().nullable() }),
    )
    .describe('Every high-risk capability and the milestone that de-risks it; null when deferred'),
  graft: z
    .object({ from: Strategy, idea: z.string(), action: Action, note: z.string() })
    .nullable(),
  stress: z.object({ sound: z.boolean(), problems: z.array(Resolved) }).nullable(),
  roadmap: z.string().nullable(),
  written: Receipt.nullable(),
});
export type RoadmapOutput = z.infer<typeof RoadmapOutput>;
