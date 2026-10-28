// Pure graph rules: the decomposition's numbering and acyclicity, a plan's placement in dependency
// order, the judge's score rule, the finalizer's problem accounting and the critical path. The
// contracts' refinements call the problem functions, so a reply that breaks a rule is a schema
// failure the runtime retries once.
import type { Capability, Size, Strategy } from '../contracts.js';

type Node = Pick<Capability, 'id' | 'dependsOn'>;
type Placement = {
  readonly milestones: readonly {
    readonly name: string;
    readonly capabilityIds: readonly string[];
  }[];
  readonly deferred: readonly string[];
};

/** The first dependency cycle in list order, as the capability ids around it, or null. */
function cycle(capabilities: readonly Node[]): string[] | null {
  const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'open') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'open');
    stack.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dependency)) continue;
      const found = visit(dependency);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const capability of capabilities) {
    const found = visit(capability.id);
    if (found) return found;
  }
  return null;
}

/** Problems with capability numbering and the graph: C1, C2, ... in order, known edges, no cycle. */
export function graphProblems(capabilities: readonly Node[]): string[] {
  const known = new Set(capabilities.map((capability) => capability.id));
  const problems = capabilities.flatMap((capability, index) => {
    const expected = `C${String(index + 1)}`;
    return [
      ...(capability.id === expected ? [] : [`${capability.id} should be numbered ${expected}`]),
      ...capability.dependsOn
        .filter((dependency) => !known.has(dependency))
        .map((dependency) => `${capability.id} depends on ${dependency}, which is not listed`),
      ...(new Set(capability.dependsOn).size === capability.dependsOn.length
        ? []
        : [`${capability.id} repeats a dependency`]),
    ];
  });
  const found = cycle(capabilities);
  return found ? [...problems, `The dependencies form a cycle: ${found.join(' -> ')}`] : problems;
}

/** Each capability's milestone index, or null when deferred; duplicates are reported separately. */
export function positions(plan: Placement): Map<string, number | null> {
  const at = new Map<string, number | null>();
  plan.milestones.forEach((milestone, index) => {
    for (const id of milestone.capabilityIds) if (!at.has(id)) at.set(id, index);
  });
  for (const id of plan.deferred) if (!at.has(id)) at.set(id, null);
  return at;
}

/**
 * Problems with a plan: every capability placed exactly once (in a milestone or deferred), never
 * before a dependency, no milestone capability depending on a deferred one, and distinct names.
 */
export function planProblems(capabilities: readonly Node[], plan: Placement): string[] {
  const placed = [
    ...plan.milestones.flatMap((milestone) => milestone.capabilityIds),
    ...plan.deferred,
  ];
  const repeated = [...new Set(placed.filter((id, index) => placed.indexOf(id) !== index))];
  const at = positions(plan);
  const names = plan.milestones.map((milestone) => milestone.name);
  return [
    ...repeated.map((id) => `${id} is placed more than once`),
    ...capabilities.flatMap((capability) => {
      if (!at.has(capability.id))
        return [`${capability.id} is neither in a milestone nor deferred`];
      const own = at.get(capability.id);
      if (own === null || own === undefined) return [];
      return capability.dependsOn.flatMap((dependency) => {
        const before = at.get(dependency);
        if (before === undefined || (before !== null && before <= own)) return [];
        return [
          before === null
            ? `${capability.id} in milestone ${String(own + 1)} depends on ${dependency}, which is deferred`
            : `${capability.id} in milestone ${String(own + 1)} depends on ${dependency}, which is in later milestone ${String(before + 1)}`,
        ];
      });
    }),
    ...(new Set(names).size === names.length ? [] : ['Milestone names must be distinct']),
  ];
}

/** Problems with the judge's scores: each strategy once, and the winner holds the top score. */
export function pickProblems(
  keys: readonly Strategy[],
  pick: {
    readonly scores: readonly { readonly strategy: Strategy; readonly score: number }[];
    readonly winner: Strategy;
    readonly graft: { readonly from: Strategy } | null;
  },
): string[] {
  const scored = pick.scores.map((score) => score.strategy);
  const top = Math.max(...pick.scores.map((score) => score.score));
  const winner = pick.scores.find((score) => score.strategy === pick.winner);
  return [
    ...keys.filter((key) => !scored.includes(key)).map((key) => `Score ${key}`),
    ...(new Set(scored).size === scored.length ? [] : ['Score each strategy once']),
    ...(winner && winner.score < top ? [`The winner ${pick.winner} must hold the top score`] : []),
    ...(pick.graft?.from === pick.winner ? ['The graft must come from a losing strategy'] : []),
  ];
}

/** Problems with the finalizer's resolutions: problems 1..n, each resolved exactly once. */
export function resolutionProblems(
  problems: number,
  resolutions: readonly { readonly problem: number }[],
): string[] {
  const resolved = resolutions.map((resolution) => resolution.problem);
  return Array.from({ length: problems }, (_, index) => index + 1).flatMap((problem) => {
    const count = resolved.filter((value) => value === problem).length;
    return count === 1 ? [] : [`Resolve problem ${String(problem)} exactly once`];
  });
}

/** Size points for the critical path. */
export const points: Record<Size, number> = { S: 1, M: 2, L: 3, XL: 5 };

/**
 * The longest dependency chain by size points, or null without capabilities. The graph is acyclic
 * (the decomposition schema refuses a cycle); ties keep the earlier capability.
 */
export function criticalPath(capabilities: readonly Capability[]) {
  const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
  const memo = new Map<string, { points: number; path: string[] }>();
  const chain = (capability: Capability): { points: number; path: string[] } => {
    const known = memo.get(capability.id);
    if (known) return known;
    let longest: { points: number; path: string[] } | undefined;
    for (const id of capability.dependsOn) {
      const dependency = byId.get(id);
      const prior = dependency && chain(dependency);
      if (prior && (!longest || prior.points > longest.points)) longest = prior;
    }
    const found = {
      points: (longest?.points ?? 0) + points[capability.size],
      path: [...(longest?.path ?? []), capability.id],
    };
    memo.set(capability.id, found);
    return found;
  };
  let best: { points: number; path: string[] } | null = null;
  for (const capability of capabilities) {
    const found = chain(capability);
    if (!best || found.points > best.points) best = found;
  }
  return best && { capabilities: best.path, points: best.points };
}

/** The critical path on a plan: each capability's milestone number, null when deferred. */
export function onPlan(
  path: { readonly capabilities: readonly string[]; readonly points: number },
  plan: Placement,
) {
  const at = positions(plan);
  return {
    steps: path.capabilities.map((id) => {
      const index = at.get(id);
      return { id, milestone: index === null || index === undefined ? null : index + 1 };
    }),
    points: path.points,
  };
}
