import { createStubPlan, StubExecutor } from '../../application/stub.js';
import { BaseCommand } from '../../cli/base-command.js';
import { formatStubResult } from '../../cli/presentation.js';

export default class ConfigurationSet extends BaseCommand {
  public static override readonly summary = 'Set a configuration value';

  public async run(): Promise<void> {
    const { flags } = await this.parse(ConfigurationSet);
    const plan = createStubPlan('configuration.set');
    const executor = new StubExecutor(this.createExecutionLogger(flags));
    const result = await executor.execute(plan);

    this.log(formatStubResult(result));
    this.exit(2);
  }
}
