// quiet-choir/std result schemas: every pattern result interface has a Zod schema of the same name
// (a factory for the generic ones), each converts to draft-7 JSON Schema, its JSON Schema is pinned
// (a workflow that returns one as its output records that schema's digest in its identity), every
// root is a strict object whose properties are all required, the factories check what varies, and
// a workflow can use one directly as its output schema and resume with it. Each pattern suite also
// round-trips the real results it produces through these schemas.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  NodeProcessRunner,
  assertCompleted,
  defineWorkflow,
  runWorkflow,
  z,
  type MergeResult,
} from '../src/index.js';
import * as std from '../src/std/index.js';
import * as aggregate from '../src/std/aggregate.js';
import * as data from '../src/std/data.js';
import * as edits from '../src/std/edits.js';
import * as gates from '../src/std/gates.js';
import * as investigate from '../src/std/investigate.js';
import * as lenses from '../src/std/lenses.js';
import * as panels from '../src/std/panels.js';
import * as patterns from '../src/std/patterns.js';
import * as revise from '../src/std/revise.js';
import * as select from '../src/std/select.js';
import * as types from '../src/std/types.js';
import {
  ScriptedHarness,
  makeRoot,
  removeRoot,
  replayAfterTail,
  roundTrip,
  runOptions,
} from './std-harness.js';

let root: string;
beforeEach(async () => {
  root = await makeRoot('choir-std-results-');
});
afterEach(async () => {
  await removeRoot(root);
});

const routes = { fix: 'A small fix.', docs: 'Documentation only.' } as const;
const labels = { bug: 'Something is broken.', feature: 'New behavior.' } as const;

/**
 * Every result schema and the helper schemas they use, by the expression that makes it: the plain
 * schemas, and each factory with its default and a representative argument.
 */
const schemas: Readonly<Record<string, z.ZodType>> = {
  'data.Health': data.Health,
  'data.Coverage': data.Coverage,
  'lenses.LensSchema': lenses.LensSchema,
  'patterns.ReviewReviseResult': patterns.ReviewReviseResult,
  'patterns.TolerantPanelResult()': patterns.TolerantPanelResult(),
  'patterns.TolerantPanelResult(Ballot)': patterns.TolerantPanelResult(types.Ballot),
  'panels.LensAnswer(Findings)': panels.LensAnswer(types.Findings),
  'panels.LensPanelResult(Findings)': panels.LensPanelResult(types.Findings),
  'panels.VoteResult': panels.VoteResult,
  'panels.Verified(Finding)': panels.Verified(types.Finding),
  'panels.VerifyResult(Finding)': panels.VerifyResult(types.Finding),
  'panels.VerifyResult(string)': panels.VerifyResult(z.string()),
  'panels.HuntResult': panels.HuntResult,
  'revise.CritiqueReviseResult': revise.CritiqueReviseResult,
  'revise.EscalationSlot': revise.EscalationSlot,
  'revise.FixRound': revise.FixRound,
  'revise.FixUntilGreenResult': revise.FixUntilGreenResult,
  'revise.EscalateResult()': revise.EscalateResult(),
  'revise.EscalateResult(Ballot)': revise.EscalateResult(types.Ballot),
  'select.TournamentEntry': select.TournamentEntry,
  'select.Standing': select.Standing,
  'select.TournamentResult': select.TournamentResult,
  'select.RankResult(string)': select.RankResult(z.string()),
  'select.RouteResult()': select.RouteResult(),
  'select.RouteResult(routes)': select.RouteResult(routes),
  'select.Assignment(string, labels)': select.Assignment(z.string(), labels),
  'select.LabelCount(labels)': select.LabelCount(labels),
  'select.ClassifyResult(string)': select.ClassifyResult(z.string()),
  'select.ClassifyResult(string, labels)': select.ClassifyResult(z.string(), labels),
  'aggregate.MapReducePart()': aggregate.MapReducePart(),
  'aggregate.MapReduceResult()': aggregate.MapReduceResult(),
  'aggregate.MapReduceResult(Changes)': aggregate.MapReduceResult(types.Changes),
  'aggregate.DecomposeResult': aggregate.DecomposeResult,
  'gates.ChecklistEntry': gates.ChecklistEntry,
  'gates.ChecklistCounts': gates.ChecklistCounts,
  'gates.ChecklistResult': gates.ChecklistResult,
  'gates.GateDisposition': gates.GateDisposition,
  'gates.GateChallenge': gates.GateChallenge,
  'gates.GateDimension': gates.GateDimension,
  'gates.GateResult': gates.GateResult,
  'investigate.TestedHypothesis': investigate.TestedHypothesis,
  'investigate.FalsifyConfidence': investigate.FalsifyConfidence,
  'investigate.FalsifyResult': investigate.FalsifyResult,
  'investigate.ResearchResult': investigate.ResearchResult,
  'edits.EditChange': edits.EditChange,
  'edits.EditViolation': edits.EditViolation,
  'edits.MergeResult': edits.MergeResult,
  'edits.IsolatedEditsResult': edits.IsolatedEditsResult,
  'edits.ApprovedPlanResult': edits.ApprovedPlanResult,
};

