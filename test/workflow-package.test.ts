// definePackage (ADR 0065 section 1, #584): field validation, freezing, resource() confinement and
// the registry-symbol brand the loader reads across quiet-choir copies.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { definePackage, definePrompts, defineWorkflow, z } from '../src/index.js';
import { packageOf } from '../src/workflow/package/index.js';
import { analyzePackagePath, isPackagePath } from '../src/workflow/package/plan.js';

const root = join(tmpdir(), 'demo.quiet-choir');

function workflow(name: string) {
  return defineWorkflow({
    name,
    version: '1',
    input: z.null(),
    output: z.null(),
    run: () => Promise.resolve(null),
  });
}

const main = workflow('main');
const other = workflow('other');
const prompts = definePrompts(join(root, 'prompts'), {
  Review: { file: 'Review.md', params: z.object({ title: z.string() }) },
});

/** definePackage with untyped options, as a JavaScript caller or a bad manifest would pass them. */
function define(options: Record<string, unknown>) {
  return definePackage({
    root,
    name: 'demo',
    version: '1',
    workflows: [main, other],
    ...options,
  });
}

describe('definePackage', () => {
  it('returns a frozen, branded package with defaults', () => {
    const pkg = definePackage({
      root,
      name: 'demo',
      version: '1',
      description: 'A demo package.',
      whenToUse: 'In tests.',
      workflows: [main, other],
      entry: main,
      prompts: [prompts],
    });
    expect(pkg).toMatchObject({
      root,
      name: 'demo',
      version: '1',
      description: 'A demo package.',
      whenToUse: 'In tests.',
      entry: main,
    });
    expect(pkg.workflows).toEqual([main, other]);
    expect(pkg.prompts).toEqual([prompts]);
    expect(Object.isFrozen(pkg)).toBe(true);
    expect(Object.isFrozen(pkg.workflows)).toBe(true);
    expect(Object.isFrozen(pkg.prompts)).toBe(true);
    expect(packageOf(pkg)).toBe(pkg);
    const minimal = define({});
    expect(minimal).toMatchObject({ description: null, whenToUse: null, entry: null, prompts: [] });
  });

  it('recognizes the brand by Symbol.for, as another copy of quiet-choir sets it', () => {
    const forged = {
      root,
      name: 'demo',
      version: '1',
      workflows: [],
      prompts: [],
      [Symbol.for('quiet-choir.package')]: true,
    };
    expect(packageOf(forged)).toBe(forged);
    expect(packageOf({ ...forged, [Symbol.for('quiet-choir.package')]: false })).toBeUndefined();
    expect(packageOf(main)).toBeUndefined();
    expect(packageOf(null)).toBeUndefined();
  });

  it('accepts a file: URL root and normalizes it', () => {
    expect(define({ root: pathToFileURL(root) }).root).toBe(root);
    expect(define({ root: pathToFileURL(root).href }).root).toBe(root);
    expect(define({ root: `${root}/./` }).root).toBe(root);
  });

  it.for([
    ['an uppercase name', { name: 'Demo' }, 'name'],
    ['a leading digit', { name: '1demo' }, 'name'],
    ['a 65-character name', { name: `a${'b'.repeat(64)}` }, 'name'],
    ['a non-string name', { name: 3 }, 'name'],
    ['an empty version', { version: '' }, 'version'],
    ['a blank version', { version: '  ' }, 'version'],
    ['a non-string version', { version: 1 }, 'version'],
    ['empty workflows', { workflows: [] }, 'workflows'],
    ['non-array workflows', { workflows: main }, 'workflows'],
    ['a non-definition workflow', { workflows: [main, { name: 'x' }] }, 'workflows[1]'],
    ['an entry not in workflows', { entry: workflow('main') }, 'entry'],
    ['an entry given by name', { entry: 'main' }, 'entry'],
    ['a non-prompt-set prompts element', { prompts: [prompts, {}] }, 'prompts[1]'],
    ['non-array prompts', { prompts }, 'prompts'],
    ['a relative root', { root: 'demo.quiet-choir' }, 'root'],
    ['a missing root', { root: undefined }, 'root'],
    ['an http URL root', { root: new URL('https://example.com/x') }, 'root'],
    ['an empty description', { description: '' }, 'description'],
    ['a non-string whenToUse', { whenToUse: 1 }, 'whenToUse'],
    ['an unknown key', { entrypoint: main }, 'unknown key entrypoint'],
  ] as const)('rejects %s, naming the field', ([, options, field]) => {
    expect(() => define(options)).toThrow(TypeError);
    expect(() => define(options)).toThrow(field);
  });

  it('accepts a 64-character name', () => {
    expect(define({ name: `a${'b'.repeat(63)}` }).name).toHaveLength(64);
  });

  it('names the duplicate workflow name', () => {
    expect(() => define({ workflows: [main, other, workflow('other')] })).toThrow(
      /workflows declares the workflow name "other" twice/u,
    );
  });

  it('points an undefined workflow at an import cycle', () => {
    expect(() => define({ workflows: [main, undefined] })).toThrow(
      /workflows\[1\] is undefined.*import cycle/u,
    );
  });

  it('rejects a non-object argument', () => {
    expect(() => definePackage(null as never)).toThrow(TypeError);
    expect(() => definePackage([] as never)).toThrow('plain object');
  });
});

