import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BuiltinHarnessRequestInput as HarnessRequestInput } from '../harness-kit.js';
import { validateAgentOptions } from '../harness-kit.js';
import { ConfigurationError } from '../harness-kit.js';
import { checkAllowedTools } from '../harness-kit.js';
import { tomlLiteral } from '../harness-kit.js';
import { snapshotImages } from '../harness-kit.js';
import { prepareCodexSchema } from './codex-schema.js';
import { resolveIsolation } from '../harness-kit.js';
import { prepareCodexHome, type PrivateCodexHome } from './codex-home.js';

/** Run pre-launch validation, rejecting as configuration rather than a settled effect failure. */
function validate<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    throw new ConfigurationError(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

/** Prepared argv with private resources owned by the caller until dispose. @internal */
export interface CliInvocation {
  readonly args: string[];
  readonly decode: (text: string) => string;
  /** Child environment overrides, applied after the scrubbed and edited environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Write back private-home state once the child has exited; idempotent, returns warnings. */
  readonly settle: () => Promise<readonly string[]>;
  readonly dispose: () => Promise<void>;
}
/** A private file represented in the plan without creating it. */
export interface CliPlanArtifact {
  /** Owned basename within the invocation's private directory. */
  readonly name: string;
  /** Stable stand-in shown in argv. */
  readonly placeholder: string;
  /** File bytes, encoded as base64. */
  readonly base64: string;
  /** Only these argv positions reference this artifact; user-supplied arguments are untouched. */
  readonly argument: number;
}

/** Pure argv and file plan shared by real calls, rehearsal, and contract probes. */
export interface CliArgumentPlan {
  /** Arguments in execution order, with stable placeholders for private files. */
  readonly argv: readonly string[];
  /** Private files to materialize immediately before spawning. */
  readonly artifacts: readonly CliPlanArtifact[];
  /**
   * `'private'` when a Codex `instructions: 'none'` call runs against a fresh temporary CODEX_HOME
   * holding only a copy of `auth.json`. Absent means the child uses the inherited CODEX_HOME.
   */
  readonly codexHome?: 'private';
}

/** Build and validate argv without filesystem access or processes. @internal */
export function planInvocation(
  request: HarnessRequestInput,
  sessionId?: string | null,
): CliArgumentPlan {
  const isolation = validate(() => {
    validateAgentOptions(request.harness, request.options);
    return resolveIsolation(request.options).isolation;
  });
  const artifacts: CliPlanArtifact[] = [];
  const args: string[] = [];
  const file = (name: string, value: string | Uint8Array, offset = 1): string => {
    const placeholder = `<quiet-choir>/${name}`;
    artifacts.push({
      name,
      placeholder,
      base64: (typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)).toString(
        'base64',
      ),
      argument: args.length + offset,
    });
    return placeholder;
  };
  if (request.harness === 'claude') {
    const options = request.options;
    const allowed = options.allowedTools ?? options.tools ?? [];
    validate(() => {
      checkAllowedTools(options.tools ?? [], allowed);
    });
    args.push(
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      options.permissionMode ?? 'dontAsk',
      '--tools',
      (options.tools ?? []).join(','),
      '--max-turns',
      String(options.maxTurns ?? 10),
      '--max-budget-usd',
      String(options.maxBudgetUsd ?? 0.5),
      '--no-session-persistence',
    );
    if (sessionId != null) {
      if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(sessionId))
        throw new ConfigurationError('Claude sessionId must be a UUID.');
      args.push('--session-id', sessionId);
    }
    if (isolation === 'restricted') args.push('--restricted', '--strict-mcp-config');
    if (allowed.length) args.push('--allowedTools', allowed.join(','));
    if (options.disallowedTools?.length)
      args.push('--disallowedTools', options.disallowedTools.join(','));
    if (options.effort !== undefined) args.push('--effort', options.effort);
    if (options.systemPrompt !== undefined)
      args.push('--system-prompt-file', file('system.txt', options.systemPrompt));
    if (options.appendSystemPrompt !== undefined)
      args.push('--append-system-prompt-file', file('append.txt', options.appendSystemPrompt));
    if (options.agents !== undefined)
      args.push('--agents', file('agents.json', JSON.stringify(options.agents)));
    if (options.agent !== undefined) args.push('--agent', options.agent);
    if (options.mcpServers !== undefined)
      args.push(
        '--mcp-config',
        file('mcp.json', JSON.stringify({ mcpServers: options.mcpServers })),
      );
    if (options.strictMcpConfig && isolation !== 'restricted') args.push('--strict-mcp-config');
    for (const path of options.plugins ?? []) args.push('--plugin-dir', resolve(request.cwd, path));
    if (options.settings !== undefined)
      args.push('--settings', file('settings.json', JSON.stringify(options.settings)));
    if (options.fallbackModel !== undefined)
      args.push(
        '--fallback-model',
        typeof options.fallbackModel === 'string'
          ? options.fallbackModel
          : options.fallbackModel.join(','),
      );
    if (request.outputSchema !== null) {
      if (
        typeof request.outputSchema !== 'object' ||
        Array.isArray(request.outputSchema) ||
        request.outputSchema['type'] !== 'object'
      )
        throw new ConfigurationError(
          'Claude structured output requires an object root at $; wrap the schema in z.object({ value: ... }).',
        );
      args.push('--json-schema', JSON.stringify(request.outputSchema));
    }
  } else {
    const options = request.options;
    args.push(
      'exec',
      '--json',
      '--sandbox',
      options.sandbox ?? 'read-only',
      '--config',
      'approval_policy="never"',
      '--ephemeral',
      '--color',
      'never',
    );
    if (isolation === 'restricted') args.push('--ignore-user-config', '--ignore-rules');
    // The private CODEX_HOME removes user instructions; this removes project AGENTS.md files.
    if (options.instructions === 'none') args.push('--config', 'project_doc_max_bytes=0');
    if (options.harnessProfile !== undefined) args.push('--profile', options.harnessProfile);
    if (options.effort !== undefined)
      args.push('--config', `model_reasoning_effort=${JSON.stringify(options.effort)}`);
    if (options.networkAccess !== undefined)
      args.push(
        '--config',
        `sandbox_workspace_write.network_access=${String(options.networkAccess)}`,
      );
    for (const [key, value] of Object.entries(options.config ?? {}))
      args.push('--config', `${key}=${tomlLiteral(value)}`);
    if (options.skipGitRepoCheck) args.push('--skip-git-repo-check');
    if (request.outputSchema !== null) {
      const outputSchema = request.outputSchema;
      const plan = validate(() =>
        prepareCodexSchema(outputSchema, options.structuredOutput ?? 'compat'),
      );
      args.push('--output-schema', file('schema.json', JSON.stringify(plan.schema)));
    }
    if ((options.images?.length ?? 0) > 0 && request.imageAttachments === undefined)
      throw new Error(
        'Planning image calls requires imageAttachments captured from the source files.',
      );
    const images = request.imageAttachments ?? [];
    for (const [index, image] of images.entries()) {
      const bytes = Buffer.from(image.base64, 'base64');
      const suffix =
        bytes[0] === 0x89
          ? 'png'
          : bytes[0] === 0xff
            ? 'jpg'
            : bytes.toString('ascii', 0, 4) === 'RIFF'
              ? 'webp'
              : bytes.toString('ascii', 0, 3) === 'GIF'
                ? 'gif'
                : 'bin';
      // Attached values ensure a variadic image flag cannot swallow stdin's trailing '-'.
      args.push(`--image=${file(`image-${String(index)}.${suffix}`, bytes, 0)}`);
    }
  }
  for (const path of request.options.addDirs ?? [])
    args.push('--add-dir', resolve(request.cwd, path));
  if (request.options.model !== undefined) args.push('--model', request.options.model);
  args.push(...(request.options.extraArgs ?? []));
  if (request.harness === 'codex') args.push('--', '-');
  return {
    argv: args,
    artifacts,
    ...(request.harness === 'codex' && request.options.instructions === 'none'
      ? { codexHome: 'private' as const }
      : {}),
  };
}

