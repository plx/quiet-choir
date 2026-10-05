import type { RunRecord } from './record.js';

/**
 * Every warning a run record persists, in reporting order: policy, replay, harness, worktree, then
 * wait. The runner's fresh completion, its re-read of a completed run, `workflow inspect` and the
 * compact run result all build their list here, so a source cannot be missed on one path. Any new
 * `*Warnings` record field must be added here. Invocation-only warnings (such as a lock-release
 * warning) are not persisted and stay with their callers. The list is not deduplicated or capped.
 * @internal
 */
export function recordWarnings(
  run: Pick<
    RunRecord,
    'policyWarnings' | 'replayWarnings' | 'harnessWarnings' | 'worktreeWarnings' | 'waitWarnings'
  >,
): readonly string[] {
  return [
    ...(run.policyWarnings ?? []),
    ...(run.replayWarnings ?? []),
    ...(run.harnessWarnings ?? []),
    ...(run.worktreeWarnings ?? []),
    ...(run.waitWarnings ?? []),
  ];
}
