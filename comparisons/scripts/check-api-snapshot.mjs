import { fileURLToPath } from 'node:url';
import { REFRESH_HINT, checkApiSnapshots } from './api-snapshot.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const problems = checkApiSnapshots(repoRoot);
if (problems.length > 0) {
  for (const problem of problems) console.error(`Workflow Lab API snapshot: ${problem}`);
  console.error(
    `Update apiSnapshot.sha256 in every batch.json to the hash of the current API file ` +
      `(${REFRESH_HINT}). Never record a commit: the site derives it from main.`,
  );
  process.exit(1);
}
console.log('Workflow Lab API snapshot matches the API file in every batch.');
