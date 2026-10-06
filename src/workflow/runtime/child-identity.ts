/**
 * The unfinished-identity rule for inline child frames (ADR 0005, ADR 0026 #240): whether a saved
 * frame may be invoked again under a changed name, version, input or schemas. Declared-tree
 * validation and invocation share it, so the two paths cannot drift.
 */
import { isTerminalStep, type MapRecord, type RunRecord } from './record.js';

/** Whether a saved child frame may adopt a new identity, and why not when it may not. @internal */
export type FrameRedefinition =
  | { readonly redefinable: true }
  | {
      readonly redefinable: false;
      /** The frame is not failed, cancelled or superseded, or it is settled. */
      readonly reason: 'status';
    }
  | {
      readonly redefinable: false;
      /** A committed map item or settled frame owns the frame, so its outcome is terminal. */
      readonly reason: 'owned';
      /** The owner, as `settled map <id> item <n>` or `settled frame <id>`. */
      readonly owner: string;
    }
  | {
      readonly redefinable: false;
      /** The frame's subtree holds a completed or settled outcome. */
      readonly reason: 'terminal-work';
      /** Terminal step, settled map and descendant frame IDs, in record order. */
      readonly terminal: readonly string[];
    };

const REDEFINABLE_STATUSES: ReadonlySet<string> = new Set(['failed', 'cancelled', 'superseded']);

/** The frame and its ancestors, nearest first, following parent links without looping. */
function chain(record: RunRecord, id: string): string[] {
  const frames = record.children ?? {};
  const seen: string[] = [];
  let current: string | null = id;
  while (current !== null && !seen.includes(current) && Object.hasOwn(frames, current)) {
    seen.push(current);
    current = frames[current]?.parent ?? null;
  }
  return seen;
}

/**
 * Decide whether the saved frame `id` may be redefined. It may when its status is failed, cancelled
 * or superseded, it is not settled, no committed map item or settled frame owns it or an ancestor,
 * and nothing in its subtree (the frame and every frame whose parent chain reaches it) is terminal:
 * no completed or settled-failed step attributed to a subtree frame or under a subtree frame's ID
 * prefix, no settled map with a completed item run by a subtree frame or under such a prefix, and
 * no completed or settled descendant frame. Compacted `child:<hash>` descendants are found by their
 * parent links. @internal
 */
export function frameRedefinition(record: RunRecord, id: string): FrameRedefinition {
  const frames = record.children ?? {};
  const frame = Object.hasOwn(frames, id) ? frames[id] : undefined;
  if (!frame || !REDEFINABLE_STATUSES.has(frame.status) || frame.settled !== undefined)
    return { redefinable: false, reason: 'status' };

  const ancestry = chain(record, id);
  for (const ancestor of ancestry.slice(1))
    if (frames[ancestor]?.settled !== undefined)
      return { redefinable: false, reason: 'owned', owner: `settled frame ${ancestor}` };
  const lineage = new Set(ancestry);
  for (const [mapId, map] of Object.entries(record.maps ?? {}))
    for (const [index, item] of map.items.entries())
      if (item.status === 'completed' && item.children?.some((child) => lineage.has(child)))
        return {
          redefinable: false,
          reason: 'owned',
          owner: `settled map ${mapId} item ${String(index)}`,
        };
  for (const [ownerId, owner] of Object.entries(frames))
    if (owner.settled?.children.some((child) => lineage.has(child)))
      return { redefinable: false, reason: 'owned', owner: `settled frame ${ownerId}` };

  const subtree = new Set<string>([id]);
  for (const candidate of Object.keys(frames))
    if (candidate !== id && chain(record, candidate).includes(id)) subtree.add(candidate);
  const prefixes = [...subtree].map((member) => `${member}/`);
  const under = (key: string): boolean => prefixes.some((prefix) => key.startsWith(prefix));

  const terminal: string[] = [];
  for (const [stepId, step] of Object.entries(record.steps))
    if (isTerminalStep(step) && ((step.frame != null && subtree.has(step.frame)) || under(stepId)))
      terminal.push(stepId);
  // A map run through a bound view need not sit under a subtree prefix: its recorded frame, or for
  // a journal saved before revision 8, an owned step attributed to the subtree or an owned subtree
  // frame, places it.
  const inSubtree = (map: MapRecord, mapId: string): boolean =>
    map.frame != null
      ? subtree.has(map.frame) || under(mapId)
      : under(mapId) ||
        map.items.some(
          (item) =>
            item.status === 'completed' &&
            (item.steps.some((stepId) => {
              const step = Object.hasOwn(record.steps, stepId) ? record.steps[stepId] : undefined;
              return (step?.frame != null && subtree.has(step.frame)) || under(stepId);
            }) ||
              item.children?.some((child) => subtree.has(child))),
        );
  for (const [mapId, map] of Object.entries(record.maps ?? {}))
    if (map.items.some((item) => item.status === 'completed') && inSubtree(map, mapId))
      terminal.push(mapId);
  for (const member of subtree) {
    const descendant = frames[member];
    if (member !== id && (descendant?.status === 'completed' || descendant?.settled !== undefined))
      terminal.push(member);
  }
  return terminal.length
    ? { redefinable: false, reason: 'terminal-work', terminal }
    : { redefinable: true };
}
