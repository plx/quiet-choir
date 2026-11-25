// quiet-choir/std types (std.types): every exported schema's JSON Schema is pinned (descriptions
// are call identity); every agent-output schema and builder result passes the Codex
// structured-output check and carries no pattern or format validator; the input-side primitives
// and records (Commit, Criteria) accept and reject representative samples; Approval stays the exact schema reviewRevise sends;
// and the builders validate their arguments. Type assertions are checked by `npm run typecheck`.
import { createHash } from 'node:crypto';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { checkCodexSchema, z, type Command, type WriteFileResult } from '../src/index.js';
import * as types from '../src/std/types.js';

/**
 * Exports that use a pattern, a format, a tuple or an array root, and so are input-side only.
 */
const inputOnly = new Set([
  'Sha',
  'ShortSha',
  'Sha256',
  'Key',
  'Argv',
  'Receipt',
  'Commit',
  'Criteria',
]);

/** Every exported schema, by export name. */
const schemas: [string, z.ZodType][] = [];
for (const [name, value] of Object.entries(types) as [string, unknown][])
  if (value instanceof z.ZodType) schemas.push([name, value]);

/** `schema` itself when it has an object root, otherwise wrapped as `{ value }`. */
function rooted(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodObject ? schema : z.object({ value: schema });
}

/** The JSON Schema keys anywhere in `schema`'s JSON Schema. */
function jsonKeys(schema: z.ZodType): Set<string> {
  const keys = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        keys.add(key);
        visit(child);
      }
  };
  visit(z.toJSONSchema(schema));
  return keys;
}

/** The JSON Schema of each property of an object schema. */
function properties(schema: z.ZodType): Record<string, { description?: string }> {
  const json = z.toJSONSchema(schema) as { properties?: Record<string, { description?: string }> };
  return json.properties ?? {};
}

