import { createStorageDirectory, syncDirectory, syncHandle } from './storage-io.js';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { open, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isValidRunId, runIdMessage } from './run-errors.js';

/** Shared working-directory and checkpoint-directory resolution inputs. */
export interface StateDirectoryOptions {
  /** Base directory, resolved against process.cwd(); defaults to process.cwd(). */
  readonly cwd?: string;
  /** Explicit runs container, relative to cwd. Overrides the environment and XDG defaults. */
  readonly stateDir?: string;
  /** Existing run used when discovering a legacy in-workspace checkpoint. */
  readonly runId?: string;
}

/** Canonical project path used for storage identity, including symlinked working directories. @internal */
export function projectCwd(cwd = process.cwd()): string {
  const path = resolve(cwd);
  try {
    return realpathSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return path;
    throw error;
  }
}

/** Parent directory containing the default per-project state roots. @internal */
export function projectsDirectory(): string {
  const xdg = process.env['XDG_STATE_HOME'];
  return join(xdg ? resolve(xdg) : join(homedir(), '.local', 'state'), 'quiet-choir');
}

/** Default runs container, outside the project working tree. @internal */
export function defaultStateDir(cwd = process.cwd()): string {
  const canonical = projectCwd(cwd);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  const label =
    basename(canonical)
      .replace(/[^a-zA-Z0-9._-]/gu, '-')
      .slice(0, 80) || 'root';
  return join(projectsDirectory(), `${label}-${hash}`, 'runs');
}

/** Resolve explicit, environment, legacy-run, then project-specific XDG storage. */
export function resolveStateDir(options: StateDirectoryOptions = {}): string {
  const cwd = projectCwd(options.cwd);
  const explicit = options.stateDir ?? process.env['QUIET_CHOIR_STATE_DIR'];
  if (explicit !== undefined) return resolve(cwd, explicit);
  if (options.runId !== undefined) {
    assertRunId(options.runId);
    const legacy = join(cwd, '.quiet-choir', 'runs');
    if (
      existsSync(join(legacy, `${options.runId}.json`)) ||
      existsSync(join(legacy, options.runId, 'run.json'))
    )
      return legacy;
  }
  return defaultStateDir(cwd);
}

function assertRunId(runId: string): void {
  if (!isValidRunId(runId)) throw new Error(runIdMessage);
}

/** Per-run directory in a resolved runs container. @internal */
export function runDirectory(stateDir: string, runId: string): string {
  assertRunId(runId);
  return join(resolve(stateDir), runId);
}

/** Original flat checkpoint path, retained only for reads and migration. @internal */
export function legacyRunPath(stateDir: string, runId: string): string {
  assertRunId(runId);
  return join(resolve(stateDir), `${runId}.json`);
}

/** Resolve ownership consistently while a legacy checkpoint awaits migration. @internal */
export function runLockPath(stateDir: string, runId: string): string {
  const primary = join(runDirectory(stateDir, runId), 'lock');
  if (existsSync(primary)) return primary;
  const legacy = legacyRunPath(stateDir, runId);
  return existsSync(`${legacy}.lock`) ? `${legacy}.lock` : primary;
}

/**
 * One inbox per run for its whole life, so exclusive links always race in one directory. The flat
 * checkpoint persists as the format-7 marker after migration, so migrated runs keep `<runId>.inbox`.
 * @internal
 */
export function runInboxPath(stateDir: string, runId: string): string {
  return existsSync(legacyRunPath(stateDir, runId))
    ? join(resolve(stateDir), `${runId}.inbox`)
    : join(runDirectory(stateDir, runId), 'inbox');
}

/**
 * The run's pending `workflow cancel` request. It follows {@link runInboxPath}'s legacy rule, so a run
 * with a flat checkpoint keeps the request beside it as `<runId>.cancel.json`. @internal
 */
export function runCancelRequestPath(stateDir: string, runId: string): string {
  return existsSync(legacyRunPath(stateDir, runId))
    ? join(resolve(stateDir), `${runId}.cancel.json`)
    : join(runDirectory(stateDir, runId), 'cancel.json');
}

