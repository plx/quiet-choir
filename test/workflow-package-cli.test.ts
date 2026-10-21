// Package-aware loading (ADR 0065 sections 1-2, #584): a `*.quiet-choir` directory runs through
// execute, validate, --dry-run and check-resume with its manifest as the typecheck entrypoint; the
// launch records the selected workflow's module and `launch.package`, and every resume route
// re-enters through the manifest.
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, vi } from 'vitest';

import { ThresholdLogger } from '../src/application/execution.js';
import WorkflowCheckResume from '../src/commands/workflow/check-resume.js';
import WorkflowExecute from '../src/commands/workflow/execute.js';
import WorkflowInspect from '../src/commands/workflow/inspect.js';
import WorkflowList from '../src/commands/workflow/list.js';
import WorkflowListDefinitions from '../src/commands/workflow/list-defs.js';
import WorkflowResume from '../src/commands/workflow/resume.js';
import WorkflowTypecheck from '../src/commands/workflow/typecheck.js';
import WorkflowValidate from '../src/commands/workflow/validate.js';
import { readRun, type WorkflowClock } from '../src/index.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { TickWorkflowExecutor } from '../src/workflow/loader/tick.js';
import { readHarnessSelection } from '../src/workflow/loader/harness-selection.js';
import type { PackageSelection } from '../src/workflow/loader/model.js';
import { PACKAGE_SIZE_WARNING_BYTES } from '../src/workflow/package/files.js';
import { analyzePackagePath } from '../src/workflow/package/plan.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { TypecheckProgramCache } from '../src/workflow/typecheck/program-cache.js';
import { it } from './setup/cli-capture.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const engine = JSON.stringify(join(repository, 'src/index.js'));
const typecheckCache = new TypecheckProgramCache();
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  Reflect.deleteProperty(globalThis, 'choirEngine');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface ProjectOptions {
  /** Declare `entry: main` (default true). */
  readonly entry?: boolean;
  /** The manifest's root expression; defaults to the module format's directory. */
  readonly root?: string;
  /** A CommonJS project (package.json type commonjs). */
  readonly commonjs?: boolean;
  /** Body of `workflows/other.ts`, replacing the default. */
  readonly other?: string;
  /** Put `other` in `workflows/other.cts`, which the manifest imports by default interop. */
  readonly otherCts?: boolean;
  /** A package-level prompt set over `prompts/Review.md` with this template. */
  readonly template?: string;
}

/**
 * A `workflows/other.ts` that declares a roster entry pinned to Claude and, with `ownPrompts`, its
 * own prompt set over `other-prompts/Bad.md`, whose `{}` params the caller's template must match.
 */
function rosterOther(ownPrompts = false): string {
  return `import { join } from 'node:path';
import { definePrompts, defineRoster, defineWorkflow, z } from ${engine};

const roster = defineRoster({
  Reviewer: { harness: 'claude', model: 'sonnet', description: 'Reviews the change.' },
});
${ownPrompts ? "const own = definePrompts(join(import.meta.dirname, '..', 'other-prompts'), { Bad: { file: 'Bad.md', params: z.object({}) } });" : ''}
export default defineWorkflow({
  name: 'other',
  version: '1',
  description: 'Review the change.',
  input: z.object({}),
  output: z.string(),
  roster,
${ownPrompts ? '  prompts: [own],\n' : ''}  async run(ctx) {
    const reply = await ctx.claude.text('review', { prompt: 'Review the change.' });
    return \`other:\${reply.output}\`;
  },
});
`;
}

const mainSource = `import { appendFileSync, existsSync } from 'node:fs';
import { defineWorkflow, z } from ${engine};
import { MainInput } from '../contracts.js';

export default defineWorkflow({
  name: 'main',
  version: '1',
  input: MainInput,
  output: z.string(),
  async run(ctx, input) {
    const first = await ctx.step('first', {
      input: input.log,
      schema: z.string(),
      run: () => {
        appendFileSync(input.log, 'first\\n');
        return 'one';
      },
    });
    await ctx.step('gate', {
      input: input.marker,
      schema: z.boolean(),
      run: () => {
        if (input.marker !== null && !existsSync(input.marker)) throw new Error('gate closed');
        return true;
      },
    });
    return \`main:\${first}\`;
  },
});
`;

const otherSource = `import { defineWorkflow, z } from ${engine};

export default defineWorkflow({
  name: 'other',
  version: '1',
  input: z.object({}),
  output: z.string(),
  async run(ctx) {
    const reply = await ctx.claude.text('review', { prompt: 'Review the change.' });
    return \`other:\${reply.output}\`;
  },
});
`;

/**
 * A project with `demo.quiet-choir/` (package.ts, contracts.ts, workflows/main.ts and
 * workflows/other.ts), a fixture file answering `review`, and a log and marker path for `main`.
 */
