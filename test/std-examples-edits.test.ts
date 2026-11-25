// The std edit recipes end to end: std-parallel-edits (isolatedEdits over input steps, each in its
// own checkout of a real temporary Git repository, squashed into one integration commit) and
// std-approved-plan (approvedPlan through real approvals, then a Mechanic implements the approved
// plan), run against a scripted harness, checking their outputs, step IDs, team wiring, grants and
// replay after a tail failure without new agent calls.
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NodeProcessRunner,
  runWorkflow,
  synthesizeOutput,
  writeAnswer,
  type HarnessRequest,
  type WorkflowDefinition,
  type WorkflowResult,
} from '../src/index.js';
import type * as std from '../src/std/index.js';
import { capabilityManifest } from '../src/workflow/runtime/profiles.js';
import approvedPlan from '../examples/patterns/std-approved-plan.workflow.js';
import parallelEdits from '../examples/patterns/std-parallel-edits.workflow.js';
import { ScriptedHarness, makeRoot, removeRoot, runOptions, tailFailure } from './std-harness.js';

const execute = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await makeRoot('choir-std-examples-edits-');
});
afterEach(async () => {
  await removeRoot(root);
});

/** A harness that answers `replies` by step ID and fills every other structured call. */
function scripted(
  replies: Readonly<Record<string, (request: HarnessRequest) => unknown>>,
): ScriptedHarness {
  return new ScriptedHarness((request) => {
    const reply = replies[request.stepId];
    if (reply !== undefined) return reply(request);
    if (request.outputSchema === null) throw new Error(`Unscripted text call ${request.stepId}`);
    return synthesizeOutput(request.outputSchema, request.stepId);
  });
}

it('asks for a grant only on the write role each recipe calls', () => {
  const required = (workflow: object) =>
    capabilityManifest(workflow, { requireGrants: true }).requiredGrants;
  expect(required(parallelEdits)).toEqual(['Mechanic']);
  expect(required(approvedPlan)).toEqual(['Mechanic']);
});

describe('std-parallel-edits', () => {
  let repo: string;
  let base: string;

  /** Run `git` in the fixture repository with a fixed identity and no signing. */
  async function git(...args: string[]): Promise<string> {
    const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];
    const { stdout } = await execute('git', [...identity, '-c', 'commit.gpgSign=false', ...args], {
      cwd: repo,
    });
    return stdout;
  }

  beforeEach(async () => {
    repo = join(root, 'repo');
    await mkdir(join(repo, 'src'), { recursive: true });
    await git('init', '--quiet');
    const hooks = join(root, 'empty-hooks');
    await mkdir(hooks);
    await git('config', '--local', 'core.hooksPath', hooks);
    await writeFile(join(repo, 'src', 'parse.ts'), 'export const parse = 1;\n');
    await writeFile(join(repo, 'src', 'format.ts'), 'export const format = 1;\n');
    await writeFile(join(repo, 'README.md'), '# Fixture\n');
    await git('add', '--all');
    await git('commit', '--quiet', '-m', 'base');
    base = (await git('rev-parse', 'HEAD')).trim();
  });

  const edits = [
    { id: 'parse', description: 'Bump parse to 2.', files: ['src/parse.ts'] },
    { id: 'format', description: 'Bump format to 2.', files: ['src/format.ts'] },
    { id: 'docs', description: 'Mention the bump.', files: ['docs/bump.md'] },
  ];

  /** Each editor writes its file; `docs` strays into README.md, outside the files it owns. */
  const writes: Readonly<Record<string, readonly [string, string]>> = {
    'edits/item/parse/edit': ['src/parse.ts', 'export const parse = 2;\n'],
    'edits/item/format/edit': ['src/format.ts', 'export const format = 2;\n'],
    'edits/item/docs/edit': ['README.md', '# Fixture, bumped\n'],
  };

  it('edits each step in its own checkout and squashes the clean ones into one commit', async () => {
    const harness = new ScriptedHarness(async (request) => {
      const write = writes[request.stepId];
      if (write === undefined) throw new Error(`Unexpected call ${request.stepId}`);
      await writeFile(join(request.cwd, write[0]), write[1]);
      return `Wrote ${write[0]}.`;
    });
    const setup = {
      ...runOptions(root),
      cwd: repo,
      harness,
      processRunner: new NodeProcessRunner(),
      worktrees: { root: join(root, 'worktrees') },
    };
    const wrapped = tailFailure(parallelEdits);
    const input = { edits, message: 'Bump parse and format' };
    await expect(runWorkflow(wrapped, { ...setup, input })).rejects.toThrow(
      'Injected tail failure',
    );
    expect(harness.calls).toHaveLength(3);
    const result = await runWorkflow(wrapped, { ...setup, resume: true });
    const again = await runWorkflow(wrapped, { ...setup, resume: true });
    expect(harness.calls).toHaveLength(3);
    expect(again.steps).toEqual(result.steps);
    expect(result.status).toBe('completed');
    const commit = result.output?.commit ?? '';
    expect(result.output).toEqual({
      status: 'degraded',
      commit,
      merged: ['parse', 'format'],
      conflicts: [],
      violations: [{ key: 'docs', files: ['README.md'] }],
      unchanged: [],
      failed: [],
    });
    expect(Object.keys(result.steps).sort()).toEqual([
      'edits/item/docs/edit',
      'edits/item/format/edit',
      'edits/item/parse/edit',
      'edits/merge',
      'probe/tail',
    ]);
    // One squash commit on the base, with the message, holding both clean changes and not the stray one.
    expect((await git('rev-list', '--parents', '-n', '1', commit)).trim()).toBe(
      `${commit} ${base}`,
    );
    expect((await git('log', '-1', '--format=%s', commit)).trim()).toBe('Bump parse and format');
    expect(await git('show', `${commit}:src/parse.ts`)).toBe('export const parse = 2;\n');
    expect(await git('show', `${commit}:src/format.ts`)).toBe('export const format = 2;\n');
    expect(await git('show', `${commit}:README.md`)).toBe('# Fixture\n');
    // The editor is the roster's Mechanic, told which files it owns.
    const call = harness.calls.find((entry) => entry.stepId === 'edits/item/parse/edit');
    expect(call?.options).toMatchObject({ tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] });
    expect(harness.prompt('edits/item/parse/edit')).toContain(
      '### Change\n\nBump parse to 2.\n\n### Paths you own\n\n- src/parse.ts',
    );
  }, 20_000);
});