/** Create private storage and a non-overwriting ignore file; register default projects. @internal */
export async function prepareStateDirectory(stateDir: string, cwd?: string): Promise<void> {
  await createStorageDirectory(stateDir);
  const create = async (path: string, value: string): Promise<void> => {
    try {
      await using file = await open(path, 'wx', 0o600);
      await file.writeFile(value);
      await syncHandle(file);
      await syncDirectory(dirname(path));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  };
  await create(join(stateDir, '.gitignore'), '*\n');
  if (cwd !== undefined && resolve(stateDir) === defaultStateDir(cwd))
    await create(
      join(dirname(stateDir), 'project.json'),
      `${JSON.stringify({ cwd: projectCwd(cwd) })}\n`,
    );
}

/** A project registration read from a root's `project.json`. @internal */
export interface RegisteredProject {
  /** The root's `runs` container, which must be the default state dir of `cwd`. */
  readonly stateDir: string;
  /** The working directory the root is registered for, as recorded. */
  readonly cwd: string;
}

/** One real directory directly under {@link projectsDirectory}. @internal */
export interface ProjectRoot {
  /** Absolute root directory. */
  readonly root: string;
  /** Its registration, or null when `project.json` is missing, unreadable or invalid. */
  readonly project: RegisteredProject | null;
  /** Why `project` is null: the reason `workflow list --all` skips the root; null when registered. */
  readonly problem: string | null;
}

/** Read and validate one root's `project.json`, throwing the reason it does not register a project. */
async function readProjectRoot(directory: string): Promise<RegisteredProject> {
  const raw: unknown = JSON.parse(await readFile(join(directory, 'project.json'), 'utf8'));
  if (raw === null || typeof raw !== 'object' || !('cwd' in raw) || typeof raw.cwd !== 'string')
    throw new Error('project.json must contain a cwd string.');
  const expected = defaultStateDir(raw.cwd);
  if (expected !== join(directory, 'runs'))
    throw new Error('Project state path does not match its recorded cwd.');
  return { stateDir: expected, cwd: raw.cwd };
}

/**
 * Every real directory directly under {@link projectsDirectory}, in directory order, with its
 * registration or the reason it has none. Symbolic links are not followed. Reads only
 * `project.json`. @internal
 */
export async function projectRoots(): Promise<ProjectRoot[]> {
  const parent = projectsDirectory();
  const entries = await readdir(parent, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  const roots: ProjectRoot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = join(parent, entry.name);
    try {
      roots.push({ root, project: await readProjectRoot(root), problem: null });
    } catch (error) {
      roots.push({
        root,
        project: null,
        problem: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return roots;
}

/**
 * The registered projects and `Skipped project` warnings of {@link projectRoots}' result, as
 * {@link projectStateDirectories} reports them. @internal
 */
export function registeredProjects(roots: readonly ProjectRoot[]): {
  directories: string[];
  /** The same roots with the project working directory each one is registered for. */
  projects: { stateDir: string; cwd: string }[];
  warnings: string[];
} {
  const projects: { stateDir: string; cwd: string }[] = [],
    warnings: string[] = [];
  for (const { root, project, problem } of roots)
    if (project) projects.push({ stateDir: project.stateDir, cwd: project.cwd });
    else warnings.push(`Skipped project ${root}: ${problem ?? 'unknown problem'}`);
  projects.sort((a, b) => (a.stateDir < b.stateDir ? -1 : a.stateDir > b.stateDir ? 1 : 0));
  return { directories: projects.map((project) => project.stateDir), projects, warnings };
}

/** Discover registered XDG projects without importing or touching workflow code. @internal */
export async function projectStateDirectories(): Promise<{
  directories: string[];
  /** The same roots with the project working directory each one is registered for. */
  projects: { stateDir: string; cwd: string }[];
  warnings: string[];
}> {
  return registeredProjects(await projectRoots());
}
