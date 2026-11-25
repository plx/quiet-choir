// quiet-choir/std edit patterns end to end: isolatedEdits against a real temporary Git repository
// (isolated editor checkouts, owned-path violations, failures, conflicts and the merge), and
// approvedPlan through real approvals answered with writeAnswer (revision rounds, rejection,
// running out of revisions). Both check the exact step IDs, that failures become data that a
// resume does not retry, replay after a tail failure without new calls, option validation, and
// that every schema they send passes checkCodexSchema.
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NodeProcessRunner,
  checkCodexSchema,
  defineWorkflow,
  runWorkflow,
  writeAnswer,
  z,
  type HarnessRequest,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowResult,
} from '../src/index.js';
import * as data from '../src/std/data.js';
import * as edits from '../src/std/edits.js';
import { Plan, WorkReport } from '../src/std/types.js';
import {
  ScriptedHarness,
  makeRoot,
  promptOf,
  removeRoot,
  roundTrip,
  runOptions,
  tailFailure,
} from './std-harness.js';

const execute = promisify(execFile);
let root: string;
let repo: string;

beforeEach(async () => {
  root = await makeRoot('choir-std-edits-');
  repo = join(root, 'repo');
});
afterEach(async () => {
  await removeRoot(root);
});

/** A workflow named `name` whose body is `body`, with an unchecked JSON output. */
function workflow(
  name: string,
  body: (ctx: WorkflowContext) => Promise<unknown>,
): WorkflowDefinition<null, unknown> {
  return defineWorkflow({
    name,
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) => body(ctx),
  });
}

/** The output of a completed isolatedEdits run, checked against its result schema. */
function outcome(result: WorkflowResult<unknown>): edits.IsolatedEditsResult {
  expect(result.status).toBe('completed');
  roundTrip(edits.IsolatedEditsResult, result.output);
  return result.output as unknown as edits.IsolatedEditsResult;
}

it('sends only schemas that Codex structured output accepts', () => {
  expect(checkCodexSchema(Plan)).toEqual([]);
  expect(checkCodexSchema(WorkReport)).toEqual([]);
  expect(edits.planCall({ plan: samplePlan() }).schema).toBe(WorkReport);
});

// ---------------------------------------------------------------------------------------------
// isolatedEdits
// ---------------------------------------------------------------------------------------------

