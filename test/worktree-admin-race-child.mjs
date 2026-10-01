// One racing worktree administrator for test/worktree-admin-race.test.ts: `cycles` times, add a
// detached worktree, list all worktrees and remove the new one, each through the runtime's
// administer() (in-process queue plus the repository's interprocess lock). Inside every critical
// section it appends `enter` and `exit` records to a shared O_APPEND log, so the log's order is the
// order in which processes really held the lock. Any Git failure fails the child.
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NodeProcessRunner } from '../src/processes/runner.ts';
import { setStorageSyncForTesting } from '../src/workflow/runtime/storage-io.ts';
import { administer } from '../src/workflow/runtime/worktrees.ts';
import { WorktreeGit } from '../src/worktrees/git.ts';
import { testInvocation } from './harness-invocation.ts';

const [repo, commonGitDir, root, log, cycles] = process.argv.slice(2);
// Like the in-process suite: fsync only slows the race and a crash is not simulated here.
setStorageSyncForTesting(false);
const git = new WorktreeGit(new NodeProcessRunner());
const invocation = testInvocation();
const signal = invocation.signal;

async function critical(label, args) {
  return administer(commonGitDir, signal, async () => {
    await appendFile(log, `${JSON.stringify({ pid: process.pid, event: 'enter', label })}\n`);
    try {
      return await git.run(repo, args, invocation);
    } finally {
      await appendFile(log, `${JSON.stringify({ pid: process.pid, event: 'exit', label })}\n`);
    }
  });
}

for (let cycle = 0; cycle < Number(cycles); cycle++) {
  const path = join(root, `${String(process.pid)}-${String(cycle)}`);
  await critical('add', ['worktree', 'add', '--force', '--detach', path, 'HEAD']);
  const listed = await critical('list', ['worktree', 'list', '--porcelain', '-z']);
  if (!listed.stdout.split('\0').includes(`worktree ${path}`))
    throw new Error(`Worktree ${path} is missing from the listing.`);
  await critical('remove', ['worktree', 'remove', '--force', path]);
}
process.send?.({ cycles: Number(cycles) }, () => process.exit(0));
