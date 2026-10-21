// Prompt checks through the CLI loader (ADR 0064 section 3, #581): workflow validate, list-defs and
// the execute preflight import the workflow through tsx, so the prompt set is built by the
// workflow's own copy of quiet-choir and read here by its brand.
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, vi } from 'vitest';

import { ThresholdLogger } from '../src/application/execution.js';
import { readRun } from '../src/index.js';
import WorkflowValidate from '../src/commands/workflow/validate.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { readHarnessSelection } from '../src/workflow/loader/harness-selection.js';
import { withPromptSources } from '../src/workflow/loader/source.js';
import { digest } from '../src/workflow/runtime/json.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { TypecheckProgramCache } from '../src/workflow/typecheck/program-cache.js';
import { it } from './setup/cli-capture.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const typecheckCache = new TypecheckProgramCache();
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const goodTemplate = '---\ndescription: Review one title.\n---\nReview {{ title }}.\n';

/** A project with `review.workflow.ts` over `prompts/Review.md`, whose schema has an unused key. */
async function project(template = goodTemplate) {
  const root = await mkdtemp(join(tmpdir(), 'choir-prompts-cli-'));
  roots.push(root);
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await mkdir(join(root, 'prompts'));
  await writeFile(join(root, 'prompts', 'Review.md'), template);
  const file = join(root, 'review.workflow.ts');
  await writeFile(
    file,
    `import { definePrompts, defineWorkflow, z } from ${JSON.stringify(join(repository, 'src/index.js'))};
const prompts = definePrompts(${JSON.stringify(join(root, 'prompts'))}, {
  Review: { file: 'Review.md', params: z.object({ title: z.string(), unused: z.string() }) },
});
export default defineWorkflow({
  name: 'review',
  version: '1',
  input: z.null(),
  output: z.string(),
  prompts: [prompts],
  async run(ctx) {
    const reply = await ctx.claude.text('review', { prompt: prompts.Review({ title: 'T', unused: 'u' }) });
    return reply.output;
  },
});
`,
  );
  await writeFile(
    join(root, 'fixtures.json'),
    JSON.stringify({ version: 1, calls: [{ step: 'review', text: 'reviewed' }] }),
  );
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  const analysis = analyzeTypecheckEntrypoint(file, root);
  if (!analysis.ok) throw new Error('invalid workflow fixture');
  return { root, file, typecheck: analysis.plan };
}

function executor(lines: string[] = []) {
  return new WorkflowExecutor({
    typecheckCache,
    logger: new ThresholdLogger('warn', (line) => lines.push(line)),
  });
}

const warning =
  'Prompt Review (Review.md): parameter unused is never read by the template or its includes';