/**
 * Capture images for direct adapter calls; runtime calls already contain their fingerprinted bytes.
 * Options are validated first, so misconfiguration rejects before any image is read, and `signal`
 * cancels the fallback image snapshot. @internal
 */
export async function invocationRequest(
  request: HarnessRequestInput,
  signal?: AbortSignal,
): Promise<HarnessRequestInput> {
  validate(() => {
    validateAgentOptions(request.harness, request.options);
  });
  if (request.harness !== 'codex' || request.imageAttachments !== undefined) return request;
  return {
    ...request,
    imageAttachments: await snapshotImages(request.options.images ?? [], request.cwd, signal),
  };
}

/** Where a private-home plan copies credentials from. @internal */
export interface InvocationContext {
  /** The real CODEX_HOME the child would otherwise use, resolved from its environment. */
  readonly codexHome?: string;
}

/** Materialize only the planner's owned files and retain cleanup on every exit. @internal */
export async function materializeInvocation(
  plan: CliArgumentPlan,
  request: HarnessRequestInput,
  context: InvocationContext = {},
): Promise<CliInvocation> {
  let directory: string | undefined;
  let home: PrivateCodexHome | undefined;
  const settle = async (): Promise<readonly string[]> => (home ? home.settle() : []);
  const dispose = async (): Promise<void> => {
    try {
      await home?.dispose();
    } finally {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    if (plan.codexHome === 'private') {
      // Never fall back to the inherited home: that would silently load user instructions.
      if (context.codexHome === undefined)
        throw new Error('A private CODEX_HOME plan requires the source CODEX_HOME for auth.json.');
      home = await prepareCodexHome(context.codexHome);
    }
    const args = [...plan.argv];
    for (const artifact of plan.artifacts) {
      directory ??= await mkdtemp(join(tmpdir(), 'quiet-choir-invoke-'));
      const path = join(directory, artifact.name);
      await writeFile(path, Buffer.from(artifact.base64, 'base64'), { mode: 0o600 });
      const original = args[artifact.argument];
      if (original !== artifact.placeholder && original !== `--image=${artifact.placeholder}`)
        throw new Error('Invalid private artifact reference in invocation plan.');
      args[artifact.argument] = original === artifact.placeholder ? path : `--image=${path}`;
    }
    const { harness, outputSchema, options } = request;
    const decode =
      harness === 'codex' && outputSchema !== null
        ? validate(() => prepareCodexSchema(outputSchema, options.structuredOutput ?? 'compat'))
            .decode
        : (text: string): string => text;
    return {
      args,
      decode,
      ...(home ? { env: { CODEX_HOME: home.path } } : {}),
      settle,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/**
 * Prepare the same invocation plan for contract probes and direct adapter consumers; `signal`
 * cancels the fallback image snapshot. @internal
 */
export async function prepareInvocation(
  request: HarnessRequestInput,
  signal?: AbortSignal,
  context?: InvocationContext,
): Promise<CliInvocation> {
  const input = await invocationRequest(request, signal);
  return materializeInvocation(planInvocation(input), input, context);
}
