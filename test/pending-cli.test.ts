// `workflow answer` and `workflow pending` driven as CLI commands, in process, against real saved
// runs: the delivery state a queued answer leaves behind, the default listing filter, and the
// structured issues of a refused answer. No workflow code is imported by either command.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
