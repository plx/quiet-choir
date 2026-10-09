import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect } from 'vitest';

import { defineWorkflow, readRun, z, type Harness, type PolicyOverride } from '../src/index.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import type { WorkflowCommandResult } from '../src/workflow/loader/model.js';
import { runDirectory } from '../src/workflow/runtime/paths.js';
import { it, type RunScope } from './setup/state-dir.js';

const usage = { inputTokens: 8, outputTokens: 2, costUsd: 0.01 };
const native = [
  `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' })}\n`,
  `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'café' }] } })}\n`,
];

/** An agent that streams `native` on stdout, split inside the multibyte character, and one stderr line. */
const harness: Harness = {
  async invoke(_request, invocation) {
    const bytes = Buffer.from(native.join(''));
    const split = bytes.indexOf(0xc3) + 1;
    await invocation.onOutput?.('stdout', bytes.subarray(0, split));
    await invocation.onOutput?.('stderr', Buffer.from('native warning\n'));
    await invocation.onOutput?.('stdout', bytes.subarray(split));
    return { text: 'ok', sessionId: 's', usage };
  },
};

const workflow = defineWorkflow({
  name: 'transcript',
  version: '1',
  input: z.null(),
  output: z.string(),
  async run(ctx) {
    await ctx.step('local', { input: null, schema: z.number(), run: () => 1 });
    await ctx.claude.text('first', { prompt: 'answer' });
    return (await ctx.claude.text('task', { prompt: 'answer' })).output;
  },
});

async function seed(
  runs: RunScope,
  stateDir: string,
  policy: PolicyOverride[] = [],
): Promise<void> {
  const run = await runs.run(workflow, {
    stateDir,
    runId: 'source',
    cwd: stateDir,
    input: null,
    harness,
    policy,
  });
  expect(run.status).toBe('completed');
}

async function transcript(
  stateDir: string,
  plan: { stepId: string; attempt?: number; stream?: 'stdout' | 'stderr'; runId?: string },
): Promise<{ result: WorkflowCommandResult; output: string }> {
  const chunks: Uint8Array[] = [];
  const result = await new WorkflowExecutor({
    logger: { log: () => undefined },
    onTranscriptChunk: (chunk) => {
      chunks.push(chunk);
    },
  }).execute({
    kind: 'workflow.transcript',
    runId: plan.runId ?? 'source',
    stateDir,
    stepId: plan.stepId,
    ...(plan.attempt === undefined ? {} : { attempt: plan.attempt }),
    stream: plan.stream ?? 'stdout',
  });
  return { result, output: Buffer.concat(chunks).toString('utf8') };
}

