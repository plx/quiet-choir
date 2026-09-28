/** Small child program: blob bytes stay in the process, never in a workflow result. @internal */
export const guardProgram = String.raw`
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, lstat, rename, rm } from 'node:fs/promises';
import { resolve, relative, dirname, basename, sep, isAbsolute } from 'node:path';
const [mode, supplied, limitText, expected, savedMode] = process.argv.slice(1);
const limit = Number(limitText);
const root = await realpath(process.cwd());
const lexical = resolve(root, supplied);
const inside = (path) => { const p = relative(root, path); return p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p); };
if (!inside(lexical)) throw new Error('Guard path escapes cwd.');
const parent = await realpath(dirname(lexical));
if (!inside(parent)) throw new Error('Guard parent escapes cwd.');
const path = resolve(parent, basename(lexical));
const read = async () => {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error('Guard requires a regular text file within maxBytes.');
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count <= limit) { const read = await handle.read(bytes, count, bytes.length - count); if (!read.bytesRead) break; count += read.bytesRead; }
    if (count > limit) throw new Error('Guard file exceeds maxBytes.');
    const content = bytes.subarray(0, count);
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    return { content, mode: info.mode & 0o777 };
  } finally { await handle.close(); }
};
const git = (args, input) => execFileSync('git', args, { input, maxBuffer: limit + 1024, stdio: ['pipe', 'pipe', 'pipe'] });
const hash = (content) => git(['hash-object', '--no-filters', '--stdin'], content).toString('utf8').trim();
try {
  const before = await read();
  if (mode === 'baseline') {
    if (!before) throw new Error('Guard baseline file is missing.');
    const blob = git(['hash-object', '-w', '--no-filters', '--stdin'], before.content).toString('utf8').trim();
    process.stdout.write(JSON.stringify({ path, blob, mode: before.mode }));
  } else {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expected)) throw new Error('Invalid baseline blob.');
    const permissions = /^[0-9]+$/.test(savedMode ?? '') ? Number(savedMode) : NaN;
    if (!Number.isSafeInteger(permissions) || permissions > 0o777) throw new Error('Invalid baseline mode.');
    const changed = before === null || hash(before.content) !== expected || before.mode !== permissions;
    if (changed) {
      const size = Number(git(['cat-file', '-s', expected]).toString('utf8').trim());
      if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new Error('Baseline blob exceeds maxBytes.');
      const content = git(['cat-file', 'blob', expected]);
      new TextDecoder('utf-8', { fatal: true }).decode(content);
      const temporary = resolve(parent, '.quiet-choir-guard-' + randomUUID());
      try {
        const file = await open(temporary, 'wx', permissions);
        try { await file.chmod(permissions); await file.writeFile(content); await file.sync(); } finally { await file.close(); }
        const latest = await lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (latest && !latest.isFile()) throw new Error('Guard target is no longer a regular file.');
        await rename(temporary, path);
        const directory = await open(parent, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await rm(temporary, { force: true }); }
    }
    process.stdout.write(JSON.stringify({ changed }));
  }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;
