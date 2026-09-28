import type { ExecutionLogger, ExecutionPlan, Executor } from './execution.js';
import type { ProcessSupervisor } from '../processes/supervisor.js';
import {
  probeHarnessContracts,
  type DoctorOptions,
  type DoctorReport,
} from '../harnesses/doctor.js';
/** Plain-data configuration diagnostic plan. */
export interface DoctorPlan
  extends ExecutionPlan, Omit<DoctorOptions, 'signal' | 'processSupervisor'> {
  readonly kind: 'configuration.doctor';
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
  ) {}
  public async execute(
    plan: DoctorPlan,
  ): Promise<DoctorReport & { readonly kind: 'configuration.doctor.result' }> {
    this.logger.log('trace', 'Executing plan for configuration.doctor');
    return {
      kind: 'configuration.doctor.result',
      ...(await probeHarnessContracts({
        ...plan,
        ...(this.signal ? { signal: this.signal } : {}),
        ...(this.processSupervisor ? { processSupervisor: this.processSupervisor } : {}),
      })),
    };
  }
}