describe('workflow.transcript', () => {
  it('streams the decoded native bytes and reports the attempt', async ({ stateDir, runs }) => {
    await seed(runs, stateDir);
    const { result, output } = await transcript(stateDir, { stepId: 'task' });
    expect(output).toBe(native.join(''));
    expect(
      output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
    ).toHaveLength(2);
    const run = await readRun({ runId: 'source', stateDir });
    expect(result).toEqual({
      kind: 'workflow.transcript.result',
      ok: true,
      runId: 'source',
      stepId: 'task',
      attempt: 1,
      harness: 'claude',
      stream: 'stdout',
      path: run.steps['task']?.attemptHistory?.[0]?.transcript?.path,
      bytes: Buffer.byteLength(native.join('')),
      truncated: false,
    });
    const stderr = await transcript(stateDir, { stepId: 'task', attempt: 1, stream: 'stderr' });
    expect(stderr.output).toBe('native warning\n');
    expect(stderr.result).toMatchObject({ ok: true, stream: 'stderr', bytes: 15 });
  });

  it('fails run.not_found for an unknown run', async ({ stateDir, runs }) => {
    await seed(runs, stateDir);
    const { result, output } = await transcript(stateDir, { runId: 'missing', stepId: 'task' });
    expect(result).toMatchObject({ ok: false, code: 'run.not_found', runId: 'missing' });
    expect(output).toBe('');
  });

  it('fails usage.flag with a reason for a step or attempt it cannot select', async ({
    stateDir,
    runs,
  }) => {
    await seed(runs, stateDir);
    const unknown = await transcript(stateDir, { stepId: 'nope' });
    expect(unknown.result).toMatchObject({
      ok: false,
      code: 'usage.flag',
      details: {
        runId: 'source',
        stepId: 'nope',
        attempt: null,
        reason: 'unknown-step',
        agentSteps: ['first', 'task'],
      },
    });
    if (unknown.result.ok) throw new Error('expected a failure');
    expect(unknown.result.message).toContain('Agent steps with a transcript: first, task.');
    expect((await transcript(stateDir, { stepId: 'local' })).result).toMatchObject({
      ok: false,
      code: 'usage.flag',
      details: { reason: 'not-agent', stepId: 'local' },
    });
    expect((await transcript(stateDir, { stepId: 'task', attempt: 9 })).result).toMatchObject({
      ok: false,
      code: 'usage.flag',
      details: { reason: 'unknown-attempt', attempt: 9 },
    });
  });

  it('fails no-transcript when transcripts were off or removed after success', async ({
    stateDir,
    runs,
  }) => {
    await seed(runs, stateDir, [{ transcripts: 'off' }]);
    const off = (await transcript(stateDir, { stepId: 'task' })).result;
    expect(off).toMatchObject({
      ok: false,
      code: 'usage.flag',
      details: { reason: 'no-transcript', attempt: null },
    });
    if (off.ok) throw new Error('expected a failure');
    expect(off.message).toContain('transcripts: off');
    expect((await transcript(stateDir, { stepId: 'nope' })).result).toMatchObject({
      details: { reason: 'unknown-step', agentSteps: [] },
    });
  });

  it('reports a removed on-failure transcript', async ({ stateDir, runs }) => {
    await seed(runs, stateDir, [{ transcripts: 'on-failure' }]);
    const removed = (await transcript(stateDir, { stepId: 'task' })).result;
    expect(removed).toMatchObject({ ok: false, details: { reason: 'no-transcript' } });
    if (removed.ok) throw new Error('expected a failure');
    expect(removed.message).toContain('on-failure');
  });

  it('fails run.unreadable for a receipt outside the run, a missing file, a symlink or bad bytes', async ({
    stateDir,
    runs,
  }) => {
    await seed(runs, stateDir);
    const recordPath = join(runDirectory(stateDir, 'source'), 'run.json');
    const original = await readFile(recordPath, 'utf8');
    const record = JSON.parse(original) as {
      steps: Record<string, { attemptHistory: { transcript: { path: string } }[] }>;
    };
    const receipt = record.steps['task']?.attemptHistory[0]?.transcript;
    if (!receipt) throw new Error('expected a transcript receipt');
    const path = receipt.path;
    const secret = join(stateDir, 'secret.jsonl');
    await writeFile(secret, `${JSON.stringify({ stream: 'stdout', base64: 'c2VjcmV0' })}\n`);
    const rewrite = async (to: string): Promise<WorkflowCommandResult> => {
      receipt.path = to;
      await writeFile(recordPath, JSON.stringify(record));
      return (await transcript(stateDir, { stepId: 'task' })).result;
    };

    for (const escaping of [
      secret,
      join(runDirectory(stateDir, 'source'), 'attempts', '..', '..', 'secret.jsonl'),
      'attempts/relative.jsonl',
    ])
      expect(await rewrite(escaping)).toMatchObject({
        ok: false,
        code: 'run.unreadable',
        details: { stepId: 'task', attempt: 1 },
      });

    // A directory link inside attempts/ that points elsewhere is refused after resolving it.
    const linked = join(runDirectory(stateDir, 'source'), 'attempts', 'linked');
    await mkdir(join(stateDir, 'elsewhere'));
    await writeFile(join(stateDir, 'elsewhere', '1.claude.jsonl'), await readFile(secret));
    await symlink(join(stateDir, 'elsewhere'), linked);
    expect(await rewrite(join(linked, '1.claude.jsonl'))).toMatchObject({
      code: 'run.unreadable',
    });

    // The file itself as a symlink is refused by O_NOFOLLOW.
    const fileLink = join(runDirectory(stateDir, 'source'), 'attempts', 'file-link.jsonl');
    await symlink(secret, fileLink);
    expect(await rewrite(fileLink)).toMatchObject({ code: 'run.unreadable' });

    await writeFile(recordPath, original);
    await writeFile(path, 'not json\n');
    const malformed = (await transcript(stateDir, { stepId: 'task' })).result;
    expect(malformed).toMatchObject({ ok: false, code: 'run.unreadable' });
    if (malformed.ok) throw new Error('expected a failure');
    expect(malformed.message).toContain('line 1');
    await rm(path);
    expect((await transcript(stateDir, { stepId: 'task' })).result).toMatchObject({
      ok: false,
      code: 'run.unreadable',
    });
  });
});
