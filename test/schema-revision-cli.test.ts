// CLI plans refuse a run record this build cannot fully read (#167): workflow resume, execute
// --resume and tick change nothing, while inspect and list succeed with a warning. One workflow
// is type-checked, once: every refusal comes before the resume's type check.
import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ThresholdLogger } from '../src/application/execution.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { TickWorkflowExecutor } from '../src/workflow/loader/tick.js';
import { inspectRun, listRuns } from '../src/workflow/loader/inspection.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';
import { SUPPORTED_SCHEMA_REVISION } from '../src/workflow/runtime/record.js';
import type { WorkflowClock } from '../src/index.js';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const logger = new ThresholdLogger('silent', () => undefined);
const runId = 'drifted';
const newer = SUPPORTED_SCHEMA_REVISION + 1;
// The sleep is already due when tick reads the run with the real clock.
const pastClock: WorkflowClock = {
  now: () => Date.now() - 120_000,
  sleep: (_ms, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('Clock cancelled'));
        },
        { once: true },
      );
    }),
};

let root: string;
let stateDir: string;
let executePlan: Parameters<WorkflowExecutor['execute']>[0];
let original: { snapshot: string; journal: string };
const snapshotPath = () => join(stateDir, runId, 'run.json');
const journalPath = () => join(stateDir, runId, 'journal.jsonl');
const bytes = async () => ({
  snapshot: await readFile(snapshotPath(), 'utf8'),
  journal: await readFile(journalPath(), 'utf8'),
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'choir-schema-cli-'));
  stateDir = join(root, 'state');
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const file = join(root, 'workflow.ts');
  await writeFile(
    file,
    `import { z } from 'zod';
import { defineWorkflow } from ${JSON.stringify(join(project, 'src/workflow/runtime/model.js'))};
export default defineWorkflow({ name: 'drift', version: '1', input: z.null(), output: z.null(),
  run: async (ctx) => {
    await ctx.sleep('timer', 60_000);
    return null;
  },
});
`,
  );
  const analysis = analyzeTypecheckEntrypoint(file, root);
  if (!analysis.ok) throw new Error(analysis.error.message);
  executePlan = {
    kind: 'workflow.execute',
    typecheck: analysis.plan,
    runId,
    stateDir,
    cwd: root,
    resume: false,
    input: null,
  };
  const first = await new WorkflowExecutor({ logger, clock: pastClock }).execute(executePlan);
  expect(first).toMatchObject({ ok: true, run: { status: 'suspended' } });
  original = await bytes();
  // measured: 0.6 s alone; the same single type check and suspend as one tick.test.ts fixture,
  // whose cases take 5.1-13.4 s in full coverage runs and 19.5 s on the Node 22.13 CI leg.
}, 40_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every write path refuses with run.incompatible and leaves run.json and journal.jsonl alone. */
async function expectRefusals(named: string): Promise<void> {
  const before = await bytes();
  const executor = new WorkflowExecutor({ logger });
  for (const plan of [
    { kind: 'workflow.resume' as const, runId, stateDir },
    { ...executePlan, resume: true },
  ]) {
    const result = await executor.execute(plan);
    expect(result, plan.kind).toMatchObject({
      ok: false,
      code: 'run.incompatible',
      details: { reason: 'record_schema' },
    });
    if (!result.ok) {
      expect(result.message).toContain(named);
      expect(result.message).toContain('Upgrade quiet-choir');
      expect(result.next ?? []).toEqual([]);
    }
    expect(await bytes()).toEqual(before);
  }
  const ticked = await new TickWorkflowExecutor({ logger }).execute({
    kind: 'workflow.tick',
    runId,
    stateDir,
  });
  expect(ticked).toMatchObject({ ok: true, resumed: [], exitCode: 1 });
  if (!ticked.ok) throw new Error(ticked.message);
  expect(ticked.skipped).toEqual([
    { runId, reason: 'incompatible', message: expect.stringContaining(named) as string },
  ]);
  expect(await bytes()).toEqual(before);

  const { summary } = await inspectRun({ stateDir, runId });
  expect(summary.status).toBe('suspended');
  expect(summary.warnings).toEqual([expect.stringContaining(named)]);
  expect(summary.next).toEqual([]);
  const listed = await listRuns({ stateDir });
  expect(listed.runs.map((run) => [run.id, run.warnings])).toEqual([
    [runId, [expect.stringContaining(named)]],
  ]);
  expect(await bytes()).toEqual(before);
}

it('refuses every write to a record with a newer schemaRevision and warns on read', async () => {
  const raw = JSON.parse(original.snapshot) as Record<string, unknown>;
  expect(raw['schemaRevision']).toBe(SUPPORTED_SCHEMA_REVISION);
  await writeFile(snapshotPath(), `${JSON.stringify({ ...raw, schemaRevision: newer })}\n`);
  await expectRefusals(`schemaRevision ${String(newer)}`);
});

it('refuses every write to a record with an unknown top-level field and warns on read', async () => {
  await writeFile(snapshotPath(), original.snapshot);
  await writeFile(journalPath(), original.journal);
  const { seq } = JSON.parse(original.snapshot) as { seq: number };
  // A newer build journals a field before compaction moves it into run.json.
  await appendFile(
    journalPath(),
    `${JSON.stringify({
      seq: seq + 1,
      at: new Date().toISOString(),
      changes: [{ area: 'run', key: 'futureLedger', value: { kept: true } }],
    })}\n`,
  );
  await expectRefusals('futureLedger');
});

it('refuses a newer record it cannot parse at all, and tick skips it as incompatible', async () => {
  const raw = JSON.parse(original.snapshot) as Record<string, unknown>;
  await writeFile(
    snapshotPath(),
    `${JSON.stringify({ ...raw, schemaRevision: newer, status: 'paused' })}\n`,
  );
  await writeFile(journalPath(), original.journal);
  const before = await bytes();
  const resumed = await new WorkflowExecutor({ logger }).execute({
    kind: 'workflow.resume',
    runId,
    stateDir,
  });
  expect(resumed).toMatchObject({
    ok: false,
    code: 'run.incompatible',
    details: { reason: 'record_schema', schemaRevision: newer },
  });
  const ticked = await new TickWorkflowExecutor({ logger }).execute({
    kind: 'workflow.tick',
    runId,
    stateDir,
  });
  expect(ticked).toMatchObject({
    ok: true,
    exitCode: 1,
    skipped: [{ runId, reason: 'incompatible' }],
  });
  const listed = await listRuns({ stateDir });
  expect(listed.runs).toEqual([]);
  expect(listed.warnings).toEqual([expect.stringContaining('Upgrade quiet-choir')]);
  expect(await bytes()).toEqual(before);
});
