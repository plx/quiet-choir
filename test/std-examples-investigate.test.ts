// The std investigation recipes end to end: std-incident (one durable git log read over a real
// temporary repository, then falsify the incident question against it and the notes) and
// std-research (research a question from the default angles into a cited answer), against a
// scripted harness. Calls that matter are scripted by step ID; other structured calls get
// schema-valid filler from synthesizeOutput. Each checks the output, step IDs, role wiring, grants
// and replay after a tail failure without new agent calls or commands.
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NodeProcessRunner,
  runWorkflow,
  stepId,
  synthesizeOutput,
  type ExecResult,
  type HarnessInvocation,
  type HarnessRequest,
  type ProcessRunRequest,
  type ProcessRunner,
  type WorkflowDefinition,
} from '../src/index.js';
import * as std from '../src/std/index.js';
import { capabilityManifest } from '../src/workflow/runtime/profiles.js';
import incident from '../examples/patterns/std-incident.workflow.js';
import research from '../examples/patterns/std-research.workflow.js';
import {
  ScriptedHarness,
  makeRoot,
  removeRoot,
  replayAfterTail as replayWithoutCommands,
  runOptions,
  tailFailure,
} from './std-harness.js';

const execute = promisify(execFile);
let root: string;
let repo: string;
let runner: RecordingRunner;

/** A real process runner that counts the commands it runs. */
class RecordingRunner implements ProcessRunner {
  public runs = 0;
  private readonly inner = new NodeProcessRunner();

  public run(request: ProcessRunRequest, invocation: HarnessInvocation): Promise<ExecResult> {
    this.runs += 1;
    return this.inner.run(request, invocation);
  }
}

beforeEach(async () => {
  root = await makeRoot('choir-std-examples-investigate-');
  repo = join(root, 'repo');
  await mkdir(repo);
  runner = new RecordingRunner();
});
afterEach(async () => {
  await removeRoot(root);
});

/**
 * A harness that answers `replies` by step ID (a returned Error is thrown), reports no leads for an
 * unscripted scout, and fills every other structured call.
 */
function scripted(
  replies: Readonly<Record<string, (request: HarnessRequest) => unknown>>,
): ScriptedHarness {
  return new ScriptedHarness((request) => {
    const reply = replies[request.stepId];
    if (reply !== undefined) {
      const value = reply(request);
      if (value instanceof Error) throw value;
      return value;
    }
    if (request.stepId.endsWith('/leads')) return { leads: [] };
    if (request.outputSchema === null) throw new Error(`Unscripted text call ${request.stepId}`);
    return synthesizeOutput(request.outputSchema, request.stepId);
  });
}

/** The step IDs called, sorted: the calls of one settled map start in no fixed order. */
function calledIds(harness: ScriptedHarness): string[] {
  return [...harness.ids()].sort();
}

/** `runWorkflow` options in the temporary repository, with a real (counting) process runner. */
function options(harness: ScriptedHarness, runId = 'std') {
  return { ...runOptions(root, runId), cwd: repo, harness, processRunner: runner };
}

/**
 * Run `workflow` to an injected tail failure, then resume it twice: the resumes make no new agent
 * call and run no command, and record the same steps. Returns the first resume.
 */
async function replayAfterTail<I, O>(
  workflow: WorkflowDefinition<I, O>,
  input: I,
  harness: ScriptedHarness,
) {
  const wrapped = tailFailure(workflow);
  await expect(runWorkflow(wrapped, { ...options(harness), input })).rejects.toThrow(
    'Injected tail failure',
  );
  const calls = harness.calls.length;
  const commands = runner.runs;
  const resumed = await runWorkflow(wrapped, { ...options(harness), resume: true });
  expect(harness.calls).toHaveLength(calls);
  expect(runner.runs).toBe(commands);
  const again = await runWorkflow(wrapped, { ...options(harness), resume: true });
  expect(again.steps).toEqual(resumed.steps);
  return resumed;
}

it('needs no grant: both recipes call only read-only roles', () => {
  const required = (workflow: object) =>
    capabilityManifest(workflow, { requireGrants: true }).requiredGrants;
  expect(required(incident)).toEqual([]);
  expect(required(research)).toEqual([]);
});

