import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { z } from 'zod';
import { canonicalCwd } from './compatibility.js';
import { digest } from './json.js';
import { commandSchema, execOptionsSchema, execResultSchema } from './exec-schema.js';
import { ConfigurationError } from './configuration-error.js';
import { ExecError } from './exec-error.js';
import type {
  Command,
  ExecOptions,
  ExecSummary,
  ProcessRunRequest,
  ProcessRunner,
} from './exec-model.js';
import type { HarnessInvocation, JsonValue } from './model.js';

/** Snapshot and normalize live inputs before deriving identity or recording anything. @internal */
export async function prepareExec(
  command: Command,
  options: ExecOptions,
  cwd: string,
  structured: boolean,
): Promise<{
  settings: ExecOptions;
  summary: ExecSummary;
  env: Readonly<Record<string, string>>;
  input: string;
}> {
  const parsedCommand = commandSchema.parse(command);
  const settings = execOptionsSchema.parse(options) as ExecOptions;
  const directory = await canonicalCwd(resolve(cwd, settings.cwd ?? '.'));
  const env = settings.env ?? {};
  const input = settings.input ?? '';
  const codes = settings.okExitCodes ?? [0];
  const inheritEnv = settings.inheritEnv ?? true;
  const scrub = settings.scrubEnv ?? false;
  if (scrub !== false && !inheritEnv)
    throw new Error(
      'Exec scrubEnv requires the inherited environment; it cannot be combined with inheritEnv: false.',
    );
  const summary: ExecSummary = {
    command: parsedCommand,
    cwd: directory,
    envSha256: digest(env),
    inheritEnv,
    // Present only when enabled, so a command without the scrub keeps its identity byte-identical.
    ...(scrub === false ? {} : { scrubEnv: scrub === true ? [] : [...new Set(scrub)].sort() }),
    inputSha256: createHash('sha256').update(input).digest('hex'),
    okExitCodes: codes === 'any' ? codes : [...new Set(codes)].sort((a, b) => a - b),
    structured,
  };
  return { settings, summary, env, input };
}

/** Normalized inputs of one command, as {@link prepareExec} returns them. @internal */
export type PreparedExec = Awaited<ReturnType<typeof prepareExec>>;

/**
 * The live request for a prepared command, shared by the `ctx.exec` effect and a callback's
 * `context.exec`. `schema` is the output's JSON Schema for `exec.json`, or null for plain exec.
 * @internal
 */
export function processRequest(
  prepared: PreparedExec,
  limits: { readonly cwd: string; readonly timeoutMs: number; readonly maxOutputBytes: number },
  schema: JsonValue | null,
  nested = false,
): ProcessRunRequest {
  return {
    command: prepared.summary.command,
    cwd: limits.cwd,
    env: prepared.env,
    inheritEnv: prepared.summary.inheritEnv,
    ...(prepared.summary.scrubEnv === undefined ? {} : { scrubEnv: prepared.summary.scrubEnv }),
    input: prepared.input,
    timeoutMs: limits.timeoutMs,
    maxOutputBytes: limits.maxOutputBytes,
    capture: schema === null ? 'truncate' : 'error',
    schema,
    ...(nested ? { nested: true } : {}),
  };
}

/**
 * The message of a command whose exit code is outside its `okExitCodes`, or that ended by a signal
 * or without a code. Fixture export matches it to tell a reproducible exit failure from other
 * `process` failures. @internal
 */
export function execExitFailureMessage(exit: string): string {
  return `Command exited with ${exit}.`;
}

/**
 * The prefix of an `exec.json` failure (kind `schema`) whose stdout did not parse after exit 0, or
 * parsed but did not match the schema; the parse or validation message follows. Fixture export
 * matches it. @internal
 */
export const EXEC_SCHEMA_FAILURE_PREFIX = 'Command stdout did not match its JSON schema: ';