// measured: 1.4 s for the first case alone (its full engine compile), 0.2-0.6 s for later ones,
// 4.9 s worst case in the full coverage run (dominated by the first tsImport compile). The validate
// command case builds two projects and took 14.4 s on CI's Node 22.13 leg and over 30 s on a loaded
// Node 24 coverage shard, hence the 60 s budget.
describe('prompt checks in the CLI loader', { timeout: 60_000 }, () => {
  it('validates, publishes prompts with warnings and logs each warning', async () => {
    const { typecheck } = await project();
    const lines: string[] = [];
    const result = await executor(lines).execute({ kind: 'workflow.validate', typecheck });
    if (result.kind !== 'workflow.validate.result') throw new Error(JSON.stringify(result));
    expect(result.workflow.prompts).toEqual([
      {
        root: expect.stringMatching(/prompts$/u) as unknown,
        entries: [
          {
            name: 'Review',
            file: 'Review.md',
            description: 'Review one title.',
            variables: ['title'],
            warnings: [warning],
          },
        ],
      },
    ]);
    expect(lines).toContain(`[warn] ${warning}`);
  });

  it.for([
    ['an undeclared variable', 'Review {{ title }} by {{ author }}', 'reads variable author'],
    ['a computed include', '{{ title }}{% include title %}', '{% include title %} has a computed'],
    ['ignore missing', '{{ title }}{% include "x.md" ignore missing %}', 'uses ignore missing'],
    ['the random filter', '{{ title | random }}', 'uses the random filter'],
    ['randrange', '{{ title }}{{ randrange(3) }}', 'names randrange'],
    ['lipsum', '{{ title }}{{ lipsum(1) }}', 'names lipsum'],
  ] as const)('fails validate on %s', async ([, template, construct]) => {
    const { typecheck } = await project(template);
    const result = await executor().execute({ kind: 'workflow.validate', typecheck });
    expect(result).toMatchObject({ ok: false, code: 'load.definition' });
    if (result.ok) throw new Error('Expected a failure.');
    expect(result.message).toContain(
      'Workflow review prompt templates failed their load-time checks',
    );
    expect(result.message).toContain('Prompt Review (Review.md): ');
    expect(result.message).toContain(construct);
  });

  it('reports the prompts section and exit code through the validate command', async ({ cli }) => {
    const good = await project();
    const ok = await cli.run(WorkflowValidate, [good.file, '--json']);
    expect(ok.error).toBeUndefined();
    const document = JSON.parse(ok.stdout) as { workflow: { prompts: unknown } };
    expect(document.workflow.prompts).toMatchObject([{ entries: [{ warnings: [warning] }] }]);
    expect(ok.stderr).toContain(warning);
    const bad = await project('{{ nope }}');
    const failed = await cli.run(WorkflowValidate, [bad.file]);
    expect(failed.error).toMatchObject({ oclif: { exit: 4 } });
    // The command's error carries the message oclif prints to stderr.
    expect((failed.error as Error).message).toContain(
      'Prompt Review (Review.md): reads variable nope',
    );
  });

  it('lists the same prompts section, invalidated by a template edit', async () => {
    const { root, typecheck } = await project();
    const engine = executor();
    const validated = await engine.execute({ kind: 'workflow.validate', typecheck });
    if (validated.kind !== 'workflow.validate.result') throw new Error('Expected validation.');
    const plan = { kind: 'workflow.list-defs' as const, directories: [root] };
    const listed = await engine.execute(plan);
    if (listed.kind !== 'workflow.list-defs.result') throw new Error(JSON.stringify(listed));
    expect(listed.definitions[0]?.workflow.prompts).toEqual(validated.workflow.prompts);
    // Served from the cache, then revalidated after a template edit without --refresh.
    expect(await engine.execute(plan)).toEqual(listed);
    await writeFile(
      join(root, 'prompts', 'Review.md'),
      '---\ndescription: Edited.\n---\n{{ title }} {{ unused }}',
    );
    const edited = await engine.execute(plan);
    if (edited.kind !== 'workflow.list-defs.result') throw new Error(JSON.stringify(edited));
    expect(edited.definitions[0]?.workflow.prompts[0]?.entries[0]).toMatchObject({
      description: 'Edited.',
      variables: ['title', 'unused'],
      warnings: [],
    });
    await writeFile(join(root, 'prompts', 'Review.md'), '{{ title | random }}');
    expect(await engine.execute(plan)).toMatchObject({
      ok: false,
      code: 'load.definition',
      message: expect.stringContaining('uses the random filter') as unknown,
    });
  });

  it('revalidates list-defs when an unreferenced file is added under a prompt root', async () => {
    const { root } = await project();
    const engine = executor();
    const plan = { kind: 'workflow.list-defs' as const, directories: [root] };
    const listed = await engine.execute(plan);
    if (listed.kind !== 'workflow.list-defs.result') throw new Error(JSON.stringify(listed));
    expect(await engine.execute(plan)).toEqual(listed);
    await writeFile(join(root, 'prompts', 'new-fragment.md'), 'A new fragment.\n');
    const added = await engine.execute(plan);
    if (added.kind !== 'workflow.list-defs.result') throw new Error(JSON.stringify(added));
    const files = added.definitions[0]?.workflow.identity?.files ?? {};
    expect(Object.keys(files)).toContain('prompts/new-fragment.md');
    expect(added.definitions[0]?.workflow.identity?.code).not.toBe(
      listed.definitions[0]?.workflow.identity?.code,
    );
    const refreshed = await engine.execute({ ...plan, refresh: true });
    expect(refreshed).toEqual(added);
  });

  it('revalidates list-defs when an in-root template symlink is retargeted', async () => {
    const { root } = await project();
    const prompts = join(root, 'prompts');
    await writeFile(join(prompts, 'A.md'), goodTemplate);
    await writeFile(join(prompts, 'B.md'), '{{ nope }}');
    // A dangling link is no template a render can read, so it does not block the cache.
    await symlink('Missing.md', join(prompts, 'Dangling.md'));
    await rm(join(prompts, 'Review.md'));
    await symlink('A.md', join(prompts, 'Review.md'));
    const engine = executor();
    const plan = { kind: 'workflow.list-defs' as const, directories: [root] };
    const listed = await engine.execute(plan);
    if (listed.kind !== 'workflow.list-defs.result') throw new Error(JSON.stringify(listed));
    expect(await engine.execute(plan)).toEqual(listed);
    await rm(join(prompts, 'Review.md'));
    await symlink('B.md', join(prompts, 'Review.md'));
    expect(await engine.execute(plan)).toMatchObject({
      ok: false,
      code: 'load.definition',
      message: expect.stringContaining('Prompt Review (Review.md): reads variable nope') as unknown,
    });
  });

  it('revalidates list-defs when a file symlink is retargeted outside the root to identical contents', async () => {
    const { root } = await project();
    const prompts = join(root, 'prompts');
    await writeFile(join(prompts, 'A.md'), goodTemplate);
    await writeFile(join(root, 'Outside.md'), goodTemplate);
    await rm(join(prompts, 'Review.md'));
    await symlink('A.md', join(prompts, 'Review.md'));
    const engine = executor();
    const plan = { kind: 'workflow.list-defs' as const, directories: [root] };
    const listed = await engine.execute(plan);
    if (listed.kind !== 'workflow.list-defs.result') throw new Error(JSON.stringify(listed));
    expect(await engine.execute(plan)).toEqual(listed);
    // The bytes a render would read are unchanged; only where the link resolves moved.
    await rm(join(prompts, 'Review.md'));
    await symlink(join('..', 'Outside.md'), join(prompts, 'Review.md'));
    expect(await engine.execute(plan)).toMatchObject({
      ok: false,
      code: 'load.definition',
      message: expect.stringContaining('resolves outside the prompt root') as unknown,
    });
  });

  it('revalidates list-defs when an in-root directory symlink is retargeted', async () => {
    const { root, file } = await project();
    const prompts = join(root, 'prompts');
    await mkdir(join(prompts, 'A'));
    await mkdir(join(prompts, 'B'));
    await writeFile(join(prompts, 'A', 'Review.md'), goodTemplate);
    await writeFile(join(prompts, 'B', 'Review.md'), '{{ nope }}');
    await symlink('A', join(prompts, 'current'));
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace("file: 'Review.md'", "file: 'current/Review.md'"),
    );
    const engine = executor();
    const plan = { kind: 'workflow.list-defs' as const, directories: [root] };
    const listed = await engine.execute(plan);
    if (listed.kind !== 'workflow.list-defs.result') throw new Error(JSON.stringify(listed));
    expect(await engine.execute(plan)).toEqual(listed);
    await rm(join(prompts, 'current'));
    await symlink('B', join(prompts, 'current'));
    expect(await engine.execute(plan)).toMatchObject({
      ok: false,
      code: 'load.definition',
      message: expect.stringContaining(
        'Prompt Review (current/Review.md): reads variable nope',
      ) as unknown,
    });
  });

  it('fails the execute preflight before any effect', async () => {
    const { root, typecheck } = await project('{{ title }} {% include "../escape.md" %}');
    const stateDir = join(root, 'state');
    const result = await executor().execute({
      kind: 'workflow.execute',
      typecheck,
      runId: 'preflight',
      stateDir,
      cwd: root,
      input: null,
      resume: false,
      harness: await readHarnessSelection('fixture:fixtures.json', undefined, root),
    });
    expect(result).toMatchObject({ ok: false, code: 'load.definition' });
    if (result.ok) throw new Error('Expected a failure.');
    expect(result.message).toContain(
      'include target "../escape.md" resolves outside the prompt root',
    );
    expect(await readdir(stateDir).catch(() => [])).toEqual([]);
  });

  it('executes with a valid template and logs its warnings', async () => {
    const { root, typecheck } = await project();
    const lines: string[] = [];
    const result = await executor(lines).execute({
      kind: 'workflow.execute',
      typecheck,
      runId: 'valid',
      stateDir: join(root, 'state'),
      cwd: root,
      input: null,
      resume: false,
      harness: await readHarnessSelection('fixture:fixtures.json', undefined, root),
    });
    expect(result).toMatchObject({ ok: true, run: { status: 'completed', output: 'reviewed' } });
    expect(lines).toContain(`[warn] ${warning}`);
  });
});

