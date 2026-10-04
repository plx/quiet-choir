import { lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { errorCode } from './checkpoint.js';
import { defaultStateDir, projectCwd, projectStateDirectories, resolveStateDir } from './paths.js';
import { RunRefusedError } from './run-errors.js';
import { readRun, listRunIds, type ReadRunOptions, type RunRecord } from './store.js';

/** Another runs container that holds the missing run, and the project it belongs to. @internal */
export interface RunCandidate {
  readonly stateDir: string;
  readonly cwd: string;
}

/** At most this many candidate roots are reported for a missing run. @internal */
export const maxRunCandidates = 10;

async function holdsRun(stateDir: string, runId: string): Promise<boolean> {
  for (const path of [join(stateDir, runId, 'run.json'), join(stateDir, `${runId}.json`)])
    try {
      await lstat(path);
      return true;
    } catch {
      /* Absent or unreadable roots are simply not candidates. */
    }
  return false;
}

/**
 * Other roots that hold the run: every registered XDG project root and its legacy
 * `.quiet-choir/runs`, plus the default and legacy roots of the working directory's ancestors.
 * Read errors are ignored, so a candidate search never turns `run.not_found` into another code.
 * @internal
 */
export async function findRunCandidates(
  runId: string,
  searched: string,
  cwd?: string,
): Promise<RunCandidate[]> {
  const roots = new Map<string, string>();
  const add = (stateDir: string, project: string): void => {
    const root = resolve(stateDir);
    if (root !== resolve(searched) && !roots.has(root)) roots.set(root, project);
  };
  const registered = await projectStateDirectories().catch(() => ({ projects: [] }));
  for (const project of registered.projects) {
    add(project.stateDir, project.cwd);
    add(join(project.cwd, '.quiet-choir', 'runs'), project.cwd);
  }
  try {
    for (let directory = projectCwd(cwd); ; directory = dirname(directory)) {
      add(defaultStateDir(directory), directory);
      add(join(directory, '.quiet-choir', 'runs'), directory);
      if (dirname(directory) === directory) break;
    }
  } catch {
    /* An unresolvable working directory only narrows the search. */
  }
  const found: RunCandidate[] = [];
  for (const [stateDir, project] of roots)
    if (await holdsRun(stateDir, runId)) found.push({ stateDir, cwd: project });
  return found
    .sort((a, b) => (a.stateDir < b.stateDir ? -1 : a.stateDir > b.stateDir ? 1 : 0))
    .slice(0, maxRunCandidates);
}

/** Explain a missing checkpoint with a bounded directory listing and any other roots holding it. @internal */
export async function missingRunError(
  options: ReadRunOptions,
  cause?: unknown,
): Promise<RunRefusedError> {
  const stateDir = resolveStateDir(options);
  const ids = await listRunIds(stateDir).catch((error: unknown) => {
    throw unreadableRunError(options, error);
  });
  const available = ids.slice(0, 20);
  const candidates = await findRunCandidates(options.runId, stateDir, options.cwd).catch(
    (): RunCandidate[] => [],
  );
  const first = candidates[0];
  const found = first
    ? ` Found in ${first.stateDir} (project ${first.cwd}); rerun with --state-dir ${first.stateDir}.${candidates.length > 1 ? ` ${String(candidates.length - 1)} more in details.candidates.` : ''}`
    : '';
  return new RunRefusedError(
    'run.not_found',
    options.runId,
    `Run ${options.runId} not found in ${stateDir} (${String(ids.length)} runs present${ids.length ? `: ${available.join(', ')}${ids.length > 20 ? ', …' : ''}` : ''}). --state-dir resolves against the current directory.${found}`,
    {
      runId: options.runId,
      stateDir,
      available,
      count: ids.length,
      candidates: candidates.map((candidate) => ({ ...candidate })),
    },
    { cause },
  );
}

/** Preserve filesystem/validation evidence without guessing a code from its message. @internal */
export function unreadableRunError(options: ReadRunOptions, cause: unknown): RunRefusedError {
  return new RunRefusedError(
    'run.unreadable',
    options.runId,
    cause instanceof Error ? cause.message : String(cause),
    { stateDir: resolveStateDir(options), filesystemCode: errorCode(cause) ?? null },
    { cause },
  );
}

/** Typed read boundary for operations that require an existing checkpoint. @internal */
export async function readRequiredRun(options: ReadRunOptions): Promise<RunRecord> {
  try {
    return await readRun(options);
  } catch (cause) {
    // A record newer than this build that it cannot parse is already a run.incompatible refusal.
    if (cause instanceof RunRefusedError) throw cause;
    if (errorCode(cause) === 'ENOENT') throw await missingRunError(options, cause);
    throw unreadableRunError(options, cause);
  }
}