describe('std-incident', () => {
  async function git(...args: string[]): Promise<string> {
    const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];
    const { stdout } = await execute('git', [...identity, '-c', 'commit.gpgSign=false', ...args], {
      cwd: repo,
    });
    return stdout;
  }
  /** Make one empty commit with `subject` and return its SHA. */
  async function commit(subject: string): Promise<string> {
    await git('commit', '--quiet', '--allow-empty', '-m', subject);
    return (await git('rev-parse', 'HEAD')).trim();
  }

  let base: string;
  beforeEach(async () => {
    await git('init', '--quiet');
    const hooks = join(root, 'empty-hooks');
    await mkdir(hooks);
    await git('config', '--local', 'core.hooksPath', hooks);
    base = await commit('Initial commit');
    await commit('Lower the connection pool size to 4');
    await commit('Retry checkout requests on timeout');
  });

  const question = 'Why did checkout requests time out after the deploy?';
  const notes = 'Timeouts began at 14:05, two minutes after the deploy; CPU stayed flat.';
  const hypothesis = (id: string, cause: string): std.types.Hypothesis => ({
    id,
    cause,
    mechanism: `${cause} makes requests wait.`,
    predictions: [`The log shows: ${cause}.`],
  });
  const pool = hypothesis('H1', 'The smaller connection pool');
  const retries = hypothesis('H2', 'A retry storm');
  const upstream = hypothesis('H3', 'A slow upstream');
  const verdict = (outcome: std.types.FalsificationVerdict) => () => ({
    verdict: outcome,
    reasoning: `The evidence says ${outcome}.`,
    checked: ['The commit log.'],
  });

  it('falsifies the rivals against the range log and notes, leaving one cause', async () => {
    const harness = scripted({
      'incident/theorize': () => ({ hypotheses: [pool, retries, upstream] }),
      'incident/hypothesis/H1/falsify': verdict('survives'),
      'incident/hypothesis/H2/falsify': verdict('falsified'),
      'incident/hypothesis/H3/falsify': verdict('falsified'),
    });
    const range = `${base}..HEAD`;
    const result = await replayAfterTail(incident, { question, range, notes }, harness);
    expect(result.output).toEqual({ confidence: 'high', status: 'complete', survivors: [pool] });
    expect(calledIds(harness)).toEqual(
      [
        'incident/theorize',
        'incident/hypothesis/H1/falsify',
        'incident/hypothesis/H2/falsify',
        'incident/hypothesis/H3/falsify',
      ].sort(),
    );
    expect(harness.ids()[0]).toBe('incident/theorize');
    expect(Object.keys(result.steps)).toContain('log');

    // The evidence is the range's log, newest first, then the notes.
    const theorize = harness.prompt('incident/theorize');
    expect(theorize).toContain(`question: ${question}`);
    expect(theorize).toContain(`## Commits in ${range}`);
    const newest = theorize.indexOf('Retry checkout requests on timeout');
    const older = theorize.indexOf('Lower the connection pool size to 4');
    expect(newest).toBeGreaterThan(0);
    expect(older).toBeGreaterThan(newest);
    expect(theorize).not.toContain('Initial commit');
    expect(theorize).toContain(`## Notes\n\n${notes}`);
    expect(harness.prompt('incident/hypothesis/H2/falsify')).toContain(`## Notes\n\n${notes}`);

    // The theorist is the Reviewer and each falsifier the Skeptic, both read-only.
    const [theorist, falsifier] = harness.calls;
    expect(theorist?.options).toMatchObject({
      tools: ['Read', 'Grep', 'Glob'],
      model: std.roles.Reviewer.model,
    });
    expect(falsifier?.options).toMatchObject({
      tools: ['Read', 'Grep', 'Glob'],
      model: std.roles.Skeptic.model,
      appendSystemPrompt: std.personas.Skeptic.appendSystemPrompt,
    });
  });

  it('reports a failed falsifier as degraded without claiming high confidence', async () => {
    const harness = scripted({
      'incident/theorize': () => ({ hypotheses: [pool, retries] }),
      'incident/hypothesis/H1/falsify': verdict('survives'),
      'incident/hypothesis/H2/falsify': () => new Error('falsifier crashed'),
    });
    const input = { question, range: `${base}..HEAD`, notes: '' };
    const result = await replayAfterTail(incident, input, harness);
    expect(result.output).toEqual({ confidence: 'medium', status: 'degraded', survivors: [pool] });
    expect(harness.count('incident/hypothesis/H2/falsify')).toBe(1);
  });
});