describe('std-approved-plan', () => {
  const plan: std.types.Plan = {
    summary: 'Add a --json flag to the export command.',
    steps: [{ id: 'S1', description: 'Parse --json and print JSON.', files: ['src/export.ts'] }],
    risks: ['The text output must not change.'],
    checks: ['npm test'],
  };
  const report: std.types.WorkReport = {
    status: 'done',
    summary: 'Added --json.',
    files: ['src/export.ts'],
    blockers: [],
    notes: [],
  };

  /**
   * Run `workflow` and answer each approval it waits for with the next of `answers`, then resume
   * it to an injected tail failure and twice more: the resumes make no new agent call and record
   * the same steps. Returns the first completed resume.
   */
  async function drive<I, O>(
    workflow: WorkflowDefinition<I, O>,
    input: I,
    harness: ScriptedHarness,
    answers: readonly { approved: boolean; comment?: string }[],
  ): Promise<WorkflowResult<O>> {
    const wrapped = tailFailure(workflow);
    const setup = { ...runOptions(root), harness };
    let waiting = await runWorkflow(wrapped, { ...setup, input });
    for (const answer of answers) {
      const pending = waiting.status === 'suspended' ? waiting.pending : [];
      const stepId = pending[0]?.stepId;
      if (pending.length !== 1 || stepId === undefined) throw new Error('Expected one approval');
      await writeAnswer({ ...setup, stepId, value: answer, by: 'human:fixture' });
      if (answer === answers.at(-1)) break;
      waiting = await runWorkflow(wrapped, { ...setup, resume: true });
    }
    await expect(runWorkflow(wrapped, { ...setup, resume: true })).rejects.toThrow(
      'Injected tail failure',
    );
    const count = harness.calls.length;
    const result = await runWorkflow(wrapped, { ...setup, resume: true });
    expect(harness.calls).toHaveLength(count);
    const again = await runWorkflow(wrapped, { ...setup, resume: true });
    expect(again.steps).toEqual(result.steps);
    return result;
  }

  it('revises the plan after a rejection, then implements the approved plan', async () => {
    const harness = scripted({
      'plan/round/0/plan': () => ({ ...plan, summary: 'Rewrite the exporter.' }),
      'plan/round/1/plan': () => plan,
      implement: () => report,
    });
    const result = await drive(
      approvedPlan,
      { task: 'Add --json to export.', revisions: 2 },
      harness,
      [{ approved: false, comment: 'Too broad: only add the flag.' }, { approved: true }],
    );
    expect(result.output).toEqual({ status: 'approved', plan, report });
    expect(harness.ids()).toEqual(['plan/round/0/plan', 'plan/round/1/plan', 'implement']);
    expect(Object.keys(result.steps)).toEqual(
      expect.arrayContaining(['plan/round/0/approve', 'plan/round/1/approve']),
    );
    expect(harness.prompt('plan/round/1/plan')).toContain('Too broad: only add the flag.');
    const implement = harness.prompt('implement');
    expect(implement).toContain('Implement the approved plan below.');
    expect(implement).toContain('### Task\n\nAdd --json to export.');
    expect(implement).toContain('"description": "Parse --json and print JSON."');
    // The planner is the read-only Planner and the implementer the editing Mechanic.
    const call = (id: string) => harness.calls.find((entry) => entry.stepId === id)?.options;
    expect(call('plan/round/0/plan')).toMatchObject({
      tools: ['Read', 'Grep', 'Glob'],
      model: 'opus',
    });
    expect(call('implement')).toMatchObject({ tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] });
  });

  it('returns the unapproved plan without implementing it', async () => {
    const harness = scripted({});
    const result = await drive(
      approvedPlan,
      { task: 'Add --json to export.', revisions: 0 },
      harness,
      [{ approved: false, comment: 'Not now.' }],
    );
    const schema = harness.calls[0]?.outputSchema ?? null;
    const synthesized = synthesizeOutput(schema, 'plan/round/0/plan');
    expect(result.output).toEqual({ status: 'out-of-revisions', plan: synthesized, report: null });
    expect(harness.ids()).toEqual(['plan/round/0/plan']);
  });
});
