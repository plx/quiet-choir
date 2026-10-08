// Run records carry a schemaRevision (#167). A build refuses to rewrite a record with a newer
// revision or with top-level fields it does not know, because its parse strips them and the next
// compaction would delete them; reads tolerate both and report the hidden field names.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkResume,
  defineHarness,
  defineWorkflow,
  FileRunStore,
  FixtureHarness,
  listPending,
  readRun,
  RunRefusedError,
  runWorkflow,
  writeAnswer,
  z,
  type Harness,
  type OwnedRunStore,
  type RunRecord,
  type RunStore,
  type WorkflowClock,
} from '../src/index.js';
import { runNextCommands } from '../src/workflow/loader/next-commands.js';
import { rehearsalState } from '../src/workflow/loader/rehearsal.js';
import { JournalWriter } from '../src/workflow/runtime/journal.js';
import { cleanWorktrees } from '../src/workflow/runtime/worktree-clean.js';
import { digest } from '../src/workflow/runtime/json.js';
import { pollIdentityKey } from '../src/workflow/runtime/poll-identity.js';
import { ReplayDivergenceError } from '../src/workflow/runtime/run-errors.js';
import {
  hiddenRecordFields,
  RECORD_FIELD_KEYS,
  recordSchemaDrift,
  recordSchemaRefusalMessage,
  recordSchemaWarning,
  SUPPORTED_SCHEMA_REVISION,
} from '../src/workflow/runtime/record.js';

// sha256 of JSON.stringify(sorted keys) for each released revision. A past revision is never
// edited in place: a new persisted field adds a revision and bumps SUPPORTED_SCHEMA_REVISION.
const revisionDigests: Readonly<Record<string, string>> = {
  '1': '80010b03d1fa34c4b824b0682b5138e0c19d138186fb659c38d46eab204992ec',
  // Revision 2 (#168) changed only nested shapes (runBudget, budgetStop), so it repeats the keys.
  '2': '80010b03d1fa34c4b824b0682b5138e0c19d138186fb659c38d46eab204992ec',
  // Revision 3 (#170) changed only the nested children shape (onError, settled), so it repeats them.
  '3': '80010b03d1fa34c4b824b0682b5138e0c19d138186fb659c38d46eab204992ec',
  // Revision 4 (#171) changed only nested shapes (capabilities claude.addDirRoots, request addDirs).
  '4': '80010b03d1fa34c4b824b0682b5138e0c19d138186fb659c38d46eab204992ec',
  // Revision 5 (#223) changed only the nested events shape (the wait.tolerated type).
  '5': '80010b03d1fa34c4b824b0682b5138e0c19d138186fb659c38d46eab204992ec',
  // Revision 6 (#226) added the top-level projectInstructions list.
  '6': '14ecaff04c78634fdbaaca9796e99503df2c253e4c7db6208169ca21b74a9b1a',
  // Revision 7 (#227) changed only the nested instruction source kind (claude-md), so it repeats 6.
  '7': '14ecaff04c78634fdbaaca9796e99503df2c253e4c7db6208169ca21b74a9b1a',
  // Revision 8 (#240) changed only nested shapes (children redefinitions, maps frame), so it repeats 7.
  '8': '14ecaff04c78634fdbaaca9796e99503df2c253e4c7db6208169ca21b74a9b1a',
  // Revision 9 (#247) changed only the nested capabilities shape (redacted.harnesses), so it repeats 8.
  '9': '14ecaff04c78634fdbaaca9796e99503df2c253e4c7db6208169ca21b74a9b1a',
  // Revision 10 (#284) added the top-level recoveryCause.
  '10': '01979d40f27afb4d663d424a519d1b89a7d840c34dfdb7f4d206d99bc60a27a5',
  // Revision 11 (#289) changed only a nested shape (question.rejections issues), so it repeats 10.
  '11': '01979d40f27afb4d663d424a519d1b89a7d840c34dfdb7f4d206d99bc60a27a5',
  // Revision 12 (#300) changed only the nested steps shape (failureHistory), so it repeats 11.
  '12': '01979d40f27afb4d663d424a519d1b89a7d840c34dfdb7f4d206d99bc60a27a5',
  // Revision 13 (#302) changed only the nested steps shape (mapItems), so it repeats 12.
  '13': '01979d40f27afb4d663d424a519d1b89a7d840c34dfdb7f4d206d99bc60a27a5',
};
// digest(readRun(...)) of the installed pre-revision fixture, computed on unmodified main 91a6d2f.
const preRevisionReadDigest = '714b6cb068de5c933b7ba04a26d1f931f589f7c9910f76f0e5c8cc493eb13016';
// digest(readRun(...)) of the installed revision-one fixture, computed on unmodified main 33b6eac.
const revisionOneReadDigest = '73d8cec57513dde827ab1ced2a31745af52b6c8af39dad13c3e4e391cfc43310';
// digest(readRun(...)) of the installed revision-two fixture, computed on unmodified main 9d054b4.
const revisionTwoReadDigest = '7c56687992acfa40d749086b301489e9babc93fc9be8f2db2a1bc29cdb1d02ae';
// digest(readRun(...)) of the installed revision-three fixture, computed on unmodified main 4c3ebf5.
const revisionThreeReadDigest = 'c2f4ad7fd501352343faa55e59b25ec9a70ef781f9849bc6282b90eb8b8c7fd0';
// digest(readRun(...)) of the installed revision-four fixture, computed on unmodified main 7fa2348.
const revisionFourReadDigest = '813c73ae37120ba658d75502e4a0757e6657a93d9f1e69ab41671716c4ebfc98';
// digest(readRun(...)) of the installed revision-five fixture, computed on unmodified main 6a05a54.
const revisionFiveReadDigest = 'b249d588cfd7dbcd1375f27b3dfccb9634b502ddd174c689ea2b4108cebadea0';
// digest(readRun(...)) of the installed revision-six fixture, computed on unmodified main 2c6be06.
const revisionSixReadDigest = 'aa4a92b3d3d284be8403ccbd2b3ad86cd048414202074063d95cbbf17089d855';
// digest(readRun(...)) of the installed revision-seven fixture, computed on unmodified main 61fb951.
const revisionSevenReadDigest = 'af4c0ae3367ad8f941f37a22168fa0ad06a33094d1c33abf816a13cb24d0d256';
// digest(readRun(...)) of the installed revision-eight fixture, computed on unmodified main b707169.
const revisionEightReadDigest = 'c00a217c100cb94e3d20a7bdac94c3afd7c38c11940c5dbbe5bf08877bf6895e';
// digest(readRun(...)) of the installed revision-nine fixture, computed on unmodified main 8acf024.
const revisionNineReadDigest = 'f7d0bbb8c91058abeb5c59fad047407a6120faa6ff8616f9acd26cf8cfafc230';
// digest(readRun(...)) of the installed revision-ten fixture, computed on unmodified main 7d02b96.
const revisionTenReadDigest = 'ef509d5e971ee33147455addee4c139aae9ca0d60b7bc20294d6dacfad4a9171';
// digest(readRun(...)) of the installed revision-eleven fixture, computed on unmodified main 943006c.
const revisionElevenReadDigest = 'b18862e839b487aa050160ae3b4eeea08bbc73c9d9a126634de4e9ceb6b0ffa8';
// digest(readRun(...)) of the installed revision-twelve fixture, computed on unmodified main b3ff960.
const revisionTwelveReadDigest = '2cb7aab642b978a2ed6fcceb5d0d139f8da680c27d83b17a4302d00a89e8f372';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-schema-revision-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('record key snapshot', () => {
  it('ties the record keys to SUPPORTED_SCHEMA_REVISION and pins every released revision', async () => {
    const { revisions } = JSON.parse(
      await readFile(
        new URL('./fixtures/schema-revision/record-keys.json', import.meta.url),
        'utf8',
      ),
    ) as { revisions: Record<string, string[]> };
    const numbers = Object.keys(revisions)
      .map(Number)
      .sort((a, b) => a - b);
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
    expect(SUPPORTED_SCHEMA_REVISION).toBe(numbers.at(-1));
    // A new top-level field needs a new revision here and a bumped SUPPORTED_SCHEMA_REVISION.
    expect([...RECORD_FIELD_KEYS].sort()).toEqual(revisions[String(SUPPORTED_SCHEMA_REVISION)]);
    for (const revision of numbers) {
      const keys = revisions[String(revision)] ?? [];
      expect(keys).toEqual([...keys].sort());
      // An unpinned revision fails too: pin its digest when it is added.
      expect(sha256(JSON.stringify(keys)), `revision ${String(revision)}`).toBe(
        revisionDigests[String(revision)],
      );
      // A revision may repeat the previous key list when it only changes a nested run-level shape.
    }
    expect(RECORD_FIELD_KEYS).toContain('schemaRevision');
  });
});

