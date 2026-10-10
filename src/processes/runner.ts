import type { HarnessInvocation } from '../workflow/runtime/model.js';
import type {
  ProcessRunner,
  ProcessRunRequest,
  ExecResult,
} from '../workflow/runtime/exec-model.js';
import { ExecError } from '../workflow/runtime/exec-error.js';
import { CheckpointError } from '../workflow/runtime/checkpoint.js';
import { errorKind } from '../workflow/runtime/step-error.js';
import { childEnvironment } from '../harnesses/environment.js';
import { runProcess, type ProcessResult } from './run.js';

/** Native process integration using owned groups and bounded output capture. */
export class NodeProcessRunner implements ProcessRunner {
  public async run(request: ProcessRunRequest, invocation: HarnessInvocation): Promise<ExecResult> {
    const command =
      'shell' in request.command
        ? process.platform === 'win32'
          ? (['cmd.exe', '/d', '/s', '/c', request.command.shell] as const)
          : (['sh', '-c', request.command.shell] as const)
        : request.command;
    // An opted-in scrub builds the inherited part here, with the agent children's patterns; the
    // overlay is spread rather than passed as edits, since exec env keys allow names edits reject.
    const scrubbed =
      request.inheritEnv && request.scrubEnv !== undefined
        ? childEnvironment(undefined, request.scrubEnv).env
        : undefined;
    try {
      const result = await runProcess({
        binary: command[0],
        args: command.slice(1),
        cwd: request.cwd,
        env: {
          ...scrubbed,
          ...request.env,
          QUIET_CHOIR_IDEMPOTENCY_KEY: `${invocation.runId}/${invocation.stepId}`,
          QUIET_CHOIR_RUN_ID: invocation.runId,
          QUIET_CHOIR_STEP_ID: invocation.stepId,
          QUIET_CHOIR_ATTEMPT: String(invocation.attempt),
        },
        inheritEnv: scrubbed === undefined && request.inheritEnv,
        input: request.input,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
        capture: request.capture,
        killGraceMs: 1000,
        signal: invocation.signal,
        trackProcess: (child) => invocation.trackProcess(child),
      });
      return result;
    } catch (error) {
      // Durable registration failures must remain infrastructure failures, never retryable data.
      if (error instanceof CheckpointError) throw error;
      const result =
        error instanceof Error && 'processResult' in error
          ? (error.processResult as ProcessResult)
          : undefined;
      const kind = errorKind(error);
      throw new ExecError(
        error instanceof Error ? error.message : String(error),
        kind === 'unknown' ? 'process' : kind,
        result,
        { cause: error },
      );
    }
  }
}
