import { readFile, readdir, mkdir, copyFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
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
const ids = JSON.parse(await readFile(`${root}/batches/index.json`, 'utf8'));
const batches = [];
for (const id of ids) {
  const dir = `${root}/batches/${id}`;
  const batch = JSON.parse(await readFile(`${dir}/batch.json`, 'utf8'));
  const catalog = JSON.parse(await readFile(`${dir}/catalog.json`, 'utf8'));
  const notes = JSON.parse(await readFile(`${dir}/notes.json`, 'utf8'));
  for (const entry of catalog)
    if (!notes[entry.name]?.summary) throw new Error(`Missing narrative for ${id}/${entry.name}`);
  const workflows = [];
  const hashes = JSON.parse(await readFile(`${dir}/source-hashes.json`, 'utf8'));
  for (const entry of catalog) {
    const original = await readFile(`${dir}/originals/${entry.name}.js`, 'utf8');
    if (createHash('sha256').update(original).digest('hex') !== hashes[`${entry.name}.js`])
      throw new Error(`Original snapshot changed: ${id}/${entry.name}`);
    workflows.push({
      ...entry,
      notes: notes[entry.name],
      original,
      ported: await readFile(`${dir}/ported/${entry.name}.workflow.ts`, 'utf8'),
    });
  }
  const support = {};
  for (const file of (await readdir(`${dir}/ported`))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.workflow.ts'))
    .sort())
    support[file] = await readFile(`${dir}/ported/${file}`, 'utf8');
  support['tsconfig.json'] = await readFile(`${dir}/tsconfig.json`, 'utf8');
  batches.push({ ...batch, workflows, support });
}
for (const file of ['index.html', 'style.css', 'app.js'])
  await copyFile(`${root}/site/${file}`, `${target}/dist/${file}`);
await writeFile(`${target}/dist/data.json`, JSON.stringify({ batches }));
await copyFile(`${root}/batches/${ids[0]}/LICENSE`, `${target}/dist/license.txt`);
console.log(
  `Built ${batches.length} batch(es), ${batches.reduce((n, b) => n + b.workflows.length, 0)} comparisons in ${target}/dist`,
);