const definition = (tail: boolean) =>
  defineWorkflow({
    name: 'schema-revision',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.now('prepare');
      if (tail) throw new Error('fixture tail');
      return null;
    },
  });
const options = { cwd: '/', fingerprint: 'schema-revision' } as const;

/** A failed run created by this build, with a committed journal entry after its snapshot. */
async function failedRun(runId: string): Promise<void> {
  await expect(
    runWorkflow(definition(true), { ...options, stateDir, runId, input: null }),
  ).rejects.toThrow('fixture tail');
  await appendRunChanges(runId, [{ area: 'run', key: 'recoveryHint', value: 'journaled' }]);
}

const paths = (runId: string) => ({
  snapshot: join(stateDir, runId, 'run.json'),
  journal: join(stateDir, runId, 'journal.jsonl'),
});

async function rawSnapshot(runId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(paths(runId).snapshot, 'utf8')) as Record<string, unknown>;
}

/** Rewrite run.json directly, as another build would have written it. */
async function editSnapshot(
  runId: string,
  edit: (raw: Record<string, unknown>) => void,
): Promise<void> {
  const raw = await rawSnapshot(runId);
  edit(raw);
  await writeFile(paths(runId).snapshot, `${JSON.stringify(raw)}\n`);
}

/** Append one committed journal entry after the latest sequence, as another build would. */
async function appendRunChanges(
  runId: string,
  changes: readonly { area: string; key: string; value?: unknown }[],
): Promise<void> {
  const raw = await rawSnapshot(runId);
  const journal = await readFile(paths(runId).journal, 'utf8');
  const lines = journal.split('\n').filter(Boolean);
  const last = lines.length
    ? (JSON.parse(lines.at(-1) ?? '{}') as { seq: number }).seq
    : (raw['seq'] as number);
  await appendFile(
    paths(runId).journal,
    `${JSON.stringify({ seq: last + 1, at: new Date().toISOString(), changes })}\n`,
  );
}

async function bytes(runId: string): Promise<{ snapshot: string; journal: string }> {
  return {
    snapshot: await readFile(paths(runId).snapshot, 'utf8'),
    journal: await readFile(paths(runId).journal, 'utf8'),
  };
}

async function refusal(promise: Promise<unknown>): Promise<RunRefusedError> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(RunRefusedError);
  return error as RunRefusedError;
}

describe('reading a record this build cannot fully read', () => {
  it('reports an unknown run.json field as hidden and leaves it out of the record', async () => {
    await failedRun('run');
    await editSnapshot('run', (raw) => {
      raw['futureBudget'] = { maxRunMinutes: 5 };
    });
    const record = await readRun({ stateDir, runId: 'run' });
    expect(record).not.toHaveProperty('futureBudget');
    expect(record.recoveryHint).toBe('journaled');
    expect(hiddenRecordFields(record)).toEqual(['futureBudget']);
    expect(recordSchemaDrift(record)).toEqual({
      schemaRevision: SUPPORTED_SCHEMA_REVISION,
      supportedSchemaRevision: SUPPORTED_SCHEMA_REVISION,
      hiddenFields: ['futureBudget'],
    });
    // A clone carries nothing, so checks run on the object the read returned.
    expect(hiddenRecordFields(structuredClone(record))).toEqual([]);
  });

  it('tolerates an unknown run key in the journal and un-hides it when a later entry removes it', async () => {
    await failedRun('run');
    await appendRunChanges('run', [{ area: 'run', key: 'futureLedger', value: { a: 1 } }]);
    const hidden = await readRun({ stateDir, runId: 'run' });
    expect(hidden).not.toHaveProperty('futureLedger');
    expect(hiddenRecordFields(hidden)).toEqual(['futureLedger']);
    await appendRunChanges('run', [{ area: 'run', key: 'futureLedger' }]);
    const removed = await readRun({ stateDir, runId: 'run' });
    expect(hiddenRecordFields(removed)).toEqual([]);
    expect(recordSchemaDrift(removed)).toBeUndefined();
  });

  it('un-hides a run.json field that a later journal entry removes', async () => {
    await failedRun('run');
    await editSnapshot('run', (raw) => {
      raw['futureBudget'] = 1;
    });
    await appendRunChanges('run', [{ area: 'run', key: 'futureBudget' }]);
    expect(hiddenRecordFields(await readRun({ stateDir, runId: 'run' }))).toEqual([]);
  });

  it('reads a journaled newer schemaRevision', async () => {
    await failedRun('run');
    await appendRunChanges('run', [
      { area: 'run', key: 'schemaRevision', value: SUPPORTED_SCHEMA_REVISION + 1 },
    ]);
    const record = await readRun({ stateDir, runId: 'run' });
    expect(record.schemaRevision).toBe(SUPPORTED_SCHEMA_REVISION + 1);
    expect(recordSchemaDrift(record)).toMatchObject({
      schemaRevision: SUPPORTED_SCHEMA_REVISION + 1,
      hiddenFields: [],
    });
    expect(recordSchemaWarning(recordSchemaDrift(record) ?? expect.fail())).toContain(
      `schemaRevision ${String(SUPPORTED_SCHEMA_REVISION + 1)}`,
    );
  });

  it('asks for an upgrade when a newer revision changed the shape of a known field', async () => {
    await failedRun('snapshot');
    await editSnapshot('snapshot', (raw) => {
      raw['schemaRevision'] = SUPPORTED_SCHEMA_REVISION + 1;
      raw['status'] = 'paused';
      raw['futureField'] = true;
    });
    const fromSnapshot = await refusal(readRun({ stateDir, runId: 'snapshot' }));
    expect(fromSnapshot.code).toBe('run.incompatible');
    expect(fromSnapshot.message).toContain('Upgrade quiet-choir');
    expect(fromSnapshot.details).toEqual({
      reason: 'record_schema',
      schemaRevision: SUPPORTED_SCHEMA_REVISION + 1,
      supportedSchemaRevision: SUPPORTED_SCHEMA_REVISION,
      hiddenFields: ['futureField'],
    });

    await failedRun('journal');
    await appendRunChanges('journal', [
      { area: 'run', key: 'schemaRevision', value: SUPPORTED_SCHEMA_REVISION + 1 },
      { area: 'run', key: 'status', value: 'paused' },
      { area: 'run', key: 'futureField', value: true },
    ]);
    const fromJournal = await refusal(readRun({ stateDir, runId: 'journal' }));
    expect(fromJournal.code).toBe('run.incompatible');
    expect(fromJournal.details).toMatchObject({ hiddenFields: ['futureField'] });
    expect(fromJournal.message).toContain('futureField');

    // Without a newer revision or unknown fields the same damage is an ordinary read failure.
    await failedRun('damaged');
    await editSnapshot('damaged', (raw) => {
      raw['status'] = 'paused';
    });
    const damaged: unknown = await readRun({ stateDir, runId: 'damaged' }).catch(
      (error: unknown) => error,
    );
    expect(damaged).toBeInstanceOf(Error);
    expect(damaged).not.toBeInstanceOf(RunRefusedError);
  });

  it('treats unknown fields as drift when a known field also fails validation', async () => {
    // No revision bump: the unknown key alone makes the failed parse a schema refusal.
    await failedRun('snapshot');
    await editSnapshot('snapshot', (raw) => {
      raw['status'] = 'paused';
      raw['futureBudget'] = 5;
    });
    const fromSnapshot = await refusal(readRun({ stateDir, runId: 'snapshot' }));
    expect(fromSnapshot.code).toBe('run.incompatible');
    expect(fromSnapshot.details).toEqual({
      reason: 'record_schema',
      schemaRevision: SUPPORTED_SCHEMA_REVISION,
      supportedSchemaRevision: SUPPORTED_SCHEMA_REVISION,
      hiddenFields: ['futureBudget'],
    });
    expect(fromSnapshot.message).toContain('futureBudget');
    expect(fromSnapshot.message).not.toContain('newer quiet-choir');
    expect(fromSnapshot.cause).toBeInstanceOf(Error);

    await failedRun('journal');
    await appendRunChanges('journal', [
      { area: 'run', key: 'status', value: 'paused' },
      { area: 'run', key: 'futureBudget', value: 5 },
    ]);
    const fromJournal = await refusal(readRun({ stateDir, runId: 'journal' }));
    expect(fromJournal.code).toBe('run.incompatible');
    expect(fromJournal.details).toMatchObject({
      schemaRevision: SUPPORTED_SCHEMA_REVISION,
      hiddenFields: ['futureBudget'],
    });
    expect(fromJournal.message).not.toContain('newer quiet-choir');

    // A key a later entry removed no longer counts: that damage is plain corruption again.
    await failedRun('removed');
    await appendRunChanges('removed', [{ area: 'run', key: 'futureBudget', value: 5 }]);
    await appendRunChanges('removed', [
      { area: 'run', key: 'futureBudget' },
      { area: 'run', key: 'status', value: 'paused' },
    ]);
    const removed: unknown = await readRun({ stateDir, runId: 'removed' }).catch(
      (error: unknown) => error,
    );
    expect(removed).toBeInstanceOf(Error);
    expect(removed).not.toBeInstanceOf(RunRefusedError);
  });

  it('builds a bounded refusal message', () => {
    const fields = Array.from({ length: 12 }, (_, index) => `f${String(index).padStart(2, '0')}`);
    const message = recordSchemaRefusalMessage('run', {
      schemaRevision: 3,
      supportedSchemaRevision: 1,
      hiddenFields: fields,
    });
    expect(message).toBe(
      'Run run was written by a newer quiet-choir (record schemaRevision 3, this build supports 1) and has fields this build does not know: f00, f01, f02, f03, f04, f05, f06, f07, f08, f09 and 2 more. Upgrade quiet-choir to resume or rewrite it; nothing was changed.',
    );
  });
});

