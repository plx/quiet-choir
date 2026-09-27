import { jsonValue } from '../runtime/json.js';
import { inspectRun, listRuns, watchRun, type RunInspection } from './inspection.js';
import { workflowFailure } from './failure.js';
import { readRequiredRun } from '../runtime/read-required-run.js';
import {
  isValidRunId,
  runIdMessage,
  RunRefusedError,
  WorkflowInputError,
  WorkflowRunError,
  type CliErrorCode,
} from '../runtime/run-errors.js';
import { defaultAgentLimits, validateAgentLimits } from '../runtime/agent-limiter.js';
import type { ProcessSupervisor } from '../../processes/supervisor.js';
import { capabilityManifest } from '../runtime/profiles.js';
import { randomUUID } from 'node:crypto';

import { tsImport } from 'tsx/esm/api';
import { register as registerCommonJs } from 'tsx/cjs/api';
import ts from 'typescript';
import { z } from 'zod';

import type { ExecutionLogger, Executor } from '../../application/execution.js';
import type { Harness, WorkflowDefinition } from '../runtime/model.js';
import { runWorkflow } from '../runtime/runner.js';
import { resolveStateDir } from '../runtime/paths.js';
import { CheckpointError } from '../runtime/checkpoint.js';
import { readRun } from '../runtime/store.js';
import { TypeScriptExecutor } from '../typecheck/typescript-executor.js';
import { fingerprintSources } from './source.js';
import { canonicalCwd, compareResume, workflowSnapshot } from '../runtime/compatibility.js';
import type {
  ExecuteWorkflowPlan,
  CheckResumePlan,
  InspectWorkflowPlan,
  WatchWorkflowPlan,
  ListWorkflowsPlan,
  ValidateWorkflowPlan,
  WorkflowCommandResult,
} from './model.js';

/** Explicit live dependencies, kept outside serializable command plans. */
export interface WorkflowExecutorOptions {
  readonly logger: ExecutionLogger;
  readonly harness?: Harness;
  readonly signal?: AbortSignal;
  readonly processSupervisor?: ProcessSupervisor;
  readonly onInspection?: (value: RunInspection) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): boolean {
  return value instanceof z.ZodType;
}

function workflowDefinition(module: unknown): WorkflowDefinition<unknown, unknown> {
  const definition: unknown = isRecord(module) ? module['default'] : undefined;
  if (!isRecord(definition))
    throw new Error(
      'Workflow must default-export a defineWorkflow({ name, version, input, output, run }) definition.',
    );
  for (const field of ['name', 'version']) {
    if (typeof definition[field] !== 'string' || !definition[field].trim())
      throw new Error(`Workflow "${field}" must be a nonempty string.`);
  }
  if (typeof definition['run'] !== 'function')
    throw new Error('Workflow "run" must be a function.');
  for (const field of ['input', 'output']) {
    if (!isSchema(definition[field]))
      throw new Error(
        `Workflow "${field}" is not a zod 4 schema (zod/v3 and zod/mini are unsupported; import { z } from 'quiet-choir').`,
      );
  }
  return definition as unknown as WorkflowDefinition<unknown, unknown>;
}

/** Type-check, import, and optionally run trusted workflow code behind a plain-data boundary. */
export class WorkflowExecutor implements Executor<
  | ValidateWorkflowPlan
  | ExecuteWorkflowPlan
  | InspectWorkflowPlan
  | CheckResumePlan
  | WatchWorkflowPlan
  | ListWorkflowsPlan,
  WorkflowCommandResult
