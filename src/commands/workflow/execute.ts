import { parseRunBudget } from '../../cli/run-budget.js';
import { executeFlags, worktreePlan, type WorkflowExecuteFlags } from '../../cli/execute-flags.js';
import { existsSync } from 'node:fs';
import type { RunBudgetPolicy } from '../../workflow/runtime/run-budget.js';
import { readWorkflowInput } from '../../cli/input.js';
import { parseAgentLimits } from '../../workflow/loader/agent-limits.js';
import type { AgentLimits } from '../../workflow/runtime/agent-limiter.js';
import { parseProfileOverride } from '../../workflow/runtime/profiles.js';
import type { ProfileOverride } from '../../workflow/runtime/profiles-model.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { Args, type Interfaces } from '@oclif/core';

import { WorkflowCommand } from '../../cli/workflow-command.js';
import { requestedFull } from '../../cli/workflow-errors.js';
import { formatWorkflowDiagnostic } from '../../cli/presentation.js';
import {
  readHarnessSelection,
  type HarnessSelection,
} from '../../workflow/loader/harness-selection.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import type { RehearsalReport } from '../../workflow/loader/rehearsal.js';
import type { JsonValue } from '../../workflow/runtime/model.js';
import { validatePolicy, type PolicyOverride } from '../../workflow/runtime/policy.js';

interface WorkflowExecuteArgs {
  readonly file: string | undefined;
}

export default class WorkflowExecute extends WorkflowCommand {
  public static override readonly args: Interfaces.ArgInput<WorkflowExecuteArgs> = {
    file: Args.string({
      description: 'Trusted TypeScript workflow module',
    }),
  };

  public static override readonly flags: Interfaces.FlagInput<WorkflowExecuteFlags> = executeFlags;

  public static override readonly summary =
    'Execute or resume a typed workflow with durable checkpoints';

  protected override compactRunDocuments(): boolean {
    return !requestedFull(this.argv);
  }

