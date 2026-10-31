// Check one Batch 03 package while authoring it, with the checks verify-packaged-ports.mjs runs
// for every package: hygiene and CLI validation, the success run with completed replay and its
// fixture module's `check`, the F1–F5 matrix and the module's extra modes. It writes no report.
//
//   node --import tsx comparisons/scripts/check-packaged-port.mjs <name> [--no-faults]
//     [--no-success] [--mode <mode>]... [--root <dir>] [--mutant <file>]
//
// --no-faults skips the fault matrix; --no-success skips the success run and, with it, the matrix.
// --mode (repeatable) runs only the named modes. --root <dir> checks the package directory <dir>
// instead of ported/<name>.quiet-choir, and --mutant <file> applies a JSON list of
// `{ file?, old, new }` replacements to a copy of the package (see packaged-fixtures/README.md).
// A failed check prints its error with the failed steps of its run.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  fixture,
  packageDirVariable,
  packageRoot,
  packagedNames,
  packagesDir,
  project,
} from './idiomatic-fixtures.mjs';
import {
  checkPort,
  checkSuccess,
  modeContracts,
  selectModes,
  validatePackage,
} from './packaged-checks.mjs';

const usage =
  'Usage: check-packaged-port.mjs <name> [--no-faults] [--no-success] [--mode <mode>]... [--root <dir>] [--mutant <file>]';
const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'no-faults': { type: 'boolean', default: false },
    'no-success': { type: 'boolean', default: false },
    mode: { type: 'string', multiple: true },
    root: { type: 'string' },
    mutant: { type: 'string' },
  },
});
const [name] = positionals;
if (positionals.length !== 1 || !packagedNames.includes(name))
  throw new Error(`${usage}; known packages: ${packagedNames.join(', ')}`);
// Fail on an unknown mode before the long runs.
selectModes(name, flags.mode);

/** Every file under `directory`, relative to it. */
async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) found.push(relative(directory, join(entry.parentPath, entry.name)));
  return found.sort();
}

/**
 * Apply a mutant to the package copy at `root`: each `{ file?, old, new }` replaces `old` once, in
 * `file` (relative to the package root) or, without it, in the one package file holding it. `old`
 * must occur exactly once there, so a mutant that no longer applies fails instead of passing.
 */
async function mutate(root, path) {
  const pairs = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(
    Array.isArray(pairs) && pairs.length,
    `${path}: expected a list of { file?, old, new }`,
  );
  for (const [index, pair] of pairs.entries()) {
    const label = `${path} [${String(index)}]`;
    assert.ok(
      typeof pair?.old === 'string' && pair.old && typeof pair.new === 'string',
      `${label}: expected { file?, old, new } with a non-empty old string`,
    );
    const candidates = pair.file ? [pair.file] : await files(root);
    const hits = [];
    for (const file of candidates) {
      const text = await readFile(join(root, file), 'utf8');
      const count = text.split(pair.old).length - 1;
      if (count) hits.push({ file, text, count });
    }
    const where = pair.file ?? 'the package';
    assert.ok(hits.length, `${label}: old string not found in ${where}`);
    assert.ok(
      hits.length === 1 && hits[0].count === 1,
      `${label}: old string occurs more than once in ${where}: ${hits.map((hit) => `${hit.file} (${String(hit.count)})`).join(', ')}`,
    );
    const [{ file, text }] = hits;
    await writeFile(
      join(root, file),
      text.replace(pair.old, () => pair.new),
    );
  }
  return pairs.length;
}

/**
 * Stage the package from `source` in the fresh directory `staged`, beside copies of the other
 * packages (a composite imports its children from there), with the `package.json` and
 * `node_modules` link that let its `.ts` modules load as ES modules importing `quiet-choir` from
 * this checkout.
 */
async function stage(source, staged) {
  const from = packagesDir();
  for (const entry of await readdir(from, { withFileTypes: true }))
    if (entry.isDirectory() && entry.name.endsWith('.quiet-choir'))
      if (entry.name !== `${name}.quiet-choir`)
        await cp(join(from, entry.name), join(staged, entry.name), { recursive: true });
  await cp(source, join(staged, `${name}.quiet-choir`), { recursive: true });
  await writeFile(join(staged, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
  await mkdir(join(staged, 'node_modules'));
  await symlink(project, join(staged, 'node_modules', 'quiet-choir'), 'dir');
}

/** One fault cell as a line: its statuses, then what it measured. */
const faultLine = (fault, cell) =>
  [
    `${fault}: ${cell.initialStatus ?? '-'} -> ${cell.finalStatus}`,
    `repaid ${String(cell.callsPaidAgain)}`,
    ...(cell.outputAdmitsDegradation === null
      ? []
      : [`degraded ${String(cell.outputAdmitsDegradation)}`]),
    ...('faultedStep' in cell ? [`faulted ${cell.faultedStep ?? '-'}`] : []),
    ...('outputMatchesSuccess' in cell
      ? [`matches success ${String(cell.outputMatchesSuccess)}`]
      : []),
    ...(cell.reason ? [cell.reason] : []),
  ].join('; ');

let staged = null,
  root = null,
  sequence = 0,
  failed = false;
const setup = async () => fixture(join(root, String(sequence++)));
const stderr = console.error;
try {
  if (flags.root || flags.mutant) {
    const source = flags.root ? resolve(flags.root) : packageRoot(name);
    assert.ok(
      existsSync(join(source, 'workflows', `${name}.ts`)),
      `${source} is not the ${name} package: no workflows/${name}.ts`,
    );
    staged = await mkdtemp(join(tmpdir(), `choir-root-${name}-`));
    await stage(source, staged);
    process.env[packageDirVariable] = staged;
    console.log(`root: ${packageRoot(name)}, copied from ${source}`);
    if (flags.mutant) {
      const count = await mutate(packageRoot(name), resolve(flags.mutant));
      console.log(`mutant: ${flags.mutant}, ${String(count)} replacement${count === 1 ? '' : 's'}`);
    }
  }
  root = await mkdtemp(join(tmpdir(), `choir-port-${name}-`));
  console.error = () => {};
  const { row: validation } = await validatePackage(name);
  console.log(`validate: ${JSON.stringify(validation)}`);
  if (flags['no-success']) console.log('success: skipped, with the fault matrix');
  else if (flags['no-faults']) {
    console.log(`success: ${JSON.stringify((await checkSuccess(name, { setup })).row)}`);
  } else {
    const { row, metric } = await checkPort(name, { setup, root });
    console.log(`success: ${JSON.stringify(row)}`);
    for (const [fault, cell] of Object.entries(metric.batches[3].faults))
      console.log(faultLine(fault, cell));
  }
  for (const mode of await modeContracts(name, { setup, only: flags.mode }))
    console.log(`mode: ${JSON.stringify(mode)}`);
  console.log(`${name}: all checks passed`);
} catch (error) {
  // The runs' own console.error noise stays silenced; the failure, with its summary, does not.
  failed = true;
  stderr(error);
} finally {
  console.error = stderr;
  for (const directory of [root, staged])
    if (directory) await rm(directory, { recursive: true, force: true });
}
// A failed run may leave a handle open; the failure is already printed.
if (failed) process.exit(1);
