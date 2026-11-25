// Shared test support for the quiet-choir/std suites: a scripted harness that answers each agent
// call from a reply function (JSON for structured calls, text otherwise), a temporary run root,
// and the tail-failure wrapper that proves a workflow replays its completed effects on resume.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import {
  runWorkflow,
  z,
  type Harness,
  type HarnessInvocation,
  type HarnessRequest,
  type HarnessResponse,
  type ProcessRunner,
  type WorkflowDefinition,
  type WorkflowResult,
} from '../src/index.js';

/** What a reply function may return: text, a JSON value (serialized), or a thrown error. */
export type Reply = (request: HarnessRequest) => unknown;

/**
 * A harness that answers every call through `reply`. A string reply is sent as-is; any other
 * value is serialized as JSON, so a structured call's reply is the object its schema expects.
 * Throwing from `reply` fails the attempt with that error.
 */
export class ScriptedHarness implements Harness {
  public readonly kind = 'std-fixture';
  public readonly calls: HarnessRequest[] = [];
  public constructor(private readonly reply: Reply) {}

  public async invoke(
    request: HarnessRequest,
    invocation: HarnessInvocation,
  ): Promise<HarnessResponse> {
    invocation.signal.throwIfAborted();
    this.calls.push(request);
    const value: unknown = await this.reply(request);
    return {
      text: typeof value === 'string' ? value : JSON.stringify(value),
      sessionId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
    };
  }

  /** The fully qualified step IDs called so far, in call order. */
  public ids(): string[] {
    return this.calls.map((call) => call.stepId);
  }

  /** How many attempts were made for `stepId`. */
  public count(stepId: string): number {
    return this.calls.filter((call) => call.stepId === stepId).length;
  }

  /** The prompt text of the last call to `stepId`. */
  public prompt(stepId: string): string {
    const call = this.calls.findLast((entry) => entry.stepId === stepId);
    if (call === undefined) throw new Error(`No call to ${stepId}`);
    return promptOf(call);
  }
}

/** The prompt text a request carries. */
export function promptOf(request: HarnessRequest): string {
  const prompt: unknown = (request.options as { prompt?: unknown }).prompt;
  if (typeof prompt !== 'string') throw new Error(`Step ${request.stepId} has no text prompt`);
  return prompt;
}

/** A fresh temporary directory for one test's runs; remove it with {@link removeRoot}. */
export async function makeRoot(prefix = 'choir-std-'): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** Remove a directory made by {@link makeRoot}. */
export async function removeRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/** `runWorkflow` options for a run under `root`, with a private state directory. */
export function runOptions(
  root: string,
  runId = 'std',
): {
  readonly runId: string;
  readonly cwd: string;
  readonly stateDir: string;
  readonly fingerprint: string;
  readonly agentLimit: number;
} {
  return { runId, cwd: root, stateDir: join(root, 'state'), fingerprint: 'std-v1', agentLimit: 4 };
}

/** Wrap `workflow` so its first execution fails after the body returns, at step `probe/tail`. */
export function tailFailure<I, O>(workflow: WorkflowDefinition<I, O>): WorkflowDefinition<I, O> {
  return {
    ...workflow,
    async run(ctx, input) {
      const output = await workflow.run(ctx, input);
      await ctx.step('probe/tail', {
        input: null,
        schema: z.null(),
        run({ attempt }) {
          if (attempt === 1) throw new Error('Injected tail failure');
          return null;
        },
      });
      return output;
    },
  };
}

/** Extra `runWorkflow` options for {@link replayAfterTail}. */
export interface ReplayOptions {
  /** The process runner of a workflow that runs commands, such as `new NodeProcessRunner()`. */
  readonly processRunner?: ProcessRunner;
}

/**
 * Run `workflow` once to an injected tail failure, then resume it twice, asserting that the resume
 * makes no new agent call and that both resumes record the same steps. Returns the first resume.
 */
export async function replayAfterTail<I, O>(
  workflow: WorkflowDefinition<I, O>,
  input: I,
  harness: ScriptedHarness,
  root: string,
  runId = 'std',
  extra: ReplayOptions = {},
): Promise<WorkflowResult<O>> {
  const wrapped = tailFailure(workflow);
  const options = { ...runOptions(root, runId), harness, ...extra };
  await expect(runWorkflow(wrapped, { ...options, input })).rejects.toThrow(
    'Injected tail failure',
  );
  const count = harness.calls.length;
  const resumed = await runWorkflow(wrapped, { ...options, resume: true });
  expect(harness.calls).toHaveLength(count);
  const again = await runWorkflow(wrapped, { ...options, resume: true });
  expect(again.steps).toEqual(resumed.steps);
  return resumed;
}
