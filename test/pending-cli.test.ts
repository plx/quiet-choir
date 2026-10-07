// `workflow answer` and `workflow pending` driven as CLI commands, in process, against real saved
// runs: the delivery state a queued answer leaves behind, the default listing filter, and the
// structured issues of a refused answer. No workflow code is imported by either command.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import WorkflowAnswer from '../src/commands/workflow/answer.js';
import WorkflowPending from '../src/commands/workflow/pending.js';
import { defineWorkflow, runWorkflow, z } from '../src/index.js';
import { answerPath } from '../src/workflow/runtime/inbox.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const entrypoint = '/project/approve.workflow.ts';
let root: string;
let stateDir: string;
let fixture: string;

interface RunnableCommand {
  run(argv: string[], options: { root: string }): Promise<unknown>;
}

async function capture(command: RunnableCommand, argv: string[]) {
  const stdout: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
    stdout.push(typeof message === 'string' ? message : inspect(message));
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let error: unknown;
  try {
    await command.run(argv, { root: projectRoot });
  } catch (caught: unknown) {
    error = caught;
  }
  const text = stdout.join('\n');
  return { error, text, document: text.startsWith('{') ? (JSON.parse(text) as unknown) : null };
}

interface Row {
  runId: string;
  delivery: { state: string; at: string | null; by: string | null } | null;
  runStatus: string;
  next: { argv: string[] }[];
}
interface PendingDocument {
  kind: string;
  pending: Row[];
  hidden: number;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'choir-pending-cli-'));
  stateDir = join(root, 'runs');
  fixture = join(root, 'fixture.json');
  const text = JSON.stringify({ version: 1, calls: [] });
  await writeFile(fixture, text);
});

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('workflow pending and answer', () => {
  it('hides an answered row by default, lists it with its delivery under --all, and explains a refusal', async () => {
    // A run launched under --harness fixture:FILE records that policy, so a resume entry repeats it.
    const sha256 = createHash('sha256')
      .update(await readFile(fixture))
      .digest('hex');
    const policy = {
      harness: { kind: 'fixture' as const, fixtures: [{ path: fixture, sha256 }] },
      waitMode: 'suspend' as const,
    };
    const suspended = await runWorkflow(
      defineWorkflow({
        name: 'approve',
        version: '1',
        input: z.null(),
        output: z.unknown(),
        run: (ctx) => ctx.approve('gate', { prompt: 'Ship?' }),
      }),
      { stateDir, runId: 'ask-run', input: null, launch: { entrypoint, tsconfig: null, policy } },
    );
    expect(suspended.status).toBe('suspended');
    const state = ['--state-dir', stateDir];

    // 1. A non-boolean approval is refused with the path of the offending field.
    const refused = await capture(WorkflowAnswer, [
      'ask-run',
      'gate',
      '--json',
      '{"approved":"yes"}',
      ...state,
    ]);
    expect(refused.error).toBeDefined();
    const failure = refused.document as {
      exitCode: number;
      error: {
        code: string;
        message: string;
        details: { issues: { code: string; path: unknown[]; message: string }[] };
      };
    };
    expect(failure.exitCode).toBe(2);
    expect(failure.error.code).toBe('answer.invalid');
    expect(failure.error.details.issues[0]).toMatchObject({
      code: 'invalid_type',
      path: ['approved'],
    });
    expect(failure.error.message).not.toContain('\n');

    // 2. A valid answer is queued, not applied.
    const before = Date.now();
    const queued = await capture(WorkflowAnswer, [
      'ask-run',
      'gate',
      '--json',
      '{"approved":true}',
      '--by',
      'agent:test',
      ...state,
    ]);
    expect(queued.error).toBeUndefined();
    const envelope = JSON.parse(
      await readFile(answerPath(stateDir, 'ask-run', 'gate'), 'utf8'),
    ) as {
      at: string;
    };

    // 3. The default listing omits the row and counts it.
    const listed = await capture(WorkflowPending, [...state, '--json']);
    const document = listed.document as PendingDocument;
    expect(document).toMatchObject({ kind: 'workflow.pending.result', ok: true });
    expect(document.pending.filter((row) => row.runId === 'ask-run')).toEqual([]);
    expect(document.hidden).toBeGreaterThanOrEqual(1);

    // 4. --all shows it with who and when, and the resume command that ingests it.
    const all = (await capture(WorkflowPending, [...state, '--all', '--json']))
      .document as PendingDocument;
    expect(all.hidden).toBe(0);
    const row = all.pending.find((item) => item.runId === 'ask-run');
    expect(row).toMatchObject({
      runStatus: 'suspended',
      delivery: { state: 'queued', at: envelope.at, by: 'agent:test' },
    });
    expect(Date.parse(envelope.at)).toBeGreaterThanOrEqual(before);
    expect(row?.next).toHaveLength(1);
    expect(row?.next[0]?.argv.slice(-7)).toEqual([
      'workflow',
      'resume',
      'ask-run',
      ...state,
      '--harness',
      `fixture:${fixture}`,
    ]);

    // 5. The text form hints at the hidden rows.
    const text = await capture(WorkflowPending, state);
    expect(text.text).toBe(
      'No pending waits.\n1 hidden (answered, or from ended runs); --all lists them.',
    );
  });
});