async function project(options: ProjectOptions = {}) {
  const base = await mkdtemp(join(tmpdir(), 'choir-package-cli-'));
  roots.push(base);
  const root = await realpath(base);
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ type: options.commonjs === true ? 'commonjs' : 'module' }),
  );
  const dir = join(root, 'demo.quiet-choir');
  await mkdir(join(dir, 'workflows'), { recursive: true });
  await writeFile(
    join(dir, 'contracts.ts'),
    `import { z } from ${engine};\nexport const MainInput = z.object({ log: z.string(), marker: z.string().nullable() });\n`,
  );
  await writeFile(join(dir, 'workflows', 'main.ts'), mainSource);
  // A resource and a helper that no module imports: only the whole-directory walk sees them.
  await mkdir(join(dir, 'resources'));
  await writeFile(join(dir, 'resources', 'notes.txt'), 'notes\n');
  await mkdir(join(dir, 'lib'));
  await writeFile(join(dir, 'lib', 'unused.ts'), 'export const unused = 1;\n');
  const otherFile = options.otherCts === true ? 'other.cts' : 'other.ts';
  // A .cts module that an ESM manifest imports is required without tsx's .js to .ts mapping, so
  // it takes the engine from the test process instead of importing it.
  if (options.otherCts === true)
    Object.assign(globalThis, { choirEngine: await import('../src/index.js') });
  await writeFile(
    join(dir, 'workflows', otherFile),
    options.other ??
      (options.otherCts === true
        ? otherSource.replace(
            `import { defineWorkflow, z } from ${engine};`,
            `const { defineWorkflow, z } = (globalThis as unknown as { choirEngine: typeof import(${engine}, { with: { 'resolution-mode': 'import' } }) }).choirEngine;`,
          )
        : otherSource),
  );
  const prompts = options.template !== undefined;
  if (prompts) {
    await mkdir(join(dir, 'prompts'));
    await writeFile(join(dir, 'prompts', 'Review.md'), options.template);
    await writeFile(
      join(dir, 'prompts.ts'),
      `import { join } from 'node:path';
import { definePrompts, z } from ${engine};
export const prompts = definePrompts(join(${options.commonjs === true ? '__dirname' : 'import.meta.dirname'}, 'prompts'), {
  Review: { file: 'Review.md', params: z.object({ title: z.string() }) },
});
`,
    );
  }
  await writeFile(
    join(dir, 'package.ts'),
    `import { definePackage } from ${engine};
import main from './workflows/main.js';
${options.otherCts === true ? "import otherModule from './workflows/other.cjs';" : "import other from './workflows/other.js';"}
${prompts ? "import { prompts } from './prompts.js';\n" : ''}${options.otherCts === true ? 'const other = otherModule.default;\n' : ''}
export default definePackage({
  root: ${options.root ?? (options.commonjs === true ? '__dirname' : 'import.meta.dirname')},
  name: 'demo',
  version: '1',
  description: 'A demo package.',
  whenToUse: 'Trying packages out.',
  workflows: [main, other],
${options.entry === false ? '' : '  entry: main,\n'}${prompts ? '  prompts: [prompts],\n' : ''}});
`,
  );
  const fixtures = join(root, 'fixtures.json');
  await writeFile(
    fixtures,
    JSON.stringify({ version: 1, calls: [{ step: 'review', text: 'reviewed' }] }),
  );
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  const analysis = analyzePackagePath(dir, root);
  if (!analysis.ok) throw new Error(analysis.error.message);
  return {
    root,
    dir,
    fixtures,
    log: join(root, 'first.log'),
    marker: join(root, 'open'),
    typecheck: analysis.typecheck,
    selection: (workflow: string | null): PackageSelection => ({ ...analysis.package, workflow }),
  };
}

type Project = Awaited<ReturnType<typeof project>>;

function executor(lines: string[] = []) {
  return new WorkflowExecutor({
    typecheckCache,
    logger: new ThresholdLogger('warn', (line) => lines.push(line)),
  });
}

async function execute(
  fixture: Project,
  stateDir: string,
  runId: string,
  workflow: string | null,
  extra: Record<string, unknown> = {},
) {
  return executor().execute({
    kind: 'workflow.execute',
    typecheck: fixture.typecheck,
    package: fixture.selection(workflow),
    runId,
    stateDir,
    cwd: fixture.root,
    resume: false,
    harness: await readHarnessSelection(`fixture:${fixture.fixtures}`, undefined, fixture.root),
    input:
      workflow === 'other' ? {} : { log: fixture.log, marker: fixture.marker as string | null },
    ...extra,
  });
}

