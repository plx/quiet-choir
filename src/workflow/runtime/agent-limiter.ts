import { addAbortListener } from 'node:events';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

/** Concurrent invocation ceilings, independent of effect identity and per-call deadlines. */
export interface AgentLimits {
  /** Maximum live harness invocations across all providers. */
  readonly total: number;
  /** Optional additional ceilings by provider; unspecified providers share the total ceiling. */
  readonly perProvider?: Readonly<Record<string, number>>;
}

/** Detached view of admission state; counts include reserved invocation slots. */
export interface AgentLimiterSnapshot {
  /** Reserved slots by provider; idle providers are omitted. */
  readonly inFlight: Readonly<Record<string, number>>;
  /** Requests waiting for a slot. */
  readonly queued: number;
}

/** One reserved invocation slot, owned until release even if its signal subsequently aborts. */
export interface AgentPermit {
  /** Monotonic milliseconds spent waiting for admission. */
  readonly waitedMs: number;
  /** Release exactly once; repeated calls are harmless. Always call from finally. */
  release(): void;
}

/** Admission boundary shared by every live agent invocation; custom policies may reject acquire. */
export interface AgentLimiter {
  /** Admit FIFO among eligible requests, or reject promptly if cancelled while queued. */
  acquire(provider: string, signal: AbortSignal): Promise<AgentPermit>;
  /** Return detached counts without exposing mutable limiter state. */
  snapshot(): AgentLimiterSnapshot;
}

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const limitsSchema = z.strictObject({
  total: positiveInteger,
  perProvider: z.record(z.string().min(1), positiveInteger).optional(),
});

/** Validate and copy plain limits before execution or checkpoint creation. @internal */
export function validateAgentLimits(value: unknown): AgentLimits {
  const parsed = limitsSchema.parse(value);
  return {
    total: parsed.total,
    ...(parsed.perProvider === undefined ? {} : { perProvider: parsed.perProvider }),
  };
}

/** Conservative per-run default for full CLI processes, with at least one slot. */
export function defaultAgentLimits(): AgentLimits {
  return { total: Math.min(8, Math.max(1, availableParallelism() - 2)) };
}

interface Waiter {
  readonly provider: string;
  readonly signal: AbortSignal;
  readonly started: number;
  readonly resolve: (permit: AgentPermit) => void;
  readonly reject: (error: unknown) => void;
}

/** Create an in-memory eligible-FIFO limiter. Share the returned object to cap several runs. */
export function createAgentLimiter(limits: AgentLimits): AgentLimiter {
  const checked = validateAgentLimits(limits);
  const ceilings = new Map(Object.entries(checked.perProvider ?? {}));
  const active = new Map<string, number>();
  const queue: Waiter[] = [];
  const groups = new Map<AbortSignal, { waiters: Set<Waiter>; dispose: () => void }>();
  const removeListener = (waiter: Waiter): void => {
    const group = groups.get(waiter.signal);
    group?.waiters.delete(waiter);
    if (group?.waiters.size === 0) {
      group.dispose();
      groups.delete(waiter.signal);
    }
  };
  let total = 0;
  const pump = (): void => {
    for (let index = 0; index < queue.length && total < checked.total;) {
      const waiter = queue[index];
      if (!waiter) break;
      const count = active.get(waiter.provider) ?? 0;
      if (count >= (ceilings.get(waiter.provider) ?? checked.total)) {
        index++;
        continue;
      }
      queue.splice(index, 1);
      removeListener(waiter);
      total++;
      active.set(waiter.provider, count + 1);
      let released = false;
      waiter.resolve({
        waitedMs: Math.max(0, performance.now() - waiter.started),
        release(): void {
          if (released) return;
          released = true;
          total--;
          const remaining = (active.get(waiter.provider) ?? 1) - 1;
          if (remaining === 0) active.delete(waiter.provider);
          else active.set(waiter.provider, remaining);
          pump();
        },
      });
    }
  };
  return {
    acquire(provider, signal) {
      return new Promise<AgentPermit>((resolve, reject) => {
        if (typeof provider !== 'string' || !provider.length)
          throw new Error('Agent provider must be a nonempty string.');
        signal.throwIfAborted();
        const waiter: Waiter = { provider, signal, started: performance.now(), resolve, reject };
        let group = groups.get(signal);
        if (!group) {
          const waiters = new Set<Waiter>();
          const subscription = addAbortListener(signal, () => {
            groups.delete(signal);
            subscription[Symbol.dispose]();
            for (let index = queue.length - 1; index >= 0; index--) {
              const entry = queue[index];
              if (entry && waiters.has(entry)) {
                queue.splice(index, 1);
                entry.reject(signal.reason);
              }
            }
            waiters.clear();
            pump();
          });
          group = {
            waiters,
            dispose: () => {
              subscription[Symbol.dispose]();
            },
          };
          groups.set(signal, group);
        }
        group.waiters.add(waiter);
        queue.push(waiter);
        pump();
      });
    },
    snapshot() {
      return { inFlight: Object.fromEntries(active), queued: queue.length };
    },
  };
}

/** Resolve data limits or preserve an explicitly shared admission object. @internal */
export function resolveAgentLimiter(value?: unknown): AgentLimiter {
  if (
    value !== null &&
    typeof value === 'object' &&
    'acquire' in value &&
    typeof value.acquire === 'function' &&
    'snapshot' in value &&
    typeof value.snapshot === 'function'
  )
    return value as AgentLimiter;
  return createAgentLimiter(
    value === undefined
      ? defaultAgentLimits()
      : typeof value === 'number'
        ? { total: value }
        : (value as AgentLimits),
  );
}
