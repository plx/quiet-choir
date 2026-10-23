import type { AgentClient, AgentOptions, WorkflowContext } from './model.js';
import { bindAgent, bindRole, type BindHooks } from './bound-agent.js';
import type { DecisionBinding } from './decisions.js';
import type { NameFrame, NameScopes } from './names.js';
import { rosterReader } from './roster.js';

/** The runner's `ctx.decide`, which a decider roster entry calls with its binding. @internal */
export type DecideCall = (
  id: string,
  options: unknown,
  binding?: DecisionBinding,
) => Promise<unknown>;

const noDecide: DecideCall = () =>
  Promise.reject(new Error('This context cannot make roster decisions.'));

/**
 * Bind an existing context without dropping overloads or eagerly reading its signal. `hooks` gives
 * the runtime's hooks for a harness, passed to the agents bound from its client. `roster` reads the
 * roster of the definition running when `ctx.roster` is read, whose agents are rebuilt over this
 * context's prefixed clients; its decider entries call `decide`, the runner's `ctx.decide`, under
 * this context's prefix. @internal
 */
export function bindContext(
  context: WorkflowContext,
  names: NameScopes,
  frame: NameFrame,
  hooks: (harness: string) => BindHooks = () => ({}),
  roster: () => unknown = () => undefined,
  decide: DecideCall = noDecide,
): WorkflowContext {
  function bind<T extends (...args: never[]) => unknown>(method: T): T {
    // This transparent wrapper forwards the same arguments/result, including generic overloads.
    return ((...args: never[]) => names.bound(frame, () => method(...args))) as T;
  }
  /** The runtime's hooks for `harness`, with a rejected bound call launched under the prefix. */
  function scopedHooks(harness: string): BindHooks {
    const { markFatal, reject } = hooks(harness);
    return { markFatal, reject: reject && bind(reject) };
  }
  // A bound agent wraps this prefixed client, never the inner one, so it keeps the prefix; a
  // rejected bound call launches under the prefix too.
  function client<TOptions extends AgentOptions>(
    inner: AgentClient<TOptions>,
    harness: string,
  ): AgentClient<TOptions> {
    const scoped = scopedHooks(harness);
    const wrapped: AgentClient<TOptions> = {
      value: bind(inner.value.bind(inner)),
      text: bind(inner.text.bind(inner)),
      object: bind(inner.object.bind(inner)),
      bind: (options) => bindAgent(wrapped, options, scoped),
    };
    return wrapped;
  }
  const claude = client(context.claude, 'claude');
  const codex = client(context.codex, 'codex');
  const readRoster = rosterReader(
    (harness, entry) =>
      bindRole(
        harness === 'claude'
          ? claude
          : harness === 'codex'
            ? codex
            : client(context.agent(harness as Parameters<WorkflowContext['agent']>[0]), harness),
        entry,
        scopedHooks(harness),
      ),
    // Bound like ctx.decide, so `ctx.within(p).roster.Name.decide('t', …)` records `p/t`.
    (binding) => bind((id: string, options: unknown) => decide(id, options, binding)),
  );
  return {
    runId: context.runId,
    cwd: context.cwd,
    agent: (name: Parameters<WorkflowContext['agent']>[0]) => client(context.agent(name), name),
    workflow: bind(context.workflow.bind(context)),
    merge: bind(context.merge.bind(context)),
    worktree: bind(context.worktree.bind(context)),
    writeFile: bind(context.writeFile.bind(context)),
    readFile: bind(context.readFile.bind(context)),
    exec: Object.assign(bind(context.exec), { json: bind(context.exec.json.bind(context.exec)) }),
    get signal() {
      return context.signal;
    },
    id: (...parts) => context.id(...parts),
    scope: bind(context.scope.bind(context)),
    within: bind(context.within.bind(context)),
    phase: bind(context.phase.bind(context)),
    log: bind(context.log.bind(context)),
    ask: bind(context.ask.bind(context)),
    now: bind(context.now.bind(context)),
    decide: bind(context.decide.bind(context)),
    wait: bind(context.wait.bind(context)),
    sleepUntil: bind(context.sleepUntil.bind(context)),
    poll: bind(context.poll.bind(context)),
    approve: bind(context.approve.bind(context)),
    step: bind(context.step.bind(context)),
    sleep: bind(context.sleep.bind(context)),
    map: bind(context.map.bind(context)),
    claude,
    codex,
    get roster() {
      return readRoster(roster()) as WorkflowContext['roster'];
    },
  };
}