function json(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

/** The words of a next entry after `workflow`, up to its `--fork-from` or `--state-dir`. */
function commandWords(argv: readonly string[]): string[] {
  const words = argv.slice(argv.indexOf('workflow') + 1);
  const end = words.findIndex((word) => word === '--fork-from' || word === '--state-dir');
  return end === -1 ? words : words.slice(0, end);
}

/** A failure document's `error` (code, message, details) with its `next` entries. */
function failure(stdout: string): Record<string, unknown> {
  const document = json(stdout);
  return { ...(document['error'] as Record<string, unknown>), next: document['next'] };
}

// measured: 3.0 s alone for the first executor case (its full engine compile), 0.2-1.1 s for later
// ones on the shared program cache (dominated by the tsImport compile); coverage slows these
// compiles about 2.5x, so the slowest stays near 8 s.
describe('packages through the executor', { timeout: 60_000 }, () => {
  it('validates the entry and --workflow other, reporting the module and package', async () => {
    const fixture = await project();
    const entry = await executor().execute({
      kind: 'workflow.validate',
      typecheck: fixture.typecheck,
      package: fixture.selection(null),
    });
    expect(entry).toMatchObject({
      kind: 'workflow.validate.result',
      ok: true,
      entrypoint: join(fixture.dir, 'workflows', 'main.ts'),
      package: { root: fixture.dir, name: 'demo', version: '1' },
      workflow: { name: 'main', version: '1' },
    });
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
    const other = await executor().execute({
      kind: 'workflow.validate',
      typecheck: fixture.typecheck,
      package: fixture.selection('other'),
    });
    expect(other).toMatchObject({
      ok: true,
      entrypoint: join(fixture.dir, 'workflows', 'other.ts'),
      workflow: { name: 'other' },
    });
    // The manifest closure is fingerprinted: both validations hash the same files.
    if (entry.kind !== 'workflow.validate.result' || other.kind !== 'workflow.validate.result')
      throw new Error('Expected validate results.');
    expect(Object.keys(entry.workflow.identity?.files ?? {}).sort()).toEqual(
      Object.keys(other.workflow.identity?.files ?? {}).sort(),
    );
    expect(Object.keys(entry.workflow.identity?.files ?? {})).toEqual(
      expect.arrayContaining([
        'demo.quiet-choir/package.ts',
        'demo.quiet-choir/workflows/main.ts',
        'demo.quiet-choir/workflows/other.ts',
      ]),
    );
  });

  it('executes the entry and another workflow, recording the module and the package', async ({
    stateDir,
  }) => {
    const fixture = await project();
    await writeFile(fixture.marker, '');
    const entry = await execute(fixture, stateDir, 'pkg-entry', null);
    expect(entry).toMatchObject({ ok: true, run: { status: 'completed', output: 'main:one' } });
    const record = await readRun({ stateDir, runId: 'pkg-entry' });
    expect(record.launch?.entrypoint).toBe(join(fixture.dir, 'workflows', 'main.ts'));
    expect(record.launch?.package).toEqual({ root: fixture.dir, name: 'demo', version: '1' });
    expect(Object.keys(record.launch?.sources ?? {})).toContain(join(fixture.dir, 'package.ts'));
    const other = await execute(fixture, stateDir, 'pkg-other', 'other');
    expect(other).toMatchObject({
      ok: true,
      run: { status: 'completed', output: 'other:reviewed' },
    });
    expect((await readRun({ stateDir, runId: 'pkg-other' })).launch?.entrypoint).toBe(
      join(fixture.dir, 'workflows', 'other.ts'),
    );
  });

  it('rehearses both forms with --dry-run', async ({ stateDir }) => {
    const fixture = await project();
    await writeFile(fixture.marker, '');
    for (const workflow of [null, 'other'] as const) {
      const result = await execute(fixture, stateDir, `dry-${workflow ?? 'entry'}`, workflow, {
        dryRun: true,
      });
      expect(result, JSON.stringify(result).slice(0, 2000)).toMatchObject({
        ok: true,
        run: { workflow: { name: workflow ?? 'main' } },
        rehearsal: {},
      });
    }
  });

  it('lists the declared names without an entry or for an unknown --workflow', async () => {
    const fixture = await project({ entry: false });
    const required = await executor().execute({
      kind: 'workflow.validate',
      typecheck: fixture.typecheck,
      package: fixture.selection(null),
    });
    expect(required).toMatchObject({
      ok: false,
      code: 'usage.entrypoint',
      details: { reason: 'package_workflow_required', workflows: ['main', 'other'] },
    });
    const unknown = await executor().execute({
      kind: 'workflow.validate',
      typecheck: fixture.typecheck,
      package: fixture.selection('missing'),
    });
    expect(unknown).toMatchObject({
      ok: false,
      code: 'usage.entrypoint',
      details: { reason: 'package_workflow_unknown', workflows: ['main', 'other'] },
    });
    if (unknown.ok) throw new Error('Expected a failure.');
    expect(unknown.message).toContain(
      'declares no workflow missing; its workflows are main, other',
    );
    expect(JSON.parse(JSON.stringify(unknown))).toEqual(unknown);
  });

  it('refuses a manifest whose root is not its own directory, naming both paths', async () => {
    const fixture = await project({ root: "import.meta.dirname + '/workflows'" });
    const result = await executor().execute({
      kind: 'workflow.validate',
      typecheck: fixture.typecheck,
      package: fixture.selection(null),
    });
    expect(result).toMatchObject({ ok: false, code: 'load.definition' });
    if (result.ok) throw new Error('Expected a failure.');
    expect(result.message).toContain(join(fixture.dir, 'workflows'));
    expect(result.message).toContain(`its manifest is in ${fixture.dir}`);
    expect(result.message).toContain('import.meta.dirname');
  });

  it('fails validate on a type error in a workflow that is not selected', async () => {
    const fixture = await project({
      other: `${otherSource}\nconst broken: number = 'not a number';\nexport { broken };\n`,
    });
    const result = await executor().execute({
      kind: 'workflow.validate',
      typecheck: fixture.typecheck,
      package: fixture.selection('main'),
    });
    expect(result).toMatchObject({ ok: false, code: 'load.typecheck' });
    if (result.ok) throw new Error('Expected a failure.');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filePath: join(fixture.dir, 'workflows', 'other.ts') }),
      ]),
    );
  });

  it('refuses a workflow that is not the default export of a module in the package', async () => {
    const fixture = await project({
      other: otherSource.replace(
        'export default defineWorkflow',
        'export const other = defineWorkflow',
      ),
    });
    await writeFile(
      join(fixture.dir, 'package.ts'),
      (await readFile(join(fixture.dir, 'package.ts'), 'utf8')).replace(
        "import other from './workflows/other.js';",
        "import { other } from './workflows/other.js';",
      ),
    );
    const result = await executor().execute({
      kind: 'workflow.validate',
      typecheck: fixture.typecheck,
      package: fixture.selection('other'),
    });
    expect(result, JSON.stringify(result).slice(0, 2000)).toMatchObject({
      ok: false,
      code: 'load.definition',
    });
    if (result.ok) throw new Error('Expected a failure.');
    expect(result.message).toContain('no TypeScript module under');
    expect(result.message).toContain('default-exports workflow other');
  });

  it('checks package-level prompt sets and fails on an invalid template', async () => {
    const lines: string[] = [];
    const good = await project({ template: 'Review {{ title }}.\n' });
    const valid = await executor(lines).execute({
      kind: 'workflow.validate',
      typecheck: good.typecheck,
      package: good.selection(null),
    });
    expect(valid).toMatchObject({ ok: true });
    if (valid.kind !== 'workflow.validate.result') throw new Error('Expected a result.');
    expect(Object.keys(valid.workflow.identity?.files ?? {})).toContain(
      'demo.quiet-choir/prompts/Review.md',
    );
    const unused = await project({ template: 'Review.\n' });
    await executor(lines).execute({
      kind: 'workflow.validate',
      typecheck: unused.typecheck,
      package: unused.selection(null),
    });
    expect(lines).toContain(
      '[warn] Prompt Review (Review.md): parameter title is never read by the template or its includes',
    );
    const bad = await project({ template: '{{ title }}{% include title %}' });
    const result = await executor().execute({
      kind: 'workflow.validate',
      typecheck: bad.typecheck,
      package: bad.selection(null),
    });
    expect(result).toMatchObject({ ok: false, code: 'load.definition' });
    if (result.ok) throw new Error('Expected a failure.');
    expect(result.message).toContain('Package demo prompt templates failed their load-time checks');
    expect(result.message).toContain('{% include title %} has a computed');
  });

  it('refuses a package-level template edit between execute and resume as a code change', async ({
    stateDir,
  }) => {
    const fixture = await project({ template: 'Review {{ title }}.\n' });
    const first = await execute(fixture, stateDir, 'pkg-template', null);
    expect(first).toMatchObject({ ok: false, code: 'workflow.failed' });
    await writeFile(join(fixture.dir, 'prompts', 'Review.md'), 'Review {{ title }} again.\n');
    await writeFile(fixture.marker, '');
    const resumed = await executor().execute({
      kind: 'workflow.resume',
      runId: 'pkg-template',
      stateDir,
      harness: await readHarnessSelection(`fixture:${fixture.fixtures}`, undefined, fixture.root),
    });
    expect(resumed).toMatchObject({ ok: false, code: 'run.incompatible' });
    if (resumed.ok) throw new Error('Expected a refusal.');
    expect(resumed.details).toMatchObject({ changed: ['code'], canAcceptCodeChange: true });
  });

  it('resumes by run ID through the manifest, reusing the completed step', async ({ stateDir }) => {
    const fixture = await project();
    const first = await execute(fixture, stateDir, 'pkg-resume', null);
    expect(first).toMatchObject({ ok: false, code: 'workflow.failed' });
    await writeFile(fixture.marker, '');
    const resumed = await executor().execute({
      kind: 'workflow.resume',
      runId: 'pkg-resume',
      stateDir,
      harness: await readHarnessSelection(`fixture:${fixture.fixtures}`, undefined, fixture.root),
    });
    expect(resumed).toMatchObject({ ok: true, run: { status: 'completed', output: 'main:one' } });
    expect(await readFile(fixture.log, 'utf8')).toBe('first\n');
  });

  it('checks resume in both forms, defaulting to the run workflow', async ({ stateDir }) => {
    const fixture = await project();
    await writeFile(fixture.marker, '');
    await execute(fixture, stateDir, 'pkg-check', 'other');
    for (const workflow of [null, 'other'] as const) {
      const result = await executor().execute({
        kind: 'workflow.check-resume',
        typecheck: fixture.typecheck,
        package: fixture.selection(workflow),
        runId: 'pkg-check',
        stateDir,
        cwd: fixture.root,
      });
      expect(result).toMatchObject({
        kind: 'workflow.check-resume.result',
        ok: true,
        check: { compatible: true },
      });
    }
  });

  it('selects a CommonJS workflow an ESM manifest imports by default interop', async ({
    stateDir,
  }) => {
    const fixture = await project({ otherCts: true });
    const result = await execute(fixture, stateDir, 'esm-cts', 'other');
    expect(result, JSON.stringify(result).slice(0, 2000)).toMatchObject({
      ok: true,
      run: { status: 'completed', output: 'other:reviewed' },
    });
    expect((await readRun({ stateDir, runId: 'esm-cts' })).launch?.entrypoint).toBe(
      join(fixture.dir, 'workflows', 'other.cts'),
    );
  });

  it('refuses check-resume of a package run from a module or another package', async ({
    stateDir,
  }) => {
    const fixture = await project();
    const other = await project();
    await writeFile(fixture.marker, '');
    await execute(fixture, stateDir, 'pkg-check-refuse', 'other');
    const analysis = analyzeTypecheckEntrypoint(
      join(fixture.dir, 'workflows', 'other.ts'),
      fixture.root,
    );
    if (!analysis.ok) throw new Error('Expected a TypeScript source.');
    const module = analysis.plan;
    for (const [typecheck, selection] of [
      [module, undefined],
      [other.typecheck, other.selection('other')],
    ] as const) {
      const result = await executor().execute({
        kind: 'workflow.check-resume',
        typecheck,
        ...(selection === undefined ? {} : { package: selection }),
        runId: 'pkg-check-refuse',
        stateDir,
        cwd: fixture.root,
        acceptCodeChange: true,
      });
      expect(result).toMatchObject({ ok: false, code: 'run.incompatible' });
    }
  });

  it('resumes a suspended package run from tick through the manifest', async ({ stateDir }) => {
    const fixture = await project({
      other: `import { defineWorkflow, z } from ${engine};
export default defineWorkflow({
  name: 'other',
  version: '1',
  input: z.object({}),
  output: z.string(),
  async run(ctx) {
    await ctx.sleep('nap', 60_000);
    return 'other:woke';
  },
});
`,
    });
    // The run sleeps two minutes in the past, so its wake-up is already due for tick's real clock.
    const clock: WorkflowClock = {
      now: () => Date.now() - 120_000,
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('Clock cancelled'));
          });
        }),
    };
    const logger = new ThresholdLogger('silent', () => undefined);
    const suspended = await new WorkflowExecutor({ typecheckCache, logger, clock }).execute({
      kind: 'workflow.execute',
      typecheck: fixture.typecheck,
      package: fixture.selection('other'),
      runId: 'pkg-tick',
      stateDir,
      cwd: fixture.root,
      resume: false,
      input: {},
    });
    expect(suspended).toMatchObject({ ok: true, run: { status: 'suspended' } });
    const ticked = await new TickWorkflowExecutor({ typecheckCache, logger }).execute({
      kind: 'workflow.tick',
      runId: 'pkg-tick',
      stateDir,
    });
    expect(ticked).toMatchObject({
      ok: true,
      resumed: [{ runId: 'pkg-tick', outcome: 'completed' }],
    });
    const record = await readRun({ stateDir, runId: 'pkg-tick' });
    expect(record).toMatchObject({ status: 'completed', output: 'other:woke' });
    expect(record.launch?.package).toEqual({ root: fixture.dir, name: 'demo', version: '1' });
  });

  it('runs a CommonJS package, entry and --workflow other', async ({ stateDir }) => {
    const fixture = await project({ commonjs: true });
    await writeFile(fixture.marker, '');
    const entry = await execute(fixture, stateDir, 'cjs-entry', null);
    expect(entry).toMatchObject({ ok: true, run: { status: 'completed', output: 'main:one' } });
    expect((await readRun({ stateDir, runId: 'cjs-entry' })).launch?.entrypoint).toBe(
      join(fixture.dir, 'workflows', 'main.ts'),
    );
    const other = await execute(fixture, stateDir, 'cjs-other', 'other');
    expect(other, JSON.stringify(other).slice(0, 2000)).toMatchObject({
      ok: true,
      run: { status: 'completed', output: 'other:reviewed' },
    });
  });

  it('re-evaluates a CommonJS package workflow edited between runs in one process', async ({
    stateDir,
  }) => {
    const fixture = await project({ commonjs: true });
    const before = await execute(fixture, stateDir, 'cjs-before', 'other');
    expect(before).toMatchObject({ ok: true, run: { output: 'other:reviewed' } });
    const otherFile = join(fixture.dir, 'workflows', 'other.ts');
    await writeFile(
      otherFile,
      (await readFile(otherFile, 'utf8')).replace(
        '`other:${reply.output}`',
        '`edited:${reply.output}`',
      ),
    );
    const after = await execute(fixture, stateDir, 'cjs-after', 'other');
    expect(after).toMatchObject({ ok: true, run: { output: 'edited:reviewed' } });
  });

  it('re-evaluates a .cts workflow edited between runs under an ESM manifest in one process', async ({
    stateDir,
  }) => {
    const fixture = await project({ otherCts: true });
    const before = await execute(fixture, stateDir, 'esm-cts-before', 'other');
    expect(before).toMatchObject({ ok: true, run: { output: 'other:reviewed' } });
    const otherFile = join(fixture.dir, 'workflows', 'other.cts');
    await writeFile(
      otherFile,
      (await readFile(otherFile, 'utf8')).replace(
        '`other:${reply.output}`',
        '`edited:${reply.output}`',
      ),
    );
    const after = await execute(fixture, stateDir, 'esm-cts-after', 'other');
    expect(after).toMatchObject({ ok: true, run: { output: 'edited:reviewed' } });
  });
});

