// Codex has one effort option (#341). Calls recorded with the old reasoningEffort keep their
// identity, persisted records and saved policy read the old key as effort, and the old shared
// Codex effort (identity option.effort) changes identity once, as the CHANGELOG documents.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { defineWorkflow, readRun, runWorkflow, z } from '../src/index.js';
import { summarizeRun } from '../src/workflow/loader/inspection.js';
import { parseJournalEntry, replayJournal } from '../src/workflow/runtime/journal.js';
import { legacyAgentIdentity } from '../src/workflow/runtime/legacy-agent.js';
import { parseRunRecord } from '../src/workflow/runtime/record.js';

const identityDigest = (identity: Readonly<Record<string, string>>): string =>
  createHash('sha256')
    .update(
      JSON.stringify(Object.entries(identity).sort(([left], [right]) => (left < right ? -1 : 1))),
    )
    .digest('hex');
const identity = (harness: 'claude' | 'codex', options: object) =>
  legacyAgentIdentity(
    {
      harness,
      cwd: '/pinned/cwd',
      outputSchema: null,
      options: { prompt: 'pinned prompt', ...options },
    },
    { type: 'object' },
  );

// Digests computed on origin/main (c73138f) before #341, for the pinned request above.
const golden = {
  codexReasoningEffort: {
    low: '3a1bbc1bc1c3dfad5979b0b54cfa7bb6016986128f59a7f5b74c6d85aeb23f18',
    none: '2ecb9e2481b615939dc2f55f4e6bb4a79906a79bdd083891e205c9701f6f42f1',
    minimal: '4d408cdef16587f87bec5c71b2bb0a4af9214fed39d4f1388dc671fb5af5423b',
    xhigh: 'faac09f785dea0b65d3a55a35b49ed7e208e0fde8eba05fadba34cac5c6f99fb',
  },
  /** The old shared Codex effort, fingerprinted as option.effort. */
  codexSharedEffortLow: '74601834304c3ff911d8253195a3bb942796e9733fdc9beaf0d2be545b4f235b',
  codexUnset: '440c8defac487e76bb6686deb544bdf0553a52b56d91279b91ba6d01dbe148cc',
  claudeEffortLow: 'beb6429fa6825bf739c5fc9f47d80332732077bffaf6da355d2c30cb2648efd0',
  claudeUnset: '6cdb34dfd55771957661f8150ad86830e6791439061f8645bcbacdf324a13229',
} as const;

it.each(Object.entries(golden.codexReasoningEffort))(
  'fingerprints Codex effort %s exactly as the pre-#341 reasoningEffort',
  (level, digest) => {
    expect(identityDigest(identity('codex', { effort: level }))).toBe(digest);
  },
);

it('pins the one-time identity change for the old shared Codex effort and leaves Claude alone', () => {
  const codex = identity('codex', { effort: 'low' });
  expect(identityDigest(codex)).toBe(golden.codexReasoningEffort.low);
  expect(identityDigest(codex)).not.toBe(golden.codexSharedEffortLow);
  expect(codex).not.toHaveProperty('option.effort');
  expect(identityDigest(identity('codex', {}))).toBe(golden.codexUnset);
  const claude = identity('claude', { effort: 'low' });
  expect(identityDigest(claude)).toBe(golden.claudeEffortLow);
  expect(claude).toHaveProperty('option.effort');
  expect(identityDigest(identity('claude', {}))).toBe(golden.claudeUnset);
});

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'choir-effort-'));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const fixture = (name: string) =>
  readFile(new URL(`./fixtures/codex-effort/${name}-checkpoint.json`, import.meta.url), 'utf8');
async function install(name: string, runId: string): Promise<string> {
  const bytes = await fixture(name);
  await mkdir(join(stateDir, runId));
  await writeFile(join(stateDir, runId, 'run.json'), bytes);
  await writeFile(join(stateDir, runId, 'journal.jsonl'), '');
  return bytes;
}
const refuse = {
  invoke(): never {
    throw new Error('replay must not invoke');
  },
};
const tunedFingerprint = 'e5fc900e5bc6a63633db8f94c2c784158ea417574dda83b3c95d2b646ef772c1';

