import type {
  AgentOptions,
  AgentRequest,
  HarnessAdapter,
  HarnessInvocation,
  HarnessRequestInput,
  HarnessResponse,
  HarnessMetadata,
  ExecutionPolicy,
  ClaudeOptions,
  CodexOptions,
} from '../../harness-kit.js';
import { NativeCliHarness, type CliHarnessOptions, type CliHarnessPlan } from '../native-cli.js';

/** Native process configuration for one built-in adapter; outside replay identity. */
export interface BuiltinAdapterOptions extends Omit<
  CliHarnessOptions,
  'claudeBinary' | 'codexBinary'
> {
  /** Executable override; defaults to the registered name on PATH. */
  readonly binary?: string;
}

/** Shared native implementation; each public adapter owns exactly one harness name. @internal */
export class BuiltinAdapter<O extends AgentOptions> implements HarnessAdapter<O> {
  public readonly kind = 'cli';
  readonly #native: NativeCliHarness;
  /** Single registered native harness supported by this adapter. */
  public readonly name: 'claude' | 'codex';
  public constructor(name: 'claude' | 'codex', options: BuiltinAdapterOptions = {}) {
    this.name = name;
    const { binary, ...limits } = options;
    this.#native = new NativeCliHarness({
      ...limits,
      ...(binary === undefined ? {} : { [`${name}Binary`]: binary }),
    });
  }
  #check(request: HarnessRequestInput): void {
    if (request.harness !== this.name)
      throw new Error(`Adapter ${this.name} cannot invoke harness ${request.harness}.`);
  }
  #invocation(
    request: AgentRequest<O>,
    signal: AbortSignal,
    invocation?: HarnessInvocation,
  ): HarnessInvocation {
    return {
      ...(invocation ?? {
        runId: request.runId,
        stepId: request.stepId,
        attempt: request.attempt,
        // Standalone adapter calls still reap processes; durable tracking belongs to runtime invocations.
        trackProcess: () => Promise.resolve({ release: () => Promise.resolve() }),
      }),
      signal,
    };
  }
  public policyDefaults(): ExecutionPolicy {
    return this.#native.policyDefaults(this.name);
  }
  /** Describe argv and private configuration artifacts without executing a process. */
  public plan(
    request: HarnessRequestInput,
    context?: Pick<HarnessInvocation, 'sessionId' | 'policy'>,
  ): CliHarnessPlan {
    this.#check(request);
    return this.#native.plan(request, context);
  }
  public metadata(
    request: AgentRequest<O>,
    signal: AbortSignal,
    invocation?: HarnessInvocation,
  ): Promise<HarnessMetadata> {
    this.#check(request);
    return this.#native.metadata(request, this.#invocation(request, signal, invocation));
  }
  public invoke(
    request: AgentRequest<O>,
    signal: AbortSignal,
    invocation?: HarnessInvocation,
  ): Promise<HarnessResponse> {
    this.#check(request);
    return this.#native.invoke(request, this.#invocation(request, signal, invocation));
  }
}

/** Claude Code adapter, using native subscription authentication and the public ownership kit. */
export class ClaudeAdapter extends BuiltinAdapter<ClaudeOptions> {
  /** Configure one Claude executable and its process limits. */
  public constructor(options: BuiltinAdapterOptions = {}) {
    super('claude', options);
  }
}

/** Codex CLI adapter, using native subscription authentication and the public ownership kit. */
export class CodexAdapter extends BuiltinAdapter<CodexOptions> {
  /** Configure one Codex executable and its process limits. */
  public constructor(options: BuiltinAdapterOptions = {}) {
    super('codex', options);
  }
}
