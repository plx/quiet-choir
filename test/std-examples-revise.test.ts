// The std revise recipes end to end: std-doc-polish (critiqueRevise over a Markdown file, written
// back under an ifMatch guard) and std-fix-tests (fixUntilGreen over a real check command), run
// against a scripted harness, checking their outputs, step IDs, team wiring, grants and replay
// after a tail failure without new agent calls, commands or writes.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NodeProcessRunner,
  runWorkflow,
  synthesizeOutput,
  type HarnessRequest,
  type WorkflowDefinition,
} from '../src/index.js';
import * as std from '../src/std/index.js';
import { capabilityManifest } from '../src/workflow/runtime/profiles.js';
import docPolish from '../examples/patterns/std-doc-polish.workflow.js';
import fixTests from '../examples/patterns/std-fix-tests.workflow.js';
import { ScriptedHarness, makeRoot, removeRoot, runOptions, tailFailure } from './std-harness.js';

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

/**
 * Run `workflow` with a real process runner to an injected tail failure, then resume it twice:
 * the resumes make no new agent call and record the same steps. Returns the first resume.
 */
async function replayAfterTail<I, O>(
  workflow: WorkflowDefinition<I, O>,
  input: I,
  harness: ScriptedHarness,
) {
  const wrapped = tailFailure(workflow);
  const options = { ...runOptions(root), harness, processRunner: new NodeProcessRunner() };
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

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

it('asks for grants only on the write roles each recipe calls', () => {
  const required = (workflow: object) =>
    capabilityManifest(workflow, { requireGrants: true }).requiredGrants;
  expect(required(docPolish)).toEqual([]);
  expect(required(fixTests)).toEqual(['Mechanic', 'Surgeon']);
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
    const result = await replayAfterTail(docPolish, { file: 'guide.md', rounds: 2 }, harness);
    expect(result.output).toEqual({
      status: 'approved',
      issues: [],
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
    expect(result.output).toEqual({ status: 'open-issues', issues: [issue], receipt: null });
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
    const result = await replayAfterTail(fixTests, input, harness);
    expect(result.output).toMatchObject({
      status: 'green',
      rounds: 3,
      fixedBy: 'surgeon',
      failedFixes: 0,
    });
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