describe('writers refuse and change nothing', () => {
  const resume = (runId: string) =>
    runWorkflow(definition(false), { ...options, stateDir, runId, resume: true });

  it.each([
    [
      'a newer schemaRevision in run.json',
      async (runId: string) => {
        await editSnapshot(runId, (raw) => {
          raw['schemaRevision'] = SUPPORTED_SCHEMA_REVISION + 1;
        });
      },
      { schemaRevision: SUPPORTED_SCHEMA_REVISION + 1, hiddenFields: [] },
    ],
    [
      'an unknown run.json field without a revision bump',
      async (runId: string) => {
        await editSnapshot(runId, (raw) => {
          raw['futureBudget'] = { maxRunMinutes: 5 };
        });
      },
      { schemaRevision: SUPPORTED_SCHEMA_REVISION, hiddenFields: ['futureBudget'] },
    ],
    [
      'an unknown journaled run field',
      async (runId: string) => {
        await appendRunChanges(runId, [{ area: 'run', key: 'futureLedger', value: [1] }]);
      },
      { schemaRevision: SUPPORTED_SCHEMA_REVISION, hiddenFields: ['futureLedger'] },
    ],
  ])('resume refuses %s', async (_name, drift, details) => {
    await failedRun('run');
    await drift('run');
    const before = await bytes('run');
    expect(before.journal).not.toBe('');
    const error = await refusal(resume('run'));
    expect(error.code).toBe('run.incompatible');
    expect(error.message).toContain('Upgrade quiet-choir to resume or rewrite it');
    expect(error.details).toEqual({
      reason: 'record_schema',
      supportedSchemaRevision: SUPPORTED_SCHEMA_REVISION,
      ...details,
    });
    expect(await bytes('run')).toEqual(before);
  });

  it.each([
    [
      'a newer schemaRevision',
      async (runId: string) => {
        await editSnapshot(runId, (raw) => {
          raw['schemaRevision'] = SUPPORTED_SCHEMA_REVISION + 1;
        });
      },
      { schemaRevision: SUPPORTED_SCHEMA_REVISION + 1, hiddenFields: [] },
    ],
    [
      'an unknown top-level field',
      async (runId: string) => {
        await editSnapshot(runId, (raw) => {
          raw['futureBudget'] = { maxRunMinutes: 5 };
        });
      },
      { schemaRevision: SUPPORTED_SCHEMA_REVISION, hiddenFields: ['futureBudget'] },
    ],
  ])(
    'checkResume reports %s as incompatible, which no flag overrides',
    async (_name, drift, why) => {
      await failedRun('run');
      const check = { ...options, stateDir, runId: 'run' };
      await expect(checkResume(definition(false), check)).resolves.toMatchObject({
        compatible: true,
        changed: [],
      });
      await drift('run');
      const before = await bytes('run');
      for (const accept of [{}, { acceptCodeChange: true }]) {
        const result = await checkResume(definition(false), { ...check, ...accept });
        expect(result).toMatchObject({
          compatible: false,
          changed: ['record schema'],
          canAcceptCodeChange: false,
          reason: 'record_schema',
          supportedSchemaRevision: SUPPORTED_SCHEMA_REVISION,
          ...why,
        });
        expect(result.message).toBe(
          recordSchemaRefusalMessage('run', {
            supportedSchemaRevision: SUPPORTED_SCHEMA_REVISION,
            ...why,
          }),
        );
      }
      // The preflight agrees with the resume that follows it.
      const error = await refusal(
        runWorkflow(definition(false), { ...options, stateDir, runId: 'run', resume: true }),
      );
      expect(error.message).toBe(
        (await checkResume(definition(false), { ...check, acceptCodeChange: true })).message,
      );
      expect(await bytes('run')).toEqual(before);
    },
  );

  it('refuses a fork from a drifted source', async () => {
    await failedRun('source');
    await editSnapshot('source', (raw) => {
      raw['schemaRevision'] = SUPPORTED_SCHEMA_REVISION + 1;
    });
    const before = await bytes('source');
    const error = await refusal(
      runWorkflow(definition(false), {
        ...options,
        stateDir,
        runId: 'target',
        input: null,
        forkFrom: { runId: 'source' },
      }),
    );
    expect(error.code).toBe('run.incompatible');
    expect(error.runId).toBe('source');
    expect(await bytes('source')).toEqual(before);
  });

  it.each([
    [
      'an unknown top-level field',
      (raw: Record<string, unknown>) => {
        raw['futureBudget'] = { maxRunMinutes: 5 };
      },
    ],
    [
      'a newer schemaRevision with every known field unchanged',
      (raw: Record<string, unknown>) => {
        raw['schemaRevision'] = SUPPORTED_SCHEMA_REVISION + 1;
      },
    ],
  ])('closes reuse when a fork source later gains %s', async (_name, drift) => {
    const live: string[] = [];
    const fixture = new FixtureHarness({ version: 1, calls: [{ step: '**', text: 'ok' }] });
    const harness: Harness = {
      invoke(request, invocation) {
        live.push(request.call.stepId);
        return fixture.invoke(request, invocation);
      },
    };
    const state = { pause: false };
    const forked = defineWorkflow({
      name: 'schema-revision-fork',
      version: '1',
      input: z.null(),
      output: z.null(),
      async run(ctx) {
        for (const id of ['a', 'b', 'c', 'd']) {
          if (state.pause && id === 'c') throw new Error('pause');
          await ctx.claude.text(id, { prompt: id });
        }
        return null;
      },
    });
    const base = { ...options, harness, stateDir } as const;
    await runWorkflow(forked, { ...base, runId: 'source', input: null });
    live.length = 0;
    state.pause = true;
    await expect(
      runWorkflow(forked, { ...base, runId: 'target', input: null, forkFrom: { runId: 'source' } }),
    ).rejects.toThrow('pause');
    expect(live).toEqual([]);
    const paused = await readRun({ runId: 'target', stateDir });
    expect(paused.forkedFrom).toMatchObject({ cursor: 2, reuseClosed: false });
    expect(Object.keys(paused.steps).sort()).toEqual(['a', 'b']);

    await editSnapshot('source', drift);
    const before = await bytes('source');
    state.pause = false;
    const resumed = await runWorkflow(forked, { ...base, runId: 'target', resume: true });
    expect(resumed.status).toBe('completed');
    expect(resumed.forkedFrom?.reuseClosed).toBe(true);
    expect(resumed.forkedFrom?.warning).toContain('newer quiet-choir or has fields');
    expect(resumed.warnings?.join('\n')).toContain('remaining effects will execute live');
    expect(live.sort()).toEqual(['c', 'd']);
    for (const id of ['c', 'd']) expect(resumed.steps[id]?.reusedFrom).toBeUndefined();
    for (const id of ['a', 'b']) expect(resumed.steps[id]?.reusedFrom).toBeDefined();
    expect(await bytes('source')).toEqual(before);
  });

  it('refuses workflow clean under the lock and a dry-run copy of the record', async () => {
    await failedRun('run');
    await editSnapshot('run', (raw) => {
      raw['schemaRevision'] = SUPPORTED_SCHEMA_REVISION + 1;
    });
    const before = await bytes('run');
    const runner = {
      run(): never {
        throw new Error('clean must not run a command');
      },
    };
    expect((await refusal(cleanWorktrees({ runId: 'run', stateDir }, runner))).code).toBe(
      'run.incompatible',
    );
    expect((await refusal(rehearsalState('run', stateDir, true))).code).toBe('run.incompatible');
    expect(await bytes('run')).toEqual(before);
  });

  it('refuses in JournalWriter before repairing a torn tail or appending', async () => {
    await failedRun('run');
    await editSnapshot('run', (raw) => {
      raw['futureBudget'] = 1;
    });
    const record = await readRun({ stateDir, runId: 'run' });
    await appendFile(paths('run').journal, '{"seq":');
    const before = await bytes('run');
    record.updatedAt = new Date().toISOString();
    const error = await refusal(new JournalWriter(stateDir, 'run').append(record));
    expect(error.code).toBe('run.incompatible');
    expect(await bytes('run')).toEqual(before);
  });

  it('refuses a custom RunStore record with a newer revision or unknown keys', async () => {
    await failedRun('run');
    const before = await bytes('run');
    const file = new FileRunStore(stateDir);
    const store = (edit: (record: RunRecord) => RunRecord): RunStore => ({
      stateDir: file.stateDir,
      read: (id) => file.read(id),
      list: () => file.list(),
      open: async (id, openOptions): Promise<OwnedRunStore> => {
        const owned = await file.open(id, openOptions);
        return {
          read: async () => {
            const record = await owned.read();
            return record && edit(structuredClone(record));
          },
          append: (record, appendOptions) => owned.append(record, appendOptions),
          compact: () => owned.compact(),
          artifacts: (stepId, attempt) => owned.artifacts(stepId, attempt),
          trackProcess: (invocation, child) => owned.trackProcess(invocation, child),
          release: () => owned.release(),
        };
      },
    });
    for (const edit of [
      (record: RunRecord) => ({ ...record, schemaRevision: SUPPORTED_SCHEMA_REVISION + 1 }),
      (record: RunRecord) => ({ ...record, futureField: true }),
    ]) {
      const error = await refusal(
        runWorkflow(definition(false), {
          ...options,
          stateDir,
          runId: 'run',
          resume: true,
          store: store(edit),
        }),
      );
      expect(error.code).toBe('run.incompatible');
      expect(await bytes('run')).toEqual(before);
    }
  });
});

