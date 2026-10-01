import { Flags, type Interfaces } from '@oclif/core';
import { runBudgetFlags } from './run-budget.js';

/** Parsed flags of `workflow execute`, shared with `workflow start`. @internal */
export interface WorkflowExecuteFlags {
  readonly 'max-child-depth': number | undefined;
  readonly 'registry-dir': string[] | undefined;
  readonly 'max-run-cost-usd': string | undefined;
  readonly 'max-run-agent-attempts': string | undefined;
  readonly progress: boolean | undefined;
  readonly transcripts: 'on' | 'on-failure' | 'off' | undefined;
  readonly 'max-retained-bytes': string | undefined;
  readonly 'max-stream-bytes': string | undefined;
  readonly 'max-transcript-bytes': string | undefined;
  readonly 'notify-command': string | undefined;
  readonly 'wait-mode': 'suspend' | 'block' | undefined;
  readonly harness: string[] | undefined;
  readonly 'harness-config': string | undefined;
  readonly 'dry-run': boolean | undefined;
  readonly 'stub-steps': string[] | undefined;
  readonly 'allow-harness-change': boolean | undefined;
  readonly 'allow-harness-config-change': boolean | undefined;
  readonly 'kill-orphans': boolean | undefined;
  readonly 'kill-grace-ms': string | undefined;
  readonly 'max-agents': string | undefined;
  readonly 'harness-limit': string[] | undefined;
  profile: string[] | undefined;
  grant: string[] | undefined;
  readonly input: string | undefined;
  readonly 'run-id': string | undefined;
  readonly resume: boolean | undefined;
  readonly 'state-dir': string | undefined;
  readonly json: boolean | undefined;
  readonly full: boolean | undefined;
  readonly policy: string[] | undefined;
  readonly 'policy-reset': boolean | undefined;
  readonly 'allow-model-override': boolean | undefined;
  readonly 'fork-from': string | undefined;
  readonly 'fork-state-dir': string | undefined;
  readonly reuse: 'prefix' | 'matching' | undefined;
  readonly invalidate: string[] | undefined;
  readonly 'accept-code-change': boolean | undefined;
  readonly 'strict-replay': boolean | undefined;
}

/**
 * The flag table of `workflow execute`. `workflow start` reuses it (without the flags that do not
 * create a new persisted run), and its child-argv builder reads it to tell value-taking flags from
 * booleans, so a new execute flag reaches both commands. @internal
 */
