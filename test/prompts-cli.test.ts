// Prompt checks through the CLI loader (ADR 0064 section 3, #581): workflow validate, list-defs and
// the execute preflight import the workflow through tsx, so the prompt set is built by the
// workflow's own copy of quiet-choir and read here by its brand.
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, vi } from 'vitest';

import { ThresholdLogger } from '../src/application/execution.js';
import WorkflowValidate from '../src/commands/workflow/validate.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { readHarnessSelection } from '../src/workflow/loader/harness-selection.js';
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
// 4.9 s worst case in the full coverage run (dominated by the first tsImport compile).
describe('prompt checks in the CLI loader', { timeout: 30_000 }, () => {
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
