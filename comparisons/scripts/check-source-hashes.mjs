import { fileURLToPath } from 'node:url';
import { SOURCE_HASH_HINT, checkSourceHashes } from './source-hashes.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const problems = checkSourceHashes(repoRoot);
if (problems.length > 0) {
  for (const problem of problems) console.error(`Workflow Lab upstream sources: ${problem}`);
  console.error(SOURCE_HASH_HINT);
  process.exit(1);
}
console.log(
  'Workflow Lab upstream originals and LICENSE match their recorded hashes in every batch.',
);
