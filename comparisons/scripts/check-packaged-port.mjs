// Check one Batch 03 package while authoring it, with the checks verify-packaged-ports.mjs runs
// for every package: hygiene and CLI validation, the success run with completed replay and its
// fixture module's `check`, the F1–F5 matrix and the module's extra modes. It writes no report.
//
//   node --import tsx comparisons/scripts/check-packaged-port.mjs <name> [--no-faults]
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, packagedNames } from './idiomatic-fixtures.mjs';
import { checkPort, checkSuccess, modeContracts, validatePackage } from './packaged-checks.mjs';

const [name, ...flags] = process.argv.slice(2);
if (!packagedNames.includes(name))
  throw new Error(
    `Usage: check-packaged-port.mjs <name> [--no-faults]; known packages: ${packagedNames.join(', ')}`,
  );
const root = await mkdtemp(join(tmpdir(), `choir-port-${name}-`));
let sequence = 0;
const setup = async () => fixture(join(root, String(sequence++)));
const stderr = console.error;
console.error = () => {};
try {
  const { row: validation } = await validatePackage(name);
  console.log(`validate: ${JSON.stringify(validation)}`);
  if (flags.includes('--no-faults')) {
    console.log(`success: ${JSON.stringify((await checkSuccess(name, { setup })).row)}`);
  } else {
    const { row, metric } = await checkPort(name, { setup, root });
    console.log(`success: ${JSON.stringify(row)}`);
    for (const [fault, cell] of Object.entries(metric.batches[3].faults))
      console.log(
        `${fault}: ${cell.initialStatus ?? '-'} -> ${cell.finalStatus}; repaid ${cell.callsPaidAgain}${cell.reason ? `; ${cell.reason}` : ''}`,
      );
  }
  for (const mode of await modeContracts(name, { setup }))
    console.log(`mode: ${JSON.stringify(mode)}`);
  console.log(`${name}: all checks passed`);
} finally {
  console.error = stderr;
  await rm(root, { recursive: true, force: true });
}
