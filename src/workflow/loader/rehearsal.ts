import type { ClaudeOptions } from '../runtime/model.js';
import type { Command, ProcessRunRequest, ProcessRunner } from '../runtime/exec-model.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';
import { CliHarness, type CliHarnessPlan } from '../../harnesses/cli.js';
import { FixtureHarness } from '../../harnesses/fixture.js';
import { FixtureExecRules } from '../../harnesses/fixture-exec.js';
import { synthesizeOutput } from '../../harnesses/synthesize.js';
import type {
  HarnessInvocation,
  HarnessRequest,
  HarnessResponse,
  JsonValue,
} from '../runtime/model.js';
import { matchesStepGlob, policyOverrideSchema, type ExecutionPolicy } from '../runtime/policy.js';
import type { RunOptions, WorkflowEvent } from '../runtime/runner.js';
import { readRequiredRun } from '../runtime/read-required-run.js';
import { writeRun, type RunRecord } from '../runtime/store.js';
import { runDirectory } from '../runtime/paths.js';
import type { HarnessSelection } from './harness-selection.js';

/** One attempted live call in rehearsal order, including planner/fixture failures. @internal */
export interface RehearsalCall {
  readonly stepId: string;
  readonly harness: string;
  readonly attempt: number;
  readonly cwd: string;
  readonly prompt: string;
  readonly schema: JsonValue;
  readonly outputSource: 'fixture' | 'synthesized';
  readonly fixtureIndex: number | null;
  wouldPay: boolean;
  plan:
    | (Omit<CliHarnessPlan, 'artifacts'> & {
        readonly artifacts: readonly Omit<CliHarnessPlan['artifacts'][number], 'base64'>[];
      })
    | null;
  error: string | null;
  limits: ExecutionPolicy | null;
  /**
   * The synthesized worktree isolation of a fresh isolated call, or null for an ordinary call. Its
   * `cwd` is a placeholder that is never created.
   */
  readonly worktree: {
    readonly synthesized: true;
    readonly base: string;
    readonly baseSource: 'resolved' | 'recorded' | 'placeholder';
  } | null;
}
/** One `ctx.merge` of unchanged changes, answered with the no-op integration. @internal */
export interface RehearsalMerge {
  readonly stepId: string;
  readonly synthesized: true;
  /** The target's current commit, or forty zeros outside a Git working tree. */
  readonly commit: string;
  /** Number of merged inputs. */
  readonly inputs: number;
  readonly target: 'ref' | 'checkout' | 'branch';
  readonly baseSource: 'resolved' | 'placeholder';
}
/**
 * One command reaching the rehearsal process runner, answered by a rule or synthesized, or an
 * observer's `live: true` command run for real. @internal
 */
export interface RehearsalCommand {
  /** The owning effect: the `ctx.exec` step, or the step or wait whose callback issued it. */
  readonly stepId: string;
  /**
   * For a command a step callback or poll observer issued through `context.exec`, the ID of that
   * step or wait (equal to `stepId`); null for a `ctx.exec` effect.
   */
  readonly parentStepId: string | null;
  readonly command: Command;
  readonly cwd: string;
  readonly structured: boolean;
  readonly outputSource: 'fixture' | 'synthesized' | 'live';
  /** Matched index in the fixture file's `exec` array, or null. */
  readonly fixtureIndex: number | null;
  /** The refusal of an unmatched command under `commands: 'fixture'`, or null. */
  readonly error: string | null;
}
/** Plain-data report; its checkpoint has already been removed from temporary storage. @internal */
export interface RehearsalReport {
  readonly kind: 'workflow.rehearsal';
  readonly calls: readonly RehearsalCall[];
  readonly commands: readonly RehearsalCommand[];
  /** Synthesized merges, in completion order. */
  readonly merges: readonly RehearsalMerge[];
  readonly replays: readonly { stepId: string; kind: string }[];
  readonly harnessCounts: Readonly<Record<string, number>>;
  /** Compatibility counts for the two original native clients. */
  readonly providerCounts: { claude: number; codex: number };
  readonly nominalClaudeCeilingUsd: number;
  readonly stubbedSteps: readonly string[];
  readonly skippedSleeps: readonly string[];
  /** Indices into the fixture file's `exec` array of rules that matched no command. */
  readonly staleExecFixtures: readonly number[];
  readonly warnings: readonly string[];
}

