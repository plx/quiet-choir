import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';
import { CliHarness, type CliHarnessPlan } from '../../harnesses/cli.js';
import { FixtureHarness } from '../../harnesses/fixture.js';
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
  readonly provider: 'claude' | 'codex';
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
}
/** Plain-data report; its checkpoint has already been removed from temporary storage. @internal */
export interface RehearsalReport {
  readonly kind: 'workflow.rehearsal';
  readonly calls: readonly RehearsalCall[];
  readonly replays: readonly { stepId: string; kind: string }[];
  readonly providerCounts: { claude: number; codex: number };
  readonly nominalClaudeCeilingUsd: number;
  readonly stubbedSteps: readonly string[];
  readonly skippedSleeps: readonly string[];
  readonly warnings: readonly string[];
}

/** Process-free harness and observation collector; never delegates metadata or invoke to CliHarness. @internal */
export class RehearsalHarness extends FixtureHarness {
  public override readonly kind = 'dry-run';
  private readonly cli: CliHarness;
  private readonly calls: RehearsalCall[] = [];
  private readonly replays: string[] = [];
  private readonly stubbedSteps = new Set<string>();
  private readonly skippedSleeps = new Set<string>();
  private readonly warnings = new Set<string>([
    'Local callbacks and workflow top-level code run for real. Temporary checkpoints do not roll back filesystem or external effects; use --stub-steps for selected local effects.',
    'The nominal Claude ceiling covers only attempted calls on the rehearsed path. One-item synthesized arrays can understate fan-out; Codex calls are counted, not priced. CLI budget limits can overshoot on a final turn.',
  ]);
  public constructor(
    selection: HarnessSelection,
    private readonly stubPatterns: readonly string[] = [],
  ) {
    super({ version: 1, calls: selection.fixtures?.calls ?? [], unmatched: 'synthesize' });
    this.cli = new CliHarness(selection.config);
    for (const match of stubPatterns) policyOverrideSchema.parse({ match });
  }
  public policyDefaults(provider: HarnessRequest['provider']): ExecutionPolicy {
    return this.cli.policyDefaults(provider);
  }
  public override async invoke(
    request: HarnessRequest,
    invocation: HarnessInvocation,
  ): Promise<HarnessResponse> {
    invocation.signal.throwIfAborted();
    const match = this.match(request);
    const call: RehearsalCall = {
      stepId: request.call.stepId,
      provider: request.provider,
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
    };
    this.calls.push(call);
    try {
      const planned = this.cli.plan(request);
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
        ...this.cli.policyDefaults(request.provider),
        timeoutMs: call.plan.timeoutMs,
        ...(request.provider === 'claude'
          ? {
              maxTurns: request.options.maxTurns ?? 10,
              maxBudgetUsd: request.options.maxBudgetUsd ?? 0.5,
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
              ['timeoutMs', 'maxTurns', 'maxBudgetUsd'].includes(key) &&
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
    // A fully completed resume short-circuits before body events; all saved effects replay as a unit.
    const replayed =
      this.calls.length === 0 && this.replays.length === 0 && record?.status === 'completed'
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
      replays: replayed,
      providerCounts: {
        claude: this.calls.filter((call) => call.provider === 'claude').length,
        codex: this.calls.filter((call) => call.provider === 'codex').length,
      },
      nominalClaudeCeilingUsd: this.calls.reduce(
        (sum, call) =>
          sum +
          (call.provider === 'claude' && call.wouldPay ? (call.limits?.maxBudgetUsd ?? 0) : 0),
        0,
      ),
      stubbedSteps: [...this.stubbedSteps],
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