/** The schemas above that are a pattern result: the `*Result` names. */
const results = Object.entries(schemas).filter(([name]) => /Result\b/u.test(name));

/** The draft-7 JSON Schema of `schema`, as a workflow's output-schema identity records it. */
function draft7(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' });
}

/** The modules whose result interfaces must each have a same-named schema. */
const modules: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  patterns,
  panels,
  revise,
  select,
  aggregate,
  gates,
  investigate,
  edits,
};

describe('std result schemas', () => {
  it('give every exported result interface of the pattern modules a same-named schema', () => {
    for (const [name, module] of Object.entries(modules)) {
      const source = readFileSync(new URL(`../src/std/${name}.ts`, import.meta.url), 'utf8');
      const interfaces = [...source.matchAll(/^export interface (\w+Result)\b/gmu)].map(
        (match) => match[1] ?? '',
      );
      expect(interfaces.length, name).toBeGreaterThan(0);
      for (const result of interfaces) {
        const value = module[result];
        expect(value instanceof z.ZodType || typeof value === 'function', result).toBe(true);
        expect(std.patterns[result as keyof typeof std.patterns], result).toBe(value);
      }
    }
  });

  it('list every exported schema of the pattern modules here', () => {
    const exported = Object.entries(modules).flatMap(([name, module]) =>
      Object.entries(module)
        .filter(([, value]) => value instanceof z.ZodType)
        .map(([key]) => `${name}.${key}`),
    );
    const listed = new Set(Object.keys(schemas).map((name) => name.replace(/\(.*$/u, '')));
    // patterns re-exports every module, so a schema is listed under the module that defines it.
    for (const name of exported) {
      const key = name.slice(name.indexOf('.') + 1);
      const owners = [...listed].filter((entry) => entry.endsWith(`.${key}`));
      expect(owners, name).toHaveLength(1);
    }
  });

  it.each(Object.entries(schemas))('%s converts to draft-7 JSON Schema', (_name, schema) => {
    expect(() => z.toJSONSchema(schema, { target: 'draft-7' })).not.toThrow();
    expect(() => z.toJSONSchema(schema)).not.toThrow();
  });

  it('pins every JSON Schema, since a workflow output schema is part of its identity', () => {
    // A failure here means a released result schema changed: a run whose workflow returns it as its
    // output would need --accept-code-change to resume. Change it deliberately or not at all.
    const digests = Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [
        name,
        createHash('sha256')
          .update(JSON.stringify(draft7(schema)))
          .digest('hex')
          .slice(0, 16),
      ]),
    );
    expect(digests).toEqual({
      'aggregate.DecomposeResult': '9af57334efca79c4',
      'aggregate.MapReducePart()': 'e37e600edbce8464',
      'aggregate.MapReduceResult()': '0cd6809dee6e3200',
      'aggregate.MapReduceResult(Changes)': '1610d1cbeed23958',
      'data.Coverage': '50daa7d2424b7006',
      'data.Health': 'c9207cff1d833d67',
      'edits.ApprovedPlanResult': 'fcb7b96dba7da61c',
      'edits.EditChange': '2d0ed44fd080326b',
      'edits.EditViolation': 'd09bb026b523b0c2',
      'edits.IsolatedEditsResult': 'efc3ba1dfd5e7882',
      'edits.MergeResult': 'c7089e33adf36284',
      'gates.ChecklistCounts': '76006ccb18c1a9ed',
      'gates.ChecklistEntry': '1546c3ad29889db0',
      'gates.ChecklistResult': '9eea45f7df01cd40',
      'gates.GateChallenge': '972546a0c599efea',
      'gates.GateDimension': '30fb015890a81dd1',
      'gates.GateDisposition': 'aa2c4df69dafc3a1',
      'gates.GateResult': 'f191ab23cd94213f',
      'investigate.FalsifyConfidence': '38b9e41da685c658',
      'investigate.FalsifyResult': '775b45dc28bae825',
      'investigate.ResearchResult': '8f67104206b1196c',
      'investigate.TestedHypothesis': '8709d9e612b378d0',
      'lenses.LensSchema': '62a7795cb2b65fb1',
      'panels.HuntResult': 'd54cc2996a291816',
      'panels.LensAnswer(Findings)': '1e2ba1b9924b61bb',
      'panels.LensPanelResult(Findings)': 'ac730fc95e5d220b',
      'panels.Verified(Finding)': 'ebf1cfe593d79309',
      'panels.VerifyResult(Finding)': '7e95024e354918e1',
      'panels.VerifyResult(string)': 'a1f65ab214749758',
      'panels.VoteResult': '6d45e560c9957354',
      'patterns.ReviewReviseResult': 'c77eb470eb81ca23',
      'patterns.TolerantPanelResult()': 'e78cfcbdbe4d464b',
      'patterns.TolerantPanelResult(Ballot)': '67fc950b20f8b346',
      'revise.CritiqueReviseResult': '6e366e5b996833cf',
      'revise.EscalateResult()': '4bd949f41f0b3be2',
      'revise.EscalateResult(Ballot)': '04d4f80f28049ed4',
      'revise.EscalationSlot': '9a92ca356ea0ecdb',
      'revise.FixRound': 'e6c88c6a0bfed34c',
      'revise.FixUntilGreenResult': '36a864eb1b99566e',
      'select.Assignment(string, labels)': '960e9d5b1df23e57',
      'select.ClassifyResult(string)': '534adbf688753653',
      'select.ClassifyResult(string, labels)': '46bd7329552c71da',
      'select.LabelCount(labels)': 'd41b0286e7ba190b',
      'select.RankResult(string)': '48a75866ec464522',
      'select.RouteResult()': 'b92db0cf3e3c80cf',
      'select.RouteResult(routes)': '9f0124d848707d7c',
      'select.Standing': 'f743432ae7b90cbf',
      'select.TournamentEntry': '118857273f863f0c',
      'select.TournamentResult': '707b1b6d1005eb59',
    });
  });

  it.each(results)('%s is a strict object whose properties are all required', (_name, schema) => {
    expect(schema).toBeInstanceOf(z.ZodObject);
    expect((schema as z.ZodObject)._zod.def.catchall).toBeInstanceOf(z.ZodNever);
    const json = draft7(schema);
    expect(json['type']).toBe('object');
    expect(json['additionalProperties']).toBe(false);
    const properties = Object.keys(json['properties'] as Record<string, unknown>);
    expect([...(json['required'] as string[])].sort()).toEqual([...properties].sort());
  });

  const hunt: panels.HuntResult = {
    findings: [],
    confirmed: [],
    refuted: [],
    undecided: [],
    unverified: [],
    rounds: 2,
    dryRounds: 2,
    failedFinders: 0,
    failedVotes: 0,
    callsAdmitted: 6,
    ended: 'dry',
    failures: 0,
    status: 'complete',
  };

  it('refuses an unknown member, a missing one and a status outside complete and degraded', () => {
    roundTrip(panels.HuntResult, hunt);
    expect(panels.HuntResult.safeParse({ ...hunt, extra: 1 }).success).toBe(false);
    const missing = Object.fromEntries(Object.entries(hunt).filter(([key]) => key !== 'failures'));
    expect(panels.HuntResult.safeParse(missing).success).toBe(false);
    expect(panels.HuntResult.safeParse({ ...hunt, status: 'green' }).success).toBe(false);
    expect(panels.HuntResult.safeParse({ ...hunt, rounds: -1 }).success).toBe(false);
    expect(panels.HuntResult.safeParse({ ...hunt, rounds: 1.5 }).success).toBe(false);
    expect(data.Health.options).toEqual(['complete', 'degraded']);
  });

  it('check what a factory varies: the item, the value, the routes and the labels', () => {
    const verdict = (item: unknown) => ({
      key: 'k',
      item,
      outcome: 'confirmed',
      upheld: 1,
      against: 0,
      missing: 0,
      seats: 1,
      reasons: ['upheld: yes'],
    });
    const verified = {
      confirmed: [verdict('a claim')],
      refuted: [],
      undecided: [],
      failedVotes: 0,
      failures: 0,
      status: 'complete',
    };
    roundTrip(panels.VerifyResult(z.string()), verified);
    expect(panels.VerifyResult(types.Finding).safeParse(verified).success).toBe(false);

    const escalated = {
      outcome: 'rejected',
      slot: 'surgeon',
      attempts: 2,
      value: null,
      problems: 'Still failing.',
      failedCalls: 1,
      failures: 1,
      status: 'degraded',
    };
    roundTrip(revise.EscalateResult(), escalated);
    roundTrip(revise.EscalateResult(types.Ballot), escalated);
    const answered = { ...escalated, value: { yes: true, reasoning: 'checked' } };
    roundTrip(revise.EscalateResult(types.Ballot), answered);
    expect(revise.EscalateResult().safeParse(answered).success).toBe(false);
    expect(revise.EscalateResult().safeParse({ ...escalated, slot: 'judge' }).success).toBe(false);

    const routed = { route: 'docs', reason: 'r', fallback: false, failures: 0, status: 'complete' };
    roundTrip(select.RouteResult(routes), routed);
    roundTrip(select.RouteResult(['docs']), routed);
    roundTrip(select.RouteResult(), { ...routed, route: 'anything' });
    expect(select.RouteResult(routes).safeParse({ ...routed, route: 'other' }).success).toBe(false);
    expect(() => select.RouteResult([])).toThrow('routes must not be empty.');
    expect(() => select.ClassifyResult(z.string(), {})).toThrow('labels must not be empty.');

    const parts = { keys: ['a'], value: 'summary' };
    roundTrip(aggregate.MapReducePart(), parts);
    expect(aggregate.MapReducePart(types.Changes).safeParse(parts).success).toBe(false);
  });

  it('type each schema as its interface, the factories by their arguments', () => {
    expectTypeOf(revise.FixUntilGreenResult).toEqualTypeOf<z.ZodType<revise.FixUntilGreenResult>>();
    expectTypeOf(panels.VerifyResult(types.Finding)).toEqualTypeOf<
      z.ZodType<panels.VerifyResult<types.Finding>>
    >();
    expectTypeOf(revise.EscalateResult()).toEqualTypeOf<
      z.ZodType<revise.EscalateResult<types.WorkReport>>
    >();
    expectTypeOf(aggregate.MapReduceResult()).toEqualTypeOf<
      z.ZodType<aggregate.MapReduceResult<string>>
    >();
    expectTypeOf(select.RouteResult(routes)).toEqualTypeOf<
      z.ZodType<select.RouteResult<'fix' | 'docs'>>
    >();
    expectTypeOf(select.RouteResult(['fix', 'docs'])).toEqualTypeOf<
      z.ZodType<select.RouteResult<'fix' | 'docs'>>
    >();
    expectTypeOf(select.RouteResult()).toEqualTypeOf<z.ZodType<select.RouteResult<string>>>();
    expectTypeOf(select.ClassifyResult(z.number(), labels)).toEqualTypeOf<
      z.ZodType<select.ClassifyResult<number, 'bug' | 'feature'>>
    >();
    expectTypeOf(select.TournamentResult).toEqualTypeOf<
      z.ZodType<select.TournamentResult<string>>
    >();
    // A result over the default rubric is a result over string criteria.
    expectTypeOf<select.TournamentResult>().toExtend<select.TournamentResult<string>>();
    expectTypeOf<z.infer<typeof data.Health>>().toEqualTypeOf<data.Health>();
    expectTypeOf<z.infer<typeof revise.EscalationSlot>>().toEqualTypeOf<revise.EscalationSlot>();
    expectTypeOf<z.infer<typeof gates.GateDisposition>>().toEqualTypeOf<gates.GateDisposition>();
    expectTypeOf<
      z.infer<typeof investigate.FalsifyConfidence>
    >().toEqualTypeOf<investigate.FalsifyConfidence>();
    expectTypeOf<edits.MergeResult>().toEqualTypeOf<MergeResult>();
  });
});

