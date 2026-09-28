import { runProcess } from '../../harnesses/process.js';
import type { ExecutionLogger } from '../../application/execution.js';
import type { ProcessSupervisor } from '../../processes/supervisor.js';
import type { WorkflowEvent } from '../runtime/runner.js';

const notificationTypes = new Set(['wait.opened', 'run.suspended', 'run.completed', 'run.failed']);

/** Best-effort operator hook; durable business notifications belong in explicit workflow steps. @internal */
export class WorkflowNotifications {
  #queue = Promise.resolve();
  public constructor(
    private readonly options: {
      readonly command: string;
      readonly cwd: string;
      readonly stateDir: string;
      readonly logger: ExecutionLogger;
      readonly signal?: AbortSignal;
      readonly processSupervisor?: ProcessSupervisor;
    },
  ) {}

  /** Enqueue without delaying a committed workflow transition. */
  public observe(event: WorkflowEvent): void {
    if (!notificationTypes.has(event.type)) return;
    const input = `${JSON.stringify({ ...event, stateDir: this.options.stateDir })}\n`;
    this.#queue = this.#queue.then(async () => {
      try {
        if (this.options.signal?.aborted) return;
        const supervisor = this.options.processSupervisor;
        const result = await runProcess({
          binary: 'sh',
          args: ['-c', this.options.command],
          cwd: this.options.cwd,
          input,
          timeoutMs: 10_000,
          maxOutputBytes: 65_536,
          killGraceMs: 250,
          drainMs: 500,
          signal: this.options.signal ?? new AbortController().signal,
          ...(supervisor === undefined
            ? {}
            : {
                trackProcess: (child) => {
                  const dispose = supervisor.track(child);
                  return Promise.resolve({
                    release: () => {
                      dispose();
                      return Promise.resolve();
                    },
                  });
                },
              }),
        });
        if (result.code !== 0)
          throw new Error(
            `Hook exited ${String(result.code)}${result.signal ? ` (${result.signal})` : ''}. ${result.stderr.slice(0, 2_000)}`,
          );
        for (const warning of result.warnings) this.warn(warning);
      } catch (error) {
        this.warn(error instanceof Error ? error.message : String(error));
      }
    });
  }

  private warn(message: string): void {
    try {
      this.options.logger.log('warn', `Notification hook: ${message}`);
    } catch {
      /* Notification diagnostics must not affect the workflow outcome. */
    }
  }

  /** The executor drains hooks after the workflow has released its writer. */
  public async flush(): Promise<void> {
    await this.#queue;
  }
}
