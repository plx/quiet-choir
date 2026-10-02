import type { WorkflowDeclaration } from '../runtime/child-model.js';
import { importWorkflow, WorkflowDefinitionError } from './import.js';
import { cleanWorktrees } from '../runtime/worktree-clean.js';
import type {
  CleanWorkflowPlan,
  ListDefinitionsPlan,
  ExecuteNamedWorkflowPlan,
  UnlockWorkflowPlan,
} from './model.js';
import { NodeProcessRunner } from '../../processes/runner.js';
import type { ProcessRunner } from '../runtime/exec-model.js';
import { lstat, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkflowNotifications } from './notifications.js';
import { WorkflowEventLog, type EventLogTarget } from './events.js';
import { recordEventLines, type EventFollowCursor } from './event-follow.js';
import { fixturesFromRun } from './fixtures.js';
import {
  harnessConfigDigest,
  inheritHarnessSelection,
  launchPolicyOf,
  selectedAdapters,
} from './harness-selection.js';
import { FixtureHarness } from '../../harnesses/fixture.js';
import { RehearsalHarness, rehearsalState } from './rehearsal.js';
import {
  divergenceRefusal,
  isDivergenceRefusal,
  preflightAcceptedReplay,
  type PreflightRunOptions,
} from './code-change-preflight.js';
import { jsonValue } from '../runtime/json.js';
import {
  inspectRun,
  listRuns,
  WatchBoundError,
  watchRun,
  type RunInspection,
} from './inspection.js';
import { workflowFailure } from './failure.js';
import { failureKind, rootCauseErrorKind } from './failure-kind.js';
import { failureNextCommands } from './next-commands.js';
import type { CommandLauncher } from '../runtime/commands.js';
import { missingRunError, readRequiredRun } from '../runtime/read-required-run.js';
import { unlockRun } from '../runtime/lock.js';
import {
  findStepIdentityChange,
  isValidRunId,
  runIdMessage,
  RunRefusedError,
  WorkflowInputError,
  WorkflowRunError,
  type CliErrorCode,
} from '../runtime/run-errors.js';
import { defaultAgentLimits, validateAgentLimits } from '../runtime/agent-limiter.js';
import type { ProcessSupervisor } from '../../processes/supervisor.js';
import { describeWorkflow } from '../runtime/definition.js';
import { listDefinitions } from './registry.js';
import { analyzeTypecheckEntrypoint } from '../typecheck/plan.js';

import type { ExecutionLogger, Executor } from '../../application/execution.js';
import type { Harness } from '../runtime/model.js';
import { runWorkflow } from '../runtime/runner.js';
import { legacyRunPath, resolveStateDir, runDirectory } from '../runtime/paths.js';
import { CheckpointError, errorCode } from '../runtime/checkpoint.js';
import { readRun, type RunRecord } from '../runtime/store.js';
import type { RunStore } from '../runtime/run-store.js';
import type { WorkflowClock } from '../runtime/wait-model.js';
import { TypeScriptExecutor } from '../typecheck/typescript-executor.js';
import { fingerprintSources, workflowLaunch } from './source.js';
import { AnswerError, listPending, writeAnswer } from '../runtime/inbox.js';
import { canonicalCwd, compareResume, workflowSnapshot } from '../runtime/compatibility.js';
import type {
  ExecuteWorkflowPlan,
  ExportFixturesPlan,
  CheckResumePlan,
  InspectWorkflowPlan,
  WatchWorkflowPlan,
  EventsWorkflowPlan,
  ListWorkflowsPlan,
  ValidateWorkflowPlan,
  WorkflowCommandResult,
  ResumeWorkflowPlan,
  AnswerWorkflowPlan,
  PendingWorkflowsPlan,
} from './model.js';

/** Explicit live dependencies, kept outside serializable command plans. */
export interface WorkflowExecutorOptions {
  readonly logger: ExecutionLogger;
  readonly harness?: Harness;
  readonly processRunner?: ProcessRunner;
  readonly signal?: AbortSignal;
  readonly processSupervisor?: ProcessSupervisor;
  readonly onInspection?: (value: RunInspection) => void;
  /** Live storage ownership injection, used by tick to claim before importing source. */
  readonly store?: RunStore;
  readonly clock?: WorkflowClock;
  /**
   * Program words that start every emitted command (`resumeCommand`, `answerCommand`, `next`).
   * The CLI detects them from its own invocation; omitted means `['quiet-choir']`.
   */
  readonly commandLauncher?: CommandLauncher | undefined;
  /**
   * The writer for a plan's `events: '-'`. The CLI passes its reserved stdout here, so the executor
   * never writes to `process.stdout` itself; a `-` plan without it is a usage error.
   */
  readonly eventsStdout?: Extract<EventLogTarget, { readonly write: unknown }>['write'];
  /** Receives each line of a `workflow.events` plan, without its newline, as soon as it is derived. */
  readonly onEventLine?: (line: string) => void;
}

