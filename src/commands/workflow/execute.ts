import { readWorkflowInput } from '../../cli/input.js';
import { parseAgentLimits } from '../../workflow/loader/agent-limits.js';
import type { AgentLimits } from '../../workflow/runtime/agent-limiter.js';
import { parseProfileOverride } from '../../workflow/runtime/profiles.js';
import type { ProfileOverride } from '../../workflow/runtime/profiles-model.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { Args, Flags, type Interfaces } from '@oclif/core';

import { WorkflowCommand } from '../../cli/workflow-command.js';
import { formatTypecheckDiagnostic } from '../../cli/presentation.js';
import {
  readHarnessSelection,
  type HarnessSelection,
} from '../../workflow/loader/harness-selection.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import type { JsonValue } from '../../workflow/runtime/model.js';
import { validatePolicy, type PolicyOverride } from '../../workflow/runtime/policy.js';

interface WorkflowExecuteArgs {
  readonly file: string;
}

interface WorkflowExecuteFlags {
  readonly harness: string;
  readonly 'harness-config': string | undefined;
  readonly 'dry-run': boolean | undefined;
  readonly 'stub-steps': string[] | undefined;
  readonly 'allow-harness-change': boolean | undefined;
  readonly 'kill-orphans': boolean | undefined;
  readonly 'kill-grace-ms': string | undefined;
  readonly 'max-agents': string | undefined;
  readonly 'provider-limit': string[] | undefined;
  profile: string[] | undefined;
  grant: string[] | undefined;
  readonly input: string | undefined;
  readonly 'run-id': string | undefined;
  readonly resume: boolean | undefined;
  readonly 'state-dir': string;
  readonly json: boolean | undefined;
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

export default class WorkflowExecute extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<WorkflowExecuteArgs> = {
    file: Args.string({
      description: 'Trusted TypeScript workflow module',
      required: true,
    }),
  };

