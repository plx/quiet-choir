import { readHarnessSelection } from '../../workflow/loader/harness-selection.js';
import { Flags, type Interfaces } from '@oclif/core';
import { DoctorExecutor, doctorVerdictLine } from '../../application/doctor.js';
import { BaseCommand } from '../../cli/base-command.js';
import { executionSignals, tolerateClosedTerminal } from '../../cli/signals.js';
import { ProcessSupervisor } from '../../processes/supervisor.js';

interface DoctorFlags {
  readonly workflow: string | undefined;
  readonly 'harness-config': string | undefined;
  readonly json: boolean | undefined;
  readonly strict: boolean | undefined;
  readonly harness: string;
  readonly 'claude-binary': string | undefined;
  readonly 'codex-binary': string | undefined;
  readonly 'codex-home': string | undefined;
  readonly 'codex-profile': string | undefined;
}

export default class ConfigurationDoctor extends BaseCommand {
  public static override readonly summary =
    'Probe harness versions, flags, enums and inherited defaults without inference';
  public static override readonly flags: Interfaces.FlagInput<DoctorFlags> = {
    workflow: Flags.file({
      description: 'Type-check a trusted workflow and list/probe its declared harness registry',
    }),
    'harness-config': Flags.string({
      description: 'Adapter JSON or @file; harnesses.<name> configures package probes',
      env: 'QUIET_CHOIR_HARNESS_CONFIG',
    }),
    json: Flags.boolean({ default: false, description: 'Print a structured contract report' }),
    strict: Flags.boolean({
      default: false,
      description: 'Treat an untested patch version as a failure (exit 1)',
    }),
    harness: Flags.string({
      default: 'all',
      description: 'Registered harness to diagnose, or all (custom names require --workflow)',
    }),
    'claude-binary': Flags.string({ description: 'Claude executable override' }),
    'codex-binary': Flags.string({ description: 'Codex executable override' }),
    'codex-home': Flags.directory({ description: 'Codex configuration directory' }),
    'codex-profile': Flags.string({ description: 'Native Codex configuration profile' }),
  };
  public async run(): Promise<void> {
    const { flags } = await this.parse(ConfigurationDoctor);
    tolerateClosedTerminal();
    const supervisor = new ProcessSupervisor();
    const controller = executionSignals(
      supervisor,
      (message) => {
        this.logToStderr(message);
      },
      'Doctor',
    );
    try {
      const result = await new DoctorExecutor(
        this.createExecutionLogger(flags),
        controller.signal,
        supervisor,
      ).execute({
        kind: 'configuration.doctor',
        ...(flags.workflow === undefined ? {} : { workflow: flags.workflow }),
        ...(flags['harness-config'] === undefined
          ? {}
          : {
              configuration: await readHarnessSelection(
                'cli',
                flags['harness-config'],
                process.cwd(),
              ),
            }),
        cwd: process.cwd(),
        harness: flags.harness,
        ...(flags.strict ? { strict: true } : {}),
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
                  `${check.status.toUpperCase()} ${check.harness} ${check.check}: ${check.message}`,
              )
              .concat(doctorVerdictLine(result))
              .join('\n'),
      );
      if (result.verdict === 'blocked') this.exit(1);
    } catch (error) {
      if (controller.signal.aborted) this.exit(130);
      throw error;
    } finally {
      controller.dispose();
    }
  }
}
