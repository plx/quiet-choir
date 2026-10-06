// An import-free leaf, so defineHarness and the profile resolver read one list without a cycle.

/**
 * Registered-harness options that a profile's `harnesses.<name>` block cannot set: the prompt and
 * profile selection, per-call placement and error handling, and limits that profiles declare as
 * profile limits instead. Such a key never reaches a capability manifest. @internal
 */
export const profileForbiddenHarnessOptions: readonly string[] = Object.freeze([
  'prompt',
  'profile',
  'cwd',
  'onError',
  'retry',
  'worktree',
  'timeoutMs',
  'idleTimeoutMs',
  'maxTurns',
  'maxBudgetUsd',
]);
