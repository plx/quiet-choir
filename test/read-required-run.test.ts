import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultStateDir, prepareStateDirectory } from '../src/workflow/runtime/paths.js';
import {
  findRunCandidates,
  maxRunCandidates,
  missingRunError,
  readRequiredRun,
} from '../src/workflow/runtime/read-required-run.js';
import { RunRefusedError } from '../src/workflow/runtime/run-errors.js';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'choir-candidates-')));
  vi.stubEnv('XDG_STATE_HOME', join(root, 'xdg'));
  vi.stubEnv('QUIET_CHOIR_STATE_DIR', undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/** Register a project's default root and save a checkpoint marker for `runId` in it. */
async function registeredRun(project: string, runId: string): Promise<string> {
  const stateDir = defaultStateDir(project);
  await mkdir(project, { recursive: true });
  await prepareStateDirectory(stateDir, project);
  await mkdir(join(stateDir, runId), { recursive: true });
  await writeFile(join(stateDir, runId, 'run.json'), '{}');
  return stateDir;
}

async function refusal(promise: Promise<unknown>): Promise<RunRefusedError> {
  const error: unknown = await promise.catch((cause: unknown) => cause);
  if (!(error instanceof RunRefusedError))
    throw new Error(`Expected a refusal, got ${String(error)}`);
  return error;
}

describe('run.not_found candidates', () => {
  it('names the registered project root that holds the run when read from a subdirectory', async () => {
    const project = join(root, 'proj');
    const projectRoot = await registeredRun(project, 't2');
    const sub = join(project, 'sub');
    await mkdir(sub);
    const error = await refusal(readRequiredRun({ runId: 't2', cwd: sub }));
    expect(error.code).toBe('run.not_found');
    expect(error.details).toMatchObject({
      stateDir: defaultStateDir(sub),
      count: 0,
      available: [],
      candidates: [{ stateDir: projectRoot, cwd: project }],
    });
    expect(error.message).toContain(
      `Found in ${projectRoot} (project ${project}); rerun with --state-dir ${projectRoot}.`,
    );
  });

  it('finds a legacy .quiet-choir/runs checkpoint in an ancestor', async () => {
    const project = join(root, 'legacy');
    const legacy = join(project, '.quiet-choir', 'runs');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'old.json'), '{}');
    const nested = join(project, 'a', 'b');
    await mkdir(nested, { recursive: true });
    const error = await refusal(readRequiredRun({ runId: 'old', cwd: nested }));
    expect(error.details).toMatchObject({ candidates: [{ stateDir: legacy, cwd: project }] });
  });

  it("finds a registered project's legacy root from an unrelated directory", async () => {
    const project = join(root, 'registered');
    await registeredRun(project, 'other-run');
    const legacy = join(project, '.quiet-choir', 'runs');
    await mkdir(join(legacy, 'moved'), { recursive: true });
    await writeFile(join(legacy, 'moved', 'run.json'), '{}');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    const error = await refusal(readRequiredRun({ runId: 'moved', cwd: elsewhere }));
    expect(error.details).toMatchObject({ candidates: [{ stateDir: legacy, cwd: project }] });
  });

  it('keeps the message and reports no candidates when nothing holds the run', async () => {
    await registeredRun(join(root, 'proj'), 'present');
    const error = await refusal(readRequiredRun({ runId: 'absent', cwd: root }));
    expect(error.details).toMatchObject({ candidates: [] });
    expect(error.message).toMatch(/--state-dir resolves against the current directory\.$/u);
  });

  it('searches an explicit state directory first and never lists it as a candidate', async () => {
    const projectRoot = await registeredRun(join(root, 'proj'), 'r1');
    const explicit = join(root, 'explicit');
    const error = await refusal(readRequiredRun({ runId: 'r1', stateDir: explicit, cwd: root }));
    expect(error.details).toMatchObject({
      stateDir: explicit,
      candidates: [{ stateDir: projectRoot, cwd: join(root, 'proj') }],
    });
    const searched = await missingRunError({ runId: 'r1', stateDir: projectRoot, cwd: root });
    expect(searched.details).toMatchObject({ stateDir: projectRoot, candidates: [] });
  });

  it('caps and sorts the candidates', async () => {
    const roots: string[] = [];
    for (let index = 0; index < maxRunCandidates + 2; index++)
      roots.push(await registeredRun(join(root, `p${String(index).padStart(2, '0')}`), 'shared'));
    const found = await findRunCandidates('shared', join(root, 'none'), root);
    expect(found.map((candidate) => candidate.stateDir)).toEqual(roots.sort().slice(0, 10));
    const error = await refusal(readRequiredRun({ runId: 'shared', cwd: root }));
    expect(error.message).toContain(`${String(maxRunCandidates - 1)} more in details.candidates.`);
  });

  it('ignores an unreadable registry, so the code stays run.not_found', async () => {
    await writeFile(join(root, 'xdg'), 'not a directory');
    const error = await refusal(readRequiredRun({ runId: 'r1', stateDir: join(root, 's') }));
    expect(error.code).toBe('run.not_found');
    expect(error.details).toMatchObject({ candidates: [] });
  });
});
