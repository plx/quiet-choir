// One quiet-choir process for test/codex-home.test.ts: snapshot a Codex home into a private one,
// wait for "go", optionally write refreshed credentials into the private copy (as Codex would on a
// token refresh), then write them back and report the warnings.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareCodexHome } from '../src/harnesses/codex-home.ts';
import { setStorageSyncForTesting } from '../src/workflow/runtime/storage-io.ts';

const [source, lockDirectory, refreshed] = process.argv.slice(2);
// Like the in-process suite: fsync only slows the race and a crash is not simulated here.
setStorageSyncForTesting(false);
const home = await prepareCodexHome(source, { lockDirectory });
process.send?.({ ready: true });
await new Promise((resolve) => process.once('message', resolve));
if (refreshed) await writeFile(join(home.path, 'auth.json'), refreshed);
const warnings = await home.settle();
await home.dispose();
process.send?.({ warnings, path: home.path }, () => process.exit(0));
