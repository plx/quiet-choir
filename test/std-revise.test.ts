// quiet-choir/std revise patterns end to end: critiqueRevise, fixUntilGreen and escalate run real
// workflows against a scripted harness (and real check commands), checking the exact step IDs, the
// loop decisions, failure tolerance, replay after a tail failure without new calls or commands,
// option validation and the structured-output schemas they send.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  NodeProcessRunner,
  checkCodexSchema,
  defineWorkflow,
  runWorkflow,
  z,
  type HarnessRequest,
  type WorkflowContext,
  type WorkflowDefinition,
} from '../src/index.js';
import { lens } from '../src/std/lenses.js';
import * as revise from '../src/std/revise.js';
import { Critique, WorkReport, type Issue } from '../src/std/types.js';
import {
  ScriptedHarness,
  makeRoot,
  removeRoot,
  replayAfterTail,
  roundTrip,
  runOptions,
  tailFailure,
} from './std-harness.js';

const execute = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await makeRoot('choir-std-revise-');
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

/** Run `definition` once as run `runId`, with a real process runner. */
function run(
  definition: WorkflowDefinition<null, unknown>,
  harness: ScriptedHarness,
  runId = 'std',
) {
  return runWorkflow(definition, {
    ...runOptions(root, runId),
    harness,
    processRunner: new NodeProcessRunner(),
    input: null,
  });
}

/** Answer each call from `replies` by step ID; an Error value is thrown. */
function scripted(replies: Readonly<Record<string, unknown>>): ScriptedHarness {
  return new ScriptedHarness((request: HarnessRequest) => {
    if (!Object.hasOwn(replies, request.stepId))
      throw new Error(`Unexpected call ${request.stepId}`);
    const reply = replies[request.stepId];
    if (reply instanceof Error) throw reply;
    return reply;
  });
}

const issue = (where: string): Issue => ({
  where,
  problem: `${where} is unclear`,
  fix: `Rewrite ${where}`,
});

it('sends only structured-output schemas both harnesses accept', () => {
  expect(checkCodexSchema(Critique)).toEqual([]);
  expect(checkCodexSchema(WorkReport)).toEqual([]);
});

it('declares the team slots with suggested std roles', () => {
  expect(Object.keys(revise.CritiqueTeam.slots)).toEqual(['critic', 'author']);
  expect(Object.keys(revise.RepairTeam.slots)).toEqual(['mechanic', 'surgeon']);
  expect(Object.keys(revise.EscalationTeam.slots)).toEqual(['mechanic', 'surgeon']);
  expect(revise.CritiqueTeam.slots.critic).toContain('std.roles.Critic');
  expect(revise.CritiqueTeam.slots.author).toContain('std.roles.Writer');
  expect(revise.RepairTeam.slots.surgeon).toContain('std.roles.Surgeon');
  expect(revise.EscalationTeam.slots.mechanic).toContain('std.roles.Mechanic');
});

