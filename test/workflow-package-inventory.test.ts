// The package file hashing and the validate package section's prompt inventory (ADR 0065
// sections 4-5, #585), without the CLI: bounded concurrent hashing that keeps path order, and
// prompt entries that repeat exactly versus differing declarations under one name.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { definePackage, definePrompts, defineWorkflow, z } from '../src/index.js';
import {
  hashPackageFiles,
  PACKAGE_HASH_CONCURRENCY,
  packageFiles,
} from '../src/workflow/package/files.js';
import { packageManifestSection } from '../src/workflow/package/manifest.js';
import type { PromptSetCheck } from '../src/workflow/prompts/check.js';
import type { AnyPromptSet } from '../src/workflow/runtime/model.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('hashPackageFiles', () => {
  it('hashes more files than the concurrency bound, keeping order, sizes and digests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'choir-package-hash-'));
    roots.push(root);
    const count = PACKAGE_HASH_CONCURRENCY * 3 + 5;
    const contents = new Map<string, string>();
    for (let index = 0; index < count; index++) {
      // Varying lengths make a result written to the wrong slot show up in `bytes` too.
      const name = `file-${String(index).padStart(3, '0')}.txt`;
      const text = `contents of ${name}\n`.repeat(index + 1);
      contents.set(name, text);
      await writeFile(join(root, name), text);
    }
    const walked = await packageFiles(root);
    expect(walked).toHaveLength(count);
    const hashed = await hashPackageFiles(walked);
    expect(hashed.map((file) => file.relative)).toEqual(walked.map((file) => file.relative));
    expect(hashed.map((file) => file.relative)).toEqual([...contents.keys()]);
    for (const file of hashed) {
      const text = contents.get(file.relative) ?? '';
      expect(file.bytes).toBe(Buffer.byteLength(text));
      expect(file.sha256).toBe(createHash('sha256').update(text).digest('hex'));
    }
  });

  it('returns an empty list for no files', async () => {
    expect(await hashPackageFiles([])).toEqual([]);
  });
});

describe('the package section prompt inventory', () => {
  const root = join(tmpdir(), 'inventory.quiet-choir');
  const templates = join(root, 'prompts');
  const main = defineWorkflow({
    name: 'main',
    version: '1',
    input: z.null(),
    output: z.null(),
    run: () => Promise.resolve(null),
  });
  const a = definePrompts(templates, {
    Review: { file: 'A.md', params: z.object({ title: z.string() }) },
  });
  const b = definePrompts(templates, {
    Review: { file: 'B.md', params: z.object({ title: z.string(), extra: z.string() }) },
  });
  const check = (file: string, variables: readonly string[]): PromptSetCheck => ({
    root: templates,
    entries: [{ name: 'Review', file, description: null, variables, warnings: [] }],
  });
  const section = (sets: readonly AnyPromptSet[], checks: PromptSetCheck[]) =>
    packageManifestSection(
      definePackage({ root, name: 'inventory', version: '1', workflows: [main], prompts: sets }),
      [],
      checks,
      [],
    ).prompts;

  it('lists differing declarations of one name side by side on a shared root', () => {
    expect(section([a, b], [check('A.md', ['title']), check('B.md', ['extra', 'title'])])).toEqual([
      {
        root: templates,
        entries: [
          {
            name: 'Review',
            file: 'A.md',
            description: null,
            params: ['title'],
            variables: ['title'],
          },
          {
            name: 'Review',
            file: 'B.md',
            description: null,
            params: ['extra', 'title'],
            variables: ['extra', 'title'],
          },
        ],
      },
    ]);
  });

  it('lists the same set declared twice once', () => {
    const prompts = section([a, a], [check('A.md', ['title']), check('A.md', ['title'])]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.entries.map((entry) => entry.file)).toEqual(['A.md']);
  });

  it('lists the same file twice when its params differ', () => {
    const c = definePrompts(templates, {
      Review: { file: 'A.md', params: z.object({ other: z.string() }) },
    });
    const prompts = section([a, c], [check('A.md', ['title']), check('A.md', ['title'])]);
    expect(prompts[0]?.entries.map((entry) => entry.params)).toEqual([['title'], ['other']]);
  });
});
