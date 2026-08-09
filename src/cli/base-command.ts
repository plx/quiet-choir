import { Command, Flags, type Interfaces } from '@oclif/core';

import {
  LOG_LEVELS,
  ThresholdLogger,
  type ExecutionLogger,
  type LogLevel,
} from '../application/execution.js';

/** Parsed flags shared by every quiet-choir command. */
export interface GlobalFlags {
  readonly 'log-level': LogLevel;
  readonly verbose: boolean | undefined;
}

/** Shared oclif command behavior and global flags. */
export abstract class BaseCommand extends Command {
  public static override readonly baseFlags: Interfaces.FlagInput<GlobalFlags> = {
    'log-level': Flags.option({ options: LOG_LEVELS })({
      default: 'info',
      description: 'Minimum executor log level',
      helpGroup: 'GLOBAL',
    }),
    verbose: Flags.boolean({
      char: 'v',
      default: false,
      description: 'Show trace-level executor logs',
      exclusive: ['log-level'],
      helpGroup: 'GLOBAL',
    }),
  };

  protected createExecutionLogger(flags: GlobalFlags): ExecutionLogger {
    const threshold = flags.verbose ? 'trace' : flags['log-level'];

    return new ThresholdLogger(threshold, (line) => {
      this.logToStderr(line);
    });
  }
}
