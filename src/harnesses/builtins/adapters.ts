import type {
  AgentOptions,
  AgentRequest,
  HarnessAdapter,
  HarnessInvocation,
  HarnessRequestInput,
  HarnessResponse,
  HarnessMetadata,
  ExecutionPolicy,
  ProjectInstructions,
  ClaudeOptions,
  CodexOptions,
} from '../../harness-kit.js';
import { standaloneInvocation } from '../../harness-kit.js';
import { NativeCliHarness, type CliHarnessOptions, type CliHarnessPlan } from '../native-cli.js';

/** Native process configuration for one built-in adapter; outside replay identity. */
export interface BuiltinAdapterOptions extends Omit<
  CliHarnessOptions,
  'claudeBinary' | 'codexBinary'
> {
  /** Executable override; defaults to the registered name on PATH. */
  readonly binary?: string;
}

/**
 * Shared native implementation behind {@link ClaudeAdapter} and {@link CodexAdapter}; each public
 * adapter owns exactly one harness name. Exported as a type only: construct the public subclasses.
 */
export class BuiltinAdapter<O extends AgentOptions> implements HarnessAdapter<O> {
  /** Adapter category: built-ins launch an installed command-line harness. */
  public readonly kind = 'cli';
  readonly #native: NativeCliHarness;
  /** Single registered native harness supported by this adapter. */
  public readonly name: 'claude' | 'codex';
  /** Bind the shared implementation to one harness name and its process configuration. */
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
    // Standalone adapter calls still reap processes; durable tracking belongs to runtime invocations.
    return invocation ? { ...invocation, signal } : standaloneInvocation(request, signal);
  }
  /** Execution-policy defaults the native harness applies when a call sets none. */
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
  /** Report the installed CLI's version and other provenance without running the task. */
  public metadata(
    request: AgentRequest<O>,
    signal: AbortSignal,
    invocation?: HarnessInvocation,
  ): Promise<HarnessMetadata> {
    this.#check(request);
    return this.#native.metadata(request, this.#invocation(request, signal, invocation));
  }
  /** Report the project-level instruction files the harness loads from `request.cwd`, spawning nothing. */
  public projectInstructions(
    request: AgentRequest<O>,
    signal: AbortSignal,
    invocation?: HarnessInvocation,
  ): Promise<ProjectInstructions | undefined> {
    this.#check(request);
    return this.#native.projectInstructions(request, this.#invocation(request, signal, invocation));
  }
  /** Perform one fresh headless call; standalone calls get {@link standaloneInvocation}. */
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
