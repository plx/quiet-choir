import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import { tsImport } from 'tsx/esm/api';
import { register as registerCommonJs } from 'tsx/cjs/api';
import ts from 'typescript';
import { z } from 'zod';

import type { ExecutionLogger, Executor } from '../../application/execution.js';
import type { Harness, WorkflowDefinition } from '../runtime/model.js';
import { runWorkflow } from '../runtime/runner.js';
import { resolveStateDir } from '../runtime/paths.js';
import { errorCode } from '../runtime/checkpoint.js';
import { readRun } from '../runtime/store.js';
import { TypeScriptExecutor } from '../typecheck/typescript-executor.js';
import type { TypecheckPlan } from '../typecheck/model.js';
import type {
  ExecuteWorkflowPlan,
  InspectWorkflowPlan,
  ValidateWorkflowPlan,
  WorkflowCommandResult,
} from './model.js';

/** Explicit live dependencies, kept outside serializable command plans. */
export interface WorkflowExecutorOptions {
  readonly logger: ExecutionLogger;
  readonly harness?: Harness;
  readonly signal?: AbortSignal;
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

async function fingerprint(plan: TypecheckPlan, sourceFiles: readonly string[]): Promise<string> {
  const files = [
    ...new Set([
      ...sourceFiles,
      ...(plan.configuration.kind === 'tsconfig' ? [plan.configuration.path] : []),
    ]),
  ].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash
      .update(file)
      .update('\0')
      .update(await readFile(file))
      .update('\0');
  }
  return hash.digest('hex');
}

/** Type-check, import, and optionally run trusted workflow code behind a plain-data boundary. */
export class WorkflowExecutor implements Executor<
  ValidateWorkflowPlan | ExecuteWorkflowPlan | InspectWorkflowPlan,
  WorkflowCommandResult
> {
  readonly #options: WorkflowExecutorOptions;

  public constructor(options: WorkflowExecutorOptions) {
    this.#options = options;
  }

  public async execute(
    plan: ValidateWorkflowPlan | ExecuteWorkflowPlan | InspectWorkflowPlan,
  ): Promise<WorkflowCommandResult> {
    let unregister: (() => void) | undefined;
    try {
      if (plan.kind === 'workflow.inspect') {
        const stateDir = resolveStateDir({ stateDir: plan.stateDir });
        try {
          return {
            kind: 'workflow.run.result',
            ok: true,
            run: await readRun({ stateDir, runId: plan.runId }),
          };
        } catch (cause) {
          if (errorCode(cause) !== 'ENOENT') throw cause;
          const entries = await readdir(stateDir, { withFileTypes: true }).catch(
            (error: unknown) => {
              if (errorCode(error) === 'ENOENT') return [];
              throw error;
            },
          );
          const ids = entries
            .filter(
              (entry) =>
                entry.isFile() && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.json$/u.test(entry.name),
            )
            .map((entry) => entry.name.slice(0, -5))
            .sort();
          throw new Error(
            `Run ${plan.runId} not found in ${stateDir} (${String(ids.length)} runs present${ids.length ? `: ${ids.slice(0, 20).join(', ')}${ids.length > 20 ? ', …' : ''}` : ''}). --state-dir resolves against the current directory.`,
            { cause },
          );
        }
      }
      const checked = await new TypeScriptExecutor(this.#options.logger).execute(plan.typecheck);
      if (!checked.ok) {
        return {
          kind: 'workflow.error',
          ok: false,
          message: 'Workflow type check failed.',
          diagnostics: checked.diagnostics,
        };
      }
      const sourceFingerprint = await fingerprint(plan.typecheck, checked.sourceFiles);
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
            fingerprint: sourceFingerprint,
          },
        };
      }
      const run = await runWorkflow(definition, {
        runId: plan.runId,
        stateDir: plan.stateDir,
        cwd: plan.cwd,
        resume: plan.resume,
        ...(plan.policy === undefined ? {} : { policy: plan.policy }),
        ...(plan.policyReset === undefined ? {} : { policyReset: plan.policyReset }),
        ...(plan.allowModelOverride === undefined
          ? {}
          : { allowModelOverride: plan.allowModelOverride }),
        ...(plan.input === undefined ? {} : { input: plan.input }),
        ...(this.#options.harness === undefined ? {} : { harness: this.#options.harness }),
        ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
        fingerprint: sourceFingerprint,
        onEvent: (event) => {
          this.#options.logger.log(
            'debug',
            `${event.type} ${event.stepId} (attempt ${String(event.attempt)})`,
          );
        },
      });
      return { kind: 'workflow.run.result', ok: true, run };
    } catch (error: unknown) {
      return {
        kind: 'workflow.error',
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        diagnostics: [],
      };
    } finally {
      unregister?.();
    }
  }
}