  public static override readonly flags: Interfaces.FlagInput<WorkflowExecuteFlags> = {
    harness: Flags.string({ description: 'cli or fixture:<JSON file>', default: 'cli' }),
    'harness-config': Flags.string({
      description: 'CliHarness configuration JSON or @file; paths resolve against cwd',
    }),
    'dry-run': Flags.boolean({
      description:
        'Rehearse with synthesized/fixture agent outputs and temporary checkpoints; local callbacks run for real',
    }),
    'stub-steps': Flags.string({
      description: 'Synthesize selected local steps by ID glob; repeatable',
      multiple: true,
      dependsOn: ['dry-run'],
    }),
    'allow-harness-change': Flags.boolean({
      description: 'Accept replaying outputs from a different recorded harness kind',
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
    'provider-limit': Flags.string({
      description: 'Additional provider ceiling, e.g. codex=1; repeatable, later rules win',
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
      description: 'Accept and record source/schema changes; keep step checks',
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
      description: 'Local durable run storage',
      default: '.quiet-choir/runs',
    }),
    json: Flags.boolean({
      description: 'Print the run record or structured error as JSON',
      default: false,
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

  public static override readonly summary =
    'Execute or resume a typed workflow with durable checkpoints';

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(WorkflowExecute);
    const runId = flags['run-id'] ?? randomUUID();
    this.runContext(runId, flags['state-dir']);
    if (flags['fork-from'] !== undefined) this.validateRunId(flags['fork-from']);
    if (flags.resume && flags['run-id'] === undefined)
      this.fail('usage.resume_requires_run_id', '--resume requires --run-id.');
    let agentLimits: AgentLimits;
    let killGraceMs: number;
    let policy: PolicyOverride[];
    let profileOverrides: ProfileOverride[];
    let harness: HarnessSelection;
    try {
      killGraceMs = flags['kill-grace-ms'] === undefined ? 3000 : Number(flags['kill-grace-ms']);
      if (
        !/^[1-9][0-9]*$/u.test(String(flags['kill-grace-ms'] ?? 3000)) ||
        !Number.isSafeInteger(killGraceMs) ||
        killGraceMs > 2_147_483_647
      )
        throw new Error('--kill-grace-ms must be an integer from 1 to 2147483647.');
      harness = await readHarnessSelection(
        flags.harness,
        flags['harness-config'],
        process.cwd(),
        flags['kill-grace-ms'] === undefined ? undefined : killGraceMs,
      );
      killGraceMs = harness.config.killGraceMs ?? killGraceMs;
      if (harness.kind === 'fixture' && flags['harness-config'] !== undefined && !flags['dry-run'])
        throw new Error(
          '--harness-config configures CLI execution or the --dry-run planner; fixture execution takes its configuration from the fixture file.',
        );
      agentLimits = parseAgentLimits(flags['max-agents'], flags['provider-limit'] ?? []);
      profileOverrides = (flags.profile ?? []).map(parseProfileOverride);
      policy = validatePolicy(
        (flags.policy ?? []).map((value) => JSON.parse(value) as unknown),
        flags['allow-model-override'] ?? false,
      );
    } catch (error) {
      this.fail('usage.flag', error instanceof Error ? error.message : 'Invalid --policy JSON.');
    }
    const typecheck = await this.entrypoint(args.file);
    let input: JsonValue | undefined;
    if (flags.input !== undefined) input = await readWorkflowInput(flags.input, this.signal);
    else if (!flags.resume && !flags['fork-from']) input = {};
    this.logToStderr(`Run ID: ${runId}`);
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      processSupervisor: this.processSupervisor,
      signal: this.signal,
    });
    const result = await executor.execute({
      kind: 'workflow.execute',
      harness,
      dryRun: flags['dry-run'] ?? false,
      stubSteps: flags['stub-steps'] ?? [],
      allowHarnessChange: flags['allow-harness-change'] ?? false,
      agentLimits,
      killGraceMs,
      ...(flags['kill-orphans'] === undefined ? {} : { killOrphans: flags['kill-orphans'] }),
      typecheck,
      runId,
      stateDir: resolve(flags['state-dir']),
      cwd: process.cwd(),
      resume: flags.resume ?? false,
      policy,
      profileOverrides,
      grants: flags.grant ?? [],
      ...(flags['fork-from'] === undefined
        ? {}
        : {
            forkFrom: {
              runId: flags['fork-from'],
              ...(flags['fork-state-dir'] === undefined
                ? {}
                : { stateDir: resolve(flags['fork-state-dir']) }),
              ...(flags.reuse === undefined ? {} : { reuse: flags.reuse }),
              ...(flags.invalidate === undefined ? {} : { invalidate: flags.invalidate }),
            },
          }),
      ...(flags['accept-code-change'] === undefined
        ? {}
        : { acceptCodeChange: flags['accept-code-change'] }),
      ...(flags['strict-replay'] === undefined ? {} : { strictReplay: flags['strict-replay'] }),
      ...(flags['policy-reset'] === undefined ? {} : { policyReset: flags['policy-reset'] }),
      ...(flags['allow-model-override'] === undefined
        ? {}
        : { allowModelOverride: flags['allow-model-override'] }),
      ...(input === undefined ? {} : { input }),
    });
    if (!result.ok) {
      for (const diagnostic of result.diagnostics) {
        this.logToStderr(formatTypecheckDiagnostic(diagnostic, process.cwd()));
      }
      this.failResult(result);
    }
    if (result.kind === 'workflow.run.result') {
      for (const warning of result.rehearsal?.warnings ?? [])
        this.logToStderr(`Warning: ${warning}`);
      if (result.rehearsal)
        this.logToStderr(
          `Rehearsal: ${String(result.rehearsal.calls.length)} calls; nominal Claude ceiling $${String(result.rehearsal.nominalClaudeCeilingUsd)}; ${String(result.rehearsal.replays.length)} replayed effects.`,
        );
      for (const warning of result.run.warnings ?? []) this.logToStderr(`Warning: ${warning}`);
      if (result.run.status === 'suspended') {
        this.suspended(result.run, result.rehearsal);
        return;
      }
      this.outputSavedCompletion(
        result.rehearsal === undefined
          ? result.run
          : { ...result.rehearsal, ok: true, run: result.run },
        `Run ${result.run.id} ${result.run.status}.\n${JSON.stringify(result.run.output, null, 2)}`,
      );
    }
  }
}