/** Process-free harness and observation collector; never delegates metadata or invoke to CliHarness. @internal */
export class RehearsalHarness extends FixtureHarness {
  public override readonly kind = 'dry-run';
  private readonly cli: CliHarness;
  private readonly calls: RehearsalCall[] = [];
  private readonly commands: RehearsalCommand[] = [];
  private readonly execRules: FixtureExecRules;
  public readonly processRunner: ProcessRunner = {
    run: (request, invocation) => {
      invocation.signal.throwIfAborted();
      const match = this.execRules.match(request, invocation);
      const entry = commandEntry(request, invocation);
      if (match) {
        this.commands.push({
          ...entry,
          outputSource: 'fixture',
          fixtureIndex: match.index,
          error: null,
        });
        return Promise.resolve(this.execRules.result(match.rule));
      }
      // Unlike `unmatched`, the commands mode is honored here: its purpose is to forbid synthesis.
      if (this.execRules.commands === 'fixture') {
        const error = this.execRules.unmatched(request, invocation);
        this.commands.push({
          ...entry,
          outputSource: 'fixture',
          fixtureIndex: null,
          error: error.message,
        });
        return Promise.reject(error);
      }
      this.commands.push({
        ...entry,
        outputSource: 'synthesized',
        fixtureIndex: null,
        error: null,
      });
      this.warnings.add(
        'Commands are synthesized without spawning. Empty plain stdout and synthesized JSON can select a different branch from real execution.',
      );
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout:
          request.schema === null
            ? ''
            : JSON.stringify(synthesizeOutput(request.schema, invocation.stepId)),
        stderr: '',
        truncated: false,
        durationMs: 0,
      });
    },
  };
  /**
   * Wrap the real runner the CLI gives a dry run: an observer's `live: true` command, the only
   * nested request that reaches it, is listed in `commands` and then run. Everything else, such as
   * read-only worktree Git, passes through unrecorded.
   */
  public recordLive(real: ProcessRunner): ProcessRunner {
    return {
      run: (request, invocation) => {
        if (request.nested === true)
          this.commands.push({
            ...commandEntry(request, invocation),
            outputSource: 'live',
            fixtureIndex: null,
            error: null,
          });
        return real.run(request, invocation);
      },
    };
  }
  private readonly merges: RehearsalMerge[] = [];
  /** Synthesized isolation by `stepId` and attempt, recorded before the call is invoked. */
  private readonly isolations = new Map<string, NonNullable<RehearsalCall['worktree']>>();
  private readonly replays: string[] = [];
  private readonly stubbedSteps = new Set<string>();
  private readonly skippedSleeps = new Set<string>();
  private readonly warnings = new Set<string>([
    'Local callbacks, file effects, poll observers, and workflow top-level code run for real. Temporary checkpoints do not roll back filesystem or external effects; use --stub-steps for selected local effects and poll observers (a stubbed poll completes with a synthesized value). Commands they issue through context.exec are synthesized like ctx.exec, except a poll observer call with live: true.',
    'The nominal Claude ceiling covers only attempted calls on the rehearsed path. One-item synthesized arrays can understate fan-out; Codex calls are counted, not priced. CLI budget limits can overshoot on a final turn.',
  ]);
  public constructor(
    selection: HarnessSelection,
    private readonly stubPatterns: readonly string[] = [],
  ) {
    super({
      version: 1,
      calls: [
        ...Object.entries(selection.named ?? {}).flatMap(([harness, fixtures]) =>
          fixtures.calls.map((call) => ({ ...call, harness })),
        ),
        ...(selection.fixtures?.calls ?? []),
      ],
      unmatched: 'synthesize',
    });
    this.cli = new CliHarness(selection.config);
    // Named fixture files cannot carry exec rules; commands come only from the global file.
    this.execRules = new FixtureExecRules(selection.fixtures?.exec, selection.fixtures?.commands);
    for (const match of stubPatterns) policyOverrideSchema.parse({ match });
  }
  public policyDefaults(harness: HarnessRequest['harness']): ExecutionPolicy {
    return harness === 'claude' || harness === 'codex' ? this.cli.policyDefaults(harness) : {};
  }
  public override async invoke(
    request: HarnessRequest,
    invocation: HarnessInvocation,
  ): Promise<HarnessResponse> {
    invocation.signal.throwIfAborted();
    const match = this.match(request);
    const call: RehearsalCall = {
      stepId: request.call.stepId,
      harness: request.harness,
      attempt: request.call.attempt,
      cwd: request.cwd,
      prompt: request.options.prompt,
      schema: request.outputSchema,
      outputSource: match ? 'fixture' : 'synthesized',
      fixtureIndex: match?.index ?? null,
      wouldPay: false,
      plan: null,
      limits: null,
      error: null,
      worktree:
        this.isolations.get(JSON.stringify([request.call.stepId, request.call.attempt])) ?? null,
    };
    this.calls.push(call);
    try {
      if (request.harness !== 'claude' && request.harness !== 'codex') {
        call.wouldPay = true;
        call.limits = invocation.policy ?? {};
        this.warnings.add(`Harness ${request.harness} is synthesized without a native argv plan.`);
        return await super.invoke(request, invocation);
      }
      const planned = this.cli.plan(request, invocation);
      call.plan = {
        ...planned,
        artifacts: planned.artifacts.map((artifact) => ({
          name: artifact.name,
          placeholder: artifact.placeholder,
          argument: artifact.argument,
        })),
      };
      call.wouldPay = true;
      call.limits = {
        ...this.cli.policyDefaults(request.harness),
        timeoutMs: call.plan.timeoutMs,
        ...(call.plan.idleTimeoutMs === null ? {} : { idleTimeoutMs: call.plan.idleTimeoutMs }),
        ...(request.harness === 'claude'
          ? {
              maxTurns: (request.options as ClaudeOptions).maxTurns ?? 10,
              maxBudgetUsd: (request.options as ClaudeOptions).maxBudgetUsd ?? 0.5,
            }
          : {}),
      };
      return await super.invoke(request, invocation);
    } catch (error) {
      call.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
  public readonly hooks: NonNullable<RunOptions['rehearsal']> = {
    localStep: (id, schema) => {
      if (!this.stubPatterns.some((pattern) => matchesStepGlob(pattern, id))) return undefined;
      this.stubbedSteps.add(id);
      return { output: synthesizeOutput(schema, id) };
    },
    onSchema: (id, schema) => {
      if (hasRefinement(schema))
        this.warnings.add(
          `Step ${id}: custom Zod refinements cannot be expressed in JSON Schema; fixture/synthesized values still undergo the original validation.`,
        );
    },
    onWorktree: (event) => {
      this.warnings.add(
        'Worktree effects are synthesized: isolated calls are planned in a placeholder directory that is never created, report unchanged trees and run no worktrees.setup, and merges integrate nothing. A branch on a captured change can differ from a real run.',
      );
      if (event.baseSource === 'placeholder')
        this.warnings.add(
          `Step ${event.stepId}: the workflow cwd is not in a Git working tree, so a placeholder commit stands in for the base; a real run fails with a configuration error.`,
        );
      if (event.kind === 'isolation')
        this.isolations.set(JSON.stringify([event.stepId, event.attempt]), {
          synthesized: true,
          base: event.base,
          baseSource: event.baseSource,
        });
      else
        this.merges.push({
          stepId: event.stepId,
          synthesized: true,
          commit: event.commit,
          inputs: event.inputs,
          target: event.target,
          baseSource: event.baseSource,
        });
    },
  };
  public observe(event: WorkflowEvent): void {
    if (event.type === 'step.replayed' || event.type === 'step.reused')
      this.replays.push(event.stepId);
    if (event.type === 'step.completed') this.skippedSleeps.add(event.stepId);
  }
  public report(record: RunRecord | null): RehearsalReport {
    for (const call of this.calls) {
      const policy = record?.steps[call.stepId]?.attemptHistory?.find(
        (attempt) => attempt.attempt === call.attempt,
      );
      if (policy) {
        call.limits = policy.policy;
        const defaults = Object.entries(policy.sources)
          .filter(
            ([key, source]) =>
              ['timeoutMs', 'idleTimeoutMs', 'maxTurns', 'maxBudgetUsd'].includes(key) &&
              (source === 'harness' || source.startsWith('profile:')),
          )
          .map(([key]) => key);
        if (defaults.length)
          this.warnings.add(
            `Step ${call.stepId}: default/profile limits remain in use for ${defaults.join(', ')}.`,
          );
      }
    }
    if (record?.status === 'suspended')
      this.warnings.add(
        Object.values(record.steps).some((step) => step.status === 'waiting' && step.question)
          ? 'Rehearsal stopped at an unanswered question. Temporary state is removed; answer/resume commands are unavailable. Start a real run to request and persist the decision.'
          : 'Rehearsal stopped at an unresolved external wait. Temporary state is removed; start a real run to keep polling or resume later.',
      );
    const staleExecFixtures = this.execRules.stale();
    if (staleExecFixtures.length)
      this.warnings.add(
        `Exec fixture rules ${staleExecFixtures.join(', ')} matched no command; check their step, argvPrefix, digests and occurrence. Rules for steps replayed from a checkpoint are always stale.`,
      );
    // A fully completed resume short-circuits before body events; all saved effects replay as a unit.
    const replayed =
      this.calls.length === 0 &&
      this.commands.length === 0 &&
      this.replays.length === 0 &&
      record?.status === 'completed'
        ? Object.entries(record.steps)
            .filter(([, step]) => step.status === 'completed' || step.status === 'settled-failed')
            .sort((a, b) => (a[1].seq ?? 0) - (b[1].seq ?? 0))
            .map(([stepId, step]) => ({ stepId, kind: step.kind }))
        : this.replays.map((stepId) => ({
            stepId,
            kind: record?.steps[stepId]?.kind ?? 'unknown',
          }));
    return structuredClone({
      kind: 'workflow.rehearsal',
      calls: this.calls,
      commands: this.commands,
      merges: this.merges,
      replays: replayed,
      harnessCounts: Object.fromEntries(
        [...new Set(this.calls.map((call) => call.harness))].map((name) => [
          name,
          this.calls.filter((call) => call.harness === name).length,
        ]),
      ),
      providerCounts: {
        claude: this.calls.filter((call) => call.harness === 'claude').length,
        codex: this.calls.filter((call) => call.harness === 'codex').length,
      },
      nominalClaudeCeilingUsd: this.calls.reduce(
        (sum, call) =>
          sum + (call.harness === 'claude' && call.wouldPay ? (call.limits?.maxBudgetUsd ?? 0) : 0),
        0,
      ),
      stubbedSteps: [...this.stubbedSteps],
      staleExecFixtures,
      skippedSleeps: [...this.skippedSleeps].filter((id) => {
        const step = record?.steps[id];
        return (
          step?.kind === 'sleep' ||
          (step?.kind === 'wait' && !step.question && !step.wait?.request.poll)
        );
      }),
      warnings: [...this.warnings],
    });
  }
}

/** The report fields every command entry shares. */
function commandEntry(
  request: ProcessRunRequest,
  invocation: HarnessInvocation,
): Pick<RehearsalCommand, 'stepId' | 'parentStepId' | 'command' | 'cwd' | 'structured'> {
  return {
    stepId: invocation.stepId,
    parentStepId: request.nested === true ? invocation.stepId : null,
    command: request.command,
    cwd: request.cwd,
    structured: request.schema !== null,
  };
}

function hasRefinement(schema: z.ZodType): boolean {
  const seen = new Set<object>();
  function visit(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const node = value as Record<string, unknown>;
    if (node['check'] === 'custom') return true;
    if ('_zod' in node) return visit(node['_zod']);
    return Object.values(node).some(visit);
  }
  return visit(schema);
}

/** Copy only checkpoint data, never source locks or child process registries. @internal */
export async function rehearsalState(
  runId: string,
  sourceStateDir: string,
  resume: boolean,
): Promise<{ stateDir: string; dispose: () => Promise<void> }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'quiet-choir-rehearsal-'));
  const dispose = async (): Promise<void> => {
    await rm(stateDir, { recursive: true, force: true });
  };
  try {
    if (resume) {
      await mkdir(runDirectory(stateDir, runId), { recursive: true, mode: 0o700 });
      await writeRun(stateDir, await readRequiredRun({ runId, stateDir: sourceStateDir }));
    }
    return { stateDir, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