describe('critiqueRevise', () => {
  /** critiqueRevise under `cr` with one bound agent in both slots. */
  const critique = (options: Partial<revise.CritiqueReviseOptions> = {}) =>
    workflow('critique-revise', (ctx) => {
      const agent = ctx.claude.bind({});
      return revise.critiqueRevise(ctx, {
        id: 'cr',
        team: { critic: agent, author: agent },
        brief: 'A greeting for new users.',
        ...options,
      });
    });

  it('drafts from the brief, revises after a critique and stops once approved', async () => {
    const harness = scripted({
      'cr/draft': 'Hi.',
      'cr/round/0/critique': { issues: [issue('the opening')] },
      'cr/round/0/revise': 'Hello, and welcome.',
      'cr/round/1/critique': { issues: [] },
    });
    const result = await replayAfterTail(critique({ rounds: 3 }), null, harness, root);
    expect(result.output).toEqual({
      draft: 'Hello, and welcome.',
      approved: true,
      rounds: 2,
      revisions: 1,
      issues: [],
      failedCritics: 0,
      failures: 0,
      status: 'complete',
    });
    roundTrip(revise.CritiqueReviseResult, result.output);
    expect(harness.ids()).toEqual([
      'cr/draft',
      'cr/round/0/critique',
      'cr/round/0/revise',
      'cr/round/1/critique',
    ]);
    const draft = harness.prompt('cr/draft');
    expect(draft).toMatch(
      /^Write a draft that meets the brief below\.\n\n## Context\n\n### Brief/u,
    );
    expect(draft).toContain('A greeting for new users.');
    const first = harness.prompt('cr/round/0/critique');
    expect(first).toContain('Critique the draft below against its brief.');
    expect(first).toContain('```\nHi.\n```');
    expect(first).toContain('the safe default is not to approve');
    expect(first).toContain('## Output\n\nThe issues, most important first.');
    const revision = harness.prompt('cr/round/0/revise');
    expect(revision).toContain('- the opening: the opening is unclear\n  Fix: Rewrite the opening');
    expect(revision).toContain('A greeting for new users.');
    expect(harness.prompt('cr/round/1/critique')).toContain('Hello, and welcome.');
  });

  it('critiques a given draft and returns it unchanged when approved at once', async () => {
    const harness = scripted({ 'cr/round/0/critique': { issues: [] } });
    const result = await run(critique({ draft: 'Welcome!' }), harness);
    expect(result.output).toMatchObject({
      draft: 'Welcome!',
      approved: true,
      rounds: 1,
      revisions: 0,
      failures: 0,
      status: 'complete',
    });
    expect(harness.ids()).toEqual(['cr/round/0/critique']);
  });

  it('never revises after the last round and returns the open issues', async () => {
    const harness = scripted({
      'cr/round/0/critique': { issues: [issue('a')] },
      'cr/round/0/revise': 'second',
      'cr/round/1/critique': { issues: [issue('b'), issue('c')] },
    });
    const result = await run(critique({ draft: 'first' }), harness);
    expect(result.output).toEqual({
      draft: 'second',
      approved: false,
      rounds: 2,
      revisions: 1,
      issues: [issue('b'), issue('c')],
      failedCritics: 0,
      failures: 0,
      status: 'complete',
    });
    roundTrip(revise.CritiqueReviseResult, result.output);
    expect(harness.ids()).toEqual([
      'cr/round/0/critique',
      'cr/round/0/revise',
      'cr/round/1/critique',
    ]);
  });

  it('runs one settled critic per lens and revises from the critics that answered', async () => {
    const lenses = [lens('clarity', 'Plain wording.'), lens('accuracy', 'True claims.')];
    const harness = scripted({
      'cr/round/0/lens/clarity/critique': { issues: [issue('the opening')] },
      'cr/round/0/lens/accuracy/critique': new Error('critic crashed'),
      'cr/round/0/revise': 'better',
      'cr/round/1/lens/clarity/critique': { issues: [] },
      'cr/round/1/lens/accuracy/critique': { issues: [] },
    });
    const result = await replayAfterTail(
      critique({ draft: 'draft', lenses, concurrency: 1 }),
      null,
      harness,
      root,
    );
    expect(result.output).toEqual({
      draft: 'better',
      approved: true,
      rounds: 2,
      revisions: 1,
      issues: [],
      failedCritics: 1,
      failures: 1,
      status: 'degraded',
    });
    roundTrip(revise.CritiqueReviseResult, result.output);
    expect(harness.ids()).toEqual([
      'cr/round/0/lens/clarity/critique',
      'cr/round/0/lens/accuracy/critique',
      'cr/round/0/revise',
      'cr/round/1/lens/clarity/critique',
      'cr/round/1/lens/accuracy/critique',
    ]);
    expect(harness.count('cr/round/0/lens/accuracy/critique')).toBe(1);
    expect(Object.keys(result.maps ?? {}).sort()).toEqual(['cr/round/0/lens', 'cr/round/1/lens']);
    const prompt = harness.prompt('cr/round/0/lens/clarity/critique');
    expect(prompt).toContain('through one lens: clarity.');
    expect(prompt).toContain('- Focus only on clarity: Plain wording.');
  });

  it('makes duplicate lens keys unique', async () => {
    const lenses = [lens('style', 'One.'), lens('style', 'Two.')];
    const harness = new ScriptedHarness(() => ({ issues: [] }));
    await run(critique({ draft: 'd', lenses }), harness);
    expect(harness.ids().sort()).toEqual([
      'cr/round/0/lens/style.2/critique',
      'cr/round/0/lens/style/critique',
    ]);
  });

  it('does not approve when a critic failed, and critiques the same draft again', async () => {
    const harness = scripted({
      'cr/round/0/critique': new Error('critic timed out'),
      'cr/round/1/critique': { issues: [] },
    });
    const recovered = await replayAfterTail(critique({ draft: 'same' }), null, harness, root);
    expect(recovered.output).toMatchObject({
      draft: 'same',
      approved: true,
      rounds: 2,
      revisions: 0,
      failedCritics: 1,
      failures: 1,
      status: 'degraded',
    });
    expect(harness.prompt('cr/round/1/critique')).toContain('```\nsame\n```');
    expect(harness.count('cr/round/0/critique')).toBe(1);
    roundTrip(revise.CritiqueReviseResult, recovered.output);

    const failing = scripted({ 'cr/round/0/critique': new Error('critic timed out') });
    const degraded = await run(critique({ draft: 'same', rounds: 1 }), failing, 'degraded');
    expect(degraded.output).toEqual({
      draft: 'same',
      approved: false,
      rounds: 1,
      revisions: 0,
      issues: [],
      failedCritics: 1,
      failures: 1,
      status: 'degraded',
    });
    roundTrip(revise.CritiqueReviseResult, degraded.output);
  });

  it('uses replacement prompts', async () => {
    const harness = scripted({
      'cr/draft': 'v1',
      'cr/round/0/critique': { issues: [issue('x')] },
      'cr/round/0/revise': 'v2',
      'cr/round/1/critique': { issues: [] },
    });
    await run(
      critique({
        prompts: {
          draft: (brief) => `DRAFT ${brief}`,
          critique: (draft, _brief, lensValue) => `CRIT ${draft} ${lensValue?.key ?? 'all'}`,
          revise: (draft, issues) => `REV ${draft} ${String(issues.length)}`,
        },
      }),
      harness,
    );
    expect(harness.prompt('cr/draft')).toBe('DRAFT A greeting for new users.');
    expect(harness.prompt('cr/round/0/critique')).toBe('CRIT v1 all');
    expect(harness.prompt('cr/round/0/revise')).toBe('REV v1 1');
    expect(harness.prompt('cr/round/1/critique')).toBe('CRIT v2 all');
  });

  it('asks the author for plain text, never a fenced block', async () => {
    const harness = scripted({
      'cr/draft': 'v1',
      'cr/round/0/critique': { issues: [issue('x')] },
      'cr/round/0/revise': 'v2',
      'cr/round/1/critique': { issues: [] },
    });
    await run(critique(), harness);
    for (const step of ['cr/draft', 'cr/round/0/revise'])
      expect(harness.prompt(step)).toContain('as plain text, not wrapped in a code fence');
  });

  it('passes the call defaults to every author and critic call', async () => {
    const calls = { timeoutMs: 12_345, addDirs: ['extra'] };
    const harness = new ScriptedHarness((request) =>
      request.outputSchema === null
        ? 'text'
        : { issues: request.stepId.includes('/round/0/') ? [issue('x')] : [] },
    );
    await run(critique({ calls }), harness, 'plain');
    await run(critique({ calls, lenses: [lens('clarity', 'Plain wording.')] }), harness, 'lens');
    expect(harness.ids()).toEqual([
      'cr/draft',
      'cr/round/0/critique',
      'cr/round/0/revise',
      'cr/round/1/critique',
      'cr/draft',
      'cr/round/0/lens/clarity/critique',
      'cr/round/0/revise',
      'cr/round/1/lens/clarity/critique',
    ]);
    for (const call of harness.calls) expect(call.options).toMatchObject(calls);
  });

  it('refuses to replay settled lens critics after a version change', async () => {
    const harness = new ScriptedHarness(() => ({ issues: [] }));
    const versioned = (version: string) =>
      tailFailure(critique({ draft: 'd', lenses: [lens('clarity', 'Plain.')], version }));
    const options = { ...runOptions(root), harness };
    await expect(runWorkflow(versioned('1'), { ...options, input: null })).rejects.toThrow(
      'Injected tail failure',
    );
    await expect(runWorkflow(versioned('2'), { ...options, resume: true })).rejects.toThrow(
      'Settled map cr/round/0/lens changed after an item completed (changed: version)',
    );
    expect(harness.calls).toHaveLength(1);
  });

  it('refuses to replay settled lens critics after a call placement change', async () => {
    const harness = new ScriptedHarness(() => ({ issues: [] }));
    const placed = (calls?: { readonly cwd: string }) =>
      tailFailure(critique({ draft: 'd', lenses: [lens('clarity', 'Plain.')], calls }));
    const options = { ...runOptions(root), harness };
    await expect(runWorkflow(placed(), { ...options, input: null })).rejects.toThrow(
      'Injected tail failure',
    );
    await expect(runWorkflow(placed({ cwd: 'pkg' }), { ...options, resume: true })).rejects.toThrow(
      'Settled map cr/round/0/lens changed after an item completed (changed: items)',
    );
    expect(harness.calls).toHaveLength(1);
  });

  it('rethrows a failed author call, and a resume retries only that call', async () => {
    let fail = true;
    const harness = new ScriptedHarness((request) => {
      if (request.stepId === 'cr/round/0/revise') {
        if (fail) throw new Error('author crashed');
        return 'revised';
      }
      return { issues: request.stepId === 'cr/round/0/critique' ? [issue('x')] : [] };
    });
    const definition = critique({ draft: 'first' });
    const options = { ...runOptions(root), harness };
    await expect(runWorkflow(definition, { ...options, input: null })).rejects.toThrow(
      'author crashed',
    );
    fail = false;
    const resumed = await runWorkflow(definition, { ...options, resume: true });
    expect(resumed.output).toMatchObject({ draft: 'revised', approved: true, revisions: 1 });
    expect(harness.ids()).toEqual([
      'cr/round/0/critique',
      'cr/round/0/revise',
      'cr/round/0/revise',
      'cr/round/1/critique',
    ]);
  });

  it('rejects invalid options before any call', async () => {
    const harness = scripted({});
    const cases: [Partial<revise.CritiqueReviseOptions>, string][] = [
      [{ brief: '  ' }, 'critiqueRevise needs a nonblank brief.'],
      [{ rounds: 0 }, 'rounds must be a positive integer; got 0.'],
      [{ lenses: [] }, 'lenses must not be empty.'],
      [{ concurrency: 0 }, 'concurrency must be a positive integer; got 0.'],
      [{ team: {} as revise.CritiqueTeam }, 'Team slot critic is not filled.'],
    ];
    for (const [index, [options, message]] of cases.entries()) {
      await expect(run(critique(options), harness, `bad-${String(index)}`)).rejects.toThrow(
        message,
      );
    }
    expect(harness.calls).toHaveLength(0);
  });

  it('refuses an unfilled critic slot before the author drafts or a lens critic is journaled', async () => {
    const harness = scripted({ 'cr/draft': 'Hello.' });
    const definition = workflow('critique-revise', (ctx) =>
      revise.critiqueRevise(ctx, {
        id: 'cr',
        team: { author: ctx.claude.bind({}) } as unknown as revise.CritiqueTeam,
        brief: 'A greeting for new users.',
        lenses: [lens('clarity', 'Is it clear?')],
      }),
    );
    await expect(run(definition, harness)).rejects.toThrow('Team slot critic is not filled.');
    expect(harness.calls).toHaveLength(0);
  });
});