> {
  readonly #options: WorkflowExecutorOptions;

  public constructor(options: WorkflowExecutorOptions) {
    this.#options = options;
  }

  public async execute(
    plan:
      | ValidateWorkflowPlan
      | ExecuteWorkflowPlan
      | InspectWorkflowPlan
      | CheckResumePlan
      | WatchWorkflowPlan
      | ListWorkflowsPlan,
  ): Promise<WorkflowCommandResult> {
    let unregister: (() => void) | undefined;
    let stage: CliErrorCode = 'load.typecheck';
    const context =
      'runId' in plan
        ? { runId: plan.runId, stateDir: resolveStateDir({ stateDir: plan.stateDir }) }
        : {
            runId: null,
            stateDir: 'stateDir' in plan ? resolveStateDir({ stateDir: plan.stateDir }) : null,
          };
    try {
      if ('runId' in plan && !isValidRunId(plan.runId))
        return workflowFailure('usage.run_id', runIdMessage, context);
      if (plan.kind === 'workflow.execute' && plan.forkFrom && !isValidRunId(plan.forkFrom.runId))
        return workflowFailure('usage.run_id', runIdMessage, context);
      if (plan.kind === 'workflow.list') {
        stage = 'run.unreadable';
        return { kind: 'workflow.list.result', ok: true, ...(await listRuns(plan)) };
      }
      if (plan.kind === 'workflow.inspect' || plan.kind === 'workflow.watch') {
        stage = 'run.unreadable';
        const inspection =
          plan.kind === 'workflow.watch'
            ? await watchRun(
                plan,
                this.#options.onInspection ?? (() => undefined),
                this.#options.signal,
              )
            : await inspectRun(plan);
        return {
          kind: 'workflow.run.result',
          ok: true,
          ...inspection,
        };
      }
      stage = 'usage.flag';
      const agentLimits =
        plan.kind === 'workflow.execute'
          ? validateAgentLimits(plan.agentLimits ?? defaultAgentLimits())
          : undefined;
      if (agentLimits)
        this.#options.logger.log(
          'info',
          `Agent limits: total=${String(agentLimits.total)}; per-provider=${JSON.stringify(agentLimits.perProvider ?? {})}`,
        );
      stage = 'load.typecheck';
      const checked = await new TypeScriptExecutor(this.#options.logger).execute(plan.typecheck);
      if (!checked.ok)
        return workflowFailure('load.typecheck', 'Workflow type check failed.', {
          ...context,
          run:
            context.runId && context.stateDir
              ? await readRun({ runId: context.runId, stateDir: context.stateDir }).catch(
                  () => null,
                )
              : null,
          diagnostics: checked.diagnostics,
        });
      this.#options.signal?.throwIfAborted();
      stage = 'load.import';
      const source = await fingerprintSources(plan.typecheck, checked.sourceFiles);
      this.#options.logger.log(
        'debug',
        `Importing trusted workflow module ${plan.typecheck.entrypoint}`,
      );
      const format = ts.getImpliedNodeFormatForFile(plan.typecheck.entrypoint, undefined, ts.sys, {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      });
      let module: unknown;
      if (format === ts.ModuleKind.CommonJS) {
        const registered = registerCommonJs({ namespace: randomUUID() });
        unregister = registered.unregister;
        module = registered.require(plan.typecheck.entrypoint, import.meta.url);
      } else {
        module = await tsImport(plan.typecheck.entrypoint, {
          parentURL: import.meta.url,
          ...(plan.typecheck.configuration.kind === 'tsconfig'
            ? { tsconfig: plan.typecheck.configuration.path }
            : {}),
        });
      }
      this.#options.signal?.throwIfAborted();
      stage = 'load.definition';
      const definition = workflowDefinition(module);
      z.toJSONSchema(definition.input, { target: 'draft-7' });
      z.toJSONSchema(definition.output, { target: 'draft-7' });
      if (plan.kind === 'workflow.validate') {
        return {
          kind: 'workflow.validate.result',
          ok: true,
          entrypoint: plan.typecheck.entrypoint,
          workflow: {
            name: definition.name,
            version: definition.version,
            ...workflowSnapshot(definition, { source }),
            capabilities: capabilityManifest(definition),
          },
        };
      }
      if (plan.kind === 'workflow.check-resume') {
        const run = await readRequiredRun({ runId: plan.runId, stateDir: plan.stateDir });
        const check = compareResume(
          definition,
          {
            source,
            ...(plan.acceptCodeChange === undefined
              ? {}
              : { acceptCodeChange: plan.acceptCodeChange }),
          },
          await canonicalCwd(plan.cwd),
          run,
        );
        if (!check.compatible)
          return workflowFailure('run.incompatible', check.message, {
            ...context,
            run,
            details: jsonValue(check),
          });
        return { kind: 'workflow.check-resume.result', ok: true, check };
      }
      stage = 'usage.flag';
      const run = await runWorkflow(definition, {
        runId: plan.runId,
        stateDir: plan.stateDir,
        cwd: plan.cwd,
        resume: plan.resume,
        ...(plan.killOrphans === undefined ? {} : { killOrphans: plan.killOrphans }),
        ...(plan.killGraceMs === undefined ? {} : { killGraceMs: plan.killGraceMs }),
        ...(this.#options.processSupervisor === undefined
          ? {}
          : { processSupervisor: this.#options.processSupervisor }),
        ...(agentLimits === undefined ? {} : { agentLimit: agentLimits }),
        ...(plan.policy === undefined ? {} : { policy: plan.policy }),
        ...(plan.profileOverrides === undefined ? {} : { profileOverrides: plan.profileOverrides }),
        ...(plan.grants === undefined ? {} : { grants: plan.grants }),
        ...(plan.policyReset === undefined ? {} : { policyReset: plan.policyReset }),
        ...(plan.allowModelOverride === undefined
          ? {}
          : { allowModelOverride: plan.allowModelOverride }),
        ...(plan.input === undefined ? {} : { input: plan.input }),
        ...(this.#options.harness === undefined ? {} : { harness: this.#options.harness }),
        ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
        source,
        ...(plan.forkFrom === undefined ? {} : { forkFrom: plan.forkFrom }),
        ...(plan.acceptCodeChange === undefined ? {} : { acceptCodeChange: plan.acceptCodeChange }),
        ...(plan.strictReplay === undefined ? {} : { strictReplay: plan.strictReplay }),
        onEvent: (event) => {
          const observational = event.type === 'phase' || event.type === 'log';
          const detail =
            event.message ??
            `${event.stepId ?? ''} (attempt ${String(event.attempt)})${event.provider === undefined ? '' : ` provider=${event.provider} waitedMs=${String(event.waitedMs)} inFlight=${JSON.stringify(event.inFlight)} queued=${String(event.queued)}`}`;
          this.#options.logger.log(
            observational ? 'info' : event.type === 'replay.divergence' ? 'warn' : 'debug',
            `${event.at} ${event.runId} ${event.type} ${detail}${event.data == null ? '' : ` ${JSON.stringify(event.data)}`}${event.replayed ? ' (replay)' : ''}`,
          );
        },
      });
      return { kind: 'workflow.run.result', ok: true, run };
    } catch (error: unknown) {
      const run =
        error instanceof WorkflowRunError
          ? error.run
          : context.runId && context.stateDir && isValidRunId(context.runId)
            ? await readRun({ runId: context.runId, stateDir: context.stateDir }).catch(() => null)
            : null;
      const message = error instanceof Error ? error.message : String(error);
      // A failed save outranks an interrupt: the cancellation state may not be on disk. A saved
      // checkpoint outranks the ambient signal: the runner saves `cancelled` only when the abort
      // caused the failure, so a `failed` run stays a failure even if a signal also arrived.
      const code = hasCheckpointError(error)
        ? 'workflow.storage'
        : error instanceof WorkflowRunError
          ? error.run.status === 'cancelled'
            ? 'workflow.interrupted'
            : 'workflow.failed'
          : this.#options.signal?.aborted
            ? 'workflow.interrupted'
            : error instanceof RunRefusedError || error instanceof WorkflowInputError
              ? error.code
              : stage;
      return workflowFailure(
        code,
        run?.recoveryHint && !message.includes('re-finalize')
          ? `${message} ${run.recoveryHint}`
          : message,
        {
          ...context,
          run,
          stepId: error instanceof WorkflowRunError ? error.stepId : null,
          details:
            error instanceof RunRefusedError || error instanceof WorkflowInputError
              ? error.details
              : null,
        },
      );
    } finally {
      unregister?.();
    }
  }
}

function hasCheckpointError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!(error instanceof Error) || seen.has(error)) return false;
  seen.add(error);
  return (
    error instanceof CheckpointError ||
    hasCheckpointError(error.cause, seen) ||
    (error instanceof AggregateError &&
      error.errors.some((entry: unknown) => hasCheckpointError(entry, seen)))
  );
}
