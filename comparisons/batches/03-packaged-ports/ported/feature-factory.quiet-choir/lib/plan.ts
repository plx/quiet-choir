// Pure rules over the module plan: the call bounds that cap it, the problems the plan schema
// refuses, the approved text and its digest, the build order, the dependency rule that skips a
// module whose foundation was not built, and a writer's receipt checked against its areas.
import { createHash } from 'node:crypto';
import type { WorktreeChange } from 'quiet-choir';
import type { Module, Plan, Ticket } from '../contracts.js';

/** The repair rounds this package asks prd-decompose for; its call bound depends on them. */
export const DECOMPOSE_REPAIRS = 1;

/**
 * Upper bounds on agent calls, from prd-decompose's and deep-code-review's current shapes: five
 * lenses, a merge and each repair with one schema retry, one audit per round; a scope, one
 * reviewer per dimension, one skeptic per checked finding and a report. A module adds its builder
 * and one fixer. The planner has one schema retry.
 */
export function callBounds(input: { dimensions: readonly string[]; maxFindings: number }) {
  const decompose = 5 + 2 + (DECOMPOSE_REPAIRS + 1) + 2 * DECOMPOSE_REPAIRS;
  const review = 1 + input.dimensions.length + input.maxFindings + 1;
  return { decompose, plan: 2, module: 1 + review + 1 };
}

/** The modules the planner may use: maxModules, or fewer when the call cap admits fewer. */
export function moduleLimit(input: {
  maxModules: number;
  maxCalls: number;
  dimensions: readonly string[];
  maxFindings: number;
}): number {
  const bounds = callBounds(input);
  const affordable = Math.floor((input.maxCalls - bounds.decompose - bounds.plan) / bounds.module);
  return Math.min(input.maxModules, affordable);
}

/** An area owns itself and everything under it, so two areas overlap when one contains the other. */
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
export const within = (path: string, areas: readonly string[]) =>
  areas.some((area) => path === area || path.startsWith(`${area}/`));

type Planned = Pick<Module, 'name' | 'isFoundation' | 'fileAreas' | 'ticketIds'>;

/**
 * Why a plan cannot be built as written: a repeated module name, a ticket placed twice or not at
 * all, overlapping file areas, or a dependency that would not be built first. Foundations build in
 * plan order and every feature builds in parallel on all of them, so a ticket may depend only on
 * its own module, an earlier foundation (a feature: any foundation); a ticket that depends on a
 * deferred one must be deferred too.
 */
export function planProblems(
  plan: { modules: readonly Planned[]; deferred: readonly { ticket: string }[] },
  tickets: readonly Pick<Ticket, 'id' | 'dependsOn'>[],
): string[] {
  const problems: string[] = [];
  const names = plan.modules.map((module) => module.name);
  for (const name of new Set(names.filter((name, index) => names.indexOf(name) !== index)))
    problems.push(`Module name "${name}" is used twice`);
  const where = new Map<string, number | 'deferred'>();
  const place = (id: string, slot: number | 'deferred') => {
    if (where.has(id)) problems.push(`${id} is placed twice`);
    else where.set(id, slot);
  };
  plan.modules.forEach((module, index) => {
    for (const id of module.ticketIds) place(id, index);
  });
  for (const { ticket } of plan.deferred) place(ticket, 'deferred');
  for (const ticket of tickets)
    if (!where.has(ticket.id)) problems.push(`${ticket.id} is in no module and not deferred`);
  const areas = plan.modules.flatMap((module) =>
    module.fileAreas.map((area) => ({ area, name: module.name })),
  );
  areas.forEach((a, index) => {
    for (const b of areas.slice(index + 1))
      if (overlaps(a.area, b.area))
        problems.push(`${a.name}'s area ${a.area} overlaps ${b.name}'s area ${b.area}`);
  });
  for (const ticket of tickets) {
    const slot = where.get(ticket.id);
    if (slot === undefined || slot === 'deferred') continue;
    const owner = plan.modules[slot];
    for (const dependency of ticket.dependsOn) {
      const other = where.get(dependency);
      if (other === undefined || other === slot || !owner) continue;
      if (other === 'deferred') {
        problems.push(`${ticket.id} depends on the deferred ${dependency}; defer it too`);
        continue;
      }
      const builder = plan.modules[other];
      if (!builder?.isFoundation)
        problems.push(
          `${ticket.id} (${owner.name}) depends on ${dependency} in the feature module ${builder?.name ?? '?'}, which builds in parallel`,
        );
      else if (owner.isFoundation && other > slot)
        problems.push(
          `${ticket.id} (${owner.name}) depends on ${dependency} in the later foundation ${builder.name}`,
        );
    }
  }
  return problems;
}

/**
 * The plan in its schema's key order, so the output's plan serializes to the text a human approves
 * and every builder receives.
 */
export const canonicalPlan = (plan: Plan): Plan => ({
  modules: plan.modules.map(({ name, isFoundation, fileAreas, ticketIds, notes }) => ({
    name,
    isFoundation,
    fileAreas,
    ticketIds,
    notes,
  })),
  deferred: plan.deferred.map(({ ticket, reason }) => ({ ticket, reason })),
});

/** The SHA-256 of the approved plan text. */
export const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A bounded preview for the approval question; the subject carries the whole plan. */
export const preview = (text: string): string =>
  Buffer.from(text).subarray(0, 15_000).toString('utf8');

/** Foundations in plan order, then the features, which build in parallel. */
export const buildOrder = (plan: Plan) => [
  ...plan.modules.filter((module) => module.isFoundation),
  ...plan.modules.filter((module) => !module.isFoundation),
];

/**
 * Why `module` cannot build: one of its tickets depends on a ticket of another module that did not
 * land (`landed` holds the tickets of accepted modules). Null when it can.
 */
export function unbuildable(
  module: Module,
  tickets: readonly Ticket[],
  landed: ReadonlySet<string>,
): string | null {
  const own = new Set(module.ticketIds);
  for (const ticket of tickets.filter((ticket) => own.has(ticket.id)))
    for (const dependency of ticket.dependsOn)
      if (!own.has(dependency) && !landed.has(dependency))
        return `Skipped: ${ticket.id} depends on ${dependency}, which was not built`;
  return null;
}

/**
 * A writer's receipt against its module's areas: the files it changed outside them (every rename
 * counts as outside, whichever paths it names), and the change, null when the tree is unchanged.
 */
export function owned(change: WorktreeChange | undefined, areas: readonly string[]) {
  if (!change) throw new Error('A writer did not produce an isolated receipt');
  const outside = change.files
    .filter((file) => file.status === 'renamed' || !within(file.path, areas))
    .map((file) => `${file.path} (${file.status})`);
  return { outside, change: change.commit ? change : null };
}