describe('records written before schemaRevision', () => {
  async function install(): Promise<string> {
    const fixture = await readFile(
      new URL('./fixtures/schema-revision/pre-revision-checkpoint.json', import.meta.url),
      'utf8',
    );
    await mkdir(join(stateDir, 'pre-revision'));
    await writeFile(paths('pre-revision').snapshot, fixture);
    await writeFile(paths('pre-revision').journal, '');
    return fixture;
  }
  const refuse = {
    invoke(): never {
      throw new Error('replay must not invoke');
    },
  };

  it('read exactly as on main, without a filled-in schemaRevision', async () => {
    await install();
    const record = await readRun({ stateDir, runId: 'pre-revision' });
    expect(record).not.toHaveProperty('schemaRevision');
    // Revision 2's window cap is optional, so a read never fills it in (#168).
    expect(record.runBudget).toEqual({ maxRunCostUsd: null, maxRunAgentAttempts: null });
    expect(recordSchemaDrift(record)).toBeUndefined();
    expect(digest(record)).toBe(preRevisionReadDigest);
  });

  it('resume without invoking anything and are saved with the current revision', async () => {
    await install();
    const original = await readRun({ stateDir, runId: 'pre-revision' });
    const result = await runWorkflow(definition(false), {
      ...options,
      stateDir,
      runId: 'pre-revision',
      resume: true,
      harness: refuse,
    });
    expect(result.status).toBe('completed');
    expect(result.output).toBeNull();
    const saved = await readRun({ stateDir, runId: 'pre-revision' });
    expect(saved.steps).toEqual(original.steps);
    expect(saved.runBudget?.maxWindowUtilization).toBeNull();
    expect(saved.schemaRevision).toBe(SUPPORTED_SCHEMA_REVISION);
    expect((await rawSnapshot('pre-revision'))['schemaRevision']).toBe(SUPPORTED_SCHEMA_REVISION);
  });

  it('fresh runs are written with the current revision', async () => {
    await expect(
      runWorkflow(definition(false), { ...options, stateDir, runId: 'fresh', input: null }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect((await rawSnapshot('fresh'))['schemaRevision']).toBe(SUPPORTED_SCHEMA_REVISION);
  });
});

describe('revision-one records (before the window gate, #168)', () => {
  const runId = 'revision-one';
  async function install(): Promise<void> {
    const fixture = await readFile(
      new URL('./fixtures/schema-revision/revision-one-checkpoint.json', import.meta.url),
      'utf8',
    );
    await mkdir(join(stateDir, runId));
    await writeFile(paths(runId).snapshot, fixture);
    await writeFile(paths(runId).journal, '');
  }
  const agentDefinition = defineWorkflow({
    name: 'schema-revision',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.now('prepare');
      await ctx.claude.text('call', { prompt: 'x' });
      return null;
    },
  });

  it('read exactly as on main, with a two-cap runBudget and the old budgetStop', async () => {
    await install();
    const record = await readRun({ stateDir, runId });
    expect(record.schemaRevision).toBe(1);
    expect(recordSchemaDrift(record)).toBeUndefined();
    expect(digest(record)).toBe(revisionOneReadDigest);
    expect(record.runBudget).toEqual({ maxRunCostUsd: null, maxRunAgentAttempts: 0 });
    expect(record.budgetStop).toMatchObject({ metric: 'maxRunAgentAttempts', stepId: 'call' });
  });

  it('resume with the window gate unlimited and are saved with the current revision', async () => {
    await install();
    let calls = 0;
    const harness: Harness = {
      invoke() {
        calls++;
        return Promise.resolve({
          text: 'ok',
          sessionId: null,
          diagnostics: {
            rateLimit: {
              status: 'allowed',
              type: null,
              resetsAt: null,
              windows: { five_hour: { utilization: 1 } },
            },
          },
        });
      },
    };
    const result = await runWorkflow(agentDefinition, {
      ...options,
      stateDir,
      runId,
      resume: true,
      harness,
      maxRunAgentAttempts: null,
    });
    expect(result.status).toBe('completed');
    expect(calls).toBe(1);
    const saved = await readRun({ stateDir, runId });
    expect(saved.runBudget).toEqual({
      maxRunCostUsd: null,
      maxRunAgentAttempts: null,
      maxWindowUtilization: null,
    });
    expect(saved.budgetStop).toBeUndefined();
    expect((await rawSnapshot(runId))['schemaRevision']).toBe(SUPPORTED_SCHEMA_REVISION);
  });

  it('round-trip a window budgetStop through the record parser', async () => {
    await install();
    const stop = {
      stepId: 'call',
      metric: 'maxWindowUtilization',
      limit: 0.5,
      observed: 1.2,
      at: '2026-10-04T00:00:00.000Z',
      harness: 'claude',
      window: 'seven_day',
      resetsAt: null,
    };
    await editSnapshot(runId, (raw) => {
      raw['schemaRevision'] = SUPPORTED_SCHEMA_REVISION;
      raw['runBudget'] = {
        maxRunCostUsd: null,
        maxRunAgentAttempts: null,
        maxWindowUtilization: 0.5,
      };
      raw['budgetStop'] = stop;
    });
    const record = await readRun({ stateDir, runId });
    expect(record.budgetStop).toEqual(stop);
    expect(record.runBudget?.maxWindowUtilization).toBe(0.5);
    expect(recordSchemaDrift(record)).toBeUndefined();
    await editSnapshot(runId, (raw) => {
      raw['runBudget'] = {
        maxRunCostUsd: null,
        maxRunAgentAttempts: null,
        maxWindowUtilization: 2,
      };
    });
    await expect(readRun({ stateDir, runId })).rejects.toThrow();
  });
});

describe('revision-two records (child frames before settled frames, #170)', () => {
  const runId = 'revision-two';
  async function install(): Promise<void> {
    const fixture = await readFile(
      new URL('./fixtures/schema-revision/revision-two-checkpoint.json', import.meta.url),
      'utf8',
    );
    await mkdir(join(stateDir, runId));
    await writeFile(paths(runId).snapshot, fixture);
    await writeFile(paths(runId).journal, '');
  }
  let bodies = 0;
  const child = defineWorkflow({
    name: 'stamp-child',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      bodies++;
      await ctx.now('stamp');
      return null;
    },
  });
  const root = defineWorkflow({
    name: 'schema-revision',
    version: '1',
    input: z.null(),
    output: z.null(),
    children: [child],
    async run(ctx) {
      await ctx.workflow('child', child, null);
      return null;
    },
  });

  it('read exactly as on main, with a completed frame and no settled fields', async () => {
    await install();
    const record = await readRun({ stateDir, runId });
    expect(record.schemaRevision).toBe(2);
    expect(recordSchemaDrift(record)).toBeUndefined();
    expect(digest(record)).toBe(revisionTwoReadDigest);
    expect(record.children?.['child']).toMatchObject({ status: 'completed', declared: true });
    expect(record.children?.['child']).not.toHaveProperty('settled');
    expect(record.children?.['child']).not.toHaveProperty('onError');
  });

  it('resume by rerunning the child body with its effect replayed', async () => {
    await install();
    bodies = 0;
    const original = await readRun({ stateDir, runId });
    const replayed: string[] = [];
    const result = await runWorkflow(root, {
      ...options,
      stateDir,
      runId,
      resume: true,
      onEvent: (event) => {
        if (event.type === 'step.replayed') replayed.push(event.stepId);
      },
    });
    expect(result.status).toBe('completed');
    expect(bodies).toBe(1);
    expect(replayed).toEqual(['child/stamp']);
    const saved = await readRun({ stateDir, runId });
    expect(saved.steps['child/stamp']?.output).toEqual(original.steps['child/stamp']?.output);
    expect(saved.children?.['child']).toMatchObject({ status: 'completed' });
    expect(saved.children?.['child']).not.toHaveProperty('settled');
    expect((await rawSnapshot(runId))['schemaRevision']).toBe(SUPPORTED_SCHEMA_REVISION);
  });
});

