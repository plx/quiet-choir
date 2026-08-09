import { createStubPlan, StubExecutor } from '../../application/stub.js';
import { BaseCommand } from '../../cli/base-command.js';
import { formatStubResult } from '../../cli/presentation.js';

export default class WorkflowValidate extends BaseCommand {
  public static override readonly summary = 'Validate a workflow';

  public async run(): Promise<void> {
    const { flags } = await this.parse(WorkflowValidate);
    const plan = createStubPlan('workflow.validate');
    const executor = new StubExecutor(this.createExecutionLogger(flags));
    const result = await executor.execute(plan);

    this.log(formatStubResult(result));
    this.exit(2);
  }
}
