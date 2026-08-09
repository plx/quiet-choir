import { createStubPlan, StubExecutor } from '../../application/stub.js';
import { BaseCommand } from '../../cli/base-command.js';
import { formatStubResult } from '../../cli/presentation.js';

export default class ConfigurationGet extends BaseCommand {
  public static override readonly summary = 'Read a configuration value';

  public async run(): Promise<void> {
    const { flags } = await this.parse(ConfigurationGet);
    const plan = createStubPlan('configuration.get');
    const executor = new StubExecutor(this.createExecutionLogger(flags));
    const result = await executor.execute(plan);

    this.log(formatStubResult(result));
    this.exit(2);
  }
}