/** The check script: it passes when state.txt says green. */
const CHECK_SCRIPT = `import { readFileSync } from 'node:fs';
const state = readFileSync('state.txt', 'utf8').trim();
if (state === 'green') { console.log('all tests passed'); process.exit(0); }
console.error('FAIL: state is ' + state);
process.exit(1);
`;

describe('a result schema as a workflow output', () => {
  /** A workflow that returns fixUntilGreen's result under its own schema. */
  const repair = defineWorkflow({
    name: 'repair',
    version: '1',
    input: z.null(),
    output: std.patterns.FixUntilGreenResult,
    run: (ctx) => {
      const agent = ctx.claude.bind({});
      return std.patterns.fixUntilGreen(ctx, {
        id: 'fix',
        team: { mechanic: agent, surgeon: agent },
        check: [process.execPath, 'check.mjs'],
      });
    },
  });
  const report = {
    status: 'done',
    summary: 'Fixed it.',
    files: ['state.txt'],
    blockers: [],
    notes: [],
  };

  it('validates and resumes a fixUntilGreen result as the workflow output', async () => {
    await writeFile(join(root, 'check.mjs'), CHECK_SCRIPT);
    await writeFile(join(root, 'state.txt'), 'red\n');
    const harness = new ScriptedHarness(async (request) => {
      await writeFile(join(request.cwd, 'state.txt'), 'green\n');
      return report;
    });
    const result = await replayAfterTail(repair, null, harness, root, 'repair', {
      processRunner: new NodeProcessRunner(),
    });
    assertCompleted(result);
    expectTypeOf(result.output).toExtend<revise.FixUntilGreenResult>();
    expect(result.output).toMatchObject({
      outcome: 'green',
      rounds: 1,
      fixedBy: 'mechanic',
      fixes: [{ round: 1, slot: 'mechanic', report, error: null }],
      failures: 0,
      status: 'complete',
    });
    expect(result.output.checks.map((check) => check.passed)).toEqual([false, true]);
    expect(harness.ids()).toEqual(['fix/fix/1']);
  });

  it('refuses a body that returns something else', async () => {
    const wrong = defineWorkflow({
      ...repair,
      name: 'wrong',
      run: async (ctx) => {
        const result = await repair.run(ctx, null);
        return { ...result, status: 'green' } as unknown as revise.FixUntilGreenResult;
      },
    });
    await writeFile(join(root, 'check.mjs'), CHECK_SCRIPT);
    await writeFile(join(root, 'state.txt'), 'green\n');
    const harness = new ScriptedHarness(() => report);
    await expect(
      runWorkflow(wrong, {
        ...runOptions(root, 'wrong'),
        harness,
        processRunner: new NodeProcessRunner(),
        input: null,
      }),
    ).rejects.toThrow(/"path": \[\s*"status"\s*\]/u);
  });

  it('takes a factory result as the output, such as a verify over string claims', async () => {
    const claims = defineWorkflow({
      name: 'claims',
      version: '1',
      input: z.null(),
      output: std.patterns.VerifyResult(z.string()),
      run: (ctx) =>
        std.patterns.verify(ctx, {
          id: 'verify',
          team: { skeptic: ctx.claude.bind({}) },
          items: ['The cache is never invalidated.', 'The parser is linear.'],
          seats: 1,
        }),
    });
    const harness = new ScriptedHarness((request) => ({
      refuted: request.stepId.startsWith('verify/item/1/'),
      reasoning: 'Checked the code.',
    }));
    const result = await replayAfterTail(claims, null, harness, root, 'claims');
    assertCompleted(result);
    expectTypeOf(result.output).toExtend<panels.VerifyResult<string>>();
    expect(result.output.confirmed.map((verdict) => verdict.item)).toEqual([
      'The cache is never invalidated.',
    ]);
    expect(result.output.refuted.map((verdict) => verdict.item)).toEqual(['The parser is linear.']);
  });
});
