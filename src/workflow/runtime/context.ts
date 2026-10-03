import type { WorkflowContext } from './model.js';
import type { NameFrame, NameScopes } from './names.js';

/** Bind an existing context without dropping overloads or eagerly reading its signal. @internal */
export function bindContext(
  context: WorkflowContext,
  names: NameScopes,
  frame: NameFrame,
): WorkflowContext {
  function bind<T extends (...args: never[]) => unknown>(method: T): T {
    // This transparent wrapper forwards the same arguments/result, including generic overloads.
    return ((...args: never[]) => names.bound(frame, () => method(...args))) as T;
  }
  return {
    runId: context.runId,
    cwd: context.cwd,
    agent: (name: Parameters<WorkflowContext['agent']>[0]) => {
      const client = context.agent(name);
      return {
        value: bind(client.value.bind(client)),
        text: bind(client.text.bind(client)),
        object: bind(client.object.bind(client)),
      };
    },
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
    wait: bind(context.wait.bind(context)),
    sleepUntil: bind(context.sleepUntil.bind(context)),
    poll: bind(context.poll.bind(context)),
    approve: bind(context.approve.bind(context)),
    step: bind(context.step.bind(context)),
    sleep: bind(context.sleep.bind(context)),
    map: bind(context.map.bind(context)),
    claude: {
      value: bind(context.claude.value.bind(context.claude)),
      text: bind(context.claude.text.bind(context.claude)),
      object: bind(context.claude.object.bind(context.claude)),
    },
    codex: {
      value: bind(context.codex.value.bind(context.codex)),
      text: bind(context.codex.text.bind(context.codex)),
      object: bind(context.codex.object.bind(context.codex)),
    },
  };
}
