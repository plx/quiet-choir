// Pure rules: collecting the strategies that competed, the risk register, the resolved stress
// problems and the status verdict.
import type { MapStepError, Settled } from 'quiet-choir';
import type { Capability, Problem, Strategy, StrategyPlan } from '../contracts.js';

type Plan = Omit<StrategyPlan, 'strategy'>;

/** The plans in strategy order, and each strategy whose strategist failed with its error. */
export function competed(
  strategies: readonly Strategy[],
  settled: readonly (Settled<Plan, MapStepError> | undefined)[],
) {
  const plans: StrategyPlan[] = [];
  const failed: { strategy: Strategy; kind: string; message: string }[] = [];
  strategies.forEach((strategy, index) => {
    const result = settled[index];
    if (result?.ok) plans.push({ strategy, ...result.value });
    else
      failed.push({
        strategy,
        kind: result?.error.kind ?? 'unknown',
        message: result?.error.message ?? 'No result',
      });
  });
  return { plans, failed };
}

/** Every high-risk capability with the milestone that schedules it, null when deferred. */
export function register(
  capabilities: readonly Capability[],
  milestones: readonly { readonly name: string; readonly capabilityIds: readonly string[] }[],
) {
  return capabilities
    .filter((capability) => capability.risk === 'high')
    .map((capability) => ({
      capability: capability.id,
      name: capability.name,
      milestone:
        milestones.find((milestone) => milestone.capabilityIds.includes(capability.id))?.name ??
        null,
    }));
}

/** Each stress-test problem with the finalizer's resolution of it (numbered from 1). */
export const resolved = (
  problems: readonly Problem[],
  resolutions: readonly { problem: number; action: 'applied' | 'declined'; note: string }[],
) =>
  problems.map((problem, index) => {
    const resolution = resolutions.find((entry) => entry.problem === index + 1);
    if (!resolution) throw new Error(`Problem ${String(index + 1)} has no resolution`);
    return { ...problem, action: resolution.action, note: resolution.note };
  });

/** A failed strategist degrades the tournament even when the rest of the run succeeds. */
export const status = (failed: readonly unknown[]) =>
  failed.length ? ('degraded' as const) : ('complete' as const);