  public async run(): Promise<void> {
    this.refuseEventsStdoutWithJson();
    const { args, flags } = await this.parse(WorkflowExecute);
    const runId = flags['run-id'] ?? randomUUID();
    const stateDir = this.runContext(runId, flags['state-dir']);
    if (flags['fork-from'] !== undefined) this.validateRunId(flags['fork-from']);
    if (flags.resume && flags['run-id'] === undefined)
      this.fail('usage.resume_requires_run_id', '--resume requires --run-id.');
    let runBudget: Partial<RunBudgetPolicy>;
    let agentLimits: AgentLimits;
    let killGraceMs: number;
    let policy: PolicyOverride[];
    let profileOverrides: ProfileOverride[];
    let harness: HarnessSelection;
    let worktrees: ReturnType<typeof worktreePlan>;
    try {
      worktrees = worktreePlan(flags['worktree-keep'], flags['worktree-root'], process.cwd());
      runBudget = parseRunBudget(flags['max-run-cost-usd'], flags['max-run-agent-attempts']);
      killGraceMs = flags['kill-grace-ms'] === undefined ? 3000 : Number(flags['kill-grace-ms']);
      if (
        !/^[1-9][0-9]*$/u.test(String(flags['kill-grace-ms'] ?? 3000)) ||
        !Number.isSafeInteger(killGraceMs) ||
        killGraceMs > 2_147_483_647
      )
        throw new Error('--kill-grace-ms must be an integer from 1 to 2147483647.');
      harness = await readHarnessSelection(
        flags.harness ?? 'cli',
        flags['harness-config'],
        process.cwd(),
        flags['kill-grace-ms'] === undefined ? undefined : killGraceMs,
      );
      killGraceMs = harness.config.killGraceMs ?? killGraceMs;
      if (harness.kind === 'fixture' && flags['harness-config'] !== undefined && !flags['dry-run'])
        throw new Error(
          '--harness-config configures CLI execution or the --dry-run planner; fixture execution takes its configuration from the fixture file.',
        );
      agentLimits = parseAgentLimits(flags['max-agents'], flags['harness-limit'] ?? []);
      profileOverrides = (flags.profile ?? []).map(parseProfileOverride);
      policy = validatePolicy(
        (flags.policy ?? []).map((value) => JSON.parse(value) as unknown),
        flags['allow-model-override'] ?? false,
      );
      const streamPolicy: Record<string, unknown> = {};
      for (const [flag, key] of [
        ['max-retained-bytes', 'maxRetainedBytes'],
        ['max-stream-bytes', 'maxStreamBytes'],
        ['max-transcript-bytes', 'maxTranscriptBytes'],
      ] as const) {
        const value = flags[flag];
        if (value === undefined) continue;
        if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`--${flag} must be a positive integer.`);
        streamPolicy[key] = Number(value);
      }
      if (flags.transcripts !== undefined) streamPolicy['transcripts'] = flags.transcripts;
      if (Object.keys(streamPolicy).length) policy.push(...validatePolicy([streamPolicy], false));
    } catch (error) {
      this.fail('usage.flag', error instanceof Error ? error.message : 'Invalid --policy JSON.');
    }
    if (args.file === undefined && !flags.resume)
      this.fail('usage.flag', 'A workflow file is required unless --resume --run-id is used.');
    const useRegistry =
      args.file !== undefined &&
      ((flags['registry-dir']?.length ?? 0) > 0 ||
        (!existsSync(args.file) && !/[\\/]|\.(?:ts|tsx|mts|cts)$/iu.test(args.file)));
    const launch =
      args.file === undefined
        ? { kind: 'workflow.resume' as const }
        : useRegistry
          ? {
              kind: 'workflow.execute-name' as const,
              name: args.file,
              directories: (flags['registry-dir']?.length ? flags['registry-dir'] : ['.']).map(
                (path) => resolve(path),
              ),
              cwd: process.cwd(),
              resume: flags.resume ?? false,
            }
          : {
              kind: 'workflow.execute' as const,
              typecheck: await this.entrypoint(args.file),
              cwd: process.cwd(),
              resume: flags.resume ?? false,
            };
    let input: JsonValue | undefined;
    if (flags.input !== undefined) input = await readWorkflowInput(flags.input, this.signal);
    else if (!flags.resume && !flags['fork-from']) input = {};
    this.logToStderr(`Run ID: ${runId}\nState directory: ${stateDir}`);
    const events = this.eventsOptions(flags.events);
    const executor = new WorkflowExecutor({
      logger: this.createExecutionLogger(flags),
      commandLauncher: this.commandLauncher,
      processSupervisor: this.processSupervisor,
      signal: this.signal,
      ...events.executor,
    });
    const result = await executor.execute({
      ...launch,
      ...(flags['max-child-depth'] === undefined
        ? {}
        : { maxChildDepth: flags['max-child-depth'] }),
      ...(flags.progress === undefined ? {} : { progress: flags.progress }),
      ...(flags['notify-command'] === undefined ? {} : { notifyCommand: flags['notify-command'] }),
      ...events.plan,
      ...(flags['wait-mode'] === undefined ? {} : { waitMode: flags['wait-mode'] }),
      ...worktrees,
      harness,
      ...(flags.resume ? { inheritHarness: flags.harness === undefined } : {}),
      dryRun: flags['dry-run'] ?? false,
      stubSteps: flags['stub-steps'] ?? [],
      allowHarnessChange: flags['allow-harness-change'] ?? false,
      allowHarnessConfigChange: flags['allow-harness-config-change'] ?? false,
      agentLimits,
      ...runBudget,
      killGraceMs,
      ...(flags['kill-orphans'] === undefined ? {} : { killOrphans: flags['kill-orphans'] }),
      runId,
      stateDir: stateDir,
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
        this.logToStderr(formatWorkflowDiagnostic(diagnostic, process.cwd()));
      }
      if (result.rehearsal) this.rehearsalSummary(result.rehearsal);
      this.failResult(result);
    }
    if (result.kind === 'workflow.run.result') {
      if (result.rehearsal) this.rehearsalSummary(result.rehearsal);
      for (const warning of result.run.warnings ?? []) this.logToStderr(`Warning: ${warning}`);
      if (result.run.status === 'suspended') {
        this.suspended(result.run, result.rehearsal);
        return;
      }
      this.outputSavedCompletion(
        result.rehearsal === undefined
          ? this.runResult(result.run, stateDir)
          : { ...result.rehearsal, ok: true, run: result.run },
        `Run ${result.run.id} ${result.run.status}.\n${JSON.stringify(result.run.output, null, 2)}`,
      );
    }
  }

  /** Print a rehearsal's warnings and one-line summary to stderr, on success and failure alike. */
  private rehearsalSummary(report: RehearsalReport): void {
    for (const warning of report.warnings) this.logToStderr(`Warning: ${warning}`);
    const commands = (source: 'synthesized' | 'fixture' | 'live'): string =>
      String(report.commands.filter((entry) => entry.outputSource === source).length);
    const live = commands('live');
    const isolated = report.calls.filter((call) => call.worktree?.synthesized).length;
    this.logToStderr(
      `Rehearsal: ${String(report.calls.length)} calls; ${commands('synthesized')} synthesized and ${commands('fixture')} fixture commands${live === '0' ? '' : `; ${live} live observer commands`}; nominal Claude ceiling $${String(report.nominalClaudeCeilingUsd)}; ${String(report.replays.length)} replayed effects${isolated > 0 ? `; ${String(isolated)} synthesized isolated calls` : ''}${report.merges.length > 0 ? `; ${String(report.merges.length)} synthesized merges` : ''}.`,
    );
  }
}
