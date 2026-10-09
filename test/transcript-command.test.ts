import { cp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import { describe, expect } from 'vitest';

import { defineWorkflow, readRun, z, type Harness, type PolicyOverride } from '../src/index.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import type { WorkflowCommandResult } from '../src/workflow/loader/model.js';
import { runDirectory } from '../src/workflow/runtime/paths.js';
import { it } from './setup/cli-capture.js';
import type { RunScope } from './setup/state-dir.js';

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
  signal?: AbortSignal,
): Promise<{ result: WorkflowCommandResult; output: string }> {
  const chunks: Uint8Array[] = [];
  const result = await new WorkflowExecutor({
    logger: { log: () => undefined },
    ...(signal === undefined ? {} : { signal }),
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

/** One stdout transcript entry carrying `text`. */
function entry(text: string): string {
  return `${JSON.stringify({ stream: 'stdout', base64: Buffer.from(text).toString('base64') })}\n`;
}

/** The receipt path of `source`'s `task` attempt, after setting that attempt's recorded status. */
async function attemptPath(stateDir: string, status?: 'running' | 'interrupted'): Promise<string> {
  const recordPath = join(runDirectory(stateDir, 'source'), 'run.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
    steps: Record<string, { attemptHistory: { status: string; transcript: { path: string } }[] }>;
  };
  const attempt = record.steps['task']?.attemptHistory[0];
  if (!attempt) throw new Error('expected an attempt');
  if (status !== undefined) {
    attempt.status = status;
    await writeFile(recordPath, JSON.stringify(record));
  }
  return attempt.transcript.path;
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
      inProgress: false,
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

  it('stops on an abort even when the selected stream has no chunk', async ({ stateDir, runs }) => {
    await seed(runs, stateDir);
    const run = await readRun({ runId: 'source', stateDir });
    const path = run.steps['task']?.attemptHistory?.[0]?.transcript?.path;
    if (path === undefined) throw new Error('expected a transcript receipt');
    // Only stdout entries: the stderr decode passes nothing on.
    await writeFile(
      path,
      `${JSON.stringify({ stream: 'stdout', base64: Buffer.from('out\n').toString('base64') })}\n`,
    );
    expect(await transcript(stateDir, { stepId: 'task', stream: 'stderr' })).toMatchObject({
      output: '',
      result: { ok: true, bytes: 0 },
    });
    const aborted = await transcript(
      stateDir,
      { stepId: 'task', stream: 'stderr' },
      AbortSignal.abort(new Error('stop reading')),
    );
    expect(aborted).toMatchObject({
      output: '',
      result: { ok: false, code: 'workflow.interrupted', message: 'stop reading' },
    });
  });

  it('re-roots the receipt under the current state directory', async ({ stateDir, runs }) => {
    await seed(runs, stateDir);
    const recordPath = join(runDirectory(stateDir, 'source'), 'run.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      steps: Record<string, { attemptHistory: { transcript: { path: string } }[] }>;
    };
    const receipt = record.steps['task']?.attemptHistory[0]?.transcript;
    if (!receipt) throw new Error('expected a transcript receipt');
    const tail = relative(stateDir, receipt.path);

    // The state directory reached through a symlinked alias.
    const alias = join(stateDir, 'alias');
    await symlink(stateDir, alias);
    expect(await transcript(alias, { stepId: 'task' })).toMatchObject({
      output: native.join(''),
      result: { ok: true, path: receipt.path },
    });

    // The whole run directory moved to another state directory.
    const moved = join(stateDir, 'moved');
    await cp(runDirectory(stateDir, 'source'), join(moved, 'source'), { recursive: true });
    expect(await transcript(moved, { stepId: 'task' })).toMatchObject({
      output: native.join(''),
      result: { ok: true, path: receipt.path },
    });

    // A receipt recorded under a state directory that no longer exists.
    receipt.path = join(stateDir, 'gone', tail);
    await writeFile(recordPath, JSON.stringify(record));
    expect(await transcript(stateDir, { stepId: 'task' })).toMatchObject({
      output: native.join(''),
      result: { ok: true, path: join(stateDir, 'gone', tail) },
    });
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
    const first = record.steps['first']?.attemptHistory[0]?.transcript;
    if (!receipt || !first) throw new Error('expected transcript receipts');
    const path = receipt.path;
    const hashDir = dirname(path);
    const secret = join(stateDir, 'secret.jsonl');
    await writeFile(secret, `${JSON.stringify({ stream: 'stdout', base64: 'c2VjcmV0' })}\n`);
    const rewrite = async (to: string): Promise<WorkflowCommandResult> => {
      receipt.path = to;
      await writeFile(recordPath, JSON.stringify(record));
      return (await transcript(stateDir, { stepId: 'task' })).result;
    };

    const attempts = join(runDirectory(stateDir, 'source'), 'attempts');
    for (const escaping of [
      secret,
      join(attempts, '..', '..', 'secret.jsonl'),
      'attempts/relative.jsonl',
      // Another step's transcript: the hash segment must be this step's.
      first.path,
      join(attempts, 'f'.repeat(64), basename(path)),
      // Another run's attempts directory, or a name the runtime never creates.
      join(stateDir, 'other', 'attempts', basename(hashDir), basename(path)),
      join(hashDir, 'notes.txt'),
    ]) {
      const result = await rewrite(escaping);
      expect(result).toMatchObject({
        ok: false,
        code: 'run.unreadable',
        details: { stepId: 'task', attempt: 1, path: escaping },
      });
      if (result.ok) throw new Error('expected a failure');
      expect(result.message).toContain('refusing to read it');
    }
    await writeFile(recordPath, original);

    // The step's own directory as a link that points elsewhere is refused after resolving it.
    await mkdir(join(stateDir, 'elsewhere'));
    await writeFile(join(stateDir, 'elsewhere', basename(path)), await readFile(secret));
    await rename(hashDir, `${hashDir}.real`);
    await symlink(join(stateDir, 'elsewhere'), hashDir);
    const linked = (await transcript(stateDir, { stepId: 'task' })).result;
    expect(linked).toMatchObject({ code: 'run.unreadable' });
    if (linked.ok) throw new Error('expected a failure');
    expect(linked.message).toContain('resolves outside');
    await rm(hashDir);
    await rename(`${hashDir}.real`, hashDir);

    // The file itself as a symlink is refused by O_NOFOLLOW.
    await rename(path, `${path}.real`);
    await symlink(secret, path);
    expect((await transcript(stateDir, { stepId: 'task' })).result).toMatchObject({
      code: 'run.unreadable',
    });
    await rm(path);
    await rename(`${path}.real`, path);
    expect((await transcript(stateDir, { stepId: 'task' })).output).toBe(native.join(''));

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

  it('decodes a running or interrupted attempt up to a torn final line', async ({
    stateDir,
    runs,
  }) => {
    await seed(runs, stateDir);
    const torn = `${entry('one\n')}${entry('two\n')}${entry('three\n').slice(0, 20)}`;
    let path = await attemptPath(stateDir, 'running');
    await writeFile(path, torn);
    expect(await transcript(stateDir, { stepId: 'task' })).toMatchObject({
      output: 'one\ntwo\n',
      result: { ok: true, bytes: 8, truncated: false, inProgress: true },
    });
    // Complete lines of a running attempt are still checked.
    await writeFile(path, `${entry('one\n')}not json\n${entry('two\n').slice(0, 20)}`);
    expect((await transcript(stateDir, { stepId: 'task' })).result).toMatchObject({
      ok: false,
      code: 'run.unreadable',
    });
    // Resume marks the dead attempt interrupted; its torn tail is still not damage.
    path = await attemptPath(stateDir, 'interrupted');
    await writeFile(path, torn);
    expect(await transcript(stateDir, { stepId: 'task' })).toMatchObject({
      output: 'one\ntwo\n',
      result: { ok: true, inProgress: false },
    });
  });

  it('fails run.unreadable for a settled attempt with a torn final line', async ({
    stateDir,
    runs,
  }) => {
    await seed(runs, stateDir);
    await writeFile(await attemptPath(stateDir), `${entry('one\n')}${entry('two\n').slice(0, 20)}`);
    const result = (await transcript(stateDir, { stepId: 'task' })).result;
    expect(result).toMatchObject({ ok: false, code: 'run.unreadable' });
    if (result.ok) throw new Error('expected a failure');
    expect(result.message).toContain('line 2');
  });
  /** Set (or with undefined, remove) the policy cap recorded for the `task` attempt. */
  async function recordCap(stateDir: string, cap: number | undefined): Promise<string> {
    const recordPath = join(runDirectory(stateDir, 'source'), 'run.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      steps: Record<
        string,
        {
          attemptHistory: {
            policy: { maxTranscriptBytes?: number };
            transcript: { path: string };
          }[];
        }
      >;
    };
    const attempt = record.steps['task']?.attemptHistory[0];
    if (!attempt) throw new Error('expected an attempt');
    if (cap === undefined) delete attempt.policy.maxTranscriptBytes;
    else attempt.policy.maxTranscriptBytes = cap;
    await writeFile(recordPath, JSON.stringify(record));
    return attempt.transcript.path;
  }

  it('reads a line over the default limit when the recorded cap allows it, and keeps the default without a cap', async ({
    stateDir,
    runs,
  }) => {
    await seed(runs, stateDir);
    const text = 'x'.repeat(50 * 1024 * 1024);
    const path = await recordCap(stateDir, 128 * 1024 * 1024);
    await writeFile(path, entry(text));
    // The entry line is about 67 MiB of base64, past the 64 MiB default.
    const wide = await transcript(stateDir, { stepId: 'task' });
    expect(wide.result).toMatchObject({ ok: true, bytes: text.length, truncated: false });
    expect(wide.output).toBe(text);

    // A record from before the cap was recorded keeps the default.
    await recordCap(stateDir, undefined);
    const narrow = await transcript(stateDir, { stepId: 'task' });
    expect(narrow.output).toBe('');
    expect(narrow.result).toMatchObject({ ok: false, code: 'run.unreadable' });
    if (narrow.result.ok) throw new Error('expected a failure');
    expect(narrow.result.message).toContain('is longer than 67108864 bytes');
  });
});