describe('isolatedEdits', () => {
  /** Run `git` in the fixture repository with a fixed identity and no signing. */
  async function git(...args: string[]): Promise<string> {
    const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];
    const { stdout } = await execute('git', [...identity, '-c', 'commit.gpgSign=false', ...args], {
      cwd: repo,
    });
    return stdout;
  }

  /** Commit everything in the fixture repository and return the commit ID. */
  async function commit(message: string): Promise<string> {
    await git('add', '--all');
    await git('commit', '--quiet', '-m', message);
    return (await git('rev-parse', 'HEAD')).trim();
  }

  let base: string;
  beforeEach(async () => {
    await mkdir(join(repo, 'src', 'a'), { recursive: true });
    await mkdir(join(repo, 'src', 'b'), { recursive: true });
    await git('init', '--quiet');
    const hooks = join(root, 'empty-hooks');
    await mkdir(hooks);
    await git('config', '--local', 'core.hooksPath', hooks);
    await writeFile(join(repo, 'src', 'a', 'a.txt'), 'a\n');
    await writeFile(join(repo, 'src', 'b', 'b.txt'), 'b\n');
    await writeFile(join(repo, 'shared.txt'), 'shared\n');
    base = await commit('base');
  });

  /** Run options with the repository as the checkout, a real process runner and a worktree root. */
  const options = (harness: ScriptedHarness, runId = 'std') => ({
    ...runOptions(root, runId),
    cwd: repo,
    harness,
    processRunner: new NodeProcessRunner(),
    worktrees: { root: join(root, 'worktrees') },
  });

  /** One edit task: its key, the files it writes (path to content) and the paths it owns. */
  interface Job {
    readonly id: string;
    readonly writes: Readonly<Record<string, string>>;
    readonly owns: readonly string[];
  }

  /** An editor that applies a job's writes in its checkout; `fail` lists keys whose call throws. */
  function editor(jobs: readonly Job[], fail: readonly string[] = []): ScriptedHarness {
    return new ScriptedHarness(async (request: HarnessRequest) => {
      const job = jobs.find((entry) => request.stepId === `edits/item/${entry.id}/edit`);
      if (job === undefined) throw new Error(`Unexpected call ${request.stepId}`);
      if (fail.includes(job.id)) throw new Error(`Editor ${job.id} crashed`);
      for (const [path, content] of Object.entries(job.writes))
        await writeFile(join(request.cwd, path), content);
      return `Edited ${Object.keys(job.writes).join(', ') || 'nothing'}.`;
    });
  }

  /** isolatedEdits over `jobs`, keyed by id, owning `owns`, with `extra` options. */
  const edit = (
    jobs: readonly Job[],
    extra: Partial<edits.IsolatedEditsOptions<Job>> = {},
  ): WorkflowDefinition<null, unknown> =>
    workflow('isolated-edits', (ctx) =>
      edits.isolatedEdits(ctx, {
        id: 'edits',
        team: { editor: ctx.claude.bind({}) },
        items: jobs,
        key: (job) => job.id,
        task: (job) => `Write ${Object.keys(job.writes).join(', ')}.`,
        owns: (job) => job.owns,
        ...extra,
      }),
    );

  /** The content of `path` at `commit`. */
  const show = (at: string, path: string) => git('show', `${at}:${path}`);

  const jobA: Job = { id: 'a', writes: { 'src/a/a.txt': 'A\n' }, owns: ['src/a/'] };
  const jobB: Job = { id: 'b', writes: { 'src/b/new.txt': 'new\n' }, owns: ['src/b'] };

  it('edits each item in its own checkout, merges the changes and replays without new calls', async () => {
    const harness = editor([jobA, jobB]);
    const wrapped = tailFailure(edit([jobA, jobB]));
    await expect(runWorkflow(wrapped, { ...options(harness), input: null })).rejects.toThrow(
      'Injected tail failure',
    );
    const resumed = await runWorkflow(wrapped, { ...options(harness), resume: true });
    const again = await runWorkflow(wrapped, { ...options(harness), resume: true });
    expect(harness.calls).toHaveLength(2);
    expect(again.steps).toEqual(resumed.steps);
    expect(resumed.status).toBe('completed');
    const output = outcome(resumed);
    expect(output).toMatchObject({
      status: 'complete',
      merged: ['a', 'b'],
      conflicts: [],
      changes: [
        { key: 'a', files: ['src/a/a.txt'], summary: 'Edited src/a/a.txt.' },
        { key: 'b', files: ['src/b/new.txt'], summary: 'Edited src/b/new.txt.' },
      ],
      violations: [],
      unchanged: [],
      failed: [],
      failures: 0,
    });
    expect(output.merge?.conflicts).toEqual([]);
    expect(output.commit).toBe(output.merge?.commit);
    expect(output.merge?.merged).toHaveLength(2);
    expect([...harness.ids()].sort()).toEqual(['edits/item/a/edit', 'edits/item/b/edit']);
    expect(Object.keys(resumed.steps).sort()).toEqual([
      'edits/item/a/edit',
      'edits/item/b/edit',
      'edits/merge',
      'probe/tail',
    ]);
    // Each editor worked in a fresh checkout under the worktree root, never in the repository.
    for (const call of harness.calls)
      expect(call.cwd.startsWith(join(root, 'worktrees'))).toBe(true);
    const commitId = output.merge?.commit ?? '';
    expect(await show(commitId, 'src/a/a.txt')).toBe('A\n');
    expect(await show(commitId, 'src/b/new.txt')).toBe('new\n');
    // The default target is a run-owned ref: the checkout is untouched.
    expect((await git('rev-parse', 'HEAD')).trim()).toBe(base);
    expect(await readFile(join(repo, 'src', 'a', 'a.txt'), 'utf8')).toBe('a\n');
    // The default prompt names the change, the owned paths and the rules.
    const prompt = harness.prompt('edits/item/a/edit');
    expect(prompt).toContain('Write src/a/a.txt.');
    expect(prompt).toContain('### Paths you own\n\n- src/a');
    expect(prompt).toContain('Change only files under the paths you own');
  }, 20_000);

  it('leaves out a change outside its owned paths and keeps failures as data', async () => {
    const stray: Job = { id: 'stray', writes: { 'shared.txt': 'stray\n' }, owns: ['docs'] };
    const idle: Job = { id: 'idle', writes: {}, owns: ['notes'] };
    const broken: Job = { id: 'broken', writes: { 'x.txt': 'x' }, owns: ['x.txt'] };
    // Owning `shared.txt` does not own `shared.txt.bak`: a path owns only itself and what is under it.
    const near: Job = { id: 'near', writes: { 'shared.txt.bak': 'near\n' }, owns: ['shared.txt'] };
    const jobs = [jobA, stray, near, idle, broken];
    const harness = editor(jobs, ['broken']);
    const result = await runWorkflow(edit(jobs), { ...options(harness), input: null });
    expect(result.output).toMatchObject({
      status: 'degraded',
      merged: ['a'],
      conflicts: [],
      changes: [{ key: 'a', files: ['src/a/a.txt'] }],
      violations: [
        { key: 'stray', files: ['shared.txt'] },
        { key: 'near', files: ['shared.txt.bak'] },
      ],
      unchanged: ['idle'],
      failed: ['broken'],
      failures: 1,
    });
    const commitId = outcome(result).merge?.commit ?? '';
    expect(await show(commitId, 'shared.txt')).toBe('shared\n');
    expect(harness.count('edits/item/broken/edit')).toBe(1);
    // A resume replays the saved failure instead of retrying the editor.
    const resumed = await runWorkflow(edit(jobs), { ...options(harness), resume: true });
    expect(resumed.output).toEqual(result.output);
    expect(harness.count('edits/item/broken/edit')).toBe(1);
  }, 20_000);

  it('checks both paths of a renamed file against the owned paths', async () => {
    // `a` moves shared.txt (which it does not own) into its own directory: Git reports a rename
    // whose destination is owned, but the merge would delete shared.txt.
    const harness = new ScriptedHarness(async (request) => {
      if (request.stepId === 'edits/item/a/edit')
        await rename(join(request.cwd, 'shared.txt'), join(request.cwd, 'src', 'a', 'shared.txt'));
      else
        await rename(
          join(request.cwd, 'src', 'b', 'b.txt'),
          join(request.cwd, 'src', 'b', 'c.txt'),
        );
      return 'moved';
    });
    const result = await runWorkflow(edit([jobA, jobB]), { ...options(harness), input: null });
    const output = outcome(result);
    expect(output).toMatchObject({
      status: 'degraded',
      merged: ['b'],
      changes: [{ key: 'b', files: ['src/b/b.txt', 'src/b/c.txt'] }],
      violations: [{ key: 'a', files: ['shared.txt'] }],
    });
    expect(await show(output.commit ?? '', 'shared.txt')).toBe('shared\n');
    expect(Object.keys(result.steps).sort()).toEqual([
      'edits/item/a/edit',
      'edits/item/a/paths',
      'edits/item/b/edit',
      'edits/item/b/paths',
      'edits/merge',
    ]);
  }, 20_000);

  it('reports a conflicting change by key and merges the rest', async () => {
    const first: Job = { id: 'first', writes: { 'shared.txt': 'first\n' }, owns: [] };
    const second: Job = { id: 'second', writes: { 'shared.txt': 'second\n' }, owns: [] };
    const harness = editor([first, second]);
    const result = await runWorkflow(edit([first, second], { owns: undefined }), {
      ...options(harness),
      input: null,
    });
    const output = outcome(result);
    expect(output).toMatchObject({
      status: 'degraded',
      merged: ['first'],
      conflicts: ['second'],
      violations: [],
    });
    expect(output.changes.map((change) => change.key)).toEqual(['first', 'second']);
    expect(await show(output.merge?.commit ?? '', 'shared.txt')).toBe('first\n');
    // Without owns, the prompt asks to keep the change to the description.
    expect(harness.prompt('edits/item/first/edit')).not.toContain('Paths you own');
  }, 20_000);

  it('starts every checkout from base and honors the merge options', async () => {
    await writeFile(join(repo, 'shared.txt'), 'moved\n');
    await commit('move HEAD');
    const seen: string[] = [];
    const harness = new ScriptedHarness(async (request) => {
      seen.push(await readFile(join(request.cwd, 'shared.txt'), 'utf8'));
      await writeFile(join(request.cwd, 'src', 'a', 'a.txt'), 'A\n');
      return 'done';
    });
    const result = await runWorkflow(
      edit([jobA], {
        base: { commit: base },
        merge: { strategy: 'squash', commit: { message: 'Integrate the edits' } },
      }),
      { ...options(harness), input: null },
    );
    expect(seen).toEqual(['shared\n']);
    const commitId = outcome(result).merge?.commit ?? '';
    expect((await git('log', '-1', '--format=%s', commitId)).trim()).toBe('Integrate the edits');
  }, 20_000);

  it('returns no commit when every change conflicts', async () => {
    await writeFile(join(repo, 'shared.txt'), 'moved\n');
    await commit('move HEAD');
    const harness = editor([{ id: 'late', writes: { 'shared.txt': 'late\n' }, owns: [] }]);
    const result = await runWorkflow(
      edit([{ id: 'late', writes: { 'shared.txt': 'late\n' }, owns: [] }], {
        owns: undefined,
        base: { commit: base },
      }),
      { ...options(harness), input: null },
    );
    const output = outcome(result);
    expect(output).toMatchObject({ status: 'degraded', commit: null, merged: [] });
    expect(output.conflicts).toEqual(['late']);
    expect(output.merge?.conflicts).toHaveLength(1);
  }, 20_000);

  it('refuses to replay the edits after the base changes', async () => {
    await writeFile(join(repo, 'shared.txt'), 'moved\n');
    const moved = await commit('move HEAD');
    const harness = editor([jobA]);
    const pinned = (at: string) => tailFailure(edit([jobA], { base: { commit: at } }));
    await expect(runWorkflow(pinned(base), { ...options(harness), input: null })).rejects.toThrow(
      'Injected tail failure',
    );
    // The base is part of each map item, so the map fingerprint shows the change.
    await expect(runWorkflow(pinned(moved), { ...options(harness), resume: true })).rejects.toThrow(
      'Settled map edits/item changed after an item completed (changed: items)',
    );
    expect(harness.calls).toHaveLength(1);
  }, 20_000);

  it('refuses to replay the edits after a call placement change', async () => {
    const harness = editor([jobA]);
    const placed = (calls?: { readonly addDirs: string[] }) => tailFailure(edit([jobA], { calls }));
    await expect(runWorkflow(placed(), { ...options(harness), input: null })).rejects.toThrow(
      'Injected tail failure',
    );
    await expect(
      runWorkflow(placed({ addDirs: ['extra'] }), { ...options(harness), resume: true }),
    ).rejects.toThrow('Settled map edits/item changed after an item completed (changed: items)');
    expect(harness.calls).toHaveLength(1);
  }, 20_000);

  it('skips the merge when nothing changed', async () => {
    const idle: Job = { id: 'idle', writes: {}, owns: [] };
    const harness = editor([idle]);
    const result = await runWorkflow(edit([idle]), { ...options(harness), input: null });
    expect(result.output).toEqual({
      status: 'complete',
      commit: null,
      merge: null,
      merged: [],
      conflicts: [],
      changes: [],
      violations: [],
      unchanged: ['idle'],
      failed: [],
      failures: 0,
    });
    expect(Object.keys(result.steps)).not.toContain('edits/merge');
    roundTrip(edits.IsolatedEditsResult, result.output);
    const empty = await runWorkflow(edit([]), { ...options(harness, 'empty'), input: null });
    expect(empty.output).toMatchObject({ status: 'complete', merge: null, changes: [] });
    roundTrip(edits.IsolatedEditsResult, empty.output);
  }, 20_000);

  it('uses a replacement prompt and the index as the default key', async () => {
    const harness = new ScriptedHarness((request) => {
      expect(promptOf(request)).toBe('custom: Write src/a/a.txt. owns src/a');
      return 'nothing';
    });
    const result = await runWorkflow(
      edit([jobA], {
        key: undefined,
        prompts: { edit: (request) => `custom: ${request.task} owns ${String(request.owns)}` },
      }),
      { ...options(harness), input: null },
    );
    expect(harness.ids()).toEqual(['edits/item/0/edit']);
    expect(result.output).toMatchObject({ unchanged: ['0'] });
  }, 20_000);

  it('validates its options before any effect', async () => {
    const harness = editor([jobA]);
    let runs = 0;
    const run = (extra: Partial<edits.IsolatedEditsOptions<Job>>, jobs = [jobA]) =>
      runWorkflow(edit(jobs, extra), {
        ...options(harness, `invalid-${String((runs += 1))}`),
        input: null,
      });
    await expect(run({ calls: { worktree: true } })).rejects.toThrow(
      'isolatedEdits edits: every edit gets a fresh checkout of its own; set base, not calls.worktree.',
    );
    await expect(run({ owns: () => ['../escape'] })).rejects.toThrow(
      'isolatedEdits edits: item a owns "../escape", which is not a repository-relative path.',
    );
    await expect(
      run({ owns: (job) => (job.id === 'a' ? ['src'] : ['src/b/b.txt']) }, [jobA, jobB]),
    ).rejects.toThrow(
      'isolatedEdits edits: items must own disjoint paths: Overlapping files: "src" (a) contains "src/b/b.txt" (b).',
    );
    await expect(run({ concurrency: 0 })).rejects.toThrow(
      'concurrency must be a positive integer; got 0.',
    );
    await expect(run({ task: () => ' ' })).rejects.toThrow(
      'isolatedEdits edits: item a has a blank task.',
    );
    // Not a TypeError journaled as every item's failed edit, which a resume would replay.
    await expect(run({ team: {} as edits.EditTeam })).rejects.toThrow(
      'Team slot editor is not filled.',
    );
    expect(harness.calls).toHaveLength(0);
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------
// approvedPlan
// ---------------------------------------------------------------------------------------------

/** A small valid plan; `tag` distinguishes revisions. */
function samplePlan(tag = 'first'): Plan {
  return {
    summary: `Add retries (${tag}).`,
    steps: [{ id: 'S1', description: 'Wrap the fetch in a retry loop.', files: ['src/fetch.ts'] }],
    risks: ['Retries could hide a persistent outage.'],
    checks: ['npm test'],
  };
}

describe('approvedPlan', () => {
  /** A planner that answers round `n` with `plans[n]`. */
  function planner(plans: readonly Plan[]): ScriptedHarness {
    return new ScriptedHarness((request) => {
      const match = /^plan\/round\/(\d+)\/plan$/u.exec(request.stepId);
      const plan = match === null ? undefined : plans[Number(match[1])];
      if (plan === undefined) throw new Error(`Unexpected call ${request.stepId}`);
      return plan;
    });
  }

  /** approvedPlan for a fixed task, with `extra` options. */
  const plan = (
    extra: Partial<edits.ApprovedPlanOptions> = {},
  ): WorkflowDefinition<null, unknown> =>
    workflow('approved-plan', (ctx) =>
      edits.approvedPlan(ctx, {
        id: 'plan',
        team: { planner: ctx.claude.bind({}) },
        task: 'Add retries to the fetch client.',
        ...extra,
      }),
    );

  /**
   * Run `definition` and answer each approval it waits for with the next of `answers`, resuming
   * until it completes; with `tail`, the run is wrapped so its first completion fails at the tail,
   * and two more resumes must make no new call and record the same steps.
   */
  async function drive(
    definition: WorkflowDefinition<null, unknown>,
    harness: ScriptedHarness,
    answers: readonly { approved: boolean; comment?: string }[],
    tail = false,
  ): Promise<{
    result: WorkflowResult<unknown>;
    questions: {
      stepId: string;
      subject: unknown;
      details: string | null;
      title: string | null;
      audience: string;
    }[];
  }> {
    const wrapped = tail ? tailFailure(definition) : definition;
    const setup = { ...runOptions(root), harness };
    const questions: {
      stepId: string;
      subject: unknown;
      details: string | null;
      title: string | null;
      audience: string;
    }[] = [];
    const next = async (resume: boolean): Promise<WorkflowResult<unknown>> =>
      resume
        ? runWorkflow(wrapped, { ...setup, resume: true })
        : runWorkflow(wrapped, { ...setup, input: null });
    let started = false;
    for (const answer of answers) {
      const waiting = await next(started);
      started = true;
      expect(waiting.status).toBe('suspended');
      const pending = waiting.status === 'suspended' ? waiting.pending : [];
      expect(pending).toHaveLength(1);
      const question = pending[0];
      if (question === undefined || !('questionFingerprint' in question))
        throw new Error('Expected one pending approval');
      questions.push({
        stepId: question.stepId,
        subject: question.subject,
        details: question.details,
        title: question.title,
        audience: question.audience,
      });
      await writeAnswer({ ...setup, stepId: question.stepId, value: answer, by: 'human:fixture' });
    }
    if (!tail) return { result: await next(started), questions };
    await expect(next(started)).rejects.toThrow('Injected tail failure');
    const count = harness.calls.length;
    const result = await next(true);
    expect(harness.calls).toHaveLength(count);
    const again = await next(true);
    expect(again.steps).toEqual(result.steps);
    return { result, questions };
  }

  it('approves the first plan, with the digest as the subject, and replays without new calls', async () => {
    const harness = planner([samplePlan()]);
    const { result, questions } = await drive(
      plan(),
      harness,
      [{ approved: true, comment: 'Cap it at three tries.' }],
      true,
    );
    const digest = data.digest(samplePlan());
    expect(result.output).toEqual({
      approved: true,
      outcome: 'approved',
      plan: samplePlan(),
      digest,
      rounds: 1,
      comment: 'Cap it at three tries.',
      failures: 0,
      status: 'complete',
    });
    roundTrip(edits.ApprovedPlanResult, result.output);
    expect(harness.ids()).toEqual(['plan/round/0/plan']);
    expect(Object.keys(result.steps).sort()).toEqual([
      'plan/round/0/approve',
      'plan/round/0/plan',
      'probe/tail',
    ]);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      stepId: 'plan/round/0/approve',
      subject: digest,
      title: 'Plan review',
      audience: 'human',
    });
    const details = questions[0]?.details ?? '';
    expect(details).toContain(`Plan digest: ${digest}`);
    expect(details).toContain('## Task\n\nAdd retries to the fetch client.');
    expect(details).toContain('1. S1: Wrap the fetch in a retry loop.\n   Files: src/fetch.ts');
    expect(details).toContain('## Checks\n\n- npm test');
    const prompt = harness.prompt('plan/round/0/plan');
    expect(prompt).toContain('Write an implementation plan for the task below.');
    expect(prompt).toContain('### Task\n\nAdd retries to the fetch client.');
  });

  it('revises a plan rejected with a comment and approves the revision', async () => {
    const harness = planner([samplePlan(), samplePlan('second')]);
    // A JSON context may hold read-only arrays and interface-typed values.
    const files: readonly string[] = ['src/fetch.ts', 'src/retry.ts'];
    const earlier: data.Coverage = { covered: ['fetch'], missing: [] };
    const { result, questions } = await drive(
      plan({ context: { client: 'src/fetch.ts', files, earlier } }),
      harness,
      [{ approved: false, comment: 'Add a step for the backoff tests.' }, { approved: true }],
    );
    expect(result.output).toMatchObject({
      approved: true,
      outcome: 'approved',
      plan: samplePlan('second'),
      digest: data.digest(samplePlan('second')),
      rounds: 2,
      comment: null,
    });
    roundTrip(edits.ApprovedPlanResult, result.output);
    expect(harness.ids()).toEqual(['plan/round/0/plan', 'plan/round/1/plan']);
    expect(Object.keys(result.steps).sort()).toEqual([
      'plan/round/0/approve',
      'plan/round/0/plan',
      'plan/round/1/approve',
      'plan/round/1/plan',
    ]);
    expect(questions.map((question) => question.stepId)).toEqual([
      'plan/round/0/approve',
      'plan/round/1/approve',
    ]);
    const revise = harness.prompt('plan/round/1/plan');
    expect(revise).toContain("### Reviewer's comment\n\nAdd a step for the backoff tests.");
    expect(revise).toContain('"summary": "Add retries (first)."');
    expect(revise).toContain(
      '### Background\n\n```json\n{\n  "client": "src/fetch.ts",\n  "files": [\n    "src/fetch.ts",\n    "src/retry.ts"\n  ],\n  "earlier": {\n    "covered": [',
    );
    expect(questions[1]?.details).toContain(
      '## Revised to answer\n\nAdd a step for the backoff tests.',
    );
  });

  it('stops at a rejection without a comment', async () => {
    const harness = planner([samplePlan()]);
    const { result } = await drive(plan(), harness, [{ approved: false, comment: '  ' }]);
    expect(result.output).toMatchObject({
      approved: false,
      outcome: 'rejected',
      rounds: 1,
      comment: null,
    });
    roundTrip(edits.ApprovedPlanResult, result.output);
    expect(harness.ids()).toEqual(['plan/round/0/plan']);
  });

  it('returns the last plan unapproved when the revisions run out', async () => {
    const harness = planner([samplePlan(), samplePlan('second')]);
    const { result } = await drive(
      plan({ revisions: 1, title: 'Retry plan', audience: 'any', question: 'Ship this plan?' }),
      harness,
      [
        { approved: false, comment: 'More detail.' },
        { approved: false, comment: 'Still too vague.' },
      ],
    );
    expect(result.output).toMatchObject({
      approved: false,
      outcome: 'out-of-revisions',
      status: 'complete',
      plan: samplePlan('second'),
      rounds: 2,
      comment: 'Still too vague.',
    });
    roundTrip(edits.ApprovedPlanResult, result.output);
    expect(harness.ids()).toEqual(['plan/round/0/plan', 'plan/round/1/plan']);
  });

  it('validates its options before any effect', async () => {
    const harness = planner([]);
    const setup = { ...runOptions(root), harness, input: null };
    await expect(runWorkflow(plan({ task: ' ' }), setup)).rejects.toThrow(
      'approvedPlan plan: task must not be blank.',
    );
    await expect(runWorkflow(plan({ revisions: -1 }), { ...setup, runId: 'neg' })).rejects.toThrow(
      'revisions must be a nonnegative integer; got -1.',
    );
    await expect(
      runWorkflow(plan({ question: 'Approve?\nReally?' }), { ...setup, runId: 'lines' }),
    ).rejects.toThrow(
      'approvedPlan plan: question must be one nonblank line of at most 1024 characters.',
    );
    await expect(
      runWorkflow(plan({ title: 'Implementation plan' }), { ...setup, runId: 'title' }),
    ).rejects.toThrow('approvedPlan plan: title must be 1 to 12 characters.');
    await expect(
      runWorkflow(plan({ team: {} as edits.PlanApprovalTeam }), { ...setup, runId: 'team' }),
    ).rejects.toThrow('Team slot planner is not filled.');
    await expect(
      runWorkflow(plan({ context: { at: new Date(0) } }), { ...setup, runId: 'context' }),
    ).rejects.toThrow(
      'approvedPlan context must be a string or a JSON value: Value is not canonical JSON at $.at: values must be plain objects, not class instances.',
    );
    expect(harness.calls).toHaveLength(0);
  });
});

describe('planCall', () => {
  it('builds the implementer prompt from an approved plan', () => {
    const call = edits.planCall(
      { approved: true, plan: samplePlan(), comment: 'Cap it at three tries.' },
      'Add retries to the fetch client.',
    );
    expect(call.schema).toBe(WorkReport);
    expect(call.prompt).toContain('Implement the approved plan below.');
    expect(call.prompt).toContain('### Task\n\nAdd retries to the fetch client.');
    expect(call.prompt).toContain('"description": "Wrap the fetch in a retry loop."');
    expect(call.prompt).toContain("### Reviewer's comment\n\nCap it at three tries.");
    expect(call.prompt).toContain("Honor the reviewer's comment above");
    const bare = edits.planCall({ plan: samplePlan() }).prompt;
    expect(bare).not.toContain('### Task');
    expect(bare).not.toContain("reviewer's comment");
  });

  it('renders the same prompt whatever the plan key order', () => {
    const plan = samplePlan();
    const reordered = {
      checks: plan.checks,
      risks: plan.risks,
      steps: plan.steps,
      summary: plan.summary,
    };
    expect(edits.planCall({ plan: reordered }).prompt).toBe(edits.planCall({ plan }).prompt);
  });

  it('refuses an unapproved plan', () => {
    expect(() => edits.planCall({ approved: false, plan: samplePlan() })).toThrow(
      'planCall: the plan was not approved; implement only an approved plan.',
    );
  });
});