describe('agent-output schemas', () => {
  const agentOutput = schemas.filter(([name]) => !inputOnly.has(name));

  it('pins every JSON Schema, since schemas and descriptions are part of call identity', () => {
    // A failure here means a released schema changed: every completed call that sent it would
    // refuse to replay. Add a new schema instead, unless the change is deliberate. The digest is
    // of the draft-7 form that agent-call identity records.
    const digests = Object.fromEntries(
      schemas.map(([name, schema]) => [
        name,
        createHash('sha256')
          .update(JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' })))
          .digest('hex')
          .slice(0, 16),
      ]),
    );
    expect(digests).toEqual({
      Approval: '89d7d32c24e86e79',
      Argv: '82398e889f582f95',
      Assessment: '5f9a4ca87d5832cf',
      Ballot: 'a1dc826254749aa9',
      Change: 'bf18c5f4f85e0341',
      ChangeKind: 'ce403e21efb57f19',
      Changes: '93b77a1cbf70ad88',
      CheckOutcome: '3d12231247fb4d49',
      CheckStatus: '3a1fd89e37693b6d',
      Citation: '94d0ba4c53260c2b',
      Claims: '4468014e15ea8def',
      Commit: '766d25d2ac8d3e18',
      Complexity: '12edf4e6cbe1a62f',
      Criteria: '3c07cc855e6106c0',
      Criterion: 'e964080b268887b5',
      CriterionResult: 'f73246e3cca9b7c3',
      Critique: '57f6927de1a6df65',
      Evidence: '99c1676e6f16897c',
      Falsification: 'c0879b3ae091a0f5',
      FalsificationVerdict: 'ee62c991688123c6',
      Finding: '63c444e963a2f15b',
      Findings: 'ca895f629f82b144',
      GateDecision: 'b6faf8a5c3519501',
      GateStatus: '7233c3e516176f31',
      Hypotheses: '1e99b60943d3efc5',
      Hypothesis: '9d1d84545ac66a64',
      Issue: '4c0310b509e078bf',
      IssueDraft: 'abe20ce190e84ca4',
      Key: '28c775ccb5ede557',
      Lead: '87772e950565e13d',
      Leads: 'cd3fdaddb175b4d1',
      Level: 'f2b38702a4c503a1',
      Outcome: 'd8e03de135782409',
      Plan: 'd4b11b6c36824ef5',
      Proposal: '01a52f8c38313b0e',
      Question: 'ecce9b1ae0c0af19',
      Questions: '7e6ab3c7c46fa5e8',
      Rationale: '7e23fbc05e8bdc62',
      Receipt: '1f4a9d326793ed3d',
      Refutation: '5a8e80ca282aabb8',
      Remediation: 'a9b37824ae7aaf14',
      Remediations: '834a0d0f18d07877',
      RepoPath: '760dc0c42559bba4',
      ReviewReply: 'e4a295f01ce9a599',
      Score: 'bc9c8f60e3a03fff',
      Severity: '54248cb7e89f292f',
      Sha: '16358f609f4b5d6a',
      Sha256: 'b1963ba6d50875ff',
      ShortSha: '36f35ce1d9de883d',
      Size: 'e17566c4e71c2d9f',
      Step: '0bff27b414b81e8d',
      Summary: '922a61e911d8cfce',
      Task: 'e6d5aca50d766a9e',
      TaskList: '58b4ca28a7322cc4',
      Verification: '27f5565f0b09755d',
      WorkReport: '715451d5ff61a9cd',
      WorkStatus: '4f86fc2259701220',
    });
  });

  it.each(agentOutput)('%s passes the Codex structured-output check', (_name, schema) => {
    expect(checkCodexSchema(rooted(schema))).toEqual([]);
  });

  it.each(agentOutput)('%s has no pattern or format validator', (_name, schema) => {
    const keys = jsonKeys(rooted(schema));
    expect(keys.has('pattern')).toBe(false);
    expect(keys.has('format')).toBe(false);
  });

  it.each(
    agentOutput.filter(([name, schema]) => schema instanceof z.ZodObject && name !== 'Approval'),
  )('%s describes every property it shows the agent', (_name, schema) => {
    for (const [key, property] of Object.entries(properties(schema)))
      expect(property.description, key).toEqual(expect.any(String));
  });

  it('flags the input-side tuple, so it is not mistaken for agent output', () => {
    expect(checkCodexSchema(z.object({ argv: types.Argv })).map((issue) => issue.rule)).toContain(
      'tuple',
    );
    for (const name of ['Sha', 'ShortSha', 'Sha256', 'Key'])
      expect(jsonKeys(types[name as 'Sha'])).toContain('pattern');
    expect(jsonKeys(types.Commit)).toContain('pattern');
    expect(jsonKeys(types.Commit)).toContain('format');
    expect(z.toJSONSchema(types.Criteria)).toMatchObject({ type: 'array', minItems: 1 });
  });

  it('makes a Remediation a Finding with a fix, and bounds Remediations', () => {
    expect(Object.keys(types.Remediation.shape)).toEqual([
      ...Object.keys(types.Finding.shape),
      'fix',
    ]);
    for (const key of Object.keys(types.Finding.shape) as (keyof types.Finding)[])
      expect(types.Remediation.shape[key], key).toBe(types.Finding.shape[key]);
    const remediation = {
      title: 'Off-by-one in the pager',
      file: 'src/pager.ts',
      line: 12,
      severity: 'high',
      evidence: 'src/pager.ts:12 uses <=',
      failureScenario: 'A page size of 10 returns 11 items.',
      fix: 'Compare with < in src/pager.ts:12.',
    } as const;
    expect(types.Remediation.parse(remediation)).toEqual(remediation);
    expect(types.Remediation.safeParse({ ...remediation, fix: '' }).success).toBe(false);
    const finding = Object.fromEntries(
      Object.entries(remediation).filter(([key]) => key !== 'fix'),
    );
    expect(types.Remediation.safeParse(finding).success).toBe(false);
    expect(types.Finding.parse(finding)).toEqual(finding);
    expect(types.Remediations.parse({ remediations: [] })).toEqual({ remediations: [] });
    expect(
      types.Remediations.safeParse({ remediations: Array.from({ length: 21 }, () => remediation) })
        .success,
    ).toBe(false);
  });

  it('requires every field of a Question and bounds Questions', () => {
    const question = {
      question: 'Which time zone do report dates use?',
      why: 'Daily totals shift by a day for users east of UTC.',
      answerFrom: 'The reporting team, or docs/reports.md',
      blocking: true,
    };
    expect(types.Question.parse(question)).toEqual(question);
    for (const key of ['question', 'why', 'answerFrom'] as const)
      expect(types.Question.safeParse({ ...question, [key]: '' }).success, key).toBe(false);
    const withoutBlocking = Object.fromEntries(
      Object.entries(question).filter(([key]) => key !== 'blocking'),
    );
    expect(types.Question.safeParse(withoutBlocking).success).toBe(false);
    expect(types.Questions.parse({ questions: [] })).toEqual({ questions: [] });
    expect(
      types.Questions.safeParse({ questions: Array.from({ length: 21 }, () => question) }).success,
    ).toBe(false);
  });

  it('lists enum values in rank order, most severe or important first', () => {
    expect(types.Severity.options).toEqual(['critical', 'high', 'medium', 'low']);
    expect(types.Level.options).toEqual(['high', 'medium', 'low']);
    expect(types.Size.options).toEqual(['XS', 'S', 'M', 'L', 'XL']);
    expect(types.Complexity.options).toEqual(['mechanical', 'subtle']);
    expect(types.WorkStatus.options).toEqual(['done', 'partial', 'blocked', 'skipped']);
    expect(types.CheckStatus.options).toEqual(['pass', 'fail', 'partial', 'unverifiable']);
    expect(types.GateStatus.options).toEqual(['pass', 'concern', 'blocker', 'cannot-check']);
    expect(types.GateDecision.options).toEqual(['go', 'conditional-go', 'no-go']);
    expect(types.Outcome.options).toEqual(['confirmed', 'refuted', 'undecided']);
    expect(types.ChangeKind.options).toEqual([
      'feature',
      'fix',
      'breaking',
      'performance',
      'deprecation',
      'docs',
      'internal',
    ]);
    expect(types.FalsificationVerdict.options).toEqual(['falsified', 'survives', 'untestable']);
  });

  it('keeps Approval the exact schema reviewRevise sends', () => {
    const review = z.object({ approved: z.boolean(), feedback: z.string() });
    expect(z.toJSONSchema(types.Approval)).toEqual(z.toJSONSchema(review));
    expect(JSON.stringify(z.toJSONSchema(types.Approval))).toBe(
      JSON.stringify(z.toJSONSchema(review)),
    );
    expect(types.Approval.parse({ approved: true, feedback: '' })).toEqual({
      approved: true,
      feedback: '',
    });
  });

  it('requires every property and uses null for an absent value', () => {
    const finding = {
      title: 'Off-by-one in the pager',
      file: 'src/pager.ts',
      line: null,
      severity: 'high',
      evidence: 'src/pager.ts:12 uses <=',
      failureScenario: 'A page size of 10 returns 11 items.',
    } as const;
    expect(types.Finding.parse(finding)).toEqual(finding);
    expect(types.Finding.safeParse({ ...finding, line: 0 }).success).toBe(false);
    expect(types.Finding.safeParse({ ...finding, file: '../escape.ts' }).success).toBe(false);
    expect(types.Finding.safeParse({ ...finding, title: '' }).success).toBe(false);
    const withoutLine = Object.fromEntries(
      Object.entries(finding).filter(([key]) => key !== 'line'),
    );
    expect(types.Finding.safeParse(withoutLine).success).toBe(false);
    expect(types.Findings.parse({ findings: [] })).toEqual({ findings: [] });
    expect(
      types.Findings.safeParse({ findings: Array.from({ length: 21 }, () => finding) }).success,
    ).toBe(false);
  });

  it('bounds the records the contract bounds', () => {
    const step = { id: 'S1', description: 'Change it.', files: [] };
    const plan = { summary: 'Do it.', steps: [step], risks: [], checks: ['npm test'] };
    expect(types.Plan.parse(plan)).toEqual(plan);
    expect(types.Plan.safeParse({ ...plan, steps: [] }).success).toBe(false);
    const task = {
      id: 'T1',
      title: 'Add the pager',
      description: 'Add a pager.',
      acceptance: ['Pages hold 10 items.'],
      dependsOn: [],
      size: 'S',
    } as const;
    expect(types.TaskList.parse({ tasks: [task] })).toEqual({ tasks: [task] });
    expect(types.TaskList.safeParse({ tasks: [] }).success).toBe(false);
    expect(types.Task.safeParse({ ...task, acceptance: [] }).success).toBe(false);
    expect(types.Task.safeParse({ ...task, id: 'x'.repeat(65) }).success).toBe(false);
    expect(types.Task.safeParse({ ...task, title: 'x'.repeat(121) }).success).toBe(false);
    const hypothesis = { id: 'H1', cause: 'c', mechanism: 'm', predictions: ['p'] };
    expect(types.Hypotheses.parse({ hypotheses: [hypothesis] }).hypotheses).toHaveLength(1);
    expect(types.Hypothesis.safeParse({ ...hypothesis, predictions: [] }).success).toBe(false);
    expect(
      types.Hypothesis.safeParse({ ...hypothesis, predictions: ['1', '2', '3', '4', '5', '6'] })
        .success,
    ).toBe(false);
    expect(types.Score.safeParse(0).success).toBe(false);
    expect(types.Score.safeParse(10).success).toBe(true);
    expect(types.Score.safeParse(11).success).toBe(false);
    expect(types.Score.safeParse(5.5).success).toBe(false);
    const draft = { title: 't', body: 'b', label: 'bug', duplicateOf: null } as const;
    expect(types.IssueDraft.parse(draft)).toEqual(draft);
    expect(types.IssueDraft.safeParse({ ...draft, duplicateOf: 0 }).success).toBe(false);
    const report = {
      status: 'done',
      summary: 's',
      files: Array.from({ length: 100 }, (_, index) => `f${String(index)}`),
      blockers: [],
      notes: [],
    } as const;
    expect(types.WorkReport.safeParse(report).success).toBe(true);
    expect(types.WorkReport.safeParse({ ...report, files: [...report.files, 'x'] }).success).toBe(
      false,
    );
    expect(types.Criterion.parse({ id: 'C1', criterion: 'Holds.', how: '' }).how).toBe('');
    expect(types.ReviewReply.parse({ decision: 'redo', answer: '' }).decision).toBe('redo');
  });

  it('keeps records extensible through .shape and .extend()', () => {
    const Ticket = types.Task.extend({ owner: z.string().min(1) });
    expect(Object.keys(Ticket.shape)).toEqual([...Object.keys(types.Task.shape), 'owner']);
    expect(checkCodexSchema(Ticket)).toEqual([]);
    expect(types.Finding.shape.severity).toBe(types.Severity);
    expect(
      types.Finding.pick({ title: true, file: true }).parse({ title: 't', file: 'a/b' }),
    ).toEqual({ title: 't', file: 'a/b' });
  });
});

describe('input-side primitives', () => {
  const valid = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

  it.each([
    ['src/index.ts'],
    ['a'],
    ['..generated/out.md'],
    ['docs/.gitignore'],
    ['a/.github/x'],
    ['x'.repeat(500)],
  ])('isRepoPath accepts %j', (path) => {
    expect(types.isRepoPath(path)).toBe(true);
    expect(valid(types.RepoPath, path)).toBe(true);
  });

  it.each([
    [''],
    ['x'.repeat(501)],
    ['/abs/x.md'],
    ['../x.md'],
    ['a/../b'],
    ['./x.md'],
    ['a/./b'],
    ['a//b.md'],
    ['a/'],
    ['.git'],
    ['.git/x.md'],
    ['a/.git/config'],
    ['a\\b.md'],
    ['a\0b'],
    ['C:/outside/file'],
    ['C:outside'],
    ['c:\\x'],
    ['z:'],
    ['\\\\server\\share'],
  ])('isRepoPath refuses %j', (path) => {
    expect(types.isRepoPath(path)).toBe(false);
    expect(valid(types.RepoPath, path)).toBe(false);
  });

  it('RepoPath reports the same message committedArtifact throws', () => {
    const result = types.RepoPath.safeParse('../x');
    expect(result.error?.issues[0]?.message).toBe(
      'Use a repository-relative path without dot segments or .git',
    );
  });

  it('Sha accepts full lowercase SHA-1 and SHA-256 object IDs only', () => {
    const sha1 = 'a'.repeat(40);
    const sha256 = '0123456789abcdef'.repeat(4);
    expect(valid(types.Sha, sha1)).toBe(true);
    expect(valid(types.Sha, sha256)).toBe(true);
    for (const bad of [
      'a'.repeat(39),
      'a'.repeat(41),
      'a'.repeat(63),
      'A'.repeat(40),
      'g'.repeat(40),
      '',
    ])
      expect(valid(types.Sha, bad), bad).toBe(false);
    expect(valid(types.Sha, `${sha1}\n`)).toBe(false);
  });

  it('ShortSha accepts 7 to 64 lowercase hex characters', () => {
    expect(valid(types.ShortSha, 'abc1234')).toBe(true);
    expect(valid(types.ShortSha, 'f'.repeat(64))).toBe(true);
    for (const bad of ['abc123', 'f'.repeat(65), 'ABC1234', 'abc123z'])
      expect(valid(types.ShortSha, bad), bad).toBe(false);
  });

  it('Sha256 accepts exactly 64 lowercase hex characters', () => {
    expect(valid(types.Sha256, 'e'.repeat(64))).toBe(true);
    for (const bad of ['e'.repeat(63), 'e'.repeat(65), 'E'.repeat(64), 'a'.repeat(40)])
      expect(valid(types.Sha256, bad), bad).toBe(false);
  });

  it('Key accepts exactly the clean step-ID segments', () => {
    for (const good of ['a', 'T1', 'finding:F1', 'a.b_c-d', '9lives', 'x'.repeat(64)])
      expect(valid(types.Key, good), good).toBe(true);
    for (const bad of ['', '-a', '.a', '_a', 'a/b', 'a b', 'x'.repeat(65), 'é'])
      expect(valid(types.Key, bad), bad).toBe(false);
  });

  it('Argv accepts a non-empty program with any arguments and is a Command', () => {
    expect(types.Argv.parse(['npm'])).toEqual(['npm']);
    expect(types.Argv.parse(['git', 'diff', ''])).toEqual(['git', 'diff', '']);
    expect(valid(types.Argv, [])).toBe(false);
    expect(valid(types.Argv, [''])).toBe(false);
    expect(valid(types.Argv, ['npm', 1])).toBe(false);
    expectTypeOf<types.Argv>().toExtend<Command>();
  });

  it('limit builds a bounded integer input with a default', () => {
    const rounds = types.limit(3, 10);
    expect(rounds.parse(undefined)).toBe(3);
    expect(rounds.parse(1)).toBe(1);
    expect(rounds.parse(10)).toBe(10);
    expect(valid(rounds, 0)).toBe(false);
    expect(valid(rounds, 11)).toBe(false);
    expect(valid(rounds, 2.5)).toBe(false);
    const zero = types.limit(0, 5, 0);
    expect(zero.parse(undefined)).toBe(0);
    expect(z.object({ rounds }).parse({})).toEqual({ rounds: 3 });
  });

  it.each([
    [() => types.limit(1.5, 3), TypeError, 'limit defaultValue must be a safe integer, got 1.5'],
    [() => types.limit(1, Infinity), TypeError, 'limit max must be a safe integer, got Infinity'],
    [() => types.limit(1, 3, Number.NaN), TypeError, 'limit min must be a safe integer, got NaN'],
    [
      () => types.limit(5, 3),
      RangeError,
      'limit needs min <= defaultValue <= max, got min 1, defaultValue 5, max 3',
    ],
    [
      () => types.limit(0, 3),
      RangeError,
      'limit needs min <= defaultValue <= max, got min 1, defaultValue 0, max 3',
    ],
  ] as const)('limit refuses bad bounds (%#)', (call, type, message) => {
    expect(call).toThrow(new type(message));
    expect(call).toThrow(type);
  });

  it('Receipt validates a writeFile receipt', () => {
    const receipt: WriteFileResult = {
      path: '/repo/notes.md',
      sha256: 'a'.repeat(64),
      bytes: 0,
      previousSha256: null,
    };
    expect(types.Receipt.parse(receipt)).toEqual(receipt);
    expect(valid(types.Receipt, { ...receipt, sha256: 'x' })).toBe(false);
    expect(valid(types.Receipt, { ...receipt, bytes: -1 })).toBe(false);
    expect(valid(types.Receipt, { ...receipt, previousSha256: 'b'.repeat(64) })).toBe(true);
    expectTypeOf<types.Receipt>().toEqualTypeOf<WriteFileResult>();
  });

  it('Commit validates one commit as std.exec.log returns it', () => {
    const commit = {
      sha: 'a'.repeat(40),
      shortSha: 'aaaaaaa',
      author: 'Ada Lovelace',
      date: '2026-01-31T09:30:00+01:00',
      subject: 'Add the pager',
    };
    expect(types.Commit.parse(commit)).toEqual(commit);
    expect(types.Commit.parse({ ...commit, author: '', subject: '' })).toMatchObject({
      author: '',
      subject: '',
    });
    expect(valid(types.Commit, { ...commit, date: '2026-01-31T08:30:00Z' })).toBe(true);
    expect(valid(types.Commit, { ...commit, sha: 'abc1234' })).toBe(false);
    expect(valid(types.Commit, { ...commit, shortSha: 'ABC1234' })).toBe(false);
    expect(valid(types.Commit, { ...commit, date: '2026-01-31' })).toBe(false);
    expect(valid(types.Commit, { ...commit, date: '2026-01-31T09:30:00' })).toBe(false);
  });

  it('Criteria accepts nonblank text and criteria, and refuses an empty list', () => {
    const criteria = [
      'Invalid input is rejected with a message.',
      { id: 'docs', criterion: 'The flag is documented.', how: 'Read README.md.' },
    ];
    expect(types.Criteria.parse(criteria)).toEqual(criteria);
    expect(valid(types.Criteria, [])).toBe(false);
    expect(valid(types.Criteria, [''])).toBe(false);
    expect(valid(types.Criteria, [' \n'])).toBe(false);
    expect(valid(types.Criteria, [{ id: 'C1', criterion: 'x' }])).toBe(false);
    expect(valid(types.Criteria, [{ id: '', criterion: 'x', how: '' }])).toBe(false);
    expectTypeOf<types.Criteria>().toEqualTypeOf<(string | types.Criterion)[]>();
  });

  it('CheckOutcome validates a command outcome', () => {
    const outcome = { passed: false, code: null, signal: 'SIGTERM', output: '', truncated: false };
    expect(types.CheckOutcome.parse(outcome)).toEqual(outcome);
    expect(valid(types.CheckOutcome, { ...outcome, code: 1.5 })).toBe(false);
  });
});

describe('builders', () => {
  it('oneOf builds a typed enum of runtime keys', () => {
    const keys = ['F1', 'F2'] as const;
    const schema = types.oneOf(keys);
    expect(schema.options).toEqual(['F1', 'F2']);
    expect(schema.parse('F2')).toBe('F2');
    expect(schema.safeParse('F3').success).toBe(false);
    expect(checkCodexSchema(z.object({ key: schema }))).toEqual([]);
    expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<'F1' | 'F2'>();
    const rest: string[] = ['b', 'c'];
    const dynamic = types.oneOf(['a', ...rest]);
    expectTypeOf<z.infer<typeof dynamic>>().toEqualTypeOf<string>();
    expect(dynamic.options).toEqual(['a', 'b', 'c']);
  });

  it('oneOf refuses an empty or repeated list', () => {
    expect(() => types.oneOf([] as unknown as readonly [string])).toThrow(
      new TypeError('oneOf needs at least one key'),
    );
    expect(() => types.oneOf(['a', 'b', 'a'])).toThrow(
      new TypeError('oneOf keys must be unique; "a" repeats'),
    );
  });

  it('listOf wraps a list in an object root with a bound', () => {
    const schema = types.listOf(types.Finding, 2);
    expect(Object.keys(schema.shape)).toEqual(['items']);
    expect(schema.parse({ items: [] })).toEqual({ items: [] });
    expect(schema.safeParse({ items: [{}, {}, {}] }).success).toBe(false);
    expect(checkCodexSchema(schema)).toEqual([]);
    expect(properties(schema)['items']?.description).toBeUndefined();
    const described = types.listOf(z.string().min(1), 5, 'Names; an empty list is a valid answer.');
    expect(properties(described)['items']?.description).toBe(
      'Names; an empty list is a valid answer.',
    );
    expect(checkCodexSchema(described)).toEqual([]);
    expectTypeOf<z.infer<typeof described>>().toEqualTypeOf<{ items: string[] }>();
    expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<{ items: types.Finding[] }>();
  });

  it.each([0, -1, 1.5, Number.NaN])('listOf refuses max %s', (max) => {
    expect(() => types.listOf(z.string(), max)).toThrow(
      new TypeError(`listOf max must be a positive integer, got ${String(max)}`),
    );
  });

  it('rubric builds a score sheet that keeps the criteria order and text', () => {
    const schema = types.rubric({
      fitness: 'How well it solves the stated problem.',
      simplicity: 'How little it adds.',
    });
    expect(Object.keys(schema.shape.scores.shape)).toEqual(['fitness', 'simplicity']);
    const json = z.toJSONSchema(schema) as unknown as {
      properties: { scores: { properties: Record<string, { description?: string }> } };
    };
    expect(json.properties.scores.properties['fitness']?.description).toBe(
      'How well it solves the stated problem.',
    );
    expect(json.properties.scores.properties['simplicity']?.description).toBe(
      'How little it adds.',
    );
    expect(checkCodexSchema(schema)).toEqual([]);
    const value = { scores: { fitness: 7, simplicity: 10 }, rationale: 'Small and complete.' };
    expect(schema.parse(value)).toEqual(value);
    expect(schema.safeParse({ ...value, scores: { fitness: 7 } }).success).toBe(false);
    expect(schema.safeParse({ ...value, scores: { fitness: 0, simplicity: 1 } }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...value, rationale: '' }).success).toBe(false);
    expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<{
      scores: { fitness: number; simplicity: number };
      rationale: string;
    }>();
    // The criteria's own description never leaks into the shared Score schema.
    expect(z.toJSONSchema(types.Score).description).toBe(
      'A score from 1 (poor) to 10 (excellent).',
    );
  });

  it('rubric refuses an empty criteria record', () => {
    expect(() => types.rubric({})).toThrow(new TypeError('rubric needs at least one criterion'));
  });
});

