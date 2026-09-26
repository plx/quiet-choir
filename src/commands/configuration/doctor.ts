import { Flags, type Interfaces } from '@oclif/core';
import { DoctorExecutor } from '../../application/doctor.js';
import { BaseCommand } from '../../cli/base-command.js';

interface DoctorFlags {
  readonly json: boolean | undefined;
  readonly harness: 'all' | 'claude' | 'codex';
  readonly 'claude-binary': string | undefined;
  readonly 'codex-binary': string | undefined;
  readonly 'codex-home': string | undefined;
  readonly 'codex-profile': string | undefined;
}

export default class ConfigurationDoctor extends BaseCommand {
  public static override readonly summary =
    'Probe harness versions, flags, enums and inherited defaults without inference';
  public static override readonly flags: Interfaces.FlagInput<DoctorFlags> = {
    json: Flags.boolean({ default: false, description: 'Print a structured contract report' }),
    harness: Flags.option({ options: ['all', 'claude', 'codex'] as const })({
      default: 'all',
      description: 'Harness to diagnose',
    }),
    'claude-binary': Flags.string({ description: 'Claude executable override' }),
    'codex-binary': Flags.string({ description: 'Codex executable override' }),
    'codex-home': Flags.directory({ description: 'Codex configuration directory' }),
    'codex-profile': Flags.string({ description: 'Native Codex configuration profile' }),
  };
  public async run(): Promise<void> {
    const { flags } = await this.parse(ConfigurationDoctor);
    const controller = new AbortController();
    const cancel = (): void => {
      controller.abort(new Error('Doctor interrupted.'));
    };
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const result = await new DoctorExecutor(
        this.createExecutionLogger(flags),
        controller.signal,
      ).execute({
        kind: 'configuration.doctor',
        cwd: process.cwd(),
        harness: flags.harness,
        ...(flags['claude-binary'] === undefined ? {} : { claudeBinary: flags['claude-binary'] }),
        ...(flags['codex-binary'] === undefined ? {} : { codexBinary: flags['codex-binary'] }),
        ...(flags['codex-home'] === undefined ? {} : { codexHome: flags['codex-home'] }),
        ...(flags['codex-profile'] === undefined ? {} : { codexProfile: flags['codex-profile'] }),
      });
      this.log(
        flags.json
          ? JSON.stringify(result)
          : result.checks
              .map(
                (check) =>
                  `${check.ok ? 'PASS' : 'FAIL'} ${check.provider} ${check.check}: ${check.message}`,
              )
              .join('\n'),
      );
      if (!result.ok) this.exit(1);
    } catch (error) {
      if (controller.signal.aborted) this.exit(130);
      throw error;
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  }
}