/**
 * A project whose workflow renders `Review` in step `review` and then calls `second`, which has no
 * fixture, so a first execute fails after `review` completes. `prompts/_fragments/unused.md` is
 * under the root but no template includes it.
 */
async function resumable() {
  const made = await project('Review {{ title }}.\n');
  await mkdir(join(made.root, 'prompts', '_fragments'));
  await writeFile(join(made.root, 'prompts', '_fragments', 'unused.md'), 'Unused fragment.\n');
  await writeFile(
    made.file,
    `import { definePrompts, defineWorkflow, z } from ${JSON.stringify(join(repository, 'src/index.js'))};
const prompts = definePrompts(${JSON.stringify(join(made.root, 'prompts'))}, {
  Review: { file: 'Review.md', params: z.object({ title: z.string() }) },
});
export default defineWorkflow({
  name: 'review',
  version: '1',
  input: z.null(),
  output: z.string(),
  prompts: [prompts],
  async run(ctx) {
    const reply = await ctx.claude.text('review', { prompt: prompts.Review({ title: 'T' }) });
    const next = await ctx.claude.text('second', { prompt: 'Second.' });
    return reply.output + next.output;
  },
});
`,
  );
  const stateDir = join(made.root, 'state');
  const execute = async (resume: boolean, acceptCodeChange?: boolean) =>
    executor().execute({
      kind: 'workflow.execute',
      typecheck: made.typecheck,
      runId: 'templated',
      stateDir,
      cwd: made.root,
      input: null,
      resume,
      ...(acceptCodeChange === undefined ? {} : { acceptCodeChange }),
      harness: await readHarnessSelection('fixture:fixtures.json', undefined, made.root),
    });
  const checkResume = (acceptCodeChange?: boolean) =>
    executor().execute({
      kind: 'workflow.check-resume',
      typecheck: made.typecheck,
      runId: 'templated',
      stateDir,
      cwd: made.root,
      ...(acceptCodeChange === undefined ? {} : { acceptCodeChange }),
    });
  const addSecondFixture = () =>
    writeFile(
      join(made.root, 'fixtures.json'),
      JSON.stringify({
        version: 1,
        calls: [
          { step: 'review', text: 'reviewed' },
          { step: 'second', text: ' twice' },
        ],
      }),
    );
  return { ...made, stateDir, execute, checkResume, addSecondFixture };
}

