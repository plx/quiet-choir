import { resolve } from 'node:path';

/** Shared working-directory and checkpoint-directory resolution inputs. */
export interface StateDirectoryOptions {
  /** Base directory, resolved against process.cwd(); defaults to process.cwd(). */
  readonly cwd?: string;
  /** Checkpoint directory relative to cwd; defaults to .quiet-choir/runs. */
  readonly stateDir?: string;
}

/** Resolve the same absolute storage directory for execution and inspection. */
export function resolveStateDir(options: StateDirectoryOptions = {}): string {
  return resolve(options.cwd ?? process.cwd(), options.stateDir ?? '.quiet-choir/runs');
}