it('reads a pre-#341 checkpoint with effort in attempts, saved policy and the capability manifest', async () => {
  await install('pre-effort', 'pre-effort');
  const record = await readRun({ stateDir, runId: 'pre-effort' });
  const attempt = record.steps['tuned']?.attemptHistory?.[0];
  expect(attempt).toMatchObject({ effort: 'high', sources: { reasoningEffort: 'override:0' } });
  expect(attempt).not.toHaveProperty('reasoningEffort');
  expect(record.policy).toEqual([{ kind: 'codex', match: 'tuned', effort: 'high' }]);
  expect(record.capabilities?.profiles['scout']?.codex).toMatchObject({ effort: 'low' });
  expect(record.capabilities?.profiles['scout']?.codex).not.toHaveProperty('reasoningEffort');
});

it('resumes a checkpoint recorded with Codex reasoningEffort after the source moves to effort', async () => {
  await install('pre-effort', 'pre-effort');
  const definition = defineWorkflow({
    name: 'effort-compatibility',
    version: '1',
    input: z.null(),
    output: z.null(),
    profiles: { scout: { extends: 'text', codex: { effort: 'low' } } },
    async run(ctx) {
      await ctx.codex.text('tuned', { prompt: 'a', profile: 'scout' });
      return null;
    },
  });
  const result = await runWorkflow(definition, {
    stateDir,
    cwd: '/',
    runId: 'pre-effort',
    resume: true,
    fingerprint: 'effort-compatibility',
    harness: refuse,
  });
  expect(result.status).toBe('completed');
  expect(result.steps['tuned']?.fingerprint).toBe(tunedFingerprint);
  const saved = await readRun({ stateDir, runId: 'pre-effort' });
  expect(saved.steps['tuned']?.attemptHistory).toHaveLength(1);
  expect(saved.steps['tuned']?.attemptHistory?.[0]).toMatchObject({ effort: 'high' });
  expect(saved.steps['tuned']?.attemptHistory?.[0]).not.toHaveProperty('reasoningEffort');
  expect(saved.policy).toEqual([{ kind: 'codex', match: 'tuned', effort: 'high' }]);
  expect(saved.capabilities?.profiles['scout']?.codex).toMatchObject({ effort: 'low' });
  // New writes carry effort; the identity slot and the sources provenance keep their names.
  const bytes = JSON.parse(await readFile(join(stateDir, 'pre-effort', 'run.json'), 'utf8')) as {
    steps: Record<string, { attemptHistory: object[]; identity: object }>;
    policy: object[];
  };
  expect(bytes.steps['tuned']?.attemptHistory[0]).toMatchObject({ effort: 'high' });
  expect(bytes.steps['tuned']?.attemptHistory[0]).not.toHaveProperty('reasoningEffort');
  expect(bytes.steps['tuned']?.identity).toHaveProperty('reasoningEffort');
  expect(bytes.policy).toEqual([{ effort: 'high', kind: 'codex', match: 'tuned' }]);
});

it('refuses to reuse a call recorded with the old shared Codex effort and points to a fork', async () => {
  await install('pre-shared-effort', 'pre-shared-effort');
  const definition = defineWorkflow({
    name: 'effort-shared',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.codex.text('shared', { prompt: 'a', effort: 'low' });
      return null;
    },
  });
  const options = {
    stateDir,
    cwd: '/',
    runId: 'pre-shared-effort',
    resume: true,
    fingerprint: 'effort-shared',
    harness: refuse,
  } as const;
  const drift =
    'Step shared: option.effort, reasoningEffort changed on a completed step; --accept-code-change cannot reuse it. Fork a new run with --fork-from RUN --reuse matching --invalidate shared.';
  await expect(runWorkflow(definition, options)).rejects.toThrow(drift);
  // The documented recovery is a fork that re-runs the step; accepting the change cannot reuse it.
  await expect(runWorkflow(definition, { ...options, acceptCodeChange: true })).rejects.toThrow(
    drift,
  );
});

