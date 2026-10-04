import { z } from 'zod';
import { analyzeTypecheckEntrypoint } from '../workflow/typecheck/plan.js';
import { TypeScriptExecutor } from '../workflow/typecheck/typescript-executor.js';
import type { TypecheckProgramCache } from '../workflow/typecheck/program-cache.js';
import { importWorkflow } from '../workflow/loader/import.js';
import { describeWorkflow } from '../workflow/runtime/definition.js';
import { harnessDefinitions } from '../workflow/runtime/harness-registry.js';
import type { HarnessSelection } from '../workflow/loader/harness-selection.js';
import type { ExecutionLogger, ExecutionPlan, Executor } from './execution.js';
import type { ProcessSupervisor } from '../processes/supervisor.js';
import {
  probeHarnessContracts,
  strictVersionFailure,
  summarizeDoctorChecks,
  type DoctorOptions,
  type DoctorReport,
} from '../harnesses/doctor.js';
/** Plain-data configuration diagnostic plan. */
export interface DoctorPlan
  extends ExecutionPlan, Omit<DoctorOptions, 'signal' | 'processSupervisor' | 'harness'> {
  readonly kind: 'configuration.doctor';
  readonly harness?: string;
  readonly workflow?: string;
  readonly configuration?: HarnessSelection;
}
const widenStep =
  'from a quiet-choir checkout run `npm run build && npm run test:contract`, then widen testedHarnessVersions';

/**
 * Final line of the text report: the verdict and, unless everything passed, the next command. An
 * untested patch version names the contract run that justifies widening the tested range.
 */
export function doctorVerdictLine(
  report: Pick<DoctorReport, 'verdict' | 'checks' | 'harnesses'>,
): string {
  if (report.verdict === 'ok') return 'ok';
  const untested = (check: DoctorReport['checks'][number]): boolean =>
    check.check === 'version' &&
    (check.status === 'warn' || check.message.includes(strictVersionFailure));
  const named = report.checks
    .filter(untested)
    .map((check) => `${check.harness} ${report.harnesses[check.harness]?.version ?? 'unknown'}`)
    .join(', ');
  if (report.verdict === 'usable-with-warnings')
    return `usable with warnings: ${named || 'a harness'} is an untested patch version; ${widenStep} (or pass --strict to treat this as a failure)`;
  const onlyStrict =
    named !== '' && report.checks.every((check) => check.status !== 'fail' || untested(check));
  return onlyStrict
    ? `blocked: ${named} is an untested patch version and --strict treats it as a failure; ${widenStep} (or rerun without --strict)`
    : 'blocked: fix the FAIL checks above, then rerun `quiet-choir configuration doctor`';
}

/** Framework-independent execution of harness contract probes. */
export class DoctorExecutor implements Executor<
  DoctorPlan,
  DoctorReport & { readonly kind: 'configuration.doctor.result' }
> {
  public constructor(
    private readonly logger: ExecutionLogger,
    private readonly signal?: AbortSignal | undefined,
    private readonly processSupervisor?: ProcessSupervisor | undefined,
    /** Internal: a program cache shared with other type checks; tests pass one. @internal */
    private readonly typecheckCache?: TypecheckProgramCache | undefined,
  ) {}
  public async execute(
    plan: DoctorPlan,
  ): Promise<DoctorReport & { readonly kind: 'configuration.doctor.result' }> {
    this.logger.log('trace', 'Executing plan for configuration.doctor');
    if (plan.workflow !== undefined) {
      const analyzed = analyzeTypecheckEntrypoint(plan.workflow, plan.cwd ?? process.cwd());
      if (!analyzed.ok) throw new Error(analyzed.error.message);
      const checked = await new TypeScriptExecutor(this.logger, {
        cache: this.typecheckCache,
      }).execute(analyzed.plan);
      if (!checked.ok)
        throw new Error(
          `Workflow type check failed: ${checked.diagnostics.map((item) => item.message).join('; ')}`,
        );
      this.signal?.throwIfAborted();
      const imported = await importWorkflow(analyzed.plan);
      try {
        const description = describeWorkflow(imported.definition, analyzed.plan.entrypoint);
        const definitions = harnessDefinitions(imported.definition);
        if (plan.harness && plan.harness !== 'all' && !definitions.has(plan.harness))
          throw new Error(
            `Workflow ${imported.definition.name} has no declared harness ${plan.harness}.`,
          );
        const checks: DoctorReport['checks'][number][] = [];
        const harnesses: DoctorReport['harnesses'] = {};
        for (const definition of definitions.values()) {
          if (
            plan.harness !== undefined &&
            plan.harness !== 'all' &&
            plan.harness !== definition.name
          )
            continue;
          this.signal?.throwIfAborted();
          if (!definition.probe) {
            checks.push({
              harness: definition.name,
              check: 'registry',
              status: 'pass',
              ok: true,
              message: `${definition.name}@${String(definition.revision)} registered; no package probe.`,
            });
            continue;
          }
          try {
            const configurations = plan.configuration?.configurations ?? {};
            const config = Object.hasOwn(configurations, definition.name)
              ? (configurations[definition.name] ?? {})
              : {};
            const probe = z
              .object({ version: z.string().nullable() })
              .parse(await definition.probe(config, this.signal));
            checks.push({
              harness: definition.name,
              check: 'version',
              status: 'pass',
              ok: true,
              message: probe.version ?? 'Version unavailable',
            });
            harnesses[definition.name] = { binary: definition.name, version: probe.version };
          } catch (cause) {
            if (this.signal?.aborted) throw cause;
            checks.push({
              harness: definition.name,
              check: 'version',
              status: 'fail',
              ok: false,
              message: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
        return {
          kind: 'configuration.doctor.result',
          ...summarizeDoctorChecks(checks),
          zeroInference: true,
          checks,
          harnesses,
          registered: description.harnesses,
        };
      } finally {
        imported.dispose?.();
      }
    }
    const harness = plan.harness ?? 'all';
    if (harness !== 'all' && harness !== 'claude' && harness !== 'codex')
      throw new Error(`Harness ${harness} requires --workflow to load its declared probe.`);
    return {
      kind: 'configuration.doctor.result',
      ...(await probeHarnessContracts({
        ...plan,
        harness,
        ...(this.signal ? { signal: this.signal } : {}),
        ...(this.processSupervisor ? { processSupervisor: this.processSupervisor } : {}),
      })),
    };
  }
}
