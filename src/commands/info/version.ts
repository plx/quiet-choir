import { createVersionPlan, VersionExecutor } from '../../application/version.js';
import { BaseCommand } from '../../cli/base-command.js';

export default class InfoVersion extends BaseCommand {
  public static override readonly summary = 'Show the quiet-choir version';

  public async run(): Promise<void> {
    const { flags } = await this.parse(InfoVersion);
    const plan = createVersionPlan();
    const executor = new VersionExecutor(this.config.version, this.createExecutionLogger(flags));
    const result = await executor.execute(plan);

    this.log(result.version);
  }
}
