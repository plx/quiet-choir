/** A serializable description of work that an executor can perform. */
export interface ExecutionPlan {
  readonly kind: string;
}

/** A serializable description of an execution outcome. */
export interface ExecutionResult {
  readonly kind: string;
}

/** Executes a plain-data plan and returns a plain-data result. */
export interface Executor<TPlan extends ExecutionPlan, TResult extends ExecutionResult> {
  execute(plan: TPlan): Promise<TResult>;
}

/** Log levels understood by executors and the CLI adapter. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

/** A supported executor log level. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Logging port supplied to executors by their caller. */
export interface ExecutionLogger {
  log(level: LogLevel, message: string): void;
}

const LOG_LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

/** Filters executor log records and writes accepted records as text lines. */
export class ThresholdLogger implements ExecutionLogger {
  readonly #threshold: LogLevel;
  readonly #writeLine: (line: string) => void;

  public constructor(threshold: LogLevel, writeLine: (line: string) => void) {
    this.#threshold = threshold;
    this.#writeLine = writeLine;
  }

  public log(level: LogLevel, message: string): void {
    if (this.#threshold !== 'silent' && LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[this.#threshold]) {
      this.#writeLine(`[${level}] ${message}`);
    }
  }
}
