// The prompt index: every agent prompt as a markdown template with typed parameters. Capabilities.md,
// Plan.md and Rules.md are fragments under prompts/_fragments/.
import { definePrompts, z } from 'quiet-choir';
import {
  Capability,
  CapabilityId,
  Milestone,
  OnPlan,
  Problem,
  Strategy,
  StrategyPlan,
} from './contracts.js';

const capabilities = z.array(Capability).min(1);
const steer = { horizon: z.string().nullable(), priorities: z.string().nullable() };
const winner = {
  strategy: Strategy,
  milestones: z.array(Milestone).min(1),
  deferred: z.array(CapabilityId),
  capabilities,
  criticalPath: OnPlan,
};

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Decompose: {
    file: 'Decompose.md',
    description:
      'Decompose the spec into capabilities with a size, risk, value and hard dependencies.',
    params: z.object({
      spec: z.string(),
      path: z.string().nullable(),
      maxCapabilities: z.number().int().min(1),
    }),
  },
  Sequence: {
    file: 'Sequence.md',
    description: 'Group the capabilities into milestones under one sequencing philosophy.',
    params: z.object({ strategy: Strategy, ...steer, capabilities }),
  },
  Pick: {
    file: 'Pick.md',
    description: 'Score the competing plans against the priorities, pick one and name a graft.',
    params: z.object({ plans: z.array(StrategyPlan).min(2), ...steer, capabilities }),
  },
  Stress: {
    file: 'Stress.md',
    description: 'Hunt the ways the winning plan fails; the spec comes last.',
    params: z.object({ ...winner, spec: z.string() }),
  },
  Finalize: {
    file: 'Finalize.md',
    description: 'Revise the winning plan with the graft and resolve every stress-test problem.',
    params: z.object({
      ...winner,
      graft: z.object({ from: Strategy, idea: z.string() }).nullable(),
      problems: z.array(Problem),
    }),
  },
});
