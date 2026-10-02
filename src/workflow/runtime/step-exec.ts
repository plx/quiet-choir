import { z } from 'zod';
import { CheckpointError } from './checkpoint.js';
import { ConfigurationError } from './configuration-error.js';
import { ExecError } from './exec-error.js';
import { executeCommand, prepareExec, processRequest } from './exec.js';
import { execResultSchema } from './exec-schema.js';
import type {
  Command,
  ExecStepError,
  ProcessRunner,
  StepExecFunction,
  StepExecOptions,
} from './exec-model.js';
import type { HarnessInvocation } from './model.js';
import { schemaJson } from './schema.js';
import { errorKind, execFailureFields, stepError } from './step-error.js';

// The defaults of the durable `ctx.exec` effect; RunOptions.policy rules never apply here.
const defaultTimeoutMs = 300_000;
const defaultMaxOutputBytes = 1_048_576;

/** What a callback's `context.exec` is bound to. @internal */
export interface StepExecDependencies {
  /** The owning step or wait, for messages. */
  readonly owner: { readonly kind: 'step' | 'wait'; readonly id: string };
  /** The callback's actual cwd; a relative `cwd` option resolves against it. */
  readonly cwd: string;
  /** The parent attempt, used for a returned failure's `attempts`. */
  readonly attempt: number;
  /** The parent's signal; a child is stopped when it aborts or when the handle closes. */
  readonly signal: AbortSignal;
  /** Strict option schema: the step variant rejects `live`, the poll variant accepts it. */
  readonly options: z.ZodType;
  /** Ownership of the child under the parent's ID and attempt, cancelled by `signal`. */
  readonly invocation: (signal: AbortSignal) => HarnessInvocation;
  /** The runner for a call; `live` is true only for an observer's `live: true`. */
  readonly runner: (live: boolean) => ProcessRunner | undefined;
  /** Whether the callback or observation is still running. */
  readonly active: () => boolean;
  /** Report an `exec.json` schema, for rehearsal diagnostics. */
  readonly onSchema?: (schema: z.ZodType) => void;
}

/**
 * Build the non-durable `context.exec` of a step callback or poll observer. Every call writes no
 * checkpoint: it prepares the command like `ctx.exec`, marks the request `nested`, and runs it
 * under the parent's invocation. {@link StepExecHandle.close} refuses later calls, aborts calls
 * still running and waits for them to finish.
 * @internal
 */
export function createStepExec(dependencies: StepExecDependencies): StepExecHandle {
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  // Created on the first call, so a callback that never runs a command costs no signal.
  let controller: AbortController | undefined;
  let combined: AbortSignal | undefined;
  const scope: CallScope = {
    active: () => !closed && dependencies.active(),
    signal: () => {
      controller ??= new AbortController();
      combined ??= AbortSignal.any([dependencies.signal, controller.signal]);
      return combined;
    },
  };
  const run = (command: Command, options: unknown, schema: z.ZodType | null): Promise<unknown> => {
    const call = execute(dependencies, scope, command, options, schema);
    pending.add(call);
    // A command the callback never awaited is terminated when the parent settles; its rejection is
    // expected, so it never surfaces as unhandled.
    void call.catch(() => undefined).finally(() => pending.delete(call));
    return call;
  };
  const exec = ((command: Command, options?: unknown) =>
    run(command, options, null)) as StepExecFunction;
  Object.defineProperty(exec, 'json', {
    value: (command: Command, options: unknown) => {
      const schema: unknown =
        options !== null && typeof options === 'object' && 'schema' in options
          ? options.schema
          : undefined;
      if (!(schema instanceof z.ZodType))
        return Promise.reject(
          new Error(`${label(dependencies)}: context.exec.json requires a Zod schema.`),
        );
      return run(command, options, schema);
    },
    enumerable: true,
  });
  return {
    exec,
    close: async (reason) => {
      closed = true;
      controller?.abort(reason);
      await Promise.allSettled([...pending]);
    },
  };
}

/** A bound `context.exec` and the drain of its calls. @internal */
export interface StepExecHandle {
  readonly exec: StepExecFunction;
  /** Refuse further calls, abort running ones with `reason`, and wait until all have settled. */
  readonly close: (reason: Error) => Promise<void>;
}

interface CallScope {
  readonly active: () => boolean;
  readonly signal: () => AbortSignal;
}

function label({ owner }: StepExecDependencies): string {
  return `${owner.kind === 'step' ? 'Step' : 'Wait'} ${owner.id}`;
}

async function execute(
  dependencies: StepExecDependencies,
  scope: CallScope,
  command: Command,
  options: unknown,
  schema: z.ZodType | null,
): Promise<unknown> {
  if (!scope.active())
    throw new Error(
      `${label(dependencies)}: context.exec must be called while its ${dependencies.owner.kind === 'step' ? 'callback' : 'poll observation'} is active.`,
    );
  const signal = scope.signal();
  signal.throwIfAborted();
  const raw: unknown = options ?? {};
  const fields =
    schema !== null && raw !== null && typeof raw === 'object'
      ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'schema'))
      : raw;
  let parsed: StepExecOptions & { readonly live?: boolean };
  try {
    parsed = dependencies.options.parse(fields) as typeof parsed;
  } catch (cause) {
    throw new Error(
      `${label(dependencies)}: invalid context.exec options: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  const { live = false, onError, ...settings } = parsed;
  const prepared = await prepareExec(command, settings, dependencies.cwd, schema !== null);
  const outputSchema = schema ?? execResultSchema;
  if (schema !== null) dependencies.onSchema?.(schema);
  const request = processRequest(
    prepared,
    {
      cwd: prepared.summary.cwd,
      timeoutMs: prepared.settings.timeoutMs ?? defaultTimeoutMs,
      maxOutputBytes: prepared.settings.maxOutputBytes ?? defaultMaxOutputBytes,
    },
    schema === null ? null : schemaJson(outputSchema),
    true,
  );
  // The parent may have settled while the command was prepared: never start it then.
  signal.throwIfAborted();
  try {
    const value = await executeCommand(
      dependencies.runner(live),
      request,
      dependencies.invocation(signal),
      prepared.summary.okExitCodes,
      schema,
    );
    return onError === 'return' ? { ok: true, value } : value;
  } catch (error) {
    if (onError !== 'return' || !settles(error, signal)) throw error;
    const failure: ExecStepError = {
      ...stepError(error, dependencies.attempt),
      ...(error instanceof ExecError ? execFailureFields(error) : {}),
    };
    return { ok: false, error: failure };
  }
}

/** Whether `onError: 'return'` may turn a failure into a value: never cancellation or setup errors. */
function settles(error: unknown, signal: AbortSignal): boolean {
  return !(
    signal.aborted ||
    error instanceof ConfigurationError ||
    error instanceof CheckpointError ||
    errorKind(error) === 'cancelled'
  );
}