// measured: 2.5 s for the first case alone (its full engine compile), 1.2-1.7 s for later ones
// in a whole-file run without coverage (three or four imports each; coverage slows compiles 2.5x).
// The first case took 9.7 s on CI's Node 22.13 leg, so the budget is 60 s.
describe('prompt templates as execution dependencies (#582)', { timeout: 60_000 }, () => {
  it('lists every prompt-root file in validate --json identity, matching the executed run', async ({
    cli,
  }) => {
    const made = await resumable();
    const validated = await cli.run(WorkflowValidate, [made.file, '--json']);
    expect(validated.error).toBeUndefined();
    const identity = (
      JSON.parse(validated.stdout) as {
        workflow: { identity: { code: string; files: Record<string, string> } };
      }
    ).workflow.identity;
    expect(Object.keys(identity.files)).toEqual(
      expect.arrayContaining(['prompts/Review.md', 'prompts/_fragments/unused.md']),
    );
    expect(identity.files['prompts/Review.md']).toBe(sha256('Review {{ title }}.\n'));
    expect(await made.execute(false)).toMatchObject({ ok: false });
    const run = await readRun({ stateDir: made.stateDir, runId: 'templated' });
    expect(run.status).toBe('failed');
    expect(run.workflow.identity?.code).toBe(identity.code);
    expect(run.workflow.identity?.files).toEqual(identity.files);
    expect(run.launch?.sources?.[join(await realpath(made.root), 'prompts', 'Review.md')]).toBe(
      identity.files['prompts/Review.md'],
    );
    expect(run.steps['review']).toMatchObject({
      status: 'completed',
      request: { promptTemplate: 'Review' },
    });
  });

  it('refuses a template edit on resume, and under --accept-code-change refuses the changed step', async () => {
    const made = await resumable();
    expect(await made.execute(false)).toMatchObject({ ok: false });
    await writeFile(join(made.root, 'prompts', 'Review.md'), 'Review {{ title }} carefully.\n');
    await made.addSecondFixture();
    const before = await readRun({ stateDir: made.stateDir, runId: 'templated' });
    for (const result of [await made.execute(true), await made.checkResume()]) {
      expect(result).toMatchObject({ ok: false, code: 'run.incompatible' });
      if (result.ok) throw new Error('Expected a refusal.');
      expect(result.message).toContain('code (prompts/Review.md)');
      expect(result.details).toMatchObject({ files: ['prompts/Review.md'], changed: ['code'] });
    }
    // Accepting the change reaches the step's own identity check: the rendered prompt changed.
    expect(await made.checkResume(true)).toMatchObject({ ok: true });
    const accepted = await made.execute(true, true);
    expect(accepted).toMatchObject({
      ok: false,
      code: 'run.incompatible',
      details: { divergent: [{ stepId: 'review', components: ['prompt'] }] },
    });
    if (accepted.ok) throw new Error('Expected a divergence refusal.');
    expect(accepted.message).toContain('Step review: prompt changed on a completed step.');
    expect(accepted.message).toContain('--fork-from templated');
    expect(await readRun({ stateDir: made.stateDir, runId: 'templated' })).toEqual(before);
  });

  it('refuses an edit to a fragment no template includes, and accepts it with the flag', async () => {
    const made = await resumable();
    expect(await made.execute(false)).toMatchObject({ ok: false });
    await writeFile(join(made.root, 'prompts', '_fragments', 'unused.md'), 'Edited.\n');
    await made.addSecondFixture();
    const refused = await made.execute(true);
    expect(refused).toMatchObject({ ok: false, code: 'run.incompatible' });
    if (refused.ok) throw new Error('Expected a refusal.');
    expect(refused.message).toContain('code (prompts/_fragments/unused.md)');
    const accepted = await made.execute(true, true);
    expect(accepted).toMatchObject({
      ok: true,
      run: { status: 'completed', output: 'reviewed twice' },
    });
    const run = await readRun({ stateDir: made.stateDir, runId: 'templated' });
    expect(run.codeChanges).toEqual([
      expect.objectContaining({ files: ['prompts/_fragments/unused.md'], components: ['code'] }),
    ]);
  });
});

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