/** Every plain-data plan the workflow executor accepts. */
export type WorkflowExecutorPlan =
  | ExportFixturesPlan
  | ValidateWorkflowPlan
  | ExecuteWorkflowPlan
  | InspectWorkflowPlan
  | CheckResumePlan
  | WatchWorkflowPlan
  | EventsWorkflowPlan
  | ListWorkflowsPlan
  | ResumeWorkflowPlan
  | AnswerWorkflowPlan
  | PendingWorkflowsPlan
  | CleanWorkflowPlan
  | UnlockWorkflowPlan
  | ListDefinitionsPlan
  | ExecuteNamedWorkflowPlan;

/** Type-check, import, and optionally run trusted workflow code behind a plain-data boundary. */
export class WorkflowExecutor implements Executor<WorkflowExecutorPlan, WorkflowCommandResult> {
  readonly #options: WorkflowExecutorOptions;

  public constructor(options: WorkflowExecutorOptions) {
    this.#options = options;
  }

  public async execute(plan: WorkflowExecutorPlan): Promise<WorkflowCommandResult> {
    const result = await this.#execute(plan);
    // Nested executions (resume, answer --resume, execution by name) may already carry theirs.
    if (result.ok || result.next !== undefined) return result;
    const next = failureNextCommands({
      code: result.code,
      details: result.details,
      run: result.run,
      runId: result.runId,
      stateDir: result.stateDir,
      launcher: this.#options.commandLauncher,
      rehearsal: result.rehearsal !== undefined || ('dryRun' in plan && plan.dryRun),
    });
    // Absent means none; the CLI document always renders an array.
    return next.length ? { ...result, next } : result;
  }

