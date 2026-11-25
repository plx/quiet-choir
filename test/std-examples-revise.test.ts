// The std revise recipes end to end: std-doc-polish (critiqueRevise over a Markdown file, written
// back under an ifMatch guard), std-fix-tests (fixUntilGreen over a real check command) and
// std-escalate (escalate whose accept runs a real check command inside each attempt), run against a
// scripted harness, checking their outputs, step IDs, team wiring, grants and replay after a tail
// failure without new agent calls, commands or writes.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NodeProcessRunner,
  runWorkflow,
  synthesizeOutput,
  type HarnessRequest,
} from '../src/index.js';
import * as std from '../src/std/index.js';
import { capabilityManifest } from '../src/workflow/runtime/profiles.js';
import docPolish from '../examples/patterns/std-doc-polish.workflow.js';
import escalateRecipe from '../examples/patterns/std-escalate.workflow.js';
import fixTests from '../examples/patterns/std-fix-tests.workflow.js';
import {
  ScriptedHarness,
  makeRoot,
  removeRoot,
  replayAfterTail,
  roundTrip,
  runOptions,
} from './std-harness.js';

let root: string;
beforeEach(async () => {
  root = await makeRoot('choir-std-examples-revise-');
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

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

it('asks for grants only on the write roles each recipe calls', () => {
  const required = (workflow: object) =>
    capabilityManifest(workflow, { requireGrants: true }).requiredGrants;
  expect(required(docPolish)).toEqual([]);
  expect(required(fixTests)).toEqual(['Mechanic', 'Surgeon']);
  expect(required(escalateRecipe)).toEqual(['Mechanic', 'Surgeon']);
});

describe('std-doc-polish', () => {
  const original = '# Guide\n\nThis are the guide.\n';
  const polished = '# Guide\n\nThis is the guide.\n';
  beforeEach(async () => {
    await writeFile(join(root, 'guide.md'), original);
  });
  const lensIds = (round: number) =>
    std.lenses.writing.map((lens) => `polish/round/${String(round)}/lens/${lens.key}/critique`);

  /** Every critic of rounds 0 and 1 approves unless a test scripts it otherwise. */
  const approveAll = Object.fromEntries(
    [...lensIds(0), ...lensIds(1)].map((id) => [id, () => ({ issues: [] })]),
  );

  it('critiques through the writing lenses, revises and writes the approved draft once', async () => {
    const harness = scripted({
      ...approveAll,
      'polish/round/0/lens/clarity/critique': () => ({
        issues: [{ where: 'line 3', problem: 'Subject-verb agreement.', fix: 'Use "is".' }],
      }),
      'polish/round/0/revise': () => polished,
    });
    const result = await replayAfterTail(
      docPolish,
      { file: 'guide.md', rounds: 2 },
      harness,
      root,
      'std',
      { processRunner: new NodeProcessRunner() },
    );
    expect(result.output).toEqual({
      polish: {
        draft: polished,
        approved: true,
        rounds: 2,
        revisions: 1,
        issues: [],
        failedCritics: 0,
        failures: 0,
        status: 'complete',
      },
      receipt: {
        path: join(root, 'guide.md'),
        sha256: sha256(polished),
        bytes: Buffer.byteLength(polished),
        previousSha256: sha256(original),
      },
    });
    expect(await readFile(join(root, 'guide.md'), 'utf8')).toBe(polished);
    expect([...harness.ids()].sort()).toEqual(
      [...lensIds(0), 'polish/round/0/revise', ...lensIds(1)].sort(),
    );
    expect(Object.keys(result.steps)).toEqual(expect.arrayContaining(['read', 'write']));
    // The critic slot is the read-only Critic and the author the tool-free Writer.
    const critic = harness.calls.find((call) => call.stepId === lensIds(0)[0]);
    expect(critic?.options).toMatchObject({ tools: ['Read', 'Grep', 'Glob'], model: 'opus' });
    expect(harness.prompt('polish/round/0/lens/clarity/critique')).toContain(original);
    const author = harness.calls.find((call) => call.stepId === 'polish/round/0/revise');
    expect(author?.options).toMatchObject({ tools: [] });
    expect(harness.prompt('polish/round/0/revise')).toContain('Subject-verb agreement.');
  });

  it('leaves the file alone when the critics do not approve', async () => {
    const issue = { where: 'title', problem: 'Too vague.', fix: 'Name the product.' };
    const harness = scripted({
      ...approveAll,
      'polish/round/0/lens/structure/critique': () => ({ issues: [issue] }),
      'polish/round/1/lens/structure/critique': () => ({ issues: [issue] }),
      'polish/round/0/revise': () => polished,
    });
    const result = await runWorkflow(docPolish, {
      ...runOptions(root),
      harness,
      input: { file: 'guide.md', rounds: 2 },
    });
    expect(result.output).toEqual({
      polish: {
        draft: polished,
        approved: false,
        rounds: 2,
        revisions: 1,
        issues: [issue],
        failedCritics: 0,
        failures: 0,
        status: 'complete',
      },
      receipt: null,
    });
    roundTrip(std.patterns.CritiqueReviseResult, result.output?.polish);
    expect(await readFile(join(root, 'guide.md'), 'utf8')).toBe(original);
    expect(Object.keys(result.steps)).not.toContain('write');
  });

  it('writes nothing when the critics approve the document as it is', async () => {
    const harness = scripted(approveAll);
    const result = await runWorkflow(docPolish, {
      ...runOptions(root),
      harness,
      input: { file: 'guide.md', rounds: 2 },
    });
    expect(result.output).toMatchObject({
      polish: { draft: original, approved: true, rounds: 1, revisions: 0 },
      receipt: null,
    });
    expect(harness.ids().sort()).toEqual(lensIds(0).sort());
    expect(Object.keys(result.steps)).not.toContain('write');
  });

  it('does not write when a last-round critic fails, and does not retry it on resume', async () => {
    const issue = { where: 'title', problem: 'Too vague.', fix: 'Name the product.' };
    const harness = scripted({
      ...approveAll,
      'polish/round/0/lens/structure/critique': () => ({ issues: [issue] }),
      'polish/round/0/revise': () => polished,
      'polish/round/1/lens/clarity/critique': () => {
        throw new Error('critic crashed');
      },
    });
    const result = await replayAfterTail(docPolish, { file: 'guide.md', rounds: 2 }, harness, root);
    // Approval needs every critic of the last round to answer, so the revision is not written.
    expect(result.output).toMatchObject({
      polish: {
        draft: polished,
        approved: false,
        rounds: 2,
        failedCritics: 1,
        failures: 1,
        status: 'degraded',
      },
      receipt: null,
    });
    expect(harness.count('polish/round/1/lens/clarity/critique')).toBe(1);
    expect(await readFile(join(root, 'guide.md'), 'utf8')).toBe(original);
    expect(Object.keys(result.steps)).not.toContain('write');
  });
});

describe('std-fix-tests', () => {
  /** The check script: it passes when state.txt says green, and logs every run to runs.log. */
  const script = `import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync('runs.log', 'run\\n');
const state = readFileSync('state.txt', 'utf8').trim();
if (state === 'green') { console.log('ok'); process.exit(0); }
console.error('FAIL: ' + state);
process.exit(1);
`;
  beforeEach(async () => {
    await writeFile(join(root, 'check.mjs'), script);
    await writeFile(join(root, 'state.txt'), 'red');
  });

  it('defaults to npm test and three rounds', () => {
    expect(fixTests.input.parse({})).toEqual({ check: ['npm', 'test'], rounds: 3 });
  });

  it('fixes with the mechanic, escalates to the surgeon and trusts only the check', async () => {
    const harness = scripted({
      'fix/fix/3': async (request) => {
        await writeFile(join(request.cwd, 'state.txt'), 'green');
        return synthesizeOutput(request.outputSchema ?? {}, request.stepId);
      },
    });
    const input = { check: [process.execPath, 'check.mjs'] as [string, ...string[]], rounds: 3 };
    const result = await replayAfterTail(fixTests, input, harness, root, 'std', {
      processRunner: new NodeProcessRunner(),
    });
    expect(result.output).toMatchObject({
      outcome: 'green',
      status: 'complete',
      rounds: 3,
      fixedBy: 'surgeon',
      failedFixes: 0,
      failures: 0,
    });
    expect(result.output?.fixes.map((fix) => fix.slot)).toEqual([
      'mechanic',
      'mechanic',
      'surgeon',
    ]);
    roundTrip(std.patterns.FixUntilGreenResult, result.output);
    expect(result.output?.checks.map((check) => check.passed)).toEqual([false, false, false, true]);
    expect(result.output?.checks[0]?.output).toContain('FAIL: red');
    expect(
      harness.calls.map((call) => [call.stepId, (call.options as { model?: string }).model]),
    ).toEqual([
      ['fix/fix/1', std.roles.Mechanic.model],
      ['fix/fix/2', std.roles.Mechanic.model],
      ['fix/fix/3', std.roles.Surgeon.model],
    ]);
    expect(Object.keys(result.steps).sort()).toEqual([
      'fix/check/0',
      'fix/check/1',
      'fix/check/2',
      'fix/check/3',
      'fix/fix/1',
      'fix/fix/2',
      'fix/fix/3',
      'probe/tail',
    ]);
    // Every check ran once; the resumes replayed them.
    const runs = (await readFile(join(root, 'runs.log'), 'utf8')).split('\n').filter(Boolean);
    expect(runs).toHaveLength(4);
  });
});

describe('std-escalate', () => {
  /** The check script: it passes when state.txt says green, and logs every run to runs.log. */
  const script = `import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync('runs.log', 'run\\n');
const state = readFileSync('state.txt', 'utf8').trim();
if (state === 'green') { console.log('ok'); process.exit(0); }
console.error('FAIL: ' + state);
process.exit(1);
`;
  beforeEach(async () => {
    await writeFile(join(root, 'check.mjs'), script);
    await writeFile(join(root, 'state.txt'), 'red');
  });

  const check: [string, ...string[]] = [process.execPath, 'check.mjs'];
  const task = 'Make the check pass without weakening it.';
  const report = (status: std.types.WorkStatus, summary: string): std.types.WorkReport => ({
    status,
    summary,
    files: ['state.txt'],
    blockers: [],
    notes: [],
  });
  /** A reply that turns the check green, then reports the work done. */
  const fixes = (summary: string) => async (request: HarnessRequest) => {
    await writeFile(join(request.cwd, 'state.txt'), 'green');
    return report('done', summary);
  };
  /** How many times the check command ran. */
  const runs = async () =>
    (await readFile(join(root, 'runs.log'), 'utf8')).split('\n').filter(Boolean).length;
  const replay = (harness: ScriptedHarness) =>
    replayAfterTail(escalateRecipe, { task, check, attempts: 2 }, harness, root, 'std', {
      processRunner: new NodeProcessRunner(),
    });

  it('defaults to npm test and two attempts', () => {
    expect(escalateRecipe.input.parse({ task })).toEqual({
      task,
      check: ['npm', 'test'],
      attempts: 2,
    });
  });

  it('hands a done report that fails the check to the surgeon, who makes it pass', async () => {
    const harness = scripted({
      'change/attempt/0/work': () => report('done', 'Changed nothing that matters.'),
      'change/attempt/1/work': fixes('Set the state to green.'),
    });
    const result = await replay(harness);
    expect(result.output).toEqual({
      outcome: 'accepted',
      slot: 'surgeon',
      attempts: 2,
      value: report('done', 'Set the state to green.'),
      problems: null,
      failedCalls: 0,
      failures: 0,
      status: 'complete',
    });
    roundTrip(std.patterns.EscalateResult(), result.output);
    // Each attempt's check is its own step inside the attempt, run once; the resumes replay them.
    expect(Object.keys(result.steps).sort()).toEqual([
      'change/attempt/0/check',
      'change/attempt/0/work',
      'change/attempt/1/check',
      'change/attempt/1/work',
      'probe/tail',
    ]);
    expect(await runs()).toBe(2);
    expect(
      harness.calls.map((call) => [call.stepId, (call.options as { model?: string }).model]),
    ).toEqual([
      ['change/attempt/0/work', std.roles.Mechanic.model],
      ['change/attempt/1/work', std.roles.Surgeon.model],
    ]);
    expect(harness.calls[0]?.options).toMatchObject({ tools: std.roles.Mechanic.tools });
    expect(harness.prompt('change/attempt/0/work').startsWith(task)).toBe(true);
    // The surgeon sees the mechanic's report and why the check rejected it.
    const surgeon = harness.prompt('change/attempt/1/work');
    expect(surgeon).toContain('"summary": "Changed nothing that matters."');
    expect(surgeon).toContain(`### Problems found\n\n${check.join(' ')} failed:\n\n`);
    expect(surgeon).toContain('FAIL: red');
  });

  it('rejects a report that is not done without running the check', async () => {
    const harness = scripted({
      'change/attempt/0/work': () => report('blocked', 'The state file is read-only.'),
      'change/attempt/1/work': () => report('done', 'Tried again.'),
    });
    const result = await replay(harness);
    expect(result.output).toMatchObject({
      outcome: 'rejected',
      slot: 'surgeon',
      attempts: 2,
      value: report('done', 'Tried again.'),
      failures: 0,
      status: 'complete',
    });
    expect(result.output?.problems).toContain('FAIL: red');
    expect(Object.keys(result.steps)).not.toContain('change/attempt/0/check');
    expect(await runs()).toBe(1);
    expect(harness.prompt('change/attempt/1/work')).toContain(
      '### Problems found\n\nThe work is blocked: The state file is read-only.',
    );
  });

  it('escalates a failed mechanic call without retrying it, reporting degraded health', async () => {
    const harness = scripted({
      'change/attempt/0/work': () => {
        throw new Error('mechanic crashed');
      },
      'change/attempt/1/work': fixes('Set the state to green.'),
    });
    const result = await replay(harness);
    expect(result.output).toMatchObject({
      outcome: 'accepted',
      slot: 'surgeon',
      attempts: 2,
      failedCalls: 1,
      failures: 1,
      status: 'degraded',
    });
    expect(harness.count('change/attempt/0/work')).toBe(1);
    expect(Object.keys(result.steps)).not.toContain('change/attempt/0/check');
    expect(await runs()).toBe(1);
  });
});
