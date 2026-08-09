import type { ExecutionLogger, ExecutionPlan, ExecutionResult, Executor } from './execution.js';

/** Command IDs represented by the spike's placeholder executors. */
export const STUB_COMMAND_IDS = [
  'workflow.execute',
  'workflow.validate',
  'configuration.doctor',
  'configuration.get',
  'configuration.set',
] as const;

/** A command that is present in the CLI tree but not implemented yet. */
export type StubCommandId = (typeof STUB_COMMAND_IDS)[number];

/** Plan for a deliberately unimplemented command. */
export interface StubPlan extends ExecutionPlan {
  readonly command: StubCommandId;
  readonly kind: 'cli.stub';
}

/** Result returned by a deliberately unimplemented command. */
export interface StubResult extends ExecutionResult {
  readonly command: StubCommandId;
  readonly kind: 'cli.stub.result';
  readonly status: 'not-implemented';
}

/** Build the plain-data plan for a placeholder command. */
export function createStubPlan(command: StubCommandId): StubPlan {
  return { command, kind: 'cli.stub' };
}

/** Executor used while a command exists only as a navigable placeholder. */
export class StubExecutor implements Executor<StubPlan, StubResult> {
  readonly #logger: ExecutionLogger;

  public constructor(logger: ExecutionLogger) {
    this.#logger = logger;
  }

  public execute(plan: StubPlan): Promise<StubResult> {
    this.#logger.log('trace', `Executing plan for ${plan.command}`);

    return Promise.resolve({
      command: plan.command,
      kind: 'cli.stub.result',
      status: 'not-implemented',
    });
  }
}
