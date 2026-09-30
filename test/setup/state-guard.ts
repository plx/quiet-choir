import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { projectsDirectory } from '../../src/workflow/runtime/paths.js';

// The unit suite must not write into the developer's real quiet-choir state (the default XDG
// location). This guard only watches: redirecting XDG_STATE_HOME for the suite would hide the very
// leaks it exists to catch. The CLI smokes have their own guard in scripts/run-cli-smokes.mjs, and
// CI additionally fails when the state directory exists at all on a fresh runner.

function entries(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/** Project directories and each project's `runs/` entries. */
function snapshot(root: string): string[] {
  return entries(root).flatMap((project) => [
    project,
    ...entries(join(root, project, 'runs')).map((run) => `${project}/runs/${run}`),
  ]);
}

let before = new Set<string>();

export function setup(): void {
  before = new Set(snapshot(projectsDirectory()));
}

export function teardown(): void {
  const root = projectsDirectory();
  const added = snapshot(root).filter((entry) => !before.has(entry));
  if (added.length === 0) return;
  // Throwing here would still exit 0 in Vitest 4.1, so set the exit code instead.
  process.exitCode = 1;
  console.error(
    `The unit tests added entries to the real quiet-choir state ${root}:\n` +
      `${added.map((entry) => `  ${entry}`).join('\n')}\n` +
      'A test must pass an explicit stateDir or point XDG_STATE_HOME at a temporary directory. ' +
      'If you started an unrelated quiet-choir run meanwhile, this can be a false positive: rerun.',
  );
}
