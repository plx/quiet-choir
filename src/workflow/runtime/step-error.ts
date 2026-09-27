import { ExecError } from './exec-error.js';
import { z } from 'zod';

import { CancelledError } from './fan-out.js';
import { HarnessError } from './harness-error.js';
import type { ErrorKind, StepError } from './model.js';

/** Shared validation for retry filters and saved failures. @internal */
export const errorKindSchema = z.enum([
  'timeout',
  'rate-limit',
  'schema',
  'authentication',
  'permission',
  'turn-limit',
  'budget-limit',
  'output-limit',
  'process',
  'protocol',
  'cancelled',
  'unknown',
]);

/** Checkpoint representation of a terminal failure. @internal */
export const stepErrorSchema = z.object({
  message: z.string(),
  kind: errorKindSchema,
  attempts: z.number().int().positive(),
});

/** Classify structured metadata, never guessed substrings of user-controlled error messages. @internal */
export function errorKind(error: unknown): ErrorKind {
  if (error instanceof CancelledError) return 'cancelled';
  if (error instanceof ExecError) return error.kind;
  if (error instanceof HarnessError) return error.kind;
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'schema';
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'cancelled';
    if (error.name === 'TimeoutError') return 'timeout';
    // runProcess marks subprocess launch failures; any errno code there is a process failure.
    if ('phase' in error && error.phase === 'spawn') return 'process';
    const code = 'code' in error ? error.code : undefined;
    if (code === 'ETIMEDOUT') return 'timeout';
    if (code === 'ABORT_ERR') return 'cancelled';
    if (code === 'QUIET_CHOIR_OUTPUT_LIMIT') return 'output-limit';
    if (code === 'ENOENT' || code === 'EPIPE') return 'process';
  }
  return 'unknown';
}

/** Convert an effect failure to lossless data. @internal */
export function stepError(error: unknown, attempts: number): StepError {
  return {
    message: error instanceof Error ? error.message : String(error),
    kind: errorKind(error),
    attempts,
  };
}