describe('revision-three records (static addDirs before bounded call-site roots, #171)', () => {
  const runId = 'revision-three';
  async function install(): Promise<void> {
    const fixture = await readFile(
      new URL('./fixtures/schema-revision/revision-three-checkpoint.json', import.meta.url),
      'utf8',
    );
    await mkdir(join(stateDir, runId));
    await writeFile(paths(runId).snapshot, fixture);
    await writeFile(paths(runId).journal, '');
  }
  const reader = defineWorkflow({
    name: 'schema-revision',
    version: '1',
    input: z.null(),
    output: z.null(),
    profiles: { reader: { extends: 'readonly', claude: { addDirs: ['docs'] } } },
    async run(ctx) {
      await ctx.claude.text('read', { prompt: 'x', profile: 'reader' });
      return null;
    },
  });
  const refuse: Harness = {
    invoke(): never {
      throw new Error('replay must not invoke');
    },
  };

  it('read exactly as on main, with no roots and no request addDirs', async () => {
    await install();
    const record = await readRun({ stateDir, runId });
    expect(record.schemaRevision).toBe(3);
    expect(recordSchemaDrift(record)).toBeUndefined();
    expect(digest(record)).toBe(revisionThreeReadDigest);
    expect(record.capabilities?.profiles['reader']?.claude.addDirs).toEqual(['docs']);
    expect(record.capabilities?.profiles['reader']?.claude).not.toHaveProperty('addDirRoots');
    expect(record.steps['read']?.request).not.toHaveProperty('addDirs');
  });

  it('resume without invoking (identity unchanged) and are saved with the current revision', async () => {
    await install();
    const original = await readRun({ stateDir, runId });
    const result = await runWorkflow(reader, {
      ...options,
      stateDir,
      runId,
      resume: true,
      harness: refuse,
    });
    expect(result.status).toBe('completed');
    const saved = await readRun({ stateDir, runId });
    expect(saved.steps['read']).toEqual(original.steps['read']);
    expect(saved.capabilities?.profiles['reader']).toEqual(
      original.capabilities?.profiles['reader'],
    );
    expect((await rawSnapshot(runId))['schemaRevision']).toBe(SUPPORTED_SCHEMA_REVISION);
  });

  it('round-trip request-summary addDirs and capability roots through the record parser', async () => {
    const rooted = defineWorkflow({
      name: 'schema-revision',
      version: '1',
      input: z.null(),
      output: z.null(),
      profiles: {
        reader: { extends: 'readonly', claude: { addDirs: ['docs'], addDirRoots: ['runs'] } },
      },
      async run(ctx) {
        await ctx.claude.text('read', { prompt: 'x', profile: 'reader' });
        return null;
      },
    });
    const harness: Harness = {
      invoke: () => Promise.resolve({ text: 'ok', sessionId: null }),
    };
    await expect(
      runWorkflow(rooted, {
        ...options,
        stateDir,
        runId: 'rooted',
        input: null,
        harness,
        policy: [{ transcripts: 'off' }],
      }),
    ).resolves.toMatchObject({ status: 'completed' });
    const record = await readRun({ stateDir, runId: 'rooted' });
    expect(record.steps['read']?.request?.addDirs).toEqual(['docs']);
    expect(record.steps['read']?.attemptHistory?.[0]?.request?.addDirs).toEqual(['docs']);
    expect(record.capabilities?.profiles['reader']?.claude.addDirRoots).toEqual(['runs']);
    expect(recordSchemaDrift(record)).toBeUndefined();
    expect((await rawSnapshot('rooted'))['schemaRevision']).toBe(SUPPORTED_SCHEMA_REVISION);
  });
});