it('infers the documented value types', () => {
  expectTypeOf<types.Finding>().toEqualTypeOf<{
    title: string;
    file: string;
    line: number | null;
    severity: 'critical' | 'high' | 'medium' | 'low';
    evidence: string;
    failureScenario: string;
  }>();
  expectTypeOf<types.Refutation>().toEqualTypeOf<{ refuted: boolean; reasoning: string }>();
  expectTypeOf<types.Approval>().toEqualTypeOf<{ approved: boolean; feedback: string }>();
  expectTypeOf<types.WorkReport['status']>().toEqualTypeOf<
    'done' | 'partial' | 'blocked' | 'skipped'
  >();
  expectTypeOf<types.Verification['failures']>().toEqualTypeOf<
    { description: string; files: string[] }[]
  >();
  expectTypeOf<types.Citation['quote']>().toEqualTypeOf<string | null>();
  expectTypeOf<types.Change['migration']>().toEqualTypeOf<string | null>();
  expectTypeOf<types.IssueDraft['label']>().toEqualTypeOf<
    'bug' | 'enhancement' | 'documentation'
  >();
  expectTypeOf<types.ReviewReply['decision']>().toEqualTypeOf<'continue' | 'redo' | 'stop'>();
  expectTypeOf<types.CheckOutcome>().toEqualTypeOf<{
    passed: boolean;
    code: number | null;
    signal: string | null;
    output: string;
    truncated: boolean;
  }>();
  expectTypeOf<types.Sha>().toEqualTypeOf<string>();
  expectTypeOf<types.Argv>().toEqualTypeOf<[string, ...string[]]>();
  expectTypeOf<types.Remediation>().toEqualTypeOf<{
    title: string;
    file: string;
    line: number | null;
    severity: 'critical' | 'high' | 'medium' | 'low';
    evidence: string;
    failureScenario: string;
    fix: string;
  }>();
  expectTypeOf<types.Remediations['remediations']>().toEqualTypeOf<types.Remediation[]>();
  expectTypeOf<types.Question>().toEqualTypeOf<{
    question: string;
    why: string;
    answerFrom: string;
    blocking: boolean;
  }>();
  expectTypeOf<types.Questions['questions']>().toEqualTypeOf<types.Question[]>();
  expectTypeOf<types.Commit>().toEqualTypeOf<{
    sha: string;
    shortSha: string;
    author: string;
    date: string;
    subject: string;
  }>();
});
