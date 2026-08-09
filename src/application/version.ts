import type { ExecutionLogger, ExecutionPlan, ExecutionResult, Executor } from './execution.js';

/** Plan for reading the running quiet-choir version. */
export interface VersionPlan extends ExecutionPlan {
  readonly kind: 'info.version';
}

/** Result of reading the running quiet-choir version. */
export interface VersionResult extends ExecutionResult {
  readonly kind: 'info.version.result';
  readonly version: string;
}

/** Build a version query plan. */
export function createVersionPlan(): VersionPlan {
  return { kind: 'info.version' };
}

/** Resolves a version captured from the CLI runtime. */
export class VersionExecutor implements Executor<VersionPlan, VersionResult> {
  readonly #logger: ExecutionLogger;
  readonly #version: string;

  public constructor(version: string, logger: ExecutionLogger) {
    this.#logger = logger;
    this.#version = version;
  }

  public execute(plan: VersionPlan): Promise<VersionResult> {
    this.#logger.log('trace', `Executing ${plan.kind}`);

    return Promise.resolve({ kind: 'info.version.result', version: this.#version });
  }
}