// measured: 15.5 s alone for the slowest CLI case, which runs seven commands that each compile the
// engine from scratch (the CLI passes no program cache), 2.2-13.4 s for the others; about 2.5x that
// under coverage, hence the 120 s budget.
describe('packages through the CLI', { timeout: 120_000 }, () => {
  it('executes the entry and --workflow other, then inspects and lists them', async ({
    cli,
    stateDir,
  }) => {
    const fixture = await project();
    await writeFile(fixture.marker, '');
    const harness = ['--harness', `fixture:${fixture.fixtures}`, '--state-dir', stateDir];
    const input = JSON.stringify({ log: fixture.log, marker: fixture.marker });
    const entry = await cli.run(WorkflowExecute, [
      fixture.dir,
      ...harness,
      '--run-id',
      'cli-entry',
      '--input',
      input,
      '--json',
    ]);
    expect(entry.error, entry.stderr).toBeUndefined();
    expect(json(entry.stdout)).toMatchObject({ ok: true, status: 'completed', output: 'main:one' });
    const other = await cli.run(WorkflowExecute, [
      `${fixture.dir}/`,
      '--workflow',
      'other',
      ...harness,
      '--run-id',
      'cli-other',
      '--json',
    ]);
    expect(other.error, other.stderr).toBeUndefined();
    expect(json(other.stdout)).toMatchObject({ ok: true, output: 'other:reviewed' });
    const pkg = { root: fixture.dir, name: 'demo', version: '1' };
    const summary = await cli.run(WorkflowInspect, [
      'cli-other',
      '--state-dir',
      stateDir,
      '--summary',
      '--json',
    ]);
    expect(json(summary.stdout)).toMatchObject({ package: pkg, workflow: { name: 'other' } });
    const human = await cli.run(WorkflowInspect, ['cli-other', '--state-dir', stateDir]);
    expect(human.stdout).toContain('Run cli-other: completed  demo/other@1');
    expect(human.stdout).toContain(`Package: demo@1 at ${fixture.dir}`);
    const rows = await cli.run(WorkflowList, ['--state-dir', stateDir]);
    expect(rows.stdout).toMatch(/cli-other {2}demo\/other@1 {2}/u);
    expect(rows.stdout).toMatch(/cli-entry {2}demo\/main@1 {2}/u);
    const listed = json((await cli.run(WorkflowList, ['--state-dir', stateDir, '--json'])).stdout);
    expect(listed['runs']).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'cli-other', package: pkg })]),
    );
  });

  it('runs an ESM package whose manifest imports a .cts workflow', async ({ cli, stateDir }) => {
    const fixture = await project({ otherCts: true });
    const ran = await cli.run(WorkflowExecute, [
      fixture.dir,
      '--workflow',
      'other',
      '--harness',
      `fixture:${fixture.fixtures}`,
      '--state-dir',
      stateDir,
      '--run-id',
      'cli-cts',
      '--json',
    ]);
    expect(ran.error, ran.stderr).toBeUndefined();
    expect(json(ran.stdout)).toMatchObject({ status: 'completed', output: 'other:reviewed' });
    expect((await readRun({ stateDir, runId: 'cli-cts' })).launch?.entrypoint).toBe(
      join(fixture.dir, 'workflows', 'other.cts'),
    );
  });

  it('validates, rehearses and checks resume in both forms', async ({ cli, stateDir }) => {
    const fixture = await project();
    const validated = await cli.run(WorkflowValidate, [fixture.dir, '--json']);
    expect(validated.error, validated.stderr).toBeUndefined();
    expect(json(validated.stdout)).toMatchObject({
      entrypoint: join(fixture.dir, 'workflows', 'main.ts'),
      package: { root: fixture.dir, name: 'demo', version: '1' },
      workflow: { name: 'main' },
    });
    const human = await cli.run(WorkflowValidate, [fixture.dir, '--workflow', 'other']);
    expect(human.stdout).toContain(
      `Validated demo/other@1 (package demo@1, ${join(fixture.dir, 'workflows', 'other.ts')}).`,
    );
    const rehearsal = await cli.run(WorkflowExecute, [
      fixture.dir,
      '--workflow',
      'other',
      '--dry-run',
      '--state-dir',
      stateDir,
      '--json',
    ]);
    expect(rehearsal.error, rehearsal.stderr).toBeUndefined();
    expect(json(rehearsal.stdout)).toMatchObject({
      ok: true,
      run: { workflow: { name: 'other' } },
    });
    const ran = await cli.run(WorkflowExecute, [
      fixture.dir,
      '--workflow',
      'other',
      '--harness',
      `fixture:${fixture.fixtures}`,
      '--state-dir',
      stateDir,
      '--run-id',
      'cli-check',
      '--json',
    ]);
    expect(ran.error, ran.stderr).toBeUndefined();
    for (const argv of [[], ['--workflow', 'other']]) {
      const checked = await cli.run(WorkflowCheckResume, [
        fixture.dir,
        ...argv,
        '--run-id',
        'cli-check',
        '--state-dir',
        stateDir,
        '--json',
      ]);
      expect(checked.error, checked.stderr).toBeUndefined();
      expect(json(checked.stdout)).toMatchObject({ ok: true, check: { compatible: true } });
    }
    const typechecked = await cli.run(WorkflowTypecheck, [fixture.dir, '--json']);
    expect(json(typechecked.stdout)).toMatchObject({
      ok: true,
      entrypoint: join(fixture.dir, 'package.ts'),
    });
  });

  it('resumes by ID and with --resume, and refuses mismatched launch modes', async ({
    cli,
    stateDir,
  }) => {
    const fixture = await project();
    const input = JSON.stringify({ log: fixture.log, marker: fixture.marker });
    const common = ['--state-dir', stateDir, '--json'];
    for (const runId of ['cli-a', 'cli-b', 'cli-c']) {
      const failed = await cli.run(WorkflowExecute, [
        fixture.dir,
        '--run-id',
        runId,
        '--input',
        input,
        ...common,
      ]);
      expect(failed.error).toMatchObject({ oclif: { exit: 1 } });
    }
    await writeFile(fixture.marker, '');
    // A plain module FILE on a package run is refused, with resume and fork entries.
    const module = await cli.run(WorkflowExecute, [
      join(fixture.dir, 'workflows', 'main.ts'),
      '--resume',
      '--run-id',
      'cli-a',
      ...common,
    ]);
    const refusal = failure(module.stdout);
    expect(refusal).toMatchObject({
      code: 'run.incompatible',
      details: {
        storedEntrypoint: join(fixture.dir, 'workflows', 'main.ts'),
        requestedEntrypoint: join(fixture.dir, 'workflows', 'main.ts'),
      },
    });
    const next = refusal['next'] as { argv: string[] }[];
    expect(next.map((entry) => commandWords(entry.argv))).toEqual([
      ['resume', 'cli-a'],
      ['execute', join(fixture.dir, 'workflows', 'main.ts')],
    ]);
    const byId = await cli.run(WorkflowResume, ['cli-a', ...common]);
    expect(byId.error, byId.stderr).toBeUndefined();
    expect(json(byId.stdout)).toMatchObject({ status: 'completed', output: 'main:one' });
    const flag = await cli.run(WorkflowExecute, ['--resume', '--run-id', 'cli-b', ...common]);
    expect(flag.error, flag.stderr).toBeUndefined();
    expect(json(flag.stdout)).toMatchObject({ status: 'completed' });
    // The package path without --workflow resumes the run's own workflow.
    const withPath = await cli.run(WorkflowExecute, [
      fixture.dir,
      '--resume',
      '--run-id',
      'cli-c',
      ...common,
    ]);
    expect(withPath.error, withPath.stderr).toBeUndefined();
    expect(json(withPath.stdout)).toMatchObject({ status: 'completed' });
    expect(await readFile(fixture.log, 'utf8')).toBe('first\nfirst\nfirst\n');
    // --workflow without FILE is a usage error.
    const flagOnly = await cli.run(WorkflowExecute, [
      '--resume',
      '--run-id',
      'cli-b',
      '--workflow',
      'main',
      ...common,
    ]);
    expect(failure(flagOnly.stdout)).toMatchObject({ code: 'usage.flag' });
  });

  it('refuses a package resume of a single-module run', async ({ cli, stateDir }) => {
    const fixture = await project();
    const single = join(fixture.root, 'single.workflow.ts');
    await writeFile(
      single,
      `import { defineWorkflow, z } from ${engine};
export default defineWorkflow({ name: 'main', version: '1', input: z.object({}), output: z.null(), async run(ctx) { await ctx.step('fail', { input: null, schema: z.null(), run: () => { throw new Error('stop'); } }); return null; } });
`,
    );
    const failed = await cli.run(WorkflowExecute, [
      single,
      '--run-id',
      'single',
      '--state-dir',
      stateDir,
      '--json',
    ]);
    expect(failed.error).toMatchObject({ oclif: { exit: 1 } });
    const refused = await cli.run(WorkflowExecute, [
      fixture.dir,
      '--resume',
      '--run-id',
      'single',
      '--state-dir',
      stateDir,
      '--json',
    ]);
    const document = failure(refused.stdout);
    expect(document).toMatchObject({
      code: 'run.incompatible',
      details: {
        storedEntrypoint: single,
        requestedEntrypoint: fixture.dir,
        requestedPackage: fixture.dir,
        requestedWorkflow: 'main',
      },
    });
    const next = document['next'] as { argv: string[] }[];
    expect(next.map((entry) => commandWords(entry.argv))).toEqual([
      ['resume', 'single'],
      ['execute', fixture.dir, '--workflow', 'main'],
    ]);
  });

  it('refuses bad package paths and --workflow with a module FILE', async ({ cli, stateDir }) => {
    const fixture = await project();
    const mjs = join(fixture.root, 'js.quiet-choir');
    await mkdir(mjs);
    await writeFile(join(mjs, 'package.mjs'), 'export default {};\n');
    const refusedMjs = await cli.run(WorkflowExecute, [mjs, '--state-dir', stateDir, '--json']);
    expect(refusedMjs.error).toMatchObject({ oclif: { exit: 2 } });
    const mjsDocument = failure(refusedMjs.stdout);
    expect(mjsDocument).toMatchObject({
      code: 'usage.entrypoint',
      details: { reason: 'JAVASCRIPT_PACKAGE_MANIFEST' },
    });
    expect(mjsDocument['message']).toContain('package.ts');
    const empty = join(fixture.root, 'empty.quiet-choir');
    await mkdir(empty);
    const missing = await cli.run(WorkflowValidate, [empty, '--json']);
    expect(failure(missing.stdout)).toMatchObject({ code: 'usage.file_not_found' });
    const absent = await cli.run(WorkflowExecute, [
      'absent.quiet-choir',
      '--state-dir',
      stateDir,
      '--json',
    ]);
    expect(failure(absent.stdout)).toMatchObject({ code: 'usage.file_not_found' });
    const module = await cli.run(WorkflowValidate, [
      join(fixture.dir, 'workflows', 'main.ts'),
      '--workflow',
      'main',
      '--json',
    ]);
    expect(module.error).toMatchObject({ oclif: { exit: 2 } });
    expect(failure(module.stdout)).toMatchObject({ code: 'usage.flag' });
    const unknown = await cli.run(WorkflowValidate, [fixture.dir, '--workflow', 'nope', '--json']);
    expect(unknown.error).toMatchObject({ oclif: { exit: 2 } });
    expect(failure(unknown.stdout)).toMatchObject({
      code: 'usage.entrypoint',
      details: { reason: 'package_workflow_unknown', workflows: ['main', 'other'] },
    });
    const manifest = await cli.run(WorkflowValidate, [join(fixture.dir, 'package.ts'), '--json']);
    expect(failure(manifest.stdout)).toMatchObject({ code: 'load.definition' });
    expect(failure(manifest.stdout)['message']).toContain(
      'is a package manifest; pass its .quiet-choir directory',
    );
  });
});

