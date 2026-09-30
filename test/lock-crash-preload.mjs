// Crash injection for test/lock-crash-cli-smoke.mjs, with no hook in production code: patch rename
// and link on node:fs/promises, then syncBuiltinESMExports() so the runtime's ESM imports see the
// wrappers. After the real call succeeds, the process SIGKILLs itself when QC_LOCK_CRASH_AT names it:
//   publish    rename of a publish .tmp directory onto a path ending in QC_LOCK_CRASH_PATH
//              (default '/lock', the primary lock)
//   tombstone  rename of a lock to a .gone tombstone
//   recovery   link of a recovery marker to recovery.json
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const promises = require('node:fs/promises');
const at = process.env.QC_LOCK_CRASH_AT;
const target = process.env.QC_LOCK_CRASH_PATH ?? '/lock';
const { rename, link } = promises;

function crash() {
  process.kill(process.pid, 'SIGKILL');
}

promises.rename = async function crashingRename(from, to) {
  await rename(from, to);
  const source = String(from);
  const destination = String(to);
  if (
    (at === 'publish' && source.endsWith('.tmp') && destination.endsWith(target)) ||
    (at === 'tombstone' && destination.endsWith('.gone'))
  )
    crash();
};

promises.link = async function crashingLink(from, to) {
  await link(from, to);
  if (at === 'recovery' && String(to).endsWith('recovery.json')) crash();
};

syncBuiltinESMExports();