/** A WorkReport reply. */
const report = (summary: string, status: 'done' | 'partial' | 'blocked' = 'done') => ({
  status,
  summary,
  files: ['state.txt'],
  blockers: [],
  notes: [],
});

/** The check script: it passes when state.txt says green, and logs every run to runs.log. */
const CHECK_SCRIPT = `import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync('runs.log', 'run\\n');
const state = readFileSync('state.txt', 'utf8').trim();
if (state === 'green') { console.log('all tests passed'); process.exit(0); }
console.error('FAIL: state is ' + state);
process.exit(1);
`;

describe('fixUntilGreen', () => {
  const command: readonly [string, ...string[]] = [process.execPath, 'check.mjs'];
  beforeEach(async () => {
    await writeFile(join(root, 'check.mjs'), CHECK_SCRIPT);
    await writeFile(join(root, 'state.txt'), 'red\n');
  });
  const runs = async (dir = root) =>
    (await readFile(join(dir, 'runs.log'), 'utf8')).split('\n').filter(Boolean).length;

  /** fixUntilGreen under `fix`, with the mechanic and surgeon told apart by their bound model. */
  const repair = (options: Partial<revise.FixUntilGreenOptions> = {}) =>
    workflow('fix-until-green', (ctx) =>
      revise.fixUntilGreen(ctx, {
        id: 'fix',
        team: {
          mechanic: ctx.claude.bind({ model: 'mechanic-model' }),
          surgeon: ctx.claude.bind({ model: 'surgeon-model' }),
        },
        check: command,
        ...options,
      }),
    );
  /** A fixer that turns the state green on the given step IDs and reports done everywhere. */
  const fixer = (greenOn: readonly string[], fail: readonly string[] = []) =>
    new ScriptedHarness(async (request) => {
      if (fail.includes(request.stepId)) throw new Error(`${request.stepId} crashed`);
      if (greenOn.includes(request.stepId))
        await writeFile(join(request.cwd, 'state.txt'), 'green');
      return report(`fixed by ${String((request.options as { model?: string }).model)}`);
    });

  it('passes at once without calling a fixer', async () => {
    await writeFile(join(root, 'state.txt'), 'green');
    const harness = fixer([]);
    const result = await run(repair(), harness);
    expect(result.output).toMatchObject({
      outcome: 'green',
      rounds: 0,
      fixedBy: null,
      fixes: [],
      failedFixes: 0,
      failures: 0,
      status: 'complete',
    });
    expect(harness.calls).toHaveLength(0);
    expect(Object.keys(result.steps)).toEqual(['fix/check/0']);
    roundTrip(revise.FixUntilGreenResult, result.output);
  });

  it('fails the run, calling no fixer, when the check cannot start; a resume runs it again', async () => {
    const harness = fixer([]);
    const missing = repair({ check: ['./no-such-check.sh'] });
    await expect(run(missing, harness)).rejects.toThrow(/Cannot start \.\/no-such-check\.sh/u);
    expect(harness.calls).toHaveLength(0);
    await writeFile(join(root, 'no-such-check.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const resumed = await runWorkflow(missing, {
      ...runOptions(root, 'std'),
      harness,
      processRunner: new NodeProcessRunner(),
      input: null,
      resume: true,
    });
    expect(resumed.output).toMatchObject({ outcome: 'green', rounds: 0, status: 'complete' });
    expect(harness.calls).toHaveLength(0);
  });

  it('fixes with the mechanic, checks after every round and replays without rerunning', async () => {
    const harness = fixer(['fix/fix/2']);
    const result = await replayAfterTail(
      repair({ task: 'Upgrade zod.' }),
      null,
      harness,
      root,
      'std',
      {
        processRunner: new NodeProcessRunner(),
      },
    );
    const output = result.output as unknown as revise.FixUntilGreenResult;
    roundTrip(revise.FixUntilGreenResult, output);
    expect(output).toMatchObject({
      outcome: 'green',
      rounds: 2,
      fixedBy: 'mechanic',
      failedFixes: 0,
      failures: 0,
      status: 'complete',
    });
    expect(output.checks.map((outcome) => outcome.passed)).toEqual([false, false, true]);
    expect(output.checks[0]).toMatchObject({ passed: false, code: 1 });
    expect(output.checks[0]?.output).toContain('FAIL: state is red');
    expect(output.checks[2]?.output).toContain('all tests passed');
    expect(output.fixes.map((fix) => [fix.round, fix.slot, fix.report?.status])).toEqual([
      [1, 'mechanic', 'done'],
      [2, 'mechanic', 'done'],
    ]);
    expect(harness.ids()).toEqual(['fix/fix/1', 'fix/fix/2']);
    expect(Object.keys(result.steps).sort()).toEqual([
      'fix/check/0',
      'fix/check/1',
      'fix/check/2',
      'fix/fix/1',
      'fix/fix/2',
      'probe/tail',
    ]);
    // Three checks ran once each; the two resumes replayed them.
    expect(await runs()).toBe(3);
    const first = harness.prompt('fix/fix/1');
    expect(first).toMatch(
      new RegExp(`^Make this check pass: ${process.execPath} check\\.mjs\\n`, 'u'),
    );
    expect(first).toContain('### Task\n\nUpgrade zod.');
    expect(first).toContain('The check failed with exit code 1:');
    expect(first).toContain('FAIL: state is red');
    expect(first).toContain('Do not weaken, skip or delete tests');
    expect(first).not.toContain('### Earlier rounds');
    const second = harness.prompt('fix/fix/2');
    expect(second).toContain(
      '### Earlier rounds\n\n- Round 1 (mechanic): reported done: fixed by mechanic-model. The check still failed.',
    );
    expect(second).toContain('see what they changed before you change more');
  });

  it('escalates the last round to the surgeon and never trusts a report', async () => {
    const harness = fixer(['fix/fix/3']);
    const result = await run(repair(), harness);
    expect(result.output).toMatchObject({ outcome: 'green', rounds: 3, fixedBy: 'surgeon' });
    expect(
      harness.calls.map((call) => [call.stepId, (call.options as { model?: string }).model]),
    ).toEqual([
      ['fix/fix/1', 'mechanic-model'],
      ['fix/fix/2', 'mechanic-model'],
      ['fix/fix/3', 'surgeon-model'],
    ]);
  });

  it('honors escalateAfter and reports red when no round fixes the check', async () => {
    const harness = fixer([], ['fix/fix/2']);
    const result = await replayAfterTail(
      repair({ rounds: 2, escalateAfter: 0 }),
      null,
      harness,
      root,
      'std',
      { processRunner: new NodeProcessRunner() },
    );
    const output = result.output as unknown as revise.FixUntilGreenResult;
    roundTrip(revise.FixUntilGreenResult, output);
    expect(output).toMatchObject({
      outcome: 'red',
      rounds: 2,
      fixedBy: null,
      failedFixes: 1,
      failures: 1,
      status: 'degraded',
    });
    expect(output.checks).toHaveLength(3);
    expect(output.fixes.map((fix) => [fix.round, fix.slot, fix.report])).toEqual([
      [1, 'surgeon', report('fixed by surgeon-model')],
      [2, 'surgeon', null],
    ]);
    expect(output.fixes[0]?.error).toBeNull();
    expect(output.fixes[1]?.error).toContain('fix/fix/2 crashed');
    expect(harness.count('fix/fix/2')).toBe(1);
    expect(await runs()).toBe(3);
  });

  it('credits no slot when the check passes after a failed fix call', async () => {
    // The mechanic's call turns the state green and then fails, as a call that times out after
    // editing would: the check passes, but no fix reported success.
    const harness = new ScriptedHarness(async (request) => {
      await writeFile(join(request.cwd, 'state.txt'), 'green');
      throw new Error(`${request.stepId} timed out`);
    });
    const result = await run(repair(), harness);
    expect(result.output).toMatchObject({
      outcome: 'green',
      rounds: 1,
      fixedBy: null,
      failedFixes: 1,
      failures: 1,
      status: 'degraded',
    });
    expect((result.output as unknown as revise.FixUntilGreenResult).fixes[0]?.error).toContain(
      'fix/fix/1 timed out',
    );
    roundTrip(revise.FixUntilGreenResult, result.output);
  });

  it('runs the check and both agents in a shared worktree', async () => {
    const repo = join(root, 'repo');
    await mkdir(repo);
    const git = (...args: string[]) =>
      execute(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'commit.gpgSign=false',
          ...args,
        ],
        { cwd: repo },
      );
    await git('init', '--quiet');
    await mkdir(join(root, 'hooks'));
    await git('config', '--local', 'core.hooksPath', join(root, 'hooks'));
    await writeFile(join(repo, 'check.mjs'), CHECK_SCRIPT);
    await writeFile(join(repo, 'state.txt'), 'red\n');
    await writeFile(join(repo, '.gitignore'), 'runs.log\n');
    await git('add', '--all');
    await git('commit', '--quiet', '-m', 'base');
    const harness = fixer(['fix/fix/1']);
    const definition = workflow('fix-in-worktree', async (ctx) => {
      const tree = await ctx.worktree('tree');
      const agent = ctx.claude.bind({});
      return revise.fixUntilGreen(ctx, {
        id: 'fix',
        team: { mechanic: agent, surgeon: agent },
        check: command,
        worktree: tree,
      });
    });
    const result = await runWorkflow(definition, {
      ...runOptions(root),
      cwd: repo,
      harness,
      processRunner: new NodeProcessRunner(),
      worktrees: { root: join(root, 'worktrees') },
      input: null,
    });
    expect(result.output).toMatchObject({ outcome: 'green', rounds: 1, fixedBy: 'mechanic' });
    const cwd = harness.calls[0]?.cwd ?? '';
    expect(cwd.startsWith(join(root, 'worktrees'))).toBe(true);
    expect(await readFile(join(repo, 'state.txt'), 'utf8')).toBe('red\n');
  }, 20_000);

  it('uses a replacement fix prompt', async () => {
    const harness = fixer(['fix/fix/1']);
    await run(
      repair({
        prompts: {
          fix: (request) =>
            `FIX ${String(request.round)} ${request.slot} ${String(request.failure.code)}`,
        },
      }),
      harness,
    );
    expect(harness.prompt('fix/fix/1')).toBe('FIX 1 mechanic 1');
  });

  it('runs the check with the exec options and the fixers with the call defaults', async () => {
    const pkg = join(root, 'pkg');
    await mkdir(pkg);
    await writeFile(join(pkg, 'check.mjs'), CHECK_SCRIPT);
    await writeFile(join(pkg, 'state.txt'), 'red');
    const harness = fixer(['fix/fix/1']);
    const result = await run(
      repair({ exec: { cwd: 'pkg' }, calls: { cwd: 'pkg', timeoutMs: 54_321 } }),
      harness,
    );
    expect(result.output).toMatchObject({ outcome: 'green', rounds: 1, fixedBy: 'mechanic' });
    expect(harness.calls[0]?.cwd).toBe(pkg);
    expect(harness.calls[0]?.options).toMatchObject({ timeoutMs: 54_321 });
    expect(await runs(pkg)).toBe(2);
    await expect(readFile(join(root, 'runs.log'), 'utf8')).rejects.toThrow();
  });

  it('fences a multi-line shell check in the fix prompt', async () => {
    const harness = fixer(['fix/fix/1']);
    const shell = `set -e\n"${process.execPath}" check.mjs`;
    const result = await run(repair({ check: { shell } }), harness);
    expect(result.output).toMatchObject({ outcome: 'green', rounds: 1 });
    expect(harness.prompt('fix/fix/1')).toMatch(
      /^Make this check pass:\n\n```sh\nset -e\n.+ check\.mjs\n```\n\n## Context/u,
    );
  });

  it('rejects invalid options before any effect', async () => {
    const harness = fixer([]);
    const cases: [Partial<revise.FixUntilGreenOptions>, string][] = [
      [{ rounds: 0 }, 'rounds must be a positive integer; got 0.'],
      [{ escalateAfter: -1 }, 'escalateAfter must be a nonnegative integer; got -1.'],
      [{ rounds: 2, escalateAfter: 3 }, 'escalateAfter must be at most rounds (2); got 3.'],
      [{ task: ' ' }, 'fixUntilGreen needs a nonblank task when one is given.'],
      [
        { calls: { worktree: true } },
        'fixUntilGreen runs the check where the fixers work: pass a shared checkout as worktree, not calls.worktree.',
      ],
      [{ team: {} as revise.RepairTeam }, 'Team slot mechanic is not filled.'],
    ];
    for (const [index, [options, message]] of cases.entries()) {
      await expect(run(repair(options), harness, `bad-${String(index)}`)).rejects.toThrow(message);
    }
    expect(harness.calls).toHaveLength(0);
    await expect(readFile(join(root, 'runs.log'), 'utf8')).rejects.toThrow();
  });
});