/**
 * The message of an `exec.json` failure whose nonzero exit code was accepted (listed in
 * `okExitCodes`, or `'any'`) but whose stdout is not JSON, such as `gh` exiting 1 with empty or
 * partial output after a dropped connection. The command failed and printed no body, so the failure
 * is kind `process`, not `schema`; the decision reads only the exit code and whether `JSON.parse`
 * succeeded, never message text (ADR 0007, ADR 0021 as amended by #349). `detail` is the parse
 * error message. Fixture export matches the message through {@link isExecNoJsonFailureMessage}.
 * @internal
 */
export function execNoJsonFailureMessage(code: number, detail: string): string {
  return `${execNoJsonFailurePrefix(code)}${detail}`;
}

/** Whether a message is {@link execNoJsonFailureMessage} for `code`. @internal */
export function isExecNoJsonFailureMessage(message: string, code: number): boolean {
  return message.startsWith(execNoJsonFailurePrefix(code));
}

function execNoJsonFailurePrefix(code: number): string {
  return `Command exited with ${String(code)} without JSON on stdout: `;
}

/**
 * Execute and validate inside the runtime's single tracked effect. A rejected exit or signal is kind
 * `process`; for `exec.json`, a truncated capture is `output-limit`, stdout that is not JSON after an
 * accepted nonzero exit is `process` ({@link execNoJsonFailureMessage}), and any other stdout that
 * does not parse or match the schema is `schema`. @internal
 */
export async function executeCommand<T>(
  runner: ProcessRunner | undefined,
  request: ProcessRunRequest,
  invocation: HarnessInvocation,
  accepted: ExecSummary['okExitCodes'],
  schema: z.ZodType<T> | null,
): Promise<T | z.infer<typeof execResultSchema>> {
  if (!runner)
    throw new ConfigurationError(
      'No process adapter configured. Supply RunOptions.processRunner (for example, NodeProcessRunner).',
    );
  const result = execResultSchema.parse(await runner.run(request, invocation));
  // A failed exec.json keeps the complete JSON it printed, so a settled failure can branch on it.
  const failure = () =>
    schema === null || result.truncated ? {} : { parsed: boundedJson(result.stdout) };
  if (
    result.code === null ||
    result.signal !== null ||
    (accepted !== 'any' && !accepted.includes(result.code))
  )
    throw new ExecError(
      execExitFailureMessage(result.signal ?? String(result.code)),
      'process',
      result,
      failure(),
    );
  if (!schema) return result;
  if (result.truncated)
    throw new ExecError('Structured command output was truncated.', 'output-limit', result);
  const reject = (cause: unknown, kind: 'process' | 'schema', message: string): never => {
    throw new ExecError(message, kind, result, { cause, ...failure() });
  };
  const detail = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
  let json: JsonValue;
  try {
    json = JSON.parse(result.stdout) as JsonValue;
  } catch (cause) {
    // An accepted nonzero exit with no JSON body is a failed command, not a contract violation:
    // the caller accepted that code only to read a body. Exit 0 with no JSON stays `schema`.
    return result.code === 0
      ? reject(cause, 'schema', `${EXEC_SCHEMA_FAILURE_PREFIX}${detail(cause)}`)
      : reject(cause, 'process', execNoJsonFailureMessage(result.code, detail(cause)));
  }
  try {
    return schema.parse(json);
  } catch (cause) {
    return reject(cause, 'schema', `${EXEC_SCHEMA_FAILURE_PREFIX}${detail(cause)}`);
  }
}

/** Largest stdout, in UTF-8 bytes, that a settled exec.json failure keeps as `parsed`. @internal */
export const SETTLED_PARSED_MAX_BYTES = 16_384;

/** Stdout as JSON when it is small enough and valid; never throws. */
function boundedJson(stdout: string): JsonValue | undefined {
  if (Buffer.byteLength(stdout, 'utf8') > SETTLED_PARSED_MAX_BYTES) return undefined;
  try {
    return JSON.parse(stdout) as JsonValue;
  } catch {
    return undefined;
  }
}
