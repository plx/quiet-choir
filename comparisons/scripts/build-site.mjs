import { readFile, readdir, mkdir, copyFile, writeFile, rename, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkApiSnapshots, deriveApiRevision } from './api-snapshot.mjs';
import { checkSourceHashes } from './source-hashes.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const target = resolve(process.argv[2] ?? '.context/comparison-site');
await mkdir(`${target}/dist`, { recursive: true });
await mkdir(`${target}/.openai`, { recursive: true });
const manifest = JSON.parse(await readFile(`${root}/site/.openai/hosting.json`, 'utf8'));
try {
  const existing = JSON.parse(await readFile(`${target}/.openai/hosting.json`, 'utf8'));
  if (existing.project_id && existing.project_id !== manifest.project_id)
    throw new Error('Refusing to overwrite a different Site identity.');
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
await writeFile(`${target}/.openai/hosting.json.tmp`, JSON.stringify(manifest, null, 2) + '\n');
await rename(`${target}/.openai/hosting.json.tmp`, `${target}/.openai/hosting.json`);
const snapshotProblems = checkApiSnapshots(repoRoot);
if (snapshotProblems.length > 0)
  throw new Error(`API snapshot check failed:\n${snapshotProblems.join('\n')}`);
const sourceProblems = checkSourceHashes(repoRoot);
if (sourceProblems.length > 0)
  throw new Error(`Upstream source hash check failed:\n${sourceProblems.join('\n')}`);
const exists = async (path) =>
  stat(path).then(
    () => true,
    () => false,
  );
const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}
// The parts of a package (ADR 0065), in the order the reader lists them.
const parts = ['manifest', 'workflows', 'contracts', 'roster', 'promptIndex', 'templates', 'lib'];
const partOf = (path) =>
  path === 'package.ts'
    ? 'manifest'
    : path.startsWith('workflows/')
      ? 'workflows'
      : path === 'contracts.ts'
        ? 'contracts'
        : path === 'roster.ts'
          ? 'roster'
          : path === 'prompts.ts'
            ? 'promptIndex'
            : path.startsWith('prompts/')
              ? 'templates'
              : path.startsWith('lib/')
                ? 'lib'
                : 'resources';
const rank = (path) => {
  const index = parts.indexOf(partOf(path));
  return index === -1 ? parts.length : index;
};
/** A `<name>.quiet-choir` directory, as the reader browses it. */
async function readPackage(dir, name, manifests) {
  const directory = `${dir}/ported/${name}.quiet-choir`;
  const files = [];
  for (const path of await walk(directory)) {
    const local = relative(directory, path).split('\\').join('/');
    const content = await readFile(path, 'utf8');
    files.push({
      path: local,
      part: partOf(local),
      lines: content.trimEnd().split('\n').length,
      content,
    });
  }
  files.sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
  const entry = `workflows/${name}.ts`;
  if (!files.some((file) => file.path === entry))
    throw new Error(`Package ${name}.quiet-choir has no ${entry}`);
  return { dir: `${name}.quiet-choir`, entry, files, manifest: manifests?.[name] ?? null };
}
const ids = JSON.parse(await readFile(`${root}/batches/index.json`, 'utf8'));
const batches = [];
for (const id of ids) {
  const dir = `${root}/batches/${id}`;
  const batch = JSON.parse(await readFile(`${dir}/batch.json`, 'utf8'));
  if (batch.baseline && !ids.includes(batch.baseline))
    throw new Error(`${id}: baseline ${batch.baseline} is not a registered batch`);
  const catalog = JSON.parse(await readFile(`${dir}/catalog.json`, 'utf8'));
  const notes = JSON.parse(await readFile(`${dir}/notes.json`, 'utf8'));
  const metrics = await readJson(`${dir}/metrics.json`);
  const manifests = await readJson(`${dir}/packages.json`);
  for (const entry of catalog)
    if (!notes[entry.name]?.summary) throw new Error(`Missing narrative for ${id}/${entry.name}`);
  const workflows = [];
  for (const entry of catalog) {
    const original = await readFile(`${dir}/originals/${entry.name}.js`, 'utf8');
    const packaged = (await exists(`${dir}/ported/${entry.name}.quiet-choir`))
      ? await readPackage(dir, entry.name, manifests)
      : null;
    workflows.push({
      ...entry,
      notes: notes[entry.name],
      original,
      ported: packaged
        ? packaged.files.find((file) => file.path === packaged.entry).content
        : await readFile(`${dir}/ported/${entry.name}.workflow.ts`, 'utf8'),
      ...(packaged ? { package: packaged } : {}),
      measured: metrics?.rows.find((row) => row.workflow === entry.name)?.batches ?? null,
    });
  }
  const support = {};
  for (const file of (await readdir(`${dir}/ported`))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.workflow.ts'))
    .sort())
    support[file] = await readFile(`${dir}/ported/${file}`, 'utf8');
  support['tsconfig.json'] = await readFile(`${dir}/tsconfig.json`, 'utf8');
  const reports = {};
  await mkdir(`${target}/dist/reports`, { recursive: true });
  for (const name of ['verification', 'metrics', 'packages']) {
    try {
      const contents = await readFile(`${dir}/${name}.json`, 'utf8');
      JSON.parse(contents);
      const path = `reports/${id}-${name}.json`;
      await writeFile(`${target}/dist/${path}`, contents);
      reports[name] = path;
    } catch (error) {
      if (name === 'verification' || error.code !== 'ENOENT') throw error;
    }
  }
  const { file, sha256 } = batch.apiSnapshot;
  const revision = deriveApiRevision({ repoRoot, file, sha256 });
  if (revision === null)
    console.warn(
      `Warning: no commit reachable from HEAD has ${file} at ${sha256} (uncommitted change or shallow clone); ${id} publishes no API revision.`,
    );
  batches.push({
    ...batch,
    apiSnapshot: { ...batch.apiSnapshot, revision },
    workflows,
    support,
    reports,
  });
}
for (const file of ['index.html', 'style.css', 'app.js'])
  await copyFile(`${root}/site/${file}`, `${target}/dist/${file}`);
await writeFile(`${target}/dist/data.json`, JSON.stringify({ batches }));
await copyFile(`${root}/batches/${ids[0]}/LICENSE`, `${target}/dist/license.txt`);
console.log(
  `Built ${batches.length} batch(es), ${batches.reduce((n, b) => n + b.workflows.length, 0)} comparisons in ${target}/dist`,
);
