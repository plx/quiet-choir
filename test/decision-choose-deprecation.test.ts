// The deprecated decision(ctx, transport).choose helper (#655, ADR 0066 section 6): it warns once
// per process, across module instances, and a decision/1 record written by the helper before the
// deprecation replays without calling its transport.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect } from 'vitest';
import { defineWorkflow, readRun, StepIdentityChangedError, z } from '../src/index.js';
import {
  choice,
  decision,
  defineDecisionProvider,
  type ProviderTransportRequest,
} from '../src/integrations/decision.js';
import { digest } from '../src/workflow/runtime/json.js';
import { it } from './setup/state-dir.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);

// measured: 0.5 s alone, 1.6 s in the full coverage run (subprocess start and tsx compile)
describe('the decision().choose deprecation warning', { timeout: 20_000 }, () => {
  it('is emitted once per process, across two module instances', async ({ runs }) => {
    const module = pathToFileURL(join(projectRoot, 'src/integrations/decision.ts')).href;
    // Distinct query strings load two module instances, as a CLI workflow can load the subpath
    // beside the runtime's own copy.
    const script = `
const a = await import(${JSON.stringify(`${module}?a`)});
const b = await import(${JSON.stringify(`${module}?b`)});
if (a.decision === b.decision) throw new Error('expected two module instances');
const ctx = { step: () => Promise.resolve(null) };
const transport = () => Promise.resolve({ output: null });
a.decision(ctx, transport);
b.decision(ctx, transport);
a.decision(ctx, transport).choose;
`;
    const child = run(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      { cwd: projectRoot, signal: runs.signal, killSignal: 'SIGKILL' },
    );
    runs.child(child.child);
    const { stderr } = await child;
    expect(stderr.match(/QUIET_CHOIR_DECISION_CHOOSE/gu)).toHaveLength(1);
    expect(stderr).toContain(
      '[QUIET_CHOIR_DECISION_CHOOSE] DeprecationWarning: quiet-choir/decision: decision(ctx, transport).choose is deprecated; use ctx.decide with a decision provider (see docs/decision-providers.md). Completed decision/1 steps still replay.',
    );
  });
});

describe('a decision/1 record written before the deprecation', () => {
  // The fixture was generated with the unmodified helper at 318b5e2; see fixtures/decision/README.md.
  const runId = 'choose-v1';
  const question = { state: { ticket: 1 }, question: 'Route?', answers: ['fix', 'skip'] } as const;

  async function install(stateDir: string): Promise<void> {
    const fixture = await readFile(
      new URL('./fixtures/decision/choose-v1-checkpoint.json', import.meta.url),
      'utf8',
    );
    await mkdir(join(stateDir, runId));
    await writeFile(join(stateDir, runId, 'run.json'), fixture);
    await writeFile(join(stateDir, runId, 'journal.jsonl'), '');
  }

  it('resumes to completed without calling its transport', async ({ stateDir, runs }) => {
    await install(stateDir);
    const original = await readRun({ stateDir, runId });

    let calls = 0;
    const definition = defineWorkflow({
      name: 'decision-choose',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: (ctx) =>
        decision(ctx, () => {
          calls += 1;
          throw new Error('replay must not call the transport');
        }).choose('pick', question),
    });
    const result = await runs.run(definition, {
      stateDir,
      runId,
      resume: true,
      cwd: '/',
      fingerprint: 'decision-choose',
    });
    expect(result.status).toBe('completed');
    expect(calls).toBe(0);
    expect(result.output).toEqual({ answer: 'fix', probabilities: { fix: 0.75, skip: 0.25 } });
    const saved = await readRun({ stateDir, runId });
    expect(saved.steps['pick']?.identity?.['version']).toBe(digest('decision/1'));
    expect(saved.steps).toEqual(original.steps);
  });

  it('is refused, with zero transport calls, when resumed by ctx.decide under the same ID', async ({
    stateDir,
    runs,
  }) => {
    await install(stateDir);
    const requests: ProviderTransportRequest[] = [];
    const provider = defineDecisionProvider({
      name: 'router',
      revision: 1,
      capabilities: { kinds: ['choice'], maxOptions: 255, levels: [2, 10], idempotencyKey: false },
      transport: () => (request: ProviderTransportRequest) => {
        requests.push(request);
        return Promise.reject(new Error('a refused resume must not call the transport'));
      },
    });
    const definition = defineWorkflow({
      name: 'decision-choose',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      decisions: [provider],
      run: (ctx) =>
        ctx.decide('pick', {
          state: question.state,
          questions: {
            route: choice({ instructions: 'Route?', options: { fix: null, skip: null } }),
          },
        }),
    });
    const refused: unknown = await runs
      .run(definition, {
        stateDir,
        runId,
        resume: true,
        cwd: '/',
        fingerprint: 'decision-choose',
        acceptCodeChange: true,
      })
      .catch((caught: unknown) => caught);
    // The accepted resume's preflight refuses before the run changes.
    expect(refused).toBeInstanceOf(StepIdentityChangedError);
    expect((refused as StepIdentityChangedError).stepId).toBe('pick');
    expect((refused as Error).message).toMatch(/changed on a completed step/u);
    expect(requests).toHaveLength(0);
  });
});
