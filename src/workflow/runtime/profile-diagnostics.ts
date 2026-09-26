import { HarnessError } from './harness-error.js';
import type { AttemptPolicy } from './model.js';

/** Add recovery guidance without mutating an adapter-owned error or losing its category/usage. @internal */
export function profileLimitError(
  error: HarnessError,
  id: string,
  profile: string,
  execution: AttemptPolicy,
): HarnessError {
  if (error.kind !== 'turn-limit' && error.kind !== 'budget-limit') return error;
  const field = error.kind === 'turn-limit' ? 'maxTurns' : 'maxBudgetUsd';
  const limit = execution.policy[field];
  const next = Math.min(
    field === 'maxTurns' ? Number.MAX_SAFE_INTEGER : Number.MAX_VALUE,
    limit === undefined ? (field === 'maxTurns' ? 60 : 5) : limit * 2,
  );
  const annotated = new HarnessError({
    provider: error.provider,
    kind: error.kind,
    exit: error.exit,
    failure: error.failure,
    reason: error.message,
    stderr: error.stderrTail,
    stdout: error.stdoutTail,
    ...(error.usage === null ? {} : { usage: error.usage }),
    sessionId: error.sessionId,
    ...(error.turns === null ? {} : { turns: error.turns }),
    ...(error.permissionDenials === null ? {} : { permissionDenials: error.permissionDenials }),
  });
  annotated.cause = error;
  annotated.message = `${error.message}; Step ${id} hit ${field}=${String(limit ?? 'unknown')} (profile ${profile}; turns=${String(error.turns ?? 'unknown')}; costUsd=${String(error.usage?.costUsd ?? 'unknown')}). Retry: --resume --profile ${profile}.${field}=${String(next)}`;
  if (execution.sources[field]?.startsWith('override:'))
    annotated.message += `; A step policy overrides this profile. Also append --policy '${JSON.stringify({ match: id, [field]: next })}'.`;
  return annotated;
}