describe('escalate', () => {
  /** escalate under `esc`, with the mechanic and surgeon told apart by their bound model. */
  const attempt = (
    accept: revise.AcceptCheck<WorkReport>,
    options: Partial<
      Pick<revise.EscalateOptions<WorkReport>, 'task' | 'attempts' | 'start' | 'team'>
    > = {},
  ) =>
    workflow('escalate', (ctx) =>
      revise.escalate(ctx, {
        id: 'esc',
        team: {
          mechanic: ctx.claude.bind({ model: 'mechanic-model' }),
          surgeon: ctx.claude.bind({ model: 'surgeon-model' }),
        },
        task: 'Add a --verbose flag.',
        accept,
        ...options,
      }),
    );
  const byModel = (replies: Readonly<Record<string, unknown>>) =>
    new ScriptedHarness((request) => {
      const reply = replies[request.stepId];
      if (reply instanceof Error) throw reply;
      return reply ?? report(String((request.options as { model?: string }).model));
    });

  it('accepts the first attempt', async () => {
    const harness = byModel({});
    const result = await replayAfterTail(
      attempt(() => true),
      null,
      harness,
      root,
    );
    expect(result.output).toEqual({
      outcome: 'accepted',
      slot: 'mechanic',
      attempts: 1,
      value: report('mechanic-model'),
      problems: null,
      failedCalls: 0,
      failures: 0,
      status: 'complete',
    });
    roundTrip(revise.EscalateResult(), result.output);
    expect(harness.ids()).toEqual(['esc/attempt/0/work']);
    const prompt = harness.prompt('esc/attempt/0/work');
    expect(prompt).toMatch(/^Add a --verbose flag\.\n\n## Guidance\n\n/u);
    expect(prompt).toContain('Report honestly');
    expect(prompt).toContain('## Output\n\nA work report:');
  });

  it('hands a rejected attempt to the surgeon, with accept effects in the attempt scope', async () => {
    const harness = byModel({});
    const definition = workflow('escalate-check', (ctx) =>
      revise.escalate(ctx, {
        id: 'esc',
        team: {
          mechanic: ctx.claude.bind({ model: 'mechanic-model' }),
          surgeon: ctx.claude.bind({ model: 'surgeon-model' }),
        },
        task: 'Add a --verbose flag.',
        accept: async (value) => {
          const ok = await ctx.step('verify', {
            input: value.summary,
            schema: z.boolean(),
            run: () => value.summary === 'surgeon-model',
          });
          return ok || 'The flag is not wired to the logger.';
        },
      }),
    );
    const result = await replayAfterTail(definition, null, harness, root);
    expect(result.output).toEqual({
      outcome: 'accepted',
      slot: 'surgeon',
      attempts: 2,
      value: report('surgeon-model'),
      problems: null,
      failedCalls: 0,
      failures: 0,
      status: 'complete',
    });
    expect(harness.ids()).toEqual(['esc/attempt/0/work', 'esc/attempt/1/work']);
    expect(Object.keys(result.steps).sort()).toEqual([
      'esc/attempt/0/verify',
      'esc/attempt/0/work',
      'esc/attempt/1/verify',
      'esc/attempt/1/work',
      'probe/tail',
    ]);
    const retry = harness.prompt('esc/attempt/1/work');
    expect(retry).toContain('### Previous attempt\n\n```json\n{\n  "status": "done"');
    expect(retry).toContain('### Problems found\n\nThe flag is not wired to the logger.');
    expect(retry).toContain('An earlier attempt at this task was not accepted');
  });

  it('escalates a failed call without retrying it on resume', async () => {
    const harness = byModel({ 'esc/attempt/0/work': new Error('mechanic crashed') });
    const result = await replayAfterTail(
      attempt(() => true),
      null,
      harness,
      root,
    );
    expect(result.output).toMatchObject({
      outcome: 'accepted',
      slot: 'surgeon',
      attempts: 2,
      failedCalls: 1,
      failures: 1,
      status: 'degraded',
    });
    expect(harness.count('esc/attempt/0/work')).toBe(1);
    roundTrip(revise.EscalateResult(WorkReport), result.output);
    const retry = harness.prompt('esc/attempt/1/work');
    expect(retry).toContain('Its agent call failed before returning a result.');
    expect(retry).toContain("The mechanic's agent call failed:");
  });

  it('returns the last value and problems when every attempt is rejected', async () => {
    const harness = byModel({});
    const result = await run(
      attempt((_value, slot, n) => (n === 0 ? `bad ${slot}` : '   '), { attempts: 3 }),
      harness,
    );
    expect(result.output).toEqual({
      outcome: 'rejected',
      slot: 'surgeon',
      attempts: 3,
      value: report('surgeon-model'),
      problems: 'Rejected without details.',
      failedCalls: 0,
      failures: 0,
      status: 'complete',
    });
    roundTrip(revise.EscalateResult(), result.output);
    expect(harness.ids()).toEqual([
      'esc/attempt/0/work',
      'esc/attempt/1/work',
      'esc/attempt/2/work',
    ]);
  });

  it('starts with the surgeon and takes a custom schema', async () => {
    const Answer = z.object({ answer: z.string() });
    expect(checkCodexSchema(Answer)).toEqual([]);
    const harness = new ScriptedHarness((request) => ({
      answer: request.stepId === 'esc/attempt/0/work' ? '41' : '42',
    }));
    const definition = workflow('escalate-schema', async (ctx) => {
      const agent = ctx.claude.bind({});
      const result = await revise.escalate(ctx, {
        id: 'esc',
        team: { mechanic: agent, surgeon: agent },
        task: 'Answer.',
        schema: Answer,
        start: 'surgeon',
        accept: (value) => value.answer === '42' || 'wrong',
        calls: { timeoutMs: 9_999 },
      });
      roundTrip(revise.EscalateResult(Answer), result);
      return { ...result, answer: result.value?.answer ?? null };
    });
    const result = await run(definition, harness);
    expect(result.output).toMatchObject({
      outcome: 'accepted',
      slot: 'surgeon',
      attempts: 2,
      answer: '42',
    });
    for (const call of harness.calls) expect(call.options).toMatchObject({ timeoutMs: 9_999 });
    const first = harness.prompt('esc/attempt/0/work');
    expect(first).toContain('## Output\n\nThe result in the requested structure.');
    expect(first).toContain('- Answer honestly: your result is checked independently');
    expect(first).not.toContain('partial or blocked');
    const retry = harness.prompt('esc/attempt/1/work');
    expect(retry).toContain('### Previous attempt\n\n```json\n{\n  "answer": "41"\n}\n```');
    expect(retry).toContain('### Problems found\n\nwrong');
    expect(retry).toContain('- Fix the problems found and keep what the earlier attempt got right');
    expect(retry).not.toContain('partial or blocked');
  });

  it('accepts options typed as the exported EscalateOptions, with or without a schema', async () => {
    const Answer = z.object({ answer: z.string() });
    const definition = workflow('escalate-typed', async (ctx) => {
      const agent = ctx.claude.bind({});
      const team = { mechanic: agent, surgeon: agent };
      const reportOptions: revise.EscalateOptions<WorkReport> = {
        id: 'report',
        team,
        task: 'Add a --verbose flag.',
        accept: () => true,
      };
      const answerOptions: revise.EscalateOptions<z.infer<typeof Answer>> = {
        id: 'answer',
        team,
        task: 'Answer.',
        schema: Answer,
        accept: () => true,
      };
      const reported = await revise.escalate(ctx, reportOptions);
      const answered = await revise.escalate(ctx, answerOptions);
      expectTypeOf(reported).toEqualTypeOf<revise.EscalateResult<WorkReport>>();
      expectTypeOf(answered).toEqualTypeOf<
        revise.EscalateResult<z.infer<typeof Answer> | WorkReport>
      >();
      return { reported: reported.value, answered: answered.value };
    });
    const harness = new ScriptedHarness((request) =>
      request.stepId.startsWith('answer/') ? { answer: '42' } : report('done'),
    );
    expect((await run(definition, harness)).output).toEqual({
      reported: report('done'),
      answered: { answer: '42' },
    });
  });

  it('rejects invalid options and accept results', async () => {
    const harness = byModel({});
    const cases: [
      Partial<Pick<revise.EscalateOptions<WorkReport>, 'task' | 'attempts' | 'start' | 'team'>>,
      string,
    ][] = [
      [{ task: ' ' }, 'escalate needs a nonblank task.'],
      [{ attempts: 0 }, 'attempts must be a positive integer; got 0.'],
      [{ start: 'judge' as 'surgeon' }, `start must be 'mechanic' or 'surgeon'; got "judge".`],
      [{ team: {} as revise.EscalationTeam }, 'Team slot mechanic is not filled.'],
    ];
    for (const [index, [options, message]] of cases.entries()) {
      await expect(
        run(
          attempt(() => true, options),
          harness,
          `bad-${String(index)}`,
        ),
      ).rejects.toThrow(message);
    }
    expect(harness.calls).toHaveLength(0);
    await expect(
      run(
        attempt(() => false as unknown as true),
        harness,
        'bad-accept',
      ),
    ).rejects.toThrow('escalate accept must return true or a string of problems; got false.');
  });
});
