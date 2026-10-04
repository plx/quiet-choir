// Run records carry a schemaRevision (#167). A build refuses to rewrite a record with a newer
// revision or with top-level fields it does not know, because its parse strips them and the next
// compaction would delete them; reads tolerate both and report the hidden field names.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defineWorkflow,
  FileRunStore,
  readRun,
  RunRefusedError,
  runWorkflow,
  z,
  type OwnedRunStore,
  type RunRecord,
  type RunStore,
} from '../src/index.js';
import { rehearsalState } from '../src/workflow/loader/rehearsal.js';
import { JournalWriter } from '../src/workflow/runtime/journal.js';
import { cleanWorktrees } from '../src/workflow/runtime/worktree-clean.js';
import { digest } from '../src/workflow/runtime/json.js';
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
};
// digest(readRun(...)) of the installed pre-revision fixture, computed on unmodified main 91a6d2f.
const preRevisionReadDigest = '714b6cb068de5c933b7ba04a26d1f931f589f7c9910f76f0e5c8cc493eb13016';

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
      if (revision > 1) expect(keys).not.toEqual(revisions[String(revision - 1)]);
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
      schemaRevision: 1,
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
    ]);
    expect((await refusal(readRun({ stateDir, runId: 'journal' }))).code).toBe('run.incompatible');

    // Without a newer revision the same damage is still an ordinary read failure.
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
      { schemaRevision: 1, hiddenFields: ['futureBudget'] },
    ],
    [
      'an unknown journaled run field',
      async (runId: string) => {
        await appendRunChanges(runId, [{ area: 'run', key: 'futureLedger', value: [1] }]);
      },
      { schemaRevision: 1, hiddenFields: ['futureLedger'] },
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