it('shows a legacy attempt effort in the inspection summary', async () => {
  const raw = JSON.parse(await fixture('pre-effort')) as {
    steps: Record<string, { attemptHistory: Record<string, unknown>[] }>;
  };
  // Older records may lack requested; the summary then falls back to the attempt effort.
  delete raw.steps['tuned']?.attemptHistory[0]?.['requested'];
  const record = parseRunRecord(JSON.stringify(raw), 'pre-effort');
  const unlocked = { locked: false, owner: null, processes: [], locks: [] } as const;
  const summary = summarizeRun(record, unlocked);
  expect(summary.agents.byRequest).toEqual([
    expect.objectContaining({ harness: 'codex', effort: 'high', profile: 'scout' }),
  ]);
  expect(summary.agents.recent[0]).toMatchObject({ id: 'tuned', effort: 'high' });
});

it('replays journal entries written with the legacy key as effort', async () => {
  const snapshot = await fixture('pre-effort');
  const raw = JSON.parse(snapshot) as {
    steps: Record<string, { attemptHistory: Record<string, unknown>[] }>;
  };
  const step = raw.steps['tuned'];
  const entry = {
    seq: 5,
    at: '2026-10-03T08:32:34.000Z',
    changes: [
      { area: 'steps', key: 'journaled', value: { ...step, seq: 2 } },
      { area: 'run', key: 'policy', value: [{ kind: 'codex', reasoningEffort: 'minimal' }] },
    ],
  };
  const record = replayJournal(snapshot, `${JSON.stringify(entry)}\n`, 'pre-effort');
  expect(record.steps['journaled']?.attemptHistory?.[0]).toMatchObject({ effort: 'high' });
  expect(record.steps['journaled']?.attemptHistory?.[0]).not.toHaveProperty('reasoningEffort');
  expect(record.policy).toEqual([{ kind: 'codex', effort: 'minimal' }]);
});

it('rejects a persisted attempt, policy rule or manifest holding both effort keys', async () => {
  const snapshot = await fixture('pre-effort');
  const both = (mutate: (raw: Record<string, unknown>) => void): string => {
    const raw = JSON.parse(snapshot) as Record<string, unknown>;
    mutate(raw);
    return JSON.stringify(raw);
  };
  const attempt = (raw: Record<string, unknown>) =>
    (raw['steps'] as Record<string, { attemptHistory: Record<string, unknown>[] }>)['tuned']
      ?.attemptHistory[0] ?? {};
  expect(() =>
    parseRunRecord(
      both((raw) => {
        attempt(raw)['effort'] = 'low';
      }),
      'pre-effort',
    ),
  ).toThrow('"steps"');
  expect(() =>
    parseRunRecord(
      both((raw) => {
        delete attempt(raw)['reasoningEffort'];
      }),
      'pre-effort',
    ),
  ).toThrow('"steps"');
  expect(() =>
    parseRunRecord(
      both((raw) => {
        raw['policy'] = [{ kind: 'codex', effort: 'low', reasoningEffort: 'high' }];
      }),
      'pre-effort',
    ),
  ).toThrow('both effort and legacy reasoningEffort');
  expect(() =>
    parseRunRecord(
      both((raw) => {
        const capabilities = raw['capabilities'] as {
          profiles: Record<string, { codex: Record<string, unknown> }>;
        };
        Object.assign(capabilities.profiles['scout']?.codex ?? {}, { effort: 'high' });
      }),
      'pre-effort',
    ),
  ).toThrow('both effort and legacy reasoningEffort');
  const raw = JSON.parse(snapshot) as {
    steps: Record<string, { attemptHistory: Record<string, unknown>[] }>;
  };
  const step = raw.steps['tuned'];
  const journaled = {
    seq: 5,
    at: '2026-10-03T08:32:34.000Z',
    changes: [
      {
        area: 'steps',
        key: 'tuned',
        value: {
          ...step,
          attemptHistory: [{ ...step?.attemptHistory[0], effort: 'low' }],
        },
      },
    ],
  };
  expect(() => parseJournalEntry(journaled)).toThrow(
    'An attempt records exactly one of effort or legacy reasoningEffort.',
  );
  expect(() =>
    parseJournalEntry({
      ...journaled,
      changes: [{ area: 'run', key: 'policy', value: [{ effort: 'low', reasoningEffort: 'low' }] }],
    }),
  ).toThrow('both effort and legacy reasoningEffort');
});