  async #execute(plan: WorkflowExecutorPlan): Promise<WorkflowCommandResult> {
    let unregister: (() => void) | undefined;
    let rehearsal: RehearsalHarness | undefined;
    let notifications: WorkflowNotifications | undefined;
    let events: WorkflowEventLog | undefined;
    let previewState: Awaited<ReturnType<typeof rehearsalState>> | undefined;
    let harness = this.#options.harness;
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
      if (plan.kind === 'workflow.list-defs' || plan.kind === 'workflow.execute-name') {
        stage = 'load.definition';
        const registry = await listDefinitions(
          plan.directories,
          (typecheck) => this.execute({ kind: 'workflow.validate', typecheck }),
          plan.kind === 'workflow.list-defs' && plan.refresh,
        );
        if (plan.kind === 'workflow.list-defs' || !registry.ok) return registry;
        if (registry.kind !== 'workflow.list-defs.result')
          throw new Error('Unexpected definition registry result.');
        const selected = registry.definitions.find((entry) => entry.workflow.name === plan.name);
        if (!selected)
          throw new Error(
            `Unknown workflow name ${plan.name}; search directories with workflow list-defs or supply --registry-dir DIR.`,
          );
        const analyzed = analyzeTypecheckEntrypoint(selected.entrypoint, plan.cwd);
        if (!analyzed.ok) throw new Error(analyzed.error.message);
        return await this.execute({
          ...plan,
          kind: 'workflow.execute',
          registryName: plan.name,
          typecheck: analyzed.plan,
        });
      }
      if (plan.kind === 'workflow.execute' && plan.forkFrom && !isValidRunId(plan.forkFrom.runId))
        return workflowFailure('usage.run_id', runIdMessage, context);
      if (plan.kind === 'workflow.resume') {
        const run = await readRequiredRun({ runId: plan.runId, stateDir: plan.stateDir });
        if (!run.launch)
          throw new RunRefusedError(
            'run.incompatible',
            run.id,
            'This run has no stored entrypoint. Resume with workflow execute FILE --resume --run-id RUN, or the original embedding application.',
          );
        await storedEntrypointExists(run.id, run.launch.entrypoint);
        return await this.execute({
          ...plan,
          kind: 'workflow.execute',
          cwd: run.cwd,
          resume: true,
          typecheck: {
            kind: 'workflow.typecheck',
            entrypoint: run.launch.entrypoint,
            configuration:
              run.launch.tsconfig === null
                ? { kind: 'defaults', profile: 'node22-es2023-strict' }
                : { kind: 'tsconfig', path: run.launch.tsconfig },
          },
        });
      }
      if (plan.kind === 'workflow.clean') {
        stage = 'workflow.storage';
        return {
          kind: 'workflow.clean.result',
          ok: true,
          ...(await cleanWorktrees(
            plan,
            this.#options.processRunner ?? new NodeProcessRunner(),
            this.#options.signal,
            this.#options.processSupervisor,
          )),
        };
      }
      if (plan.kind === 'workflow.unlock') {
        stage = 'workflow.storage';
        const stateDir = resolveStateDir({ stateDir: plan.stateDir });
        const locks = await unlockRun(plan);
        // Nothing locked and nothing saved is most likely a mistyped run ID, not a no-op. Checked
        // here, not in the lock module, so an unreadable record never blocks an unlock.
        if (!locks.length && !(await hasCheckpoint(stateDir, plan.runId)))
          throw await missingRunError({ runId: plan.runId, stateDir });
        return {
          kind: 'workflow.unlock.result',
          ok: true,
          runId: plan.runId,
          stateDir,
          forceRemote: plan.forceRemote,
          locks,
        };
      }
      if (plan.kind === 'workflow.pending') {
        stage = 'run.unreadable';
        return {
          kind: 'workflow.pending.result',
          ok: true,
          pending: (
            await Promise.all(
              [...new Set([plan.stateDir, ...(plan.additionalStateDirs ?? [])])].map((stateDir) =>
                listPending({
                  stateDir,
                  ...(this.#options.commandLauncher === undefined
                    ? {}
                    : { commandLauncher: this.#options.commandLauncher }),
                }),
              ),
            )
          ).flat(),
        };
      }
      if (plan.kind === 'workflow.answer') {
        stage = 'workflow.storage';
        await readRequiredRun({ runId: plan.runId, stateDir: plan.stateDir });
        const delivery = await writeAnswer(plan);
        if (plan.resume)
          return await this.execute({
            kind: 'workflow.resume',
            runId: plan.runId,
            stateDir: plan.stateDir,
            ...(plan.harness === undefined ? {} : { harness: plan.harness }),
            ...(plan.inheritHarness === undefined ? {} : { inheritHarness: plan.inheritHarness }),
            ...(plan.waitMode === undefined ? {} : { waitMode: plan.waitMode }),
            ...(plan.allowHarnessConfigChange === undefined
              ? {}
              : { allowHarnessConfigChange: plan.allowHarnessConfigChange }),
            ...(plan.events === undefined ? {} : { events: plan.events }),
          });
        return { kind: 'workflow.answer.result', ok: true, delivery };
      }
      if (plan.kind === 'workflow.fixtures') {
        stage = 'run.unreadable';
        const run = await readRequiredRun({ runId: plan.runId, stateDir: plan.stateDir });
        return { kind: 'workflow.fixtures.result', ok: true, fixtures: fixturesFromRun(run) };
      }
      if (plan.kind === 'workflow.list') {
        stage = 'run.unreadable';
        return {
          kind: 'workflow.list.result',
          ok: true,
          ...(await listRuns({ ...plan, commandLauncher: this.#options.commandLauncher })),
        };
      }
      if (plan.kind === 'workflow.events') {
        stage = 'run.unreadable';
        const { start } = plan;
        if (!plan.follow && start === 'end')
          return workflowFailure(
            'usage.flag',
            'Printing events without following starts from the record start or an execution.',
            context,
          );
        const after = typeof start === 'object' ? start.afterExecution : undefined;
        let cursor: EventFollowCursor | null = null;
        const emit = (value: RunInspection): void => {
          const derived = recordEventLines(value.run, cursor, start);
          cursor = derived.cursor;
          this.#options.logger.log(
            'debug',
            `Events: read run ${value.run.id} (${value.summary.status}, execution ${String(value.summary.execution)}); ${String(derived.lines.length)} new lines.`,
          );
          for (const line of derived.lines) this.#options.onEventLine?.(line);
        };
        const options = {
          runId: plan.runId,
          stateDir: plan.stateDir,
          commandLauncher: this.#options.commandLauncher,
        };
        const inspection = plan.follow
          ? await watchRun(
              {
                ...options,
                intervalMs: plan.intervalMs,
                timeoutMs: plan.timeoutMs,
                waitCreatedMs: plan.waitCreatedMs,
                done: (value) =>
                  value.summary.status !== 'running' &&
                  (after === undefined || (value.summary.execution ?? 0) > after),
              },
              emit,
              this.#options.signal,
            )
          : await inspectRun(options);
        if (!plan.follow) emit(inspection);
        return { kind: 'workflow.run.result', ok: true, ...inspection };
      }
      if (plan.kind === 'workflow.inspect' || plan.kind === 'workflow.watch') {
        stage = 'run.unreadable';
        const inspection =
          plan.kind === 'workflow.watch'
            ? await watchRun(
                { ...plan, commandLauncher: this.#options.commandLauncher },
                this.#options.onInspection ?? (() => undefined),
                this.#options.signal,
              )
            : await inspectRun({ ...plan, commandLauncher: this.#options.commandLauncher });
        return {
          kind: 'workflow.run.result',
          ok: true,
          ...inspection,
        };
      }
      stage = 'usage.flag';
      // The effective selection and wait mode. On resume, the run's recorded launch policy fills in
      // what the invocation left out, before anything below builds a harness from the selection.
      let selection = plan.kind === 'workflow.execute' ? plan.harness : undefined;
      let waitMode = plan.kind === 'workflow.execute' ? plan.waitMode : undefined;
      let saved: RunRecord | undefined;
      if (plan.kind === 'workflow.execute' && plan.resume) {
        saved = await readRequiredRun({ runId: plan.runId, stateDir: plan.stateDir });
        const recorded = saved.launch?.policy;
        if (recorded && plan.inheritHarness)
          selection = await inheritHarnessSelection(selection, recorded.harness, (message) => {
            this.#options.logger.log('warn', message);
          });
        waitMode ??= recorded?.waitMode;
      }
      if (plan.kind === 'workflow.execute') {
        if ((plan.stubSteps?.length ?? 0) > 0 && !plan.dryRun)
          throw new Error('--stub-steps requires --dry-run.');
        if (plan.dryRun) {
          rehearsal = new RehearsalHarness(
            selection ?? { kind: 'cli', config: {} },
            plan.stubSteps,
          );
          harness = rehearsal;
          previewState = await rehearsalState(plan.runId, plan.stateDir, plan.resume);
          context.stateDir = previewState.stateDir;
        } else if (selection) {
          if (selection.kind === 'fixture') {
            if (!selection.fixtures) throw new Error('Fixture selection requires fixture data.');
            harness = new FixtureHarness(selection.fixtures);
          }
        }
      }
      stage = 'usage.flag';
      const agentLimits =
        plan.kind === 'workflow.execute'
          ? validateAgentLimits(plan.agentLimits ?? defaultAgentLimits())
          : undefined;
      if (agentLimits)
        this.#options.logger.log(
          'info',
          `Agent limits: total=${String(agentLimits.total)}; per-harness=${JSON.stringify(agentLimits.perProvider ?? {})}`,
        );
      if (plan.kind === 'workflow.execute' && saved) {
        if (saved.launch) {
          // A missing stored file is the entrypoint_missing refusal, whatever FILE was requested.
          await storedEntrypointExists(saved.id, saved.launch.entrypoint);
          const requested = await realpath(plan.typecheck.entrypoint);
          if (requested !== saved.launch.entrypoint)
            throw new RunRefusedError(
              'run.incompatible',
              saved.id,
              `Run ${saved.id} was launched from ${saved.launch.entrypoint}; requested ${requested}. Use its stored entrypoint or fork a new run.`,
              { storedEntrypoint: saved.launch.entrypoint, requestedEntrypoint: requested },
            );
        }
      }
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
      const imported = await importWorkflow(plan.typecheck);
      unregister = imported.dispose;
      this.#options.signal?.throwIfAborted();
      stage = 'load.definition';
      const definition = imported.definition;
      if (
        plan.kind === 'workflow.execute' &&
        plan.registryName !== undefined &&
        definition.name !== plan.registryName
      )
        throw new Error(
          `Registry name ${plan.registryName} now resolves to workflow ${definition.name}; refresh workflow list-defs before executing by name.`,
        );
      const description = describeWorkflow(definition, plan.typecheck.entrypoint);
      if (plan.kind === 'workflow.validate') {
        return {
          kind: 'workflow.validate.result',
          ok: true,
          entrypoint: plan.typecheck.entrypoint,
          workflow: {
            ...description,
            ...workflowSnapshot(definition, { source }),
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
      if (!plan.dryRun && plan.notifyCommand?.trim())
        notifications = new WorkflowNotifications({
          command: plan.notifyCommand,
          cwd: plan.cwd,
          stateDir: plan.stateDir,
          logger: this.#options.logger,
          ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
          ...(this.#options.processSupervisor === undefined
            ? {}
            : { processSupervisor: this.#options.processSupervisor }),
        });
      if (plan.events !== undefined) {
        const stdout = this.#options.eventsStdout;
        if (plan.events === '-' && stdout === undefined)
          throw new Error('--events - needs a stdout writer; give --events a file path.');
        events = new WorkflowEventLog({
          target: plan.events === '-' && stdout ? { write: stdout } : { path: plan.events },
          logger: this.#options.logger,
        });
        events.open();
      }
      const adapters = plan.dryRun ? {} : selectedAdapters(selection, harness);
      const declaredNames = new Set<string>(['claude', 'codex']);
      const pendingDeclarations = [definition as unknown as WorkflowDeclaration];
      const visitedDeclarations = new Set<object>();
      while (pendingDeclarations.length) {
        const declared = pendingDeclarations.pop();
        if (!declared || visitedDeclarations.has(declared)) continue;
        visitedDeclarations.add(declared);
        for (const item of declared.harnesses ?? []) declaredNames.add(item.name);
        pendingDeclarations.push(...(declared.children ?? []));
      }
      for (const name of [
        ...Object.keys(selection?.named ?? {}),
        ...Object.keys(selection?.configurations ?? {}),
      ])
        if (!declaredNames.has(name))
          this.#options.logger.log(
            'warn',
            `Harness ${name} is not declared in the static workflow tree; this setting only applies if a child invoked dynamically (via ctx.workflow) declares it.`,
          );
      // Options shared with the accepted-replay preflight; live-only ones are added below.
      const policy = launchPolicyOf(selection, waitMode ?? 'suspend');
      const shared: PreflightRunOptions = {
        runId: plan.runId,
        launch: {
          ...(await workflowLaunch(plan.typecheck, source)),
          ...(policy === undefined ? {} : { policy }),
        },
        cwd: plan.cwd,
        ...(plan.maxRunCostUsd === undefined ? {} : { maxRunCostUsd: plan.maxRunCostUsd }),
        ...(plan.maxChildDepth === undefined ? {} : { maxChildDepth: plan.maxChildDepth }),
        ...(plan.maxRunAgentAttempts === undefined
          ? {}
          : { maxRunAgentAttempts: plan.maxRunAgentAttempts }),
        ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
        resume: plan.resume,
        ...(plan.killGraceMs === undefined ? {} : { killGraceMs: plan.killGraceMs }),
        ...(agentLimits === undefined ? {} : { agentLimit: agentLimits }),
        ...(plan.policy === undefined ? {} : { policy: plan.policy }),
        ...(plan.profileOverrides === undefined ? {} : { profileOverrides: plan.profileOverrides }),
        ...(plan.grants === undefined ? {} : { grants: plan.grants }),
        ...(plan.policyReset === undefined ? {} : { policyReset: plan.policyReset }),
        ...(plan.allowModelOverride === undefined
          ? {}
          : { allowModelOverride: plan.allowModelOverride }),
        ...(plan.input === undefined ? {} : { input: plan.input }),
        ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
        source,
        ...(plan.acceptCodeChange === undefined ? {} : { acceptCodeChange: plan.acceptCodeChange }),
        ...(plan.strictReplay === undefined ? {} : { strictReplay: plan.strictReplay }),
      };
      if (plan.resume && plan.acceptCodeChange && !plan.dryRun) {
        // An accepted replay that meets a changed completed step would fail only after recording
        // the change and clearing the saved outcome; find that on a disposable copy first.
        this.#options.logger.log(
          'info',
          'Preflighting the accepted code change against a disposable copy.',
        );
        const change = await preflightAcceptedReplay(definition, shared, {
          stateDir: plan.stateDir,
          ...(selection === undefined ? {} : { selection }),
        });
        if (change)
          throw divergenceRefusal(
            change,
            {
              runId: plan.runId,
              stateDir: resolveStateDir({ stateDir: plan.stateDir }),
              entrypoint: await realpath(plan.typecheck.entrypoint),
            },
            this.#options.commandLauncher,
          );
      }
      // A one-execution mode (tick's suspend) applies now; the recorded policy keeps waitMode.
      const effectiveWaitMode = plan.waitModeOnce ?? waitMode;
      const run = await runWorkflow(definition, {
        ...shared,
        ...(Object.keys(adapters).length ? { adapters } : {}),
        ...(selection?.configurations === undefined
          ? {}
          : { harnessConfigurations: selection.configurations }),
        stateDir: previewState?.stateDir ?? plan.stateDir,
        processRunner:
          rehearsal?.processRunner ?? this.#options.processRunner ?? new NodeProcessRunner(),
        ...(effectiveWaitMode === undefined ? {} : { waitMode: effectiveWaitMode }),
        ...(this.#options.store === undefined ? {} : { store: this.#options.store }),
        ...(this.#options.commandLauncher === undefined
          ? {}
          : { commandLauncher: this.#options.commandLauncher }),
        ...(rehearsal === undefined ? {} : { rehearsal: rehearsal.hooks }),
        allowHarnessChange: rehearsal !== undefined || (plan.allowHarnessChange ?? false),
        // Only a live CLI execution knows its configuration: a rehearsal ignores it, and an injected
        // fallback harness carries its own. The accepted-replay preflight needs no check, because
        // this call refuses before it changes the checkpoint.
        ...(plan.dryRun || this.#options.harness !== undefined
          ? {}
          : {
              harnessConfigDigest: harnessConfigDigest(selection),
              allowHarnessConfigChange: plan.allowHarnessConfigChange ?? false,
            }),
        ...(plan.killOrphans === undefined ? {} : { killOrphans: plan.killOrphans }),
        ...(this.#options.processSupervisor === undefined
          ? {}
          : { processSupervisor: this.#options.processSupervisor }),
        ...(harness === undefined ? {} : { harness }),
        ...(plan.forkFrom === undefined
          ? {}
          : { forkFrom: { ...plan.forkFrom, stateDir: plan.forkFrom.stateDir ?? plan.stateDir } }),
        onEvent: (event) => {
          rehearsal?.observe(event);
          notifications?.observe(event);
          events?.observe(event);
          const observational = event.type === 'phase' || event.type === 'log';
          const agentProgress =
            event.type === 'agent.started' ||
            event.type === 'agent.progress' ||
            event.type === 'agent.finished';
          const denials = event.diagnostics?.['permissionDenials'];
          if (event.type === 'agent.finished' && typeof denials === 'number' && denials > 0)
            this.#options.logger.log(
              'warn',
              `${event.stepId}: ${String(denials)} permission denials${Array.isArray(event.diagnostics?.['deniedTools']) ? ` (${event.diagnostics['deniedTools'].filter((tool) => typeof tool === 'string').join(', ')})` : ''}.`,
            );
          const detail =
            event.message ??
            `${event.stepId ?? ''} (attempt ${String(event.attempt)})${event.harness === undefined ? '' : ` harness=${event.harness}`}${agentProgress ? ` ${event.progress?.summary ?? event.outcome ?? 'started'}${event.sessionId ? ` session=${event.sessionId}` : ''}` : event.waitedMs === undefined ? '' : ` waitedMs=${String(event.waitedMs)} inFlight=${JSON.stringify(event.inFlight)} queued=${String(event.queued)}`}`;
          this.#options.logger.log(
            observational || (plan.progress && agentProgress)
              ? 'info'
              : event.type === 'replay.divergence'
                ? 'warn'
                : 'debug',
            `${event.at} ${event.runId} ${event.type} ${detail}${event.data == null ? '' : ` ${JSON.stringify(event.data)}`}${event.replayed ? ' (replay)' : ''}`,
          );
        },
      });
      return {
        kind: 'workflow.run.result',
        ok: true,
        run:
          rehearsal && run.status === 'suspended'
            ? {
                ...run,
                resumeCommand: null,
                pending: run.pending.map((question) => ({ ...question, answerCommand: null })),
              }
            : run,
        ...(rehearsal === undefined ? {} : { rehearsal: rehearsal.report(run) }),
      };
    } catch (thrown: unknown) {
      // A dry-run of an accepted resume reports a changed completed step the way the real command
      // refuses it, with the real state directory and entrypoint.
      const dryRunChange =
        plan.kind === 'workflow.execute' && plan.dryRun && plan.resume && plan.acceptCodeChange
          ? findStepIdentityChange(thrown)
          : undefined;
      const error =
        dryRunChange && plan.kind === 'workflow.execute'
          ? divergenceRefusal(
              dryRunChange,
              {
                runId: plan.runId,
                stateDir: resolveStateDir({ stateDir: plan.stateDir }),
                entrypoint: await realpath(plan.typecheck.entrypoint).catch(
                  () => plan.typecheck.entrypoint,
                ),
              },
              this.#options.commandLauncher,
            )
          : thrown;
      // A bounded watch reports what it observed: re-reading could attach a record created after
      // the deadline, or a newer status than the one the watch timed out on.
      const run =
        thrown instanceof WorkflowRunError || thrown instanceof WatchBoundError
          ? thrown.run
          : context.runId && context.stateDir && isValidRunId(context.runId)
            ? await readRun({ runId: context.runId, stateDir: context.stateDir }).catch(() => null)
            : null;
      const message = error instanceof Error ? error.message : String(error);
      // A failed save outranks an interrupt: the cancellation state may not be on disk. A saved
      // checkpoint outranks the ambient signal: the runner saves `cancelled`, or a resumable
      // `suspended` with `interruptedBy` for a marked interruption, only when the abort caused the
      // failure, so a `failed` run stays a failure even if a signal also arrived. An answer
      // rejection is a definitive refusal, not an interrupted execution.
      const code = hasCheckpointError(error)
        ? 'workflow.storage'
        : error instanceof AnswerError
          ? error.reason === 'invalid'
            ? 'answer.invalid'
            : 'answer.conflict'
          : error instanceof WorkflowRunError
            ? error.run.status === 'cancelled' ||
              (error.run.status === 'suspended' && error.run.interruptedBy !== undefined)
              ? 'workflow.interrupted'
              : 'workflow.failed'
            : this.#options.signal?.aborted
              ? 'workflow.interrupted'
              : error instanceof RunRefusedError ||
                  error instanceof WorkflowInputError ||
                  error instanceof WatchBoundError
                ? error.code
                : error instanceof WorkflowDefinitionError
                  ? 'load.definition'
                  : stage;
      return workflowFailure(
        code,
        // A divergence refusal must not advertise the path it refused.
        run?.recoveryHint && !isDivergenceRefusal(error) && !message.includes('re-finalize')
          ? `${message} ${run.recoveryHint}`
          : message,
        {
          ...context,
          run,
          ...(rehearsal === undefined
            ? {}
            : {
                rehearsal: rehearsal.report(run),
                stack: thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown),
              }),
          stepId: error instanceof WorkflowRunError ? error.stepId : null,
          details:
            code === 'workflow.failed' && error instanceof WorkflowRunError
              ? failureKind(rootCauseErrorKind(error.run))
              : error instanceof RunRefusedError ||
                  error instanceof WorkflowInputError ||
                  error instanceof WatchBoundError
                ? error.details
                : null,
        },
      );
    } finally {
      events?.close();
      await notifications?.flush();
      unregister?.();
      await previewState?.dispose();
    }
  }
}

/**
 * Refuse a resume whose stored entrypoint is gone, such as after a checkout moved: the run is
 * intact but cannot load its code from there, so this is `run.incompatible`, not a usage error.
 */
async function storedEntrypointExists(runId: string, entrypoint: string): Promise<void> {
  try {
    await stat(entrypoint);
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    throw new RunRefusedError(
      'run.incompatible',
      runId,
      `Run ${runId} was launched from ${entrypoint}, which no longer exists: the checkout moved or the file was deleted. Fork a new run from the new location with workflow execute FILE --fork-from ${runId}.`,
      { storedEntrypoint: entrypoint, reason: 'entrypoint_missing' },
      { cause: error },
    );
  }
}

/** Whether a directory checkpoint or a legacy flat checkpoint exists for the run. */
async function hasCheckpoint(stateDir: string, runId: string): Promise<boolean> {
  for (const path of [
    join(runDirectory(stateDir, runId), 'run.json'),
    legacyRunPath(stateDir, runId),
  ])
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return true;
    }
  return false;
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
