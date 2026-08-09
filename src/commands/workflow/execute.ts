import { createStubPlan, StubExecutor } from '../../application/stub.js';
import { BaseCommand } from '../../cli/base-command.js';
import { formatStubResult } from '../../cli/presentation.js';

export default class WorkflowExecute extends BaseCommand {
  public static override readonly summary = 'Execute a workflow';

  public async run(): Promise<void> {
    const { flags } = await this.parse(WorkflowExecute);
    const plan = createStubPlan('workflow.execute');
    const executor = new StubExecutor(this.createExecutionLogger(flags));
    const result = await executor.execute(plan);

    this.log(formatStubResult(result));
    this.exit(2);
  }
}
