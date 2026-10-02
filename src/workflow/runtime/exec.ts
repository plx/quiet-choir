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
  const summary: ExecSummary = {
    command: parsedCommand,
    cwd: directory,
    envSha256: digest(env),
    inheritEnv: settings.inheritEnv ?? true,
    inputSha256: createHash('sha256').update(input).digest('hex'),
    okExitCodes: codes === 'any' ? codes : [...new Set(codes)].sort((a, b) => a - b),
    structured,
  };
  return { settings, summary, env, input };
}

/** Execute and validate inside the runtime's single tracked effect. @internal */
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
      `Command exited with ${result.signal ?? String(result.code)}.`,
      'process',
      result,
      failure(),
    );
  if (!schema) return result;
  if (result.truncated)
    throw new ExecError('Structured command output was truncated.', 'output-limit', result);
  try {
    return schema.parse(JSON.parse(result.stdout) as JsonValue);
  } catch (cause) {
    throw new ExecError(
      `Command stdout did not match its JSON schema: ${cause instanceof Error ? cause.message : String(cause)}`,
      'schema',
      result,
      { cause, ...failure() },
    );
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