describe('revision-four records (tolerated poll errors before wait.tolerated events, #223)', () => {
  const runId = 'revision-four';
  async function install(): Promise<void> {
    const fixture = await readFile(
      new URL('./fixtures/schema-revision/revision-four-checkpoint.json', import.meta.url),
      'utf8',
    );
    await mkdir(join(stateDir, runId));
    await writeFile(paths(runId).snapshot, fixture);
    await writeFile(paths(runId).journal, '');
  }
  // A fixed time after the fixture's saved nextCheckAt, so the resumed check is due at once.
  const clock: WorkflowClock = {
    now: () => 1_791_246_031_836 + 1_000,
    sleep: (_milliseconds, signal) =>
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
  // The fixture's observer source is replaced by a helper identity, so the wait's identity does
  // not depend on how a test transformer prints the callback.
  const watcher = (observe: () => Promise<{ done: true; value: 'ok' }>) =>
    defineWorkflow({
      name: 'schema-revision',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      async run(ctx) {
        ctx.phase('watch');
        ctx.log('waiting', { n: 1 });
        return ctx.wait('ready', {
          poll: {
            input: null,
            schema: z.literal('ok'),
            every: 60_000,
            onError: { tolerate: 3 },
            observe,
            [pollIdentityKey]: { helper: 'schema-revision', version: 1 },
          },
        });
      },
    });

  it('read exactly as on main, with a tolerated lastError and no wait.tolerated event', async () => {
    await install();
    const record = await readRun({ stateDir, runId });
    expect(record.schemaRevision).toBe(4);
    expect(recordSchemaDrift(record)).toBeUndefined();
    expect(digest(record)).toBe(revisionFourReadDigest);
    expect(record.steps['ready']?.wait?.lastError).toMatchObject({
      message: 'HTTP 502: Bad Gateway',
      consecutive: 1,
    });
    expect(record.events?.map((event) => event.type)).toEqual([
      'run.started',
      'phase',
      'log',
      'run.suspended',
    ]);
  });

  it('resume with the persisted count and identity unchanged and are saved with the current revision', async () => {
    await install();
    const original = await readRun({ stateDir, runId });
    const events: string[] = [];
    // The saved check is due: it fails again, continuing the count from the old record.
    const suspended = await runWorkflow(
      watcher(() => Promise.reject(new Error('HTTP 503'))),
      {
        ...options,
        stateDir,
        runId,
        resume: true,
        clock,
        onEvent: (event) => {
          events.push(event.type);
        },
      },
    );
    expect(suspended.status).toBe('suspended');
    expect(suspended.steps['ready']?.fingerprint).toBe(original.steps['ready']?.fingerprint);
    expect(suspended.steps['ready']?.identity).toEqual(original.steps['ready']?.identity);
    expect(suspended.steps['ready']?.wait?.lastError).toMatchObject({ consecutive: 2 });
    expect(events.filter((type) => type === 'wait.tolerated')).toHaveLength(1);
    const tolerated = (await readRun({ stateDir, runId })).events?.filter(
      (event) => event.type === 'wait.tolerated',
    );
    expect(tolerated).toEqual([
      expect.objectContaining({
        stepId: 'ready',
        phase: 'watch',
        message: 'HTTP 503',
        data: { consecutive: 2, tolerate: 3 },
        execution: 2,
      }),
    ]);
    expect((await rawSnapshot(runId))['schemaRevision']).toBe(SUPPORTED_SCHEMA_REVISION);
    // The original phase and log entries were not replayed as new entries.
    expect(
      (await readRun({ stateDir, runId })).events?.filter(
        (event) => event.type === 'phase' || event.type === 'log',
      ),
    ).toEqual(original.events?.filter((event) => event.type === 'phase' || event.type === 'log'));
  });

  it('round-trip a wait.tolerated entry through the record parser', async () => {
    await install();
    await editSnapshot(runId, (raw) => {
      raw['schemaRevision'] = SUPPORTED_SCHEMA_REVISION;
      (raw['events'] as unknown[]).splice(3, 0, {
        at: '2026-10-06T00:19:31.836Z',
        execution: 1,
        type: 'wait.tolerated',
        phase: 'watch',
        total: null,
        message: 'HTTP 502: Bad Gateway',
        data: { consecutive: 1, tolerate: 3, code: 'ECONNRESET' },
        stepId: 'ready',
      });
    });
    const record = await readRun({ stateDir, runId });
    expect(recordSchemaDrift(record)).toBeUndefined();
    expect(record.events?.[3]).toEqual({
      at: '2026-10-06T00:19:31.836Z',
      execution: 1,
      type: 'wait.tolerated',
      phase: 'watch',
      total: null,
      message: 'HTTP 502: Bad Gateway',
      data: { consecutive: 1, tolerate: 3, code: 'ECONNRESET' },
      stepId: 'ready',
    });
    const done = await runWorkflow(
      watcher(() => Promise.resolve({ done: true, value: 'ok' })),
      { ...options, stateDir, runId, resume: true, clock },
    );
    expect(done.output).toMatchObject({ by: 'poll', value: 'ok', checks: 2 });
    expect(done.events?.filter((event) => event.type === 'wait.tolerated')).toHaveLength(1);
  });
});

describe('revision-five records (project instruction sources inside harnesses, #226)', () => {
  const runId = 'revision-five';
  async function install(): Promise<void> {
    const fixture = await readFile(
      new URL('./fixtures/schema-revision/revision-five-checkpoint.json', import.meta.url),
      'utf8',
    );
    await mkdir(join(stateDir, runId));
    await writeFile(paths(runId).snapshot, fixture);
    await writeFile(paths(runId).journal, '');
  }
  const caller = defineWorkflow({
    name: 'schema-revision',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.codex.text('read', { prompt: 'x' });
      await ctx.codex.text('write', { prompt: 'y' });
      return null;
    },
  });
  const user = {
    scope: 'user',
    kind: 'agents',
    path: '/home/fixture/.codex/AGENTS.md',
    sha256: 'a'.repeat(64),
  } as const;
  const project = {
    scope: 'project',
    kind: 'agents',
    path: '/AGENTS.md',
    sha256: 'b'.repeat(64),
  } as const;

  it('read exactly as on main, with project sources under harnesses and no projectInstructions', async () => {
    await install();
    const record = await readRun({ stateDir, runId });
    expect(record.schemaRevision).toBe(5);
    expect(recordSchemaDrift(record)).toBeUndefined();
    expect(digest(record)).toBe(revisionFiveReadDigest);
    expect(record.harnesses?.['codex']?.instructionSources).toEqual([user, project]);
    expect(record).not.toHaveProperty('projectInstructions');
    expect(record.steps['write']?.status).toBe('failed');
  });

  it('resume, keep the old harnesses entry and add projectInstructions, saved with the current revision', async () => {
    await install();
    const original = await readRun({ stateDir, runId });
    const invoked: string[] = [];
    const harness: Harness = {
      projectInstructions: (request) =>
        Promise.resolve({
          sources: [{ ...project, path: `${request.cwd}AGENTS.md`, sha256: 'c'.repeat(64) }],
        }),
      invoke: (request) => {
        invoked.push(request.stepId);
        return Promise.resolve({ text: 'ok', sessionId: null });
      },
    };
    const result = await runWorkflow(caller, {
      ...options,
      stateDir,
      runId,
      resume: true,
      harness,
      policy: [{ transcripts: 'off' }],
    });
    expect(result.status).toBe('completed');
    // The completed call replays; only the failed one runs again.
    expect(invoked).toEqual(['write']);
    const saved = await readRun({ stateDir, runId });
    expect(saved.steps['read']).toEqual(original.steps['read']);
    expect(saved.harnesses).toEqual(original.harnesses);
    expect(saved.projectInstructions).toEqual([
      { harness: 'codex', cwd: '/', sources: [{ ...project, sha256: 'c'.repeat(64) }] },
    ]);
    expect(recordSchemaDrift(saved)).toBeUndefined();
    expect((await rawSnapshot(runId))['schemaRevision']).toBe(SUPPORTED_SCHEMA_REVISION);
  });

  it('compare only user-level sources when new metadata reports no project entries', async () => {
    await install();
    const harness: Harness = {
      metadata: () =>
        Promise.resolve({ binary: 'codex', version: '0.157.1', instructionSources: [user] }),
      invoke: () => Promise.resolve({ text: 'ok', sessionId: null }),
    };
    await runWorkflow(caller, {
      ...options,
      stateDir,
      runId,
      resume: true,
      harness,
      policy: [{ transcripts: 'off' }],
    });
    const saved = await readRun({ stateDir, runId });
    expect(saved.harnesses?.['codex']?.instructionSources).toEqual([user]);
    expect(saved.harnessWarnings).toEqual([]);
  });
});

describe('revision-six records (instruction source kinds before claude-md, #227)', () => {
  const runId = 'revision-six';
  async function install(): Promise<void> {
    const fixture = await readFile(
      new URL('./fixtures/schema-revision/revision-six-checkpoint.json', import.meta.url),
      'utf8',
    );
    await mkdir(join(stateDir, runId));
    await writeFile(paths(runId).snapshot, fixture);
    await writeFile(paths(runId).journal, '');
  }
  const sources = [
    { kind: 'agents', path: '/AGENTS.md', scope: 'project', sha256: 'b'.repeat(64) },
    {
      kind: 'skill',
      path: '/.agents/skills/review/SKILL.md',
      scope: 'project',
      sha256: 'd'.repeat(64),
    },
  ] as const;

  it('read exactly as on main', async () => {
    await install();
    const record = await readRun({ stateDir, runId });
    expect(record.schemaRevision).toBe(6);
    expect(recordSchemaDrift(record)).toBeUndefined();
    expect(digest(record)).toBe(revisionSixReadDigest);
    expect(record.projectInstructions).toEqual([{ harness: 'codex', cwd: '/', sources }]);
    expect(record.steps['write']?.status).toBe('failed');
  });

  it('resume, add a claude-md entry beside the old one, saved with the current revision', async () => {
    await install();
    const original = await readRun({ stateDir, runId });
    const invoked: string[] = [];
    const claudeMd = {
      scope: 'user',
      kind: 'claude-md',
      path: '/home/fixture/.claude/CLAUDE.md',
      sha256: 'e'.repeat(64),
    } as const;
    const resumed = defineWorkflow({
      name: 'schema-revision',
      version: '1',
      input: z.null(),
      output: z.null(),
      async run(ctx) {
        await ctx.codex.text('read', { prompt: 'x' });
        await ctx.codex.text('write', { prompt: 'y' });
        await ctx.claude.text('note', { prompt: 'z' });
        return null;
      },
    });
    const harness: Harness = {
      projectInstructions: (request) =>
        Promise.resolve(request.harness === 'claude' ? { sources: [claudeMd] } : undefined),
      invoke: (request) => {
        invoked.push(request.stepId);
        return Promise.resolve({ text: 'ok', sessionId: null });
      },
    };
    const result = await runWorkflow(resumed, {
      ...options,
      stateDir,
      runId,
      resume: true,
      harness,
      policy: [{ transcripts: 'off' }],
    });
    expect(result.status).toBe('completed');
    expect(invoked).toEqual(['write', 'note']);
    const saved = await readRun({ stateDir, runId });
    expect(saved.steps['read']).toEqual(original.steps['read']);
    // The Codex detection resolved undefined, so the revision-six entry stays as it was.
    expect(saved.projectInstructions).toEqual([
      { harness: 'codex', cwd: '/', sources },
      { harness: 'claude', cwd: '/', sources: [claudeMd] },
    ]);
    expect(recordSchemaDrift(saved)).toBeUndefined();
    expect((await rawSnapshot(runId))['schemaRevision']).toBe(SUPPORTED_SCHEMA_REVISION);
  });
});