describe('WorkflowPackage.resource', () => {
  const pkg = define({});

  it('resolves a path under resources/ without touching the disk', () => {
    expect(pkg.resource('notes.txt')).toBe(join(root, 'resources', 'notes.txt'));
    expect(pkg.resource('a/b/../c.json')).toBe(join(root, 'resources', 'a', 'c.json'));
    expect(pkg.resource('./x')).toBe(join(root, 'resources', 'x'));
  });

  it.for(['', '/etc/passwd', '../x', 'a/../../x', '.', 'a/..'])('rejects %j', (path) => {
    expect(() => pkg.resource(path)).toThrow(TypeError);
  });
});

describe('package paths', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('recognizes .quiet-choir paths with or without a trailing separator', () => {
    expect(isPackagePath('demo.quiet-choir')).toBe(true);
    expect(isPackagePath('./x/demo.quiet-choir/')).toBe(true);
    expect(isPackagePath('demo.quiet-choir/package.ts')).toBe(false);
    expect(isPackagePath('demo.ts')).toBe(false);
  });

  it('analyzes a package directory into plain data', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'choir-package-plan-'));
    roots.push(parent);
    const dir = join(parent, 'demo.quiet-choir');
    expect(analyzePackagePath(dir, parent)).toMatchObject({
      ok: false,
      error: { code: 'PACKAGE_NOT_FOUND', path: dir },
    });
    await writeFile(dir, '');
    expect(analyzePackagePath(dir, parent)).toMatchObject({
      ok: false,
      error: { code: 'PACKAGE_NOT_DIRECTORY' },
    });
    await rm(dir);
    await mkdir(dir);
    expect(analyzePackagePath('demo.quiet-choir', parent)).toMatchObject({
      ok: false,
      error: { code: 'PACKAGE_MANIFEST_MISSING', path: join(dir, 'package.ts') },
    });
    await writeFile(join(dir, 'package.mjs'), '');
    const javascript = analyzePackagePath(dir, parent);
    expect(javascript).toMatchObject({ ok: false, error: { code: 'JAVASCRIPT_PACKAGE_MANIFEST' } });
    if (javascript.ok) throw new Error('Expected a refusal.');
    expect(javascript.error.message).toContain('package.ts');
    await writeFile(join(dir, 'package.ts'), '');
    const analysis = analyzePackagePath('demo.quiet-choir/', parent);
    expect(analysis).toEqual({
      ok: true,
      typecheck: {
        kind: 'workflow.typecheck',
        entrypoint: join(dir, 'package.ts'),
        configuration: { kind: 'defaults', profile: 'node22-es2023-strict' },
      },
      package: { kind: 'workflow.package', root: dir, manifest: join(dir, 'package.ts') },
    });
    expect(JSON.parse(JSON.stringify(analysis))).toEqual(analysis);
    await writeFile(join(dir, 'tsconfig.json'), '{}');
    const configured = analyzePackagePath(dir, parent);
    expect(configured).toMatchObject({
      ok: true,
      typecheck: { configuration: { kind: 'tsconfig', path: join(dir, 'tsconfig.json') } },
    });
  });
});
