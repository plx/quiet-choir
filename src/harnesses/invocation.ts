import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HarnessRequest } from '../workflow/runtime/model.js';
import { validateAgentOptions } from '../workflow/runtime/options.js';
import { ConfigurationError } from '../workflow/runtime/configuration-error.js';
import { checkAllowedTools } from '../workflow/runtime/profiles.js';
import { tomlLiteral } from '../workflow/runtime/agent-controls.js';
import { snapshotImages } from '../workflow/runtime/images.js';
import { prepareCodexSchema } from './codex-schema.js';

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
  readonly dispose: () => Promise<void>;
}
/** The single argv builder used by normal invocation and doctor contract probes. @internal */
export async function prepareInvocation(request: HarnessRequest): Promise<CliInvocation> {
  validate(() => {
    validateAgentOptions(request.provider, request.options);
  });
  let directory: string | undefined;
  const dispose = async (): Promise<void> => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  };
  const file = async (name: string, value: string | Uint8Array): Promise<string> => {
    directory ??= await mkdtemp(join(tmpdir(), 'quiet-choir-invoke-'));
    const path = join(directory, name);
    await writeFile(path, value, { mode: 0o600 });
    return path;
  };
  const args: string[] = [];
  let decode = (text: string): string => text;
  try {
    if (request.provider === 'claude') {
      const options = request.options;
      const allowed = options.allowedTools ?? options.tools ?? [];
      validate(() => {
        checkAllowedTools(options.tools ?? [], allowed);
      });
      args.push(
        '--print',
        '--output-format',
        'json',
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
      if (allowed.length) args.push('--allowedTools', allowed.join(','));
      if (options.disallowedTools?.length)
        args.push('--disallowedTools', options.disallowedTools.join(','));
      if (options.effort !== undefined) args.push('--effort', options.effort);
      if (options.systemPrompt !== undefined)
        args.push('--system-prompt-file', await file('system.txt', options.systemPrompt));
      if (options.appendSystemPrompt !== undefined)
        args.push(
          '--append-system-prompt-file',
          await file('append.txt', options.appendSystemPrompt),
        );
      if (options.agents !== undefined)
        args.push('--agents', await file('agents.json', JSON.stringify(options.agents)));
      if (options.agent !== undefined) args.push('--agent', options.agent);
      if (options.mcpServers !== undefined)
        args.push(
          '--mcp-config',
          await file('mcp.json', JSON.stringify({ mcpServers: options.mcpServers })),
        );
      if (options.strictMcpConfig) args.push('--strict-mcp-config');
      if (options.settings !== undefined)
        args.push('--settings', await file('settings.json', JSON.stringify(options.settings)));
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
      if (options.harnessProfile !== undefined) args.push('--profile', options.harnessProfile);
      const effort = options.effort ?? options.reasoningEffort;
      if (effort !== undefined)
        args.push('--config', `model_reasoning_effort=${JSON.stringify(effort)}`);
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
        decode = plan.decode;
        args.push('--output-schema', await file('schema.json', JSON.stringify(plan.schema)));
      }
      const images =
        request.imageAttachments ?? (await snapshotImages(options.images ?? [], request.cwd));
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
        args.push(`--image=${await file(`image-${String(index)}.${suffix}`, bytes)}`);
      }
    }
    for (const path of request.options.addDirs ?? [])
      args.push('--add-dir', resolve(request.cwd, path));
    if (request.options.model !== undefined) args.push('--model', request.options.model);
    args.push(...(request.options.extraArgs ?? []));
    if (request.provider === 'codex') args.push('--', '-');
    return { args, decode, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
