import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type { Harness, HarnessRequest, HarnessResponse } from '../workflow/runtime/model.js';
import { HarnessError } from '../workflow/runtime/harness-error.js';
import { prepareCodexSchema } from './codex-schema.js';
import { runProcess } from './process.js';
import { parseClaude, parseCodex } from './protocol.js';

/** Executable overrides and resource limits for headless harness processes. */
export interface CliHarnessOptions {
  /** Claude executable, resolved through PATH by default. */
  readonly claudeBinary?: string;
  /** Codex executable, resolved through PATH by default. */
  readonly codexBinary?: string;
  /** Combined stdout/stderr limit per process; defaults to 8 MiB. */
  readonly maxOutputBytes?: number;
  /** Milliseconds to wait after SIGTERM before SIGKILL; defaults to 250. */
  readonly killGraceMs?: number;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function timerDuration(value: number, name: string): number {
  positive(value, name);
  if (value > 2_147_483_647) throw new Error(`${name} must not exceed 2147483647ms.`);
  return value;
}

/** Invoke installed Claude Code and Codex CLIs with subscription authentication and bounded processes. */
export class CliHarness implements Harness {
  private readonly options: CliHarnessOptions;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;

  /** Configure executable paths or retain the CLIs found on PATH. */
  public constructor(options: CliHarnessOptions = {}) {
    this.options = { ...options };
    this.maxOutputBytes = positive(options.maxOutputBytes ?? 8 * 1024 * 1024, 'maxOutputBytes');
    this.killGraceMs = timerDuration(options.killGraceMs ?? 250, 'killGraceMs');
  }

  /** Execute a fresh headless session, rejecting cancellation, limits, and protocol failures. */
  public async invoke(request: HarnessRequest, signal: AbortSignal): Promise<HarnessResponse> {
    signal.throwIfAborted();
    if (!isAbsolute(request.cwd)) throw new Error('Harness cwd must be an absolute path.');
    const timeoutMs = timerDuration(request.options.timeoutMs ?? 120_000, 'timeoutMs');
    const args: string[] = [];
    let binary: string;
    let schemaDirectory: string | undefined;
    let decode = (text: string): string => text;
    try {
      if (request.provider === 'claude') {
        binary = this.options.claudeBinary ?? 'claude';
        const maxTurns = positive(request.options.maxTurns ?? 3, 'maxTurns');
        const budget = request.options.maxBudgetUsd ?? 0.25;
        if (!Number.isFinite(budget) || budget <= 0)
          throw new Error('maxBudgetUsd must be positive and finite.');
        args.push(
          '--print',
          '--output-format',
          'json',
          '--permission-mode',
          'dontAsk',
          '--tools',
          (request.options.tools ?? []).join(','),
          '--max-turns',
          String(maxTurns),
          '--max-budget-usd',
          String(budget),
          '--no-session-persistence',
        );
        if (request.options.allowedTools !== undefined && request.options.allowedTools.length > 0) {
          args.push('--allowedTools', request.options.allowedTools.join(','));
        }
        if (request.outputSchema !== null) {
          if (
            typeof request.outputSchema !== 'object' ||
            Array.isArray(request.outputSchema) ||
            request.outputSchema['type'] !== 'object'
          )
            throw new Error(
              'Claude structured output requires an object root at $; wrap the schema in z.object({ value: ... }).',
            );
          args.push('--json-schema', JSON.stringify(request.outputSchema));
        }
      } else {
        binary = this.options.codexBinary ?? 'codex';
        args.push(
          'exec',
          '--json',
          '--sandbox',
          request.options.sandbox ?? 'read-only',
          '--config',
          'approval_policy="never"',
          '--ephemeral',
          '--color',
          'never',
        );
        if (request.options.reasoningEffort !== undefined) {
          args.push(
            '--config',
            `model_reasoning_effort=${JSON.stringify(request.options.reasoningEffort)}`,
          );
        }
        if (request.options.skipGitRepoCheck === true) args.push('--skip-git-repo-check');
        if (request.outputSchema !== null) {
          const plan = prepareCodexSchema(
            request.outputSchema,
            request.options.structuredOutput ?? 'compat',
          );
          decode = plan.decode;
          schemaDirectory = await mkdtemp(join(tmpdir(), 'quiet-choir-schema-'));
          const schemaPath = join(schemaDirectory, 'output.json');
          await writeFile(schemaPath, JSON.stringify(plan.schema), { mode: 0o600 });
          args.push('--output-schema', schemaPath);
        }
      }
      if (request.options.model !== undefined) args.push('--model', request.options.model);
      if (request.provider === 'codex') args.push('-');
      const result = await runProcess({
        binary,
        args,
        cwd: request.cwd,
        input: request.options.prompt,
        timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        killGraceMs: this.killGraceMs,
        signal,
      });
      const outcome =
        request.provider === 'claude'
          ? parseClaude(result.stdout, request.outputSchema !== null)
          : parseCodex(result.stdout);
      if (result.code === 0 && result.signal === null && outcome.kind === 'success')
        return { ...outcome.response, text: decode(outcome.response.text) };
      throw new HarnessError({
        provider: request.provider,
        exit: { code: result.code, signal: result.signal },
        failure: outcome.kind === 'failure' ? outcome.failure : null,
        reason:
          outcome.kind === 'unparseable'
            ? outcome.reason
            : 'process failed after a successful protocol result',
        stderr: result.stderr,
        stdout: result.stdout,
        ...(outcome.kind === 'success'
          ? { usage: outcome.response.usage, sessionId: outcome.response.sessionId }
          : {}),
      });
    } finally {
      if (schemaDirectory !== undefined)
        await rm(schemaDirectory, { recursive: true, force: true });
    }
  }
}
