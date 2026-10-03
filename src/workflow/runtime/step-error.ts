import { ExecError } from './exec-error.js';
import { z } from 'zod';

import { CancelledError } from './fan-out.js';
import { HarnessError } from './harness-error.js';
import { outputLimitCode } from '../../processes/output-limit.js';
import type { ExecStepError } from './exec-model.js';
import type { ErrorKind, StepError } from './model.js';

/** Shared validation for retry filters and saved failures. @internal */
export const errorKindSchema = z.enum([
  'timeout',
  'idle-timeout',
  'rate-limit',
  'overloaded',
  'invalid-request',
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

/** The kinds the `'transient'` retry filter stands for. @internal */
export const transientErrorKinds = ['rate-limit', 'overloaded', 'timeout', 'idle-timeout'] as const;

/**
 * Whether a failure of this kind is worth retrying later: membership in
 * {@link transientErrorKinds}. A missing kind is not transient. This is the single membership test
 * behind the `'transient'` retry filter and the `retryable` flag in failure documents.
 * @internal
 */
export function isTransientErrorKind(kind: ErrorKind | null | undefined): boolean {
  if (kind === null || kind === undefined) return false;
  const transient: readonly ErrorKind[] = transientErrorKinds;
  return transient.includes(kind);
}

/**
 * Validation for one `retry.on` entry: any error kind, or the `'transient'` alias. The alias is a
 * filter, never a kind: saved failures and attempt kinds keep using {@link errorKindSchema}.
 * @internal
 */
export const retryOnSchema = z.enum([...errorKindSchema.options, 'transient']);

/**
 * Checkpoint representation of a terminal failure. The optional process fields are filled only for
 * a settled command ({@link execFailureFields}); the schema stays non-strict. @internal
 */
export const stepErrorSchema = z.object({
  message: z.string(),
  kind: errorKindSchema,
  attempts: z.number().int().positive(),
  code: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
  stdoutTail: z.string().max(1024).optional(),
  stderrTail: z.string().max(1024).optional(),
  parsed: z.json().optional(),
});

/** Classify structured metadata, never guessed substrings of user-controlled error messages. @internal */
export function errorKind(error: unknown): ErrorKind {
  if (error instanceof CancelledError) return 'cancelled';
  // Another quiet-choir copy (possibly another version) may build these; trust only known kinds.
  if (error instanceof ExecError || error instanceof HarnessError) return knownKind(error.kind);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'schema';
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'cancelled';
    if (error.name === 'TimeoutError') return 'timeout';
    // runProcess marks subprocess launch failures; any errno code there is a process failure.
    if ('phase' in error && error.phase === 'spawn') return 'process';
    const code = 'code' in error ? error.code : undefined;
    if (code === 'ETIMEDOUT') return 'timeout';
    if (code === 'QUIET_CHOIR_IDLE_TIMEOUT') return 'idle-timeout';
    if (code === 'ABORT_ERR') return 'cancelled';
    if (code === outputLimitCode) return 'output-limit';
    if (code === 'ENOENT' || code === 'EPIPE') return 'process';
  }
  return 'unknown';
}

function knownKind(kind: unknown): ErrorKind {
  const kinds: readonly unknown[] = errorKindSchema.options;
  return kinds.includes(kind) ? (kind as ErrorKind) : 'unknown';
}

/** Convert an effect failure to lossless data. @internal */
export function stepError(error: unknown, attempts: number): StepError {
  return {
    message: error instanceof Error ? error.message : String(error),
    kind: errorKind(error),
    attempts,
  };
}

/**
 * The process fields a settled command adds to its {@link StepError}: the exit code, signal and
 * bounded output tails of an {@link ExecError}, and `parsed` when `exec.json` captured it.
 * @internal
 */
export function execFailureFields(
  error: ExecError,
): Omit<ExecStepError, 'message' | 'kind' | 'attempts'> {
  const { code, signal, stdoutTail, stderrTail } = error.diagnostics;
  return {
    code,
    signal,
    stdoutTail: stdoutTail.slice(-1024),
    stderrTail: stderrTail.slice(-1024),
    ...(error.parsed === undefined ? {} : { parsed: error.parsed }),
  };
}
