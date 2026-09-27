// One managed process owns recovery, mutation, test execution and restoration.
// This source is part of exec identity. It never accepts arbitrary JavaScript from an agent.
export const mutationWorker = String.raw`
import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, relative, isAbsolute } from 'node:path';
const input = JSON.parse(readFileSync(0, 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const root = realpathSync(process.cwd());
const file = resolve(root, input.file);
const leaf = lstatSync(file);
const path = relative(root, realpathSync(file));
if (!leaf.isFile() || leaf.isSymbolicLink() || path.startsWith('..') || isAbsolute(path))
  throw new Error('Mutation target must be a regular file within cwd');
const pristine = Buffer.from(input.pristine, 'utf8');
if (hash(pristine) !== input.sha256) throw new Error('Pristine digest mismatch');
const { before, after, id } = input.mutant;
if (!before || before === after || input.pristine.split(before).length !== 2)
  throw new Error('Mutant must replace exactly one nonempty occurrence');
const mutated = Buffer.from(input.pristine.replace(before, () => after), 'utf8');
const mutatedHash = hash(mutated);
function restore() {
  const actual = hash(readFileSync(file));
  if (actual === input.sha256) return;
  if (actual !== mutatedHash) throw new Error('Unknown target bytes; refusing to overwrite an external edit');
  writeFileSync(file, pristine);
}
// Heal this same unfinished effect before executing its test again.
restore();
let result;
try {
  if (hash(readFileSync(file)) !== input.sha256) throw new Error('Target changed before mutation');
  writeFileSync(file, mutated);
  result = spawnSync(input.argv[0], input.argv.slice(1), {
    encoding: 'utf8', timeout: 120000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.signal || result.status === null)
    throw result.error ?? new Error('Mutation test terminated: ' + result.signal);
} finally { restore(); }
const restoredSha256 = hash(readFileSync(file));
if (restoredSha256 !== input.sha256) throw new Error('Restoration digest mismatch');
process.stdout.write(JSON.stringify({ id, killed: result.status !== 0, code: result.status, restoredSha256 }));
`;