/** Resume a package run by ID with the project's fixture harness. */
async function resume(fixture: Project, stateDir: string, runId: string, acceptCodeChange = false) {
  return executor().execute({
    kind: 'workflow.resume',
    runId,
    stateDir,
    harness: await readHarnessSelection(`fixture:${fixture.fixtures}`, undefined, fixture.root),
    ...(acceptCodeChange ? { acceptCodeChange } : {}),
  });
}

// Whole-directory fingerprinting and the validate package section (ADR 0065 sections 4-5, #585).
// measured: 0.4-1.6 s each in a two-file local run without coverage (dominated by the tsImport
// compiles on the shared program cache); about 2.5x that under coverage.
describe('package fingerprints and the validate package section', { timeout: 60_000 }, () => {
  it.for(['resources/notes.txt', 'lib/unused.ts'])(
    'refuses an edit to %s between execute and resume as a code change',
    async (file, { stateDir }) => {
      const fixture = await project();
      const first = await execute(fixture, stateDir, 'pkg-walk', null);
      expect(first).toMatchObject({ ok: false, code: 'workflow.failed' });
      const sources = Object.keys(
        (await readRun({ stateDir, runId: 'pkg-walk' })).launch?.sources ?? {},
      );
      expect(sources).toEqual(
        expect.arrayContaining([
          join(fixture.dir, 'resources', 'notes.txt'),
          join(fixture.dir, 'lib', 'unused.ts'),
        ]),
      );
      await writeFile(join(fixture.dir, ...file.split('/')), 'edited\n');
      await writeFile(fixture.marker, '');
      const refused = await resume(fixture, stateDir, 'pkg-walk');
      expect(refused).toMatchObject({
        ok: false,
        code: 'run.incompatible',
        details: { changed: ['code'], canAcceptCodeChange: true },
      });
      const checked = await executor().execute({
        kind: 'workflow.check-resume',
        typecheck: fixture.typecheck,
        package: fixture.selection(null),
        runId: 'pkg-walk',
        stateDir,
        cwd: fixture.root,
      });
      expect(checked).toMatchObject({
        ok: false,
        code: 'run.incompatible',
        details: { changed: ['code'], canAcceptCodeChange: true },
      });
      const accepted = await resume(fixture, stateDir, 'pkg-walk', true);
      expect(accepted, JSON.stringify(accepted).slice(0, 2000)).toMatchObject({
        ok: true,
        run: { status: 'completed', output: 'main:one' },
      });
      expect(await readFile(fixture.log, 'utf8')).toBe('first\n');
    },
  );

  it('leaves node_modules, .git and symlinks inside the package out of the fingerprint', async ({
    stateDir,
  }) => {
    const fixture = await project();
    const ignoredFiles = [
      join(fixture.dir, 'node_modules', 'dep', 'index.js'),
      join(fixture.dir, 'resources', 'node_modules', 'nested.txt'),
      join(fixture.dir, '.git', 'HEAD'),
    ];
    for (const file of ignoredFiles) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, 'before\n');
    }
    await symlink(join(fixture.dir, 'resources', 'notes.txt'), join(fixture.dir, 'link.txt'));
    await symlink(join(fixture.dir, 'resources'), join(fixture.dir, 'linked-resources'));
    const first = await execute(fixture, stateDir, 'pkg-ignored', null);
    expect(first).toMatchObject({ ok: false, code: 'workflow.failed' });
    const sources = Object.keys(
      (await readRun({ stateDir, runId: 'pkg-ignored' })).launch?.sources ?? {},
    );
    expect(sources).toContain(join(fixture.dir, 'resources', 'notes.txt'));
    for (const path of [
      ...ignoredFiles,
      join(fixture.dir, 'link.txt'),
      join(fixture.dir, 'linked-resources', 'notes.txt'),
    ])
      expect(sources).not.toContain(path);
    for (const file of ignoredFiles) await writeFile(file, 'after\n');
    await writeFile(fixture.marker, '');
    const resumed = await resume(fixture, stateDir, 'pkg-ignored');
    expect(resumed, JSON.stringify(resumed).slice(0, 2000)).toMatchObject({
      ok: true,
      run: { status: 'completed' },
    });
  });

  it('warns once about a package above the size threshold, naming its largest files', async () => {
    const small: string[] = [];
    const fixture = await project();
    expect(
      await executor(small).execute({
        kind: 'workflow.validate',
        typecheck: fixture.typecheck,
        package: fixture.selection(null),
      }),
    ).toMatchObject({ ok: true });
    expect(small.filter((line) => line.includes('warning threshold'))).toEqual([]);
    await writeFile(
      join(fixture.dir, 'resources', 'big.bin'),
      Buffer.alloc(PACKAGE_SIZE_WARNING_BYTES + 1),
    );
    const lines: string[] = [];
    expect(
      await executor(lines).execute({
        kind: 'workflow.validate',
        typecheck: fixture.typecheck,
        package: fixture.selection(null),
      }),
    ).toMatchObject({ ok: true });
    const warnings = lines.filter((line) => line.includes('warning threshold'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^\[warn\] Package demo holds 10\.0 MiB in \d+ files, above the 10\.0 MiB warning threshold; every resume hashes all of them\. Largest: resources\/big\.bin \(10\.0 MiB\), /u,
    );
  });

  it('fails validate on a broken template in a workflow that is not selected', async () => {
    const fixture = await project({ other: rosterOther(true) });
    await mkdir(join(fixture.dir, 'other-prompts'));
    await writeFile(join(fixture.dir, 'other-prompts', 'Bad.md'), '{{ missing }}\n');
    const result = await executor().execute({
      kind: 'workflow.validate',
      typecheck: fixture.typecheck,
      package: fixture.selection('main'),
    });
    expect(result).toMatchObject({ ok: false, code: 'load.definition' });
    if (result.ok) throw new Error('Expected a failure.');
    expect(result.message).toContain('Package demo workflow other');
    expect(result.message).toContain('reads variable missing');
  });
});