describe('revision-seven records (child frames before redefinitions, #240)', () => {
  const runId = 'revision-seven';
  async function install(): Promise<void> {
    const fixture = await readFile(
      new URL('./fixtures/schema-revision/revision-seven-checkpoint.json', import.meta.url),
      'utf8',
    );
    await mkdir(join(stateDir, runId));
    await writeFile(paths(runId).snapshot, fixture);
    await writeFile(paths(runId).journal, '');
  }
  const root = (version: string) => {
    const kid = defineWorkflow({
      name: 'kid',
      version,
      input: z.null(),
      output: z.null(),
      run: () => Promise.resolve(null),
    });
    return defineWorkflow({
      name: 'schema-revision',
      version: '1',
      input: z.null(),
      output: z.null(),
      children: [kid],
      async run(ctx) {
        await ctx.now('prepare');
        await ctx.workflow('kid', kid, null);
        return null;
      },
    });
  };

  it('read exactly as on main, with a failed frame and no redefinitions', async () => {
    await install();
    const record = await readRun({ stateDir, runId });
    expect(record.schemaRevision).toBe(7);
    expect(recordSchemaDrift(record)).toBeUndefined();
    expect(digest(record)).toBe(revisionSevenReadDigest);
    expect(record.children?.['kid']).toMatchObject({
      status: 'failed',
      workflow: { name: 'kid', version: '1' },
    });
    expect(record.children?.['kid']).not.toHaveProperty('redefinitions');
  });

  it('resume with a bumped child version, recording the old identity, saved with the current revision', async () => {
    await install();
    const original = await readRun({ stateDir, runId });
    const result = await runWorkflow(root('2'), { ...options, stateDir, runId, resume: true });
    expect(result.status).toBe('completed');
    const saved = await readRun({ stateDir, runId });
    expect(saved.steps['prepare']).toEqual(original.steps['prepare']);
    const prior = original.children?.['kid'];
    expect(saved.children?.['kid']).toMatchObject({
      status: 'completed',
      workflow: { name: 'kid', version: '2' },
      redefinitions: [
        {
          workflow: { name: 'kid', version: '1' },
          schemaDigest: prior?.schemaDigest,
          inputDigest: prior?.inputDigest,
        },
      ],
    });
    expect(recordSchemaDrift(saved)).toBeUndefined();
    expect((await rawSnapshot(runId))['schemaRevision']).toBe(SUPPORTED_SCHEMA_REVISION);
  });
});

describe('revision-eight records (plaintext registered harness options, #247)', () => {
  const runId = 'revision-eight';
  async function install(): Promise<void> {
    const fixture = await readFile(
      new URL('./fixtures/schema-revision/revision-eight-checkpoint.json', import.meta.url),
      'utf8',
    );
    await mkdir(join(stateDir, runId));
    await writeFile(paths(runId).snapshot, fixture);
    await writeFile(paths(runId).journal, '');
  }
  // The fixture's registration, now listing token as sensitive.
  const vault = defineHarness({
    name: 'vault',
    revision: 1,
    options: z.object({ prompt: z.string(), token: z.string().optional() }),
    capabilities: { structuredOutput: 'none' },
    access: () => 'none',
    sensitiveOptions: ['token'],
  });
  const caller = defineWorkflow({
    name: 'schema-revision',
    version: '1',
    input: z.null(),
    output: z.null(),
    harnesses: [vault],
    profiles: { keeper: { harnesses: { vault: { token: 'fixture-token' } } } },
    async run(ctx) {
      await ctx.agent('vault').text('read', { prompt: 'x', profile: 'keeper' });
      return null;
    },
  });

  it('read exactly as on main, with the plaintext option and no redacted entry', async () => {
    await install();
    const record = await readRun({ stateDir, runId });
    expect(record.schemaRevision).toBe(8);
    expect(recordSchemaDrift(record)).toBeUndefined();
    expect(digest(record)).toBe(revisionEightReadDigest);
    const keeper = record.capabilities?.profiles['keeper'];
    expect(keeper?.harnesses?.['vault']).toEqual({ token: 'fixture-token' });
    expect(keeper).not.toHaveProperty('redacted');
  });

  it('resume without invoking (identity unchanged), scrub the option and save the current revision', async () => {
    await install();
    const original = await readRun({ stateDir, runId });
    const invoked: string[] = [];
    const result = await runWorkflow(caller, {
      ...options,
      stateDir,
      runId,
      resume: true,
      policy: [{ transcripts: 'off' }],
      adapters: {
        vault: {
          invoke: (request) => {
            invoked.push(request.stepId);
            return Promise.resolve({ text: 'ok', sessionId: null });
          },
        },
      },
    });
    expect(result.status).toBe('completed');
    expect(invoked).toEqual([]);
    const saved = await readRun({ stateDir, runId });
    expect(saved.steps['read']).toEqual(original.steps['read']);
    const keeper = saved.capabilities?.profiles['keeper'];
    expect(keeper?.harnesses?.['vault']).toEqual({});
    expect(keeper?.redacted?.harnesses).toEqual({
      vault: { token: { sha256: digest('fixture-token') } },
    });
    expect(recordSchemaDrift(saved)).toBeUndefined();
    const raw = await readFile(paths(runId).snapshot, 'utf8');
    expect(raw).not.toContain('fixture-token');
    expect(await readFile(paths(runId).journal, 'utf8')).not.toContain('fixture-token');
    expect((JSON.parse(raw) as Record<string, unknown>)['schemaRevision']).toBe(
      SUPPORTED_SCHEMA_REVISION,
    );
  });
});

describe('revision-nine records (a grant failure before recoveryCause, #284)', () => {
  const runId = 'revision-nine';
  async function install(): Promise<void> {
    const fixture = await readFile(
      new URL('./fixtures/schema-revision/revision-nine-checkpoint.json', import.meta.url),
      'utf8',
    );
    await mkdir(join(stateDir, runId));
    await writeFile(paths(runId).snapshot, fixture);
    await writeFile(paths(runId).journal, '');
  }
  const granted = defineWorkflow({
    name: 'schema-revision',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.now('prepare');
      await ctx.claude.text('edit', { prompt: 'x', profile: 'edit' });
      return null;
    },
  });

  it('read exactly as on main, with a grant hint, no recoveryCause and a plain resume entry', async () => {
    await install();
    const record = await readRun({ stateDir, runId });
    expect(record.schemaRevision).toBe(9);
    expect(recordSchemaDrift(record)).toBeUndefined();
    expect(digest(record)).toBe(revisionNineReadDigest);
    expect(record.status).toBe('failed');
    expect(record.recoveryHint).toContain('--resume --grant edit');
    expect(record).not.toHaveProperty('recoveryCause');
    // Without the saved cause, the failed run keeps the entry it had before #284.
    const launch = { entrypoint: '/fixture/w.workflow.ts', tsconfig: null };
    expect(runNextCommands({ ...record, launch }, 'failed', stateDir)).toEqual([
      {
        why: 'Resume the failed run; completed steps are reused and failed ones run again.',
        argv: ['quiet-choir', 'workflow', 'resume', runId, '--state-dir', stateDir],
      },
    ]);
  });

  it('resume with the grant, clear the hint and save the current revision', async () => {
    await install();
    const original = await readRun({ stateDir, runId });
    const invoked: string[] = [];
    const result = await runWorkflow(granted, {
      ...options,
      stateDir,
      runId,
      resume: true,
      grants: ['edit'],
      harness: {
        invoke: (request) => {
          invoked.push(request.stepId);
          return Promise.resolve({ text: 'ok', sessionId: null });
        },
      },
    });
    expect(result.status).toBe('completed');
    expect(invoked).toEqual(['edit']);
    const saved = await readRun({ stateDir, runId });
    expect(saved.steps['prepare']).toEqual(original.steps['prepare']);
    expect(saved.recoveryHint).toBeUndefined();
    expect(saved.recoveryCause).toBeUndefined();
    expect(recordSchemaDrift(saved)).toBeUndefined();
    expect((await rawSnapshot(runId))['schemaRevision']).toBe(SUPPORTED_SCHEMA_REVISION);
    expect(SUPPORTED_SCHEMA_REVISION).toBe(13);
  });

  it('round-trip every recovery cause through the record parser', async () => {
    const causes = [
      { kind: 'grant', profile: 'edit', access: 'write' },
      { kind: 'grant', profile: 'text', access: 'write', classOnly: true },
      { kind: 'divergence' },
      { kind: 'map-changed', mapperOnly: true },
      { kind: 'configuration' },
      { kind: 'budget', flag: '--max-run-cost-usd' },
      { kind: 'authoring' },
      { kind: 'effect' },
      { kind: 'cancelled' },
    ] as const;
    await install();
    for (const cause of causes) {
      await editSnapshot(runId, (raw) => {
        raw['schemaRevision'] = 10;
        raw['recoveryCause'] = cause;
      });
      const record = await readRun({ stateDir, runId });
      expect(record.recoveryCause).toEqual(cause);
      expect(recordSchemaDrift(record)).toBeUndefined();
    }
  });
});