describe('std-research', () => {
  const question = 'Does undici 7 still pool connections per origin?';
  const docs = 'https://undici.nodejs.org/#/docs/api/Pool';
  const code = 'https://github.com/nodejs/undici/blob/main/lib/dispatcher/pool.js';
  const lead = (ref: string): std.types.Lead => ({ ref, why: `Shows ${ref}` });
  const claims = (claim: string, source: string) => () => ({
    claims: [{ claim, source, quote: null }],
  });

  it('scouts every default angle, reads the leads and returns the cited answer', async () => {
    const harness = scripted({
      'research/scout/official-docs/leads': () => ({ leads: [lead(docs)] }),
      'research/scout/source-code/leads': () => ({ leads: [lead(code)] }),
      [`research/read/${stepId(docs)}/claims`]: claims('A Pool serves one origin.', docs),
      [`research/read/${stepId(code)}/claims`]: claims('Pool keys by origin.', `${code}#L12`),
      'research/synthesize': () => 'Yes: one pool per origin [1, 2].',
    });
    const result = await replayWithoutCommands(research, { question, reads: 6 }, harness, root);
    expect(result.output).toEqual({
      status: 'complete',
      answer: 'Yes: one pool per origin [1, 2].',
      sources: [lead(docs), lead(code)],
    });
    expect(calledIds(harness)).toEqual(
      [
        ...std.lenses.research.map((angle) => `research/scout/${angle.key}/leads`),
        `research/read/${stepId(docs)}/claims`,
        `research/read/${stepId(code)}/claims`,
        'research/synthesize',
      ].sort(),
    );
    expect(harness.ids().at(-1)).toBe('research/synthesize');
    expect(harness.prompt('research/synthesize')).toContain(
      `1. A Pool serves one origin.\n   Source: ${docs}\n2. Pool keys by origin.\n   Source: ${code}#L12`,
    );

    // Researchers scout and read with web tools; the tool-free Writer writes the answer.
    const scout = harness.calls[0];
    expect(scout?.options).toMatchObject({ tools: std.roles.Researcher.tools });
    expect(std.roles.Researcher.tools).toContain('WebSearch');
    const writer = harness.calls.find((call) => call.stepId === 'research/synthesize');
    expect(writer?.options).toMatchObject({ tools: [] });
  });

  it('reads at most `reads` leads and degrades when a reader fails', async () => {
    const issue = 'https://github.com/nodejs/undici/issues/1';
    const harness = scripted({
      'research/scout/official-docs/leads': () => ({ leads: [lead(docs)] }),
      'research/scout/source-code/leads': () => ({ leads: [lead(code)] }),
      'research/scout/issues-and-discussions/leads': () => ({ leads: [lead(issue)] }),
      [`research/read/${stepId(docs)}/claims`]: () => new Error('reader crashed'),
      [`research/read/${stepId(code)}/claims`]: claims('Pool keys by origin.', code),
      'research/synthesize': () => 'Probably [1].',
    });
    const result = await replayWithoutCommands(research, { question, reads: 2 }, harness, root);
    expect(result.output).toEqual({
      status: 'degraded',
      answer: 'Probably [1].',
      sources: [lead(code)],
    });
    expect(harness.ids()).not.toContain(`research/read/${stepId(issue)}/claims`);
    expect(harness.count(`research/read/${stepId(docs)}/claims`)).toBe(1);
    expect(harness.prompt('research/synthesize')).toContain(`### Not read\n\n- ${docs}`);
  });

  it('reads six leads by default', () => {
    expect(research.input.parse({ question })).toEqual({ question, reads: 6 });
  });
});