export const executeFlags: Interfaces.FlagInput<WorkflowExecuteFlags> = {
  'max-child-depth': Flags.integer({
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    description: 'Sticky inline child depth limit; default 8, root depth 0',
  }),
  'registry-dir': Flags.string({
    multiple: true,
    description:
      'Trusted directory to search; when given, the workflow argument is always resolved as a registered name, not a file path',
  }),
  ...runBudgetFlags,
  progress: Flags.boolean({ description: 'Print bounded live agent activity to stderr' }),
  transcripts: Flags.option({ options: ['on', 'on-failure', 'off'] as const })({
    description: 'Agent transcript retention; default on, saved across resumes',
  }),
  'max-retained-bytes': Flags.string({
    description: 'Agent parser state and single-line cap; default 8 MiB, saved across resumes',
  }),
  'max-stream-bytes': Flags.string({
    description: 'Agent raw stdout/stderr safety cap; default 1 GiB, saved across resumes',
  }),
  'max-transcript-bytes': Flags.string({
    description:
      'Agent transcript file cap; default 64 MiB, minimum 128 bytes, saved across resumes',
  }),
  'notify-command': Flags.string({
    description: 'Best-effort sh -c hook receiving event JSON on stdin',
    env: 'QUIET_CHOIR_NOTIFY_COMMAND',
  }),

  'wait-mode': Flags.option({ options: ['suspend', 'block'] as const })({
    description:
      'Suspend long waits (default) or keep waiting in this process; saved, and reused by a resume without it',
  }),
  harness: Flags.string({
    description:
      "cli (default), fixture:<file>, or name=fixture:<file>; repeatable. Saved; --resume without it reuses the run's selection",
    multiple: true,
  }),
  'harness-config': Flags.string({
    env: 'QUIET_CHOIR_HARNESS_CONFIG',
    description:
      'Adapter configuration JSON or @file (harnesses.<name> for packages); paths resolve against cwd',
  }),
  'dry-run': Flags.boolean({
    description:
      'Rehearse with synthesized/fixture agent outputs and temporary checkpoints; local callbacks run for real',
  }),
  'stub-steps': Flags.string({
    description:
      'Synthesize selected local steps, file effects and poll waits by ID glob; repeatable',
    multiple: true,
    dependsOn: ['dry-run'],
  }),
  'allow-harness-change': Flags.boolean({
    description: 'Accept replaying outputs from a different recorded harness kind',
  }),
  'allow-harness-config-change': Flags.boolean({
    description: 'Accept a --harness-config different from the one the run last executed with',
  }),
  'kill-orphans': Flags.boolean({
    description: 'Before resume, stop identity-confirmed processes left by a dead owner',
    dependsOn: ['resume'],
  }),
  'kill-grace-ms': Flags.string({
    description:
      'SIGTERM grace before SIGKILL for calls and orphan recovery, in milliseconds (default 3000)',
  }),
  'max-agents': Flags.string({
    description: 'Max concurrent live agents across the run; default min(8, max(1, CPUs - 2))',
  }),
  'harness-limit': Flags.string({
    aliases: ['provider-limit'],
    description: 'Additional harness ceiling, e.g. codex=1; repeatable, later rules win',
    multiple: true,
  }),
  'fork-from': Flags.string({
    description: 'Source run for a new run with completed-effect reuse',
    exclusive: ['resume', 'accept-code-change'],
  }),
  'fork-state-dir': Flags.directory({
    description: 'Source checkpoint directory; defaults to --state-dir',
    dependsOn: ['fork-from'],
  }),
  reuse: Flags.option({ options: ['prefix', 'matching'] as const })({
    description: 'Fork reuse mode; default prefix',
    dependsOn: ['fork-from'],
  }),
  invalidate: Flags.string({
    description: 'Fork step-ID glob forced live; repeat for more globs',
    multiple: true,
    dependsOn: ['fork-from'],
  }),
  'accept-code-change': Flags.boolean({
    description:
      'Accept and record source/schema changes; keep step checks. Refuses without changes when a completed step changed; preview with --dry-run',
    dependsOn: ['resume'],
  }),
  'strict-replay': Flags.boolean({
    description: 'Fail before live work that skips earlier completed steps',
  }),
  input: Flags.string({
    description:
      'JSON input, @file, or - for stdin; defaults to {} for new runs, saved input on resume',
  }),
  'run-id': Flags.string({ description: 'Run identifier; generated for new runs' }),
  resume: Flags.boolean({
    description: 'Replay an existing run using its completed checkpoints',
    default: false,
  }),
  'state-dir': Flags.directory({
    description:
      'Runs container; defaults to environment, legacy run discovery, then project XDG state',
  }),
  json: Flags.boolean({
    description: 'Print the run result or structured error as JSON; --full for the whole record',
    default: false,
  }),
  full: Flags.boolean({
    description: 'With --json, print the full run record instead of the compact result',
  }),
  profile: Flags.string({
    description: 'Named limit override, e.g. scout.maxTurns=50; repeatable and sticky on resume',
    multiple: true,
  }),
  grant: Flags.string({
    description: 'Authorize an elevated profile, write/exec class, or all; saved across resumes',
    multiple: true,
  }),
  policy: Flags.string({
    description: 'JSON policy override; repeat for ordered rules, saved across resumes',
    multiple: true,
  }),
  'policy-reset': Flags.boolean({
    description: 'Clear saved policy overrides before applying new rules',
  }),
  'allow-model-override': Flags.boolean({
    description: 'Authorize model/effort overrides for unfinished calls',
  }),
};
