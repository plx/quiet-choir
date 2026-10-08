import { attachHarnessEvidence, HarnessError, harnessEvidence } from './harness-error.js';
import type { AttemptPolicy } from './model.js';
import { errorKind } from './step-error.js';

/** Copy an adapter-owned error so a hint can be added without mutating the original. */
function cloneHarnessError(error: HarnessError): HarnessError {
  const annotated = new HarnessError({
    harness: error.harness,
    kind: error.kind,
    exit: error.exit,
    failure: error.failure,
    reason: error.message,
    stderr: error.stderrTail,
    stdout: error.stdoutTail,
    ...(error.usage === null ? {} : { usage: error.usage }),
    sessionId: error.sessionId,
    diagnostics: error.diagnostics,
    rawText: error.rawText,
    responseTruncated: error.responseTruncated,
    ...(error.turns === null ? {} : { turns: error.turns }),
    ...(error.permissionDenials === null ? {} : { permissionDenials: error.permissionDenials }),
  });
  annotated.cause = error;
  return annotated;
}

/**
 * Add recovery guidance without mutating an adapter-owned error or losing its category/usage. A
 * message that already carries this step's hint (a fixture rule exported from an annotated failure)
 * is returned unchanged, so a replay records the same message instead of a second hint. @internal
 */
export function profileLimitError(
  error: HarnessError,
  id: string,
  profile: string,
  execution: AttemptPolicy,
): HarnessError {
  if (error.kind !== 'turn-limit' && error.kind !== 'budget-limit') return error;
  const field = error.kind === 'turn-limit' ? 'maxTurns' : 'maxBudgetUsd';
  if (error.message.includes(`Step ${id} hit ${field}=`)) return error;
  const limit = execution.policy[field];
  const next = Math.min(
    field === 'maxTurns' ? Number.MAX_SAFE_INTEGER : Number.MAX_VALUE,
    limit === undefined ? (field === 'maxTurns' ? 60 : 5) : limit * 2,
  );
  const annotated = cloneHarnessError(error);
  annotated.message = `${error.message}; Step ${id} hit ${field}=${String(limit ?? 'unknown')} (profile ${profile}; turns=${String(error.turns ?? 'unknown')}; costUsd=${String(error.usage?.costUsd ?? 'unknown')}). Retry: --resume --profile ${profile}.${field}=${String(next)}`;
  if (execution.sources[field]?.startsWith('override:'))
    annotated.message += `; A step policy overrides this profile. Also append --policy '${JSON.stringify({ match: id, [field]: next })}'.`;
  return annotated;
}

/**
 * Add the idle-deadline recovery hint to an `idle-timeout` failure, mirroring
 * {@link profileLimitError}. The adapter's error is not mutated: a plain process error is replaced
 * by a new error with the same code and harness evidence, and a {@link HarnessError} keeps its kind.
 * A message that already carries this step's hint is returned unchanged, as in
 * {@link profileLimitError}.
 * @internal
 */
export function idleTimeoutError(
  error: unknown,
  id: string,
  profile: string,
  execution: AttemptPolicy,
): unknown {
  if (errorKind(error) !== 'idle-timeout' || !(error instanceof Error)) return error;
  if (error.message.includes(`Step ${id} produced no output for idleTimeoutMs=`)) return error;
  const limit = execution.policy.idleTimeoutMs;
  const next = limit === undefined ? 120_000 : Math.min(2_147_483_647, limit * 2);
  let hint = `Step ${id} produced no output for idleTimeoutMs=${String(limit ?? 'unknown')} (profile ${profile}). Retry: --resume --profile ${profile}.idleTimeoutMs=${String(next)}`;
  if (execution.sources['idleTimeoutMs']?.startsWith('override:'))
    hint += `; A step policy overrides this profile. Also append --policy '${JSON.stringify({ match: id, idleTimeoutMs: next })}'.`;
  if (error instanceof HarnessError) {
    const annotated = cloneHarnessError(error);
    annotated.message = `${error.message}; ${hint}`;
    return annotated;
  }
  const annotated = Object.assign(new Error(`${error.message}; ${hint}`, { cause: error }), {
    code: 'QUIET_CHOIR_IDLE_TIMEOUT',
  });
  const evidence = harnessEvidence(error);
  if (evidence) attachHarnessEvidence(annotated, evidence);
  return annotated;
}