// measured: 5 ms for the unit case and 0.4 s for the validate case in a whole-file run without
// coverage; alone, the validate case pays the 2.5 s first engine compile (2.5x under coverage).
describe('withPromptSources', { timeout: 30_000 }, () => {
  it('keys files by the real root and their in-root path, and follows in-root links', async () => {
    const { root, typecheck } = await project();
    const prompts = join(root, 'prompts');
    await writeFile(join(prompts, 'A.md'), 'A\n');
    await writeFile(join(prompts, 'B.md'), 'B\n');
    await rm(join(prompts, 'Review.md'));
    await symlink('A.md', join(prompts, 'Review.md'));
    await mkdir(join(prompts, 'dir'));
    await writeFile(join(prompts, 'dir', 'Inner.md'), 'Inner\n');
    await symlink('dir', join(prompts, 'current'));
    // The root is named through a link; keys still use its real path.
    await symlink('prompts', join(root, 'linked'));
    const base = {
      hash: digest({ 'review.workflow.ts': 'x' }),
      files: { 'review.workflow.ts': 'x' },
    };
    const first = await withPromptSources(typecheck, base, [join(root, 'linked')]);
    expect(first.files).toEqual({
      'prompts/A.md': sha256('A\n'),
      'prompts/B.md': sha256('B\n'),
      'prompts/Review.md': sha256('A\n'),
      'prompts/current/Inner.md': sha256('Inner\n'),
      'prompts/dir/Inner.md': sha256('Inner\n'),
      'review.workflow.ts': 'x',
    });
    expect(Object.keys(first.files)).toEqual(Object.keys(first.files).sort());
    expect(first.hash).toBe(digest(first.files));
    // Each key resolves from the project root to the bytes it hashes.
    const real = await realpath(root);
    for (const [key, value] of Object.entries(first.files))
      if (key !== 'review.workflow.ts') expect(sha256(await readFile(join(real, key)))).toBe(value);
    // Moving a link between two existing in-root files changes the map under the link's path.
    await rm(join(prompts, 'Review.md'));
    await symlink('B.md', join(prompts, 'Review.md'));
    const second = await withPromptSources(typecheck, base, [prompts]);
    expect(second.files['prompts/Review.md']).toBe(sha256('B\n'));
    expect(second.hash).not.toBe(first.hash);
    // No roots, or only a missing root, keeps the fingerprint as it was.
    expect(await withPromptSources(typecheck, base, [])).toBe(base);
    expect(await withPromptSources(typecheck, base, [join(root, 'missing')])).toEqual(base);
  });

  it('leaves a workflow without prompts with only its TypeScript sources', async () => {
    const { file, typecheck } = await project();
    await writeFile(
      file,
      `import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'src/index.js'))};
export default defineWorkflow({
  name: 'plain',
  version: '1',
  input: z.null(),
  output: z.null(),
  run: () => Promise.resolve(null),
});
`,
    );
    const result = await executor().execute({ kind: 'workflow.validate', typecheck });
    if (result.kind !== 'workflow.validate.result') throw new Error(JSON.stringify(result));
    expect(Object.keys(result.workflow.identity?.files ?? {})).toEqual(['review.workflow.ts']);
    expect(result.workflow.identity?.code).toBe(digest(result.workflow.identity?.files));
  });
});
