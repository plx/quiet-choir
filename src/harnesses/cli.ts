import type {
  Harness,
  HarnessRequest,
  ClaudeOptions,
  CodexOptions,
  HarnessRequestInput,
  HarnessInvocation,
  HarnessMetadata,
  HarnessResponse,
  ExecutionPolicy,
} from '../harness-kit.js';
import { ClaudeAdapter, CodexAdapter } from './builtins/adapters.js';
import type { CliHarnessOptions, CliHarnessPlan } from './native-cli.js';
export type { CliHarnessOptions, CliHarnessPlan } from './native-cli.js';

/** Compatibility dispatcher for the two built-in adapters. Unknown names always reject. */
export class CliHarness implements Harness {
  /** Native CLI provenance, unchanged for existing embedders. */
  public readonly kind = 'cli';
  readonly #claude: ClaudeAdapter;
  readonly #codex: CodexAdapter;
  /** Configure native executable paths and resource bounds. */
  public constructor(options: CliHarnessOptions = {}) {
    const { claudeBinary, codexBinary, ...limits } = options;
    this.#claude = new ClaudeAdapter({
      ...limits,
      ...(claudeBinary === undefined ? {} : { binary: claudeBinary }),
    });
    this.#codex = new CodexAdapter({
      ...limits,
      ...(codexBinary === undefined ? {} : { binary: codexBinary }),
    });
  }
  #adapter(name: string): ClaudeAdapter | CodexAdapter {
    if (name === 'claude') return this.#claude;
    if (name === 'codex') return this.#codex;
    throw new Error(`CliHarness does not support harness ${name}; register a named adapter.`);
  }
  #durable(
    request: HarnessRequestInput<ClaudeOptions | CodexOptions>,
    invocation: HarnessInvocation,
  ): HarnessRequest {
    const call = {
      runId: invocation.runId,
      stepId: invocation.stepId,
      attempt: invocation.attempt,
      idempotencyKey: `${invocation.runId}/${invocation.stepId}`,
    };
    return { ...request, revision: request.revision ?? 1, ...call, call };
  }
  /** Effective native limits for diagnostic policy records. */
  public policyDefaults(harness: string): ExecutionPolicy {
    return this.#adapter(harness).policyDefaults();
  }
  /** Plan a native call without probing or launching it. */
  public plan(
    request: HarnessRequestInput<ClaudeOptions | CodexOptions>,
    context?: Pick<HarnessInvocation, 'sessionId' | 'policy'>,
  ): CliHarnessPlan {
    return this.#adapter(request.harness).plan(request, context);
  }
  /** Discover native installation metadata on live use. */
  public metadata(
    request: HarnessRequestInput<ClaudeOptions | CodexOptions>,
    invocation: HarnessInvocation,
  ): Promise<HarnessMetadata> {
    return this.#adapter(request.harness).metadata(
      this.#durable(request, invocation),
      invocation.signal,
      invocation,
    );
  }
  /** Invoke the selected native adapter with durable process ownership. */
  public invoke(
    request: HarnessRequestInput<ClaudeOptions | CodexOptions>,
    invocation: HarnessInvocation,
  ): Promise<HarnessResponse> {
    return this.#adapter(request.harness).invoke(
      this.#durable(request, invocation),
      invocation.signal,
      invocation,
    );
  }
}