describe('workflow pending --run', () => {
  const state = (): string[] => ['--state-dir', stateDir];
  const asker = (name: string) =>
    defineWorkflow({
      name,
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: (ctx) => ctx.approve('gate', { prompt: `Ship ${name}?` }),
    });
  async function suspend(runId: string): Promise<void> {
    const sha256 = createHash('sha256')
      .update(await readFile(fixture))
      .digest('hex');
    const policy = {
      harness: { kind: 'fixture' as const, fixtures: [{ path: fixture, sha256 }] },
      waitMode: 'suspend' as const,
    };
    const run = await runWorkflow(asker(runId), {
      stateDir,
      runId,
      input: null,
      launch: { entrypoint, tsconfig: null, policy },
    });
    expect(run.status).toBe('suspended');
  }
  const ids = (document: unknown): string[] =>
    (document as PendingDocument).pending.map((row) => row.runId);

  it('lists only the named runs, in text and JSON, once each', async () => {
    await suspend('ask-run');
    await suspend('other-run');
    expect(ids((await capture(WorkflowPending, [...state(), '--json'])).document).sort()).toEqual([
      'ask-run',
      'other-run',
    ]);

    const one = await capture(WorkflowPending, [...state(), '--run', 'ask-run', '--json']);
    expect(ids(one.document)).toEqual(['ask-run']);
    expect((one.document as PendingDocument).hidden).toBe(0);

    const text = await capture(WorkflowPending, [...state(), '--run', 'ask-run']);
    expect(text.text).toContain('ask-run gate');
    expect(text.text).not.toContain('other-run');

    const both = await capture(WorkflowPending, [
      ...state(),
      '--run',
      'other-run',
      '--run',
      'ask-run',
      '--run',
      'other-run',
      '--json',
    ]);
    expect(ids(both.document)).toEqual(['other-run', 'ask-run']);
  });

  it('refuses an unknown run with run.not_found and an invalid one with usage.run_id', async () => {
    await suspend('ask-run');
    const unknown = await capture(WorkflowPending, [
      ...state(),
      '--run',
      'ask-run',
      '--run',
      'no-such-run',
      '--json',
    ]);
    const missing = unknown.document as {
      exitCode: number;
      error: { code: string; message: string; details: { runId: string; available: string[] } };
    };
    expect(missing.exitCode).toBe(3);
    expect(missing.error.code).toBe('run.not_found');
    expect(missing.error.message).toContain('no-such-run');
    expect(missing.error.details).toMatchObject({ runId: 'no-such-run', available: ['ask-run'] });

    const invalid = await capture(WorkflowPending, [...state(), '--run', 'bad id!', '--json']);
    const usage = invalid.document as { exitCode: number; error: { code: string } };
    expect(usage.exitCode).toBe(2);
    expect(usage.error.code).toBe('usage.run_id');
  });

  it('composes with default hiding and --all, counting only the selected runs', async () => {
    await suspend('ask-run');
    await suspend('other-run');
    const queued = await capture(WorkflowAnswer, [
      'ask-run',
      'gate',
      '--json',
      '{"approved":true}',
      ...state(),
    ]);
    expect(queued.error).toBeUndefined();

    const hiddenDefault = (
      await capture(WorkflowPending, [...state(), '--run', 'ask-run', '--json'])
    ).document as PendingDocument;
    expect(hiddenDefault.pending).toEqual([]);
    expect(hiddenDefault.hidden).toBe(1);
    const text = await capture(WorkflowPending, [...state(), '--run', 'ask-run']);
    expect(text.text).toBe(
      'No pending waits.\n1 hidden (answered, or from ended runs); --all lists them.',
    );

    const all = (
      await capture(WorkflowPending, [...state(), '--run', 'ask-run', '--all', '--json'])
    ).document as PendingDocument;
    expect(all.hidden).toBe(0);
    expect(all.pending).toHaveLength(1);
    expect(all.pending[0]).toMatchObject({ runId: 'ask-run', delivery: { state: 'queued' } });
    expect(all.pending[0]?.next).toHaveLength(1);

    const other = (await capture(WorkflowPending, [...state(), '--run', 'other-run', '--json']))
      .document as PendingDocument;
    expect(ids(other)).toEqual(['other-run']);
    expect(other.hidden).toBe(0);
  });

  it('answers a known run with no waiting rows as an empty listing', async () => {
    await suspend('ask-run');
    await runWorkflow(
      defineWorkflow({
        name: 'done',
        version: '1',
        input: z.null(),
        output: z.null(),
        run: () => Promise.resolve(null),
      }),
      { stateDir, runId: 'done-run', input: null },
    );
    const listed = await capture(WorkflowPending, [...state(), '--run', 'done-run', '--json']);
    expect(listed.document).toMatchObject({ ok: true, pending: [], hidden: 0 });
    expect((await capture(WorkflowPending, [...state(), '--run', 'done-run'])).text).toBe(
      'No pending waits.',
    );
  });

  it('does not fail on a damaged record of another run', async () => {
    await suspend('ask-run');
    await mkdir(join(stateDir, 'broken-run'), { recursive: true });
    await writeFile(join(stateDir, 'broken-run', 'run.json'), '{ not json');

    const unfiltered = await capture(WorkflowPending, [...state(), '--json']);
    expect((unfiltered.document as { error: { code: string } }).error.code).toBe('run.unreadable');

    const filtered = await capture(WorkflowPending, [...state(), '--run', 'ask-run', '--json']);
    expect(ids(filtered.document)).toEqual(['ask-run']);

    const damaged = await capture(WorkflowPending, [...state(), '--run', 'broken-run', '--json']);
    expect((damaged.document as { error: { code: string } }).error.code).toBe('run.unreadable');
  });
});

describe('workflow answer with text that is not JSON', () => {
  it('reports one answer_not_json issue on one line', async () => {
    const refused = await capture(WorkflowAnswer, [
      'any-run',
      'gate',
      '--json',
      '{"approved":',
      '--state-dir',
      stateDir,
    ]);
    const failure = refused.document as {
      exitCode: number;
      error: {
        code: string;
        message: string;
        details: { issues: { code: string; path: unknown[]; message: string }[] };
      };
    };
    expect(failure.exitCode).toBe(2);
    expect(failure.error.code).toBe('answer.invalid');
    expect(failure.error.details.issues).toEqual([
      { code: 'answer_not_json', path: [], message: failure.error.message },
    ]);
    expect(failure.error.message).not.toContain('\n');
  });
});