describe('revision-ten records (a plain rejection before issues, #289)', () => {
  const runId = 'revision-ten';
  async function install(): Promise<void> {
    const fixture = await readFile(
      new URL('./fixtures/schema-revision/revision-ten-checkpoint.json', import.meta.url),
      'utf8',
    );
    await mkdir(join(stateDir, runId));
    await writeFile(paths(runId).snapshot, fixture);
    await writeFile(paths(runId).journal, '');
  }
  const even = defineWorkflow({
    name: 'schema-revision',
    version: '1',
    input: z.null(),
    output: z.number(),
    run: (ctx) =>
      ctx.ask('even', {
        prompt: 'Even number?',
        schema: z.number().refine((n) => n % 2 === 0, 'Must be even'),
      }),
  });
  const resume = () => ({ ...options, stateDir, runId, input: null, resume: true }) as const;

  it('read exactly as on main, with a rejection that has no issues, listed without them', async () => {
    await install();
    const record = await readRun({ stateDir, runId });
    expect(record.schemaRevision).toBe(10);
    expect(recordSchemaDrift(record)).toBeUndefined();
    expect(digest(record)).toBe(revisionTenReadDigest);
    const rejections = record.steps['even']?.question?.rejections ?? [];
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.error).toContain('Must be even');
    expect(rejections[0]).not.toHaveProperty('issues');
    const pending = await listPending({ stateDir });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.rejections[0]).not.toHaveProperty('issues');
  });

  it('keep the plain entry beside a structured one, then complete and save the current revision', async () => {
    await install();
    await writeAnswer({ stateDir, runId, stepId: 'even', value: 3, by: 'agent:fixture' });
    expect((await runWorkflow(even, resume())).status).toBe('suspended');
    const rejections = (await readRun({ stateDir, runId })).steps['even']?.question?.rejections;
    expect(rejections).toHaveLength(2);
    expect(rejections?.[0]).not.toHaveProperty('issues');
    expect(rejections?.[1]?.issues).toEqual([
      { code: 'custom', path: [], message: 'Must be even' },
    ]);
    expect((await listPending({ stateDir }))[0]?.rejections[1]?.issues).toHaveLength(1);
    await writeAnswer({ stateDir, runId, stepId: 'even', value: 4, by: 'agent:fixture' });
    const result = await runWorkflow(even, resume());
    expect(result.status).toBe('completed');
    expect(result.output).toBe(4);
    const saved = await readRun({ stateDir, runId });
    expect(recordSchemaDrift(saved)).toBeUndefined();
    expect(saved.steps['even']?.question?.rejections).toHaveLength(2);
    expect((await rawSnapshot(runId))['schemaRevision']).toBe(SUPPORTED_SCHEMA_REVISION);
  });
});

describe('revision-eleven records (a repeated failure before failureHistory, #300)', () => {
  const runId = 'revision-eleven';
  async function install(): Promise<void> {
    const fixture = await readFile(
      new URL('./fixtures/schema-revision/revision-eleven-checkpoint.json', import.meta.url),
      'utf8',
    );
    await mkdir(join(stateDir, runId));
    await writeFile(paths(runId).snapshot, fixture);
    await writeFile(paths(runId).journal, '');
  }
  const fanIn = defineWorkflow({
    name: 'schema-revision',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await Promise.all([
        ctx.codex.text('impl', { prompt: 'impl' }),
        ctx.codex.text('followups', { prompt: 'followups' }),
      ]);
      await ctx.codex.text('ship', { prompt: 'ship' });
      return null;
    },
  });
  const resume = (harness: Harness, strictReplay: boolean) =>
    ({
      ...options,
      stateDir,
      runId,
      input: null,
      resume: true,
      harness,
      strictReplay,
      policy: [{ transcripts: 'off' }],
    }) as const;
  const succeeding = (invoked: string[]): Harness => ({
    invoke: (request) => {
      invoked.push(request.stepId);
      return Promise.resolve({ text: 'ok', sessionId: null });
    },
  });

  it('read exactly as on main, with only the first failure stamp and no history', async () => {
    await install();
    const record = await readRun({ stateDir, runId });
    expect(record.schemaRevision).toBe(11);
    expect(recordSchemaDrift(record)).toBeUndefined();
    expect(digest(record)).toBe(revisionElevenReadDigest);
    const impl = record.steps['impl'];
    const followups = record.steps['followups'];
    expect(impl?.status).toBe('failed');
    expect(impl).not.toHaveProperty('failureHistory');
    // Failed in both runs; the stamp is still the first run's failure.
    expect(impl?.failureStamp).toBeDefined();
    expect(impl?.failureStamp).toBeLessThan(impl?.settleStamp ?? 0);
    expect(followups?.status).toBe('completed');
    expect(followups?.launchStamp).toBeGreaterThanOrEqual(impl?.failureStamp ?? 0);
  });

  it('keep the conservative watermark: strict replay stops on the healed step as on main', async () => {
    await install();
    const invoked: string[] = [];
    const error = await runWorkflow(fanIn, resume(succeeding(invoked), true)).catch(
      (cause: unknown) => cause,
    );
    let divergence: unknown = error;
    while (divergence instanceof Error && !(divergence instanceof ReplayDivergenceError))
      divergence = divergence.cause;
    expect(divergence).toBeInstanceOf(ReplayDivergenceError);
    expect(divergence).toMatchObject({ reason: 'healed' });
    expect((divergence as Error).message).toContain(
      'Healed step impl now succeeded; later recorded steps (followups)',
    );
    expect(invoked).toEqual(['impl']);
    const saved = await readRun({ stateDir, runId });
    expect(saved.steps['impl']).toMatchObject({ status: 'completed' });
    expect(saved.steps['impl']).not.toHaveProperty('failureHistory');
    expect(saved.steps['impl']).not.toHaveProperty('failureStamp');
  });

  it('resume without strict replay, warn about followups, and save the current revision', async () => {
    await install();
    const invoked: string[] = [];
    const result = await runWorkflow(fanIn, resume(succeeding(invoked), false));
    expect(result.status).toBe('completed');
    expect(invoked).toEqual(['impl', 'ship']);
    const saved = await readRun({ stateDir, runId });
    expect(saved.replayWarnings?.[0]).toContain(
      'Healed step impl now succeeded; later recorded steps (followups)',
    );
    expect(recordSchemaDrift(saved)).toBeUndefined();
    expect((await rawSnapshot(runId))['schemaRevision']).toBe(SUPPORTED_SCHEMA_REVISION);
  });
});

describe('revision-twelve records (named-map steps before mapItems, #302)', () => {
  const runId = 'revision-twelve';
  async function install(): Promise<void> {
    const fixture = await readFile(
      new URL('./fixtures/schema-revision/revision-twelve-checkpoint.json', import.meta.url),
      'utf8',
    );
    await mkdir(join(stateDir, runId));
    await writeFile(paths(runId).snapshot, fixture);
    await writeFile(paths(runId).journal, '');
  }
  const keyed = (keys: string[], check: boolean) =>
    defineWorkflow({
      name: 'schema-revision',
      version: '1',
      input: z.null(),
      output: z.null(),
      async run(ctx) {
        await ctx.map('review', keys, { concurrency: 1, key: (key) => key }, async () => {
          await ctx.now('stamp');
          if (check) await ctx.now('check');
        });
        return null;
      },
    });
  const stampIds = ['review/a/stamp', 'review/b/stamp', 'review/gone/stamp'];

  it('read exactly as on main, with no recorded map items', async () => {
    await install();
    const record = await readRun({ stateDir, runId });
    expect(record.schemaRevision).toBe(12);
    expect(recordSchemaDrift(record)).toBeUndefined();
    expect(digest(record)).toBe(revisionTwelveReadDigest);
    expect(Object.keys(record.steps).sort()).toEqual(stampIds);
    for (const id of stampIds) {
      expect(record.steps[id]?.status).toBe('completed');
      expect(record.steps[id]).not.toHaveProperty('mapItems');
    }
  });

  it('resume at the current revision: live steps record map items, replayed ones stay as saved', async () => {
    await install();
    const result = await runWorkflow(keyed(['a', 'gone', 'b'], true), {
      ...options,
      stateDir,
      runId,
      input: null,
      resume: true,
    });
    expect(result.status).toBe('completed');
    const saved = await readRun({ stateDir, runId });
    const invocation = digest(['0', 'review/a/', 'review/b/', 'review/gone/']);
    expect(saved.steps['review/b/check']?.mapItems).toEqual([{ item: 'review/b/', invocation }]);
    expect(saved.steps['review/b/stamp']).not.toHaveProperty('mapItems');
    expect(recordSchemaDrift(saved)).toBeUndefined();
    expect((await rawSnapshot(runId))['schemaRevision']).toBe(SUPPORTED_SCHEMA_REVISION);
  });

  it('fork without the removed key conservatively: a later surviving item runs live', async () => {
    await install();
    const fork = await runWorkflow(keyed(['a', 'b'], false), {
      ...options,
      stateDir,
      runId: 'revision-twelve-fork',
      input: null,
      forkFrom: { runId },
    });
    expect(fork.status).toBe('completed');
    // 'b' launched after the unrecorded 'gone' item settled, so it may have depended on it.
    expect(fork.steps['review/a/stamp']?.reusedFrom).toMatchObject({ runId });
    expect(fork.steps['review/b/stamp']?.reusedFrom).toBeUndefined();
    expect(fork.steps['review/b/stamp']?.mapItems).toEqual([
      { item: 'review/b/', invocation: digest(['0', 'review/a/', 'review/b/']) },
    ]);
    expect(fork.forkedFrom).toMatchObject({ cursor: 1 });
  });
});
