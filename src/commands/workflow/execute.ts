import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { Args, Flags, type Interfaces } from '@oclif/core';

import { BaseCommand } from '../../cli/base-command.js';
import { formatTypecheckDiagnostic } from '../../cli/presentation.js';
import { CliHarness } from '../../harnesses/cli.js';
import { WorkflowExecutor } from '../../workflow/loader/executor.js';
import type { JsonValue } from '../../workflow/runtime/model.js';
import { analyzeTypecheckEntrypoint } from '../../workflow/typecheck/plan.js';
import { validatePolicy, type PolicyOverride } from '../../workflow/runtime/policy.js';

interface WorkflowExecuteArgs {
  readonly file: string;
}

interface WorkflowExecuteFlags {
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

export default class WorkflowExecute extends BaseCommand {
  public static override readonly args: Interfaces.ArgInput<WorkflowExecuteArgs> = {
    file: Args.file({
      description: 'Trusted TypeScript workflow module',
      exists: true,
      required: true,
    }),
  };

  public static override readonly flags: Interfaces.FlagInput<WorkflowExecuteFlags> = {
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
      description: 'JSON workflow input; defaults to {} for new runs, saved input on resume',
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
    json: Flags.boolean({ description: 'Print the completed run record as JSON', default: false }),
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
    if (flags.resume && flags['run-id'] === undefined) {
      this.error('--resume requires --run-id.', { exit: 2 });
    }
    let policy: PolicyOverride[];
    try {
      policy = validatePolicy(
        (flags.policy ?? []).map((value) => JSON.parse(value) as unknown),
        flags['allow-model-override'] ?? false,
      );
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Invalid --policy JSON.', { exit: 2 });
    }
    const analysis = analyzeTypecheckEntrypoint(args.file, process.cwd());
    if (!analysis.ok) {
      this.error(analysis.error.message, { code: analysis.error.code, exit: 2 });
    }
    let input: JsonValue | undefined;
    if (flags.input !== undefined) {
      try {
        input = JSON.parse(flags.input) as JsonValue;
      } catch {
        this.error('--input must contain valid JSON.', { exit: 2 });
      }
    } else if (!flags.resume && !flags['fork-from']) {
      input = {};
    }
    const runId = flags['run-id'] ?? randomUUID();
    this.logToStderr(`Run ID: ${runId}`);
    const controller = new AbortController();
    const cancel = (): void => {
      controller.abort(new Error('Workflow interrupted.'));
    };
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const executor = new WorkflowExecutor({
        logger: this.createExecutionLogger(flags),
        harness: new CliHarness(),
        signal: controller.signal,
      });
      const result = await executor.execute({
        kind: 'workflow.execute',
        typecheck: analysis.plan,
        runId,
        stateDir: resolve(flags['state-dir']),
        cwd: process.cwd(),
        resume: flags.resume ?? false,
        policy,
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
        this.error(result.message, { exit: controller.signal.aborted ? 130 : 1 });
      }
      if (result.kind === 'workflow.run.result') {
        for (const warning of result.run.warnings ?? []) this.logToStderr(`Warning: ${warning}`);
        this.log(
          flags.json
            ? JSON.stringify(result.run)
            : `Run ${result.run.id} ${result.run.status}.\n${JSON.stringify(result.run.output, null, 2)}`,
        );
      }
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  }
}