// measured: 4.6-4.7 s each in a two-file local run without coverage, since every command compiles
// the engine from scratch (the CLI passes no program cache); about 2.5x that under coverage.
describe('package sections and registry names through the CLI', { timeout: 120_000 }, () => {
  it('pins the package section of validate --json, independent of the package location', async ({
    cli,
  }) => {
    const fixture = await project({ other: rosterOther(), template: 'Review {{ title }}.\n' });
    const validated = await cli.run(WorkflowValidate, [fixture.dir, '--json']);
    expect(validated.error, validated.stderr).toBeUndefined();
    const document = json(validated.stdout);
    expect(document['package']).toEqual({
      root: fixture.dir,
      name: 'demo',
      version: '1',
      description: 'A demo package.',
      whenToUse: 'Trying packages out.',
      entry: 'main',
      workflows: [
        {
          name: 'main',
          version: '1',
          description: null,
          whenToUse: null,
          entrypoint: join(fixture.dir, 'workflows', 'main.ts'),
          inputSchema: expect.any(Object) as unknown,
          roster: [],
        },
        {
          name: 'other',
          version: '1',
          description: 'Review the change.',
          whenToUse: null,
          entrypoint: join(fixture.dir, 'workflows', 'other.ts'),
          inputSchema: expect.any(Object) as unknown,
          roster: [
            {
              name: 'Reviewer',
              harness: 'claude',
              access: 'none',
              model: 'sonnet',
              description: 'Reviews the change.',
            },
          ],
        },
      ],
      prompts: [
        {
          root: join(fixture.dir, 'prompts'),
          entries: [
            {
              name: 'Review',
              file: 'Review.md',
              description: null,
              params: ['title'],
              variables: ['title'],
            },
          ],
        },
      ],
      // package.ts, contracts.ts, prompts.ts, prompts/Review.md, both workflows, the resource and
      // the un-imported helper.
      files: {
        count: 8,
        bytes: expect.any(Number) as unknown,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown,
      },
    });
    // The top-level workflow stays compact; the human line is unchanged.
    expect(document['workflow']).not.toHaveProperty('entrypoint');
    // The same package elsewhere has the same file digest.
    const moved = await project();
    await rm(moved.dir, { recursive: true });
    await cp(fixture.dir, moved.dir, { recursive: true });
    const copied = await cli.run(WorkflowValidate, [moved.dir, '--json']);
    expect(copied.error, copied.stderr).toBeUndefined();
    const files = (document['package'] as { files: unknown }).files;
    expect((json(copied.stdout)['package'] as { files: unknown }).files).toEqual(files);
  });

  it('lists package workflows and runs one by <package>/<workflow> without --registry-dir', async ({
    cli,
    stateDir,
  }) => {
    const fixture = await project();
    const listed = await cli.run(WorkflowListDefinitions, [fixture.root]);
    expect(listed.error, listed.stderr).toBeUndefined();
    expect(listed.stdout).toContain(
      `demo/main@1\t${join(fixture.dir, 'workflows', 'main.ts')}\tpackage demo@1: A demo package.`,
    );
    expect(listed.stdout).toContain(
      `demo/other@1\t${join(fixture.dir, 'workflows', 'other.ts')}\t`,
    );
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(fixture.root);
    try {
      const ran = await cli.run(WorkflowExecute, [
        'demo/other',
        '--harness',
        `fixture:${fixture.fixtures}`,
        '--state-dir',
        stateDir,
        '--run-id',
        'by-name',
        '--json',
      ]);
      expect(ran.error, ran.stderr).toBeUndefined();
      expect(json(ran.stdout)).toMatchObject({ status: 'completed', output: 'other:reviewed' });
      const missing = await cli.run(WorkflowExecute, [
        'demo/missing',
        '--state-dir',
        stateDir,
        '--json',
      ]);
      expect(failure(missing.stdout)).toMatchObject({
        code: 'load.definition',
        message: expect.stringContaining('treated as a registered name') as unknown,
      });
    } finally {
      cwd.mockRestore();
    }
    expect((await readRun({ stateDir, runId: 'by-name' })).launch?.package).toEqual({
      root: fixture.dir,
      name: 'demo',
      version: '1',
    });
  });
});
