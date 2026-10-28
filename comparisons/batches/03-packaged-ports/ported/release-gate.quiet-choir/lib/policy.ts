// Pure rules: prompt excerpts, the refusal reasons, the read-only receipt check, how a command
// ended, the dimension rows, the code-owned gate rule (which decisions the evidence allows), the
// fallback when the gatekeeper fails, and the status.
import type { MapStepError, Settled, WorktreeChange, z } from 'quiet-choir';
import type {
  Allowed,
  Assessed,
  Assessment,
  Confirmation,
  Decision,
  Dimension,
  Excerpt,
  ReleaseGateOutput,
  Row,
  Rule,
  Run,
  TestCheck,
} from '../contracts.js';

/** The first `max` characters without trailing whitespace, and whether anything was cut. */
export function head(text: string, max: number): Excerpt {
  const whole = text.trimEnd();
  return { text: whole.slice(0, max), chars: whole.length, clipped: whole.length > max };
}

/** The last `max` characters: a command's verdict and its failures are at the end. */
export function tail(text: string, max: number): Excerpt {
  const whole = text.trimEnd();
  return {
    text: whole.length > max ? whole.slice(-max) : whole,
    chars: whole.length,
    clipped: whole.length > max,
  };
}

/** Up to five `git status` lines, and how many more there were. */
const listed = (lines: readonly string[]) =>
  lines.slice(0, 5).join(', ') + (lines.length > 5 ? `, and ${String(lines.length - 5)} more` : '');

/** Why the gate will not run the operator's commands on this checkout. */
export const notHead = (lines: readonly string[]) =>
  `The checkout differs from HEAD (${listed(lines)}); the gate runs the operator's commands on HEAD's tree only, so commit, stash or ignore these first.`;

/** Why the gate stops after the operator's commands. */
export const changedByCommands = (lines: readonly string[]) =>
  `A test or evidence command changed tracked files (${listed(lines)}).`;

/** The output of a call in a pinned checkout, which a read-only role must leave unchanged. */
export function unchanged<T>(result: {
  readonly output: T;
  readonly worktree?: WorktreeChange;
}): T {
  if (!result.worktree) throw new Error('A pinned call returned no worktree receipt');
  if (result.worktree.files.length)
    throw new Error(
      `A read-only role changed its checkout: ${result.worktree.files.map((file) => `${file.status} ${file.path}`).join(', ')}`,
    );
  return result.output;
}

const row = (dimension: Dimension, fields: Partial<Row> & Pick<Row, 'reported'>): Row => ({
  dimension,
  source: dimension === 'tests' ? 'code' : 'assessor',
  status: fields.reported,
  confirmation: null,
  evidence: '',
  findings: [],
  reasoning: null,
  ...fields,
});

/**
 * How one command run ended. Under okExitCodes 'any' every exit is a completed result, so a settled
 * failure has no exit status: a timeout, a signal (a crash, which fails), or a `process` failure
 * with neither code nor signal, which is a command that could not start.
 */
export type Ending = 'passed' | 'failed' | 'timed-out' | 'not-started';
export const ending = (run: Run): Ending =>
  run.failure === null
    ? run.code === 0
      ? 'passed'
      : 'failed'
    : run.failure === 'timeout'
      ? 'timed-out'
      : run.signal !== null
        ? 'failed'
        : 'not-started';

/** How a command run ended, in a few words. */
export function outcome(run: Run): string {
  if (run.failure === 'timeout') return 'timed out';
  if (run.signal !== null) return `killed by ${run.signal}`;
  if (run.failure === null) return `exit ${String(run.code)}`;
  return run.failure === 'process' ? 'could not start' : run.failure;
}

type TestRows = readonly (TestCheck & { readonly output: Excerpt })[];

/** The excerpt of a test command's output in its finding, marked when only its end is shown. */
const shown = ({ text, chars, clipped }: Excerpt) =>
  !text
    ? ''
    : clipped
      ? ` Output ends (last ${String(text.length)} of ${String(chars)} characters): ${text}`
      : ` Output: ${text}`;

/** One test command's finding, from both of its runs. */
function testFinding(check: TestRows[number], timeoutMs: number): string {
  const argv = check.argv.join(' ');
  const runs = check.rerun ? `${outcome(check)}, then ${outcome(check.rerun)}` : outcome(check);
  const output = shown(check.output);
  switch (check.verdict) {
    case 'failed':
      return `${argv} failed on a run and never passed (${runs}).${output}`;
    case 'unfinished':
      return `${argv} did not finish within ${String(timeoutMs)} ms on either run (${runs}).${output}`;
    case 'not-run':
      return `${argv} could not start, so it was not run: ${check.error ?? check.failure ?? 'unknown'}`;
    default:
      return `${argv} failed (${outcome(check)}), then passed on its rerun (flaky).`;
  }
}

/**
 * The code-owned tests row. A command that failed on a run and never passed blocks; one that never
 * started or never finished leaves the suite unverified (cannot-check, as the upstream charter
 * says of a suite that will not run); one that passed on its rerun is a flaky concern.
 */
export function testsRow(checks: TestRows, timeoutMs: number): Row {
  if (!checks.length)
    return row('tests', {
      reported: 'cannot-check',
      evidence: 'No test command was given (testCommands is empty), so nothing ran.',
    });
  const failed = checks.filter((check) => check.verdict === 'failed');
  const unrun = checks.filter(
    (check) => check.verdict === 'not-run' || check.verdict === 'unfinished',
  );
  const flaky = checks.filter((check) => check.verdict === 'flaky');
  const summary = checks.map((check) => `${check.argv.join(' ')}: ${check.verdict}`).join('; ');
  return row('tests', {
    reported: failed.length
      ? 'blocker'
      : unrun.length
        ? 'cannot-check'
        : flaky.length
          ? 'concern'
          : 'pass',
    evidence: `The workflow's ${String(checks.length)} test command(s) in the checkout: ${summary}.`,
    findings: [...failed, ...unrun, ...flaky].map((check) => testFinding(check, timeoutMs)),
  });
}

/** A settled failure's kind and the first line of its message. */
const cause = (error: MapStepError) => `${error.kind}: ${error.message.split('\n')[0] ?? ''}`;

/** An assessor's row, or `unassessed` when its settled call failed. */
export const assessedRow = (
  dimension: Assessed,
  result: Settled<z.infer<typeof Assessment>, MapStepError> | undefined,
): Row =>
  result?.ok
    ? row(dimension, {
        reported: result.value.status,
        evidence: result.value.evidence,
        findings: result.value.findings,
      })
    : row(dimension, {
        reported: 'unassessed',
        evidence: `The assessor failed (${result ? cause(result.error) : 'missing'}), so this dimension was not checked.`,
      });

/**
 * Apply the confirmers' verdicts to the flagged rows. A downgrade becomes a concern or a pass; a
 * confirmer that failed leaves its blocker standing, unconfirmed: a gate fails closed.
 */
export function confirm(
  rows: readonly Row[],
  flagged: readonly Row[],
  results: readonly Settled<z.infer<typeof Confirmation>, MapStepError>[],
): Row[] {
  return rows.map((current) => {
    const index = flagged.indexOf(current);
    if (index === -1) return current;
    const result = results[index];
    if (!result?.ok) return { ...current, confirmation: 'unconfirmed' };
    const { verdict, reasoning } = result.value;
    const status = verdict === 'confirmed' ? 'blocker' : verdict === 'concern' ? 'concern' : 'pass';
    return { ...current, status, confirmation: verdict, reasoning };
  });
}

const unverifiable = (status: Row['status']) =>
  status === 'cannot-check' || status === 'unassessed';

/** Hard-block dimensions whose evidence nobody could establish. */
export const unverified = (rows: readonly Row[], blockOn: readonly Dimension[]): Dimension[] =>
  rows
    .filter((current) => blockOn.includes(current.dimension) && unverifiable(current.status))
    .map((current) => current.dimension);

/**
 * The gate rule, in code: a blocker on a hard-block dimension allows only no-go; any other blocker,
 * or a hard-block dimension nobody could verify, rules out go; otherwise go or conditional-go.
 */
export function gate(rows: readonly Row[], blockOn: readonly Dimension[]) {
  const blockers = rows.filter((current) => current.status === 'blocker');
  const hard = blockers.some((current) => blockOn.includes(current.dimension));
  const rule: Rule = hard
    ? 'hard-block'
    : blockers.length || unverified(rows, blockOn).length
      ? 'held'
      : 'clear';
  const allowed: Allowed =
    rule === 'hard-block'
      ? ['no-go']
      : rule === 'held'
        ? ['conditional-go', 'no-go']
        : ['go', 'conditional-go'];
  return { rule, allowed };
}

/** Code's decision when the gatekeeper failed: the first allowed one, as the upstream fell back. */
export function fallback(rows: readonly Row[], blockOn: readonly Dimension[], allowed: Allowed) {
  const decision: Decision = allowed[0];
  const blockers = rows.filter((current) => current.status === 'blocker');
  const conditions =
    decision === 'go'
      ? []
      : [
          ...blockers.map((current) => `Resolve the ${current.dimension} blocker.`),
          ...unverified(rows, blockOn).map(
            (dimension) => `Verify ${dimension}; the gate could not.`,
          ),
        ];
  return {
    decision,
    conditions,
    rationale: `${decision}, decided by code because the gatekeeper failed: ${String(blockers.length)} blocker(s), ${String(rows.filter((current) => current.status === 'concern').length)} concern(s), ${String(unverified(rows, blockOn).length)} unverified hard-block dimension(s).`,
  };
}

/** The gatekeeper's lists: blockers with their hardness, concerns, and everything else. */
export const groups = (rows: readonly Row[], blockOn: readonly Dimension[]) => ({
  blockers: rows
    .filter((current) => current.status === 'blocker')
    .map((current) => ({ ...current, hard: blockOn.includes(current.dimension) })),
  concerns: rows.filter((current) => current.status === 'concern'),
  others: rows.filter((current) => !['blocker', 'concern'].includes(current.status)),
});

/** The pinned range, or as much of it as was established before a refusal. */
interface Window {
  readonly since: string | null;
  readonly start: string | null;
  readonly end: string | null;
  readonly manifest: readonly string[];
}
const pinned = ({ since, start, end, manifest }: Window) => ({
  since,
  start,
  end,
  manifest: [...manifest],
});

type Tests = TestRows;
type Evidence = readonly {
  readonly dimension: Assessed;
  readonly row: Run;
  readonly clipped: boolean;
}[];
/** The commands that ran, without the output text only prompts and findings need. */
export const ran = (tests: Tests, evidence: Evidence) => ({
  tests: tests.map(({ output: _output, ...check }) => check),
  evidence: evidence.map(({ dimension, row: run, clipped }) => ({ dimension, ...run, clipped })),
});

interface Parts {
  readonly decision: Decision;
  readonly conditions: readonly string[];
  readonly rationale: string;
  readonly decidedBy: 'gatekeeper' | 'code';
  readonly allowed: Allowed;
  readonly window: Window;
  readonly blockOn: Dimension[];
  readonly dimensions: Row[];
  readonly tests: Tests;
  readonly evidence: Evidence;
  readonly log: Excerpt;
  readonly patch: Excerpt;
}

/**
 * Assemble the result, without the prompt-only text. Degraded means a role failed, a dimension
 * went unchecked, a blocker stayed unconfirmed, or a test or evidence command did not finish (it
 * never started, timed out or was killed); limited means an assessor saw a clipped excerpt.
 */
export function report(parts: Parts): ReleaseGateOutput {
  const { dimensions: rows, blockOn, evidence, log, patch, decidedBy, tests } = parts;
  const degraded =
    decidedBy === 'code' ||
    tests.some((check) => check.verdict === 'not-run' || check.verdict === 'unfinished') ||
    evidence.some(({ row: run }) => run.failure !== null) ||
    rows.some((current) => unverifiable(current.status) || current.confirmation === 'unconfirmed');
  const limited = log.clipped || patch.clipped || evidence.some((run) => run.clipped);
  return {
    status: degraded ? 'degraded' : limited ? 'limited' : 'complete',
    reason: null,
    decision: parts.decision,
    decidedBy,
    allowed: [...parts.allowed],
    ...pinned(parts.window),
    blockOn,
    dimensions: rows,
    blockers: rows
      .filter((current) => current.status === 'blocker')
      .map(({ dimension, evidence: why, findings, confirmation }) => ({
        dimension,
        evidence: why,
        findings,
        hard: blockOn.includes(dimension),
        confirmation:
          confirmation === 'confirmed' || confirmation === 'unconfirmed' ? confirmation : null,
      })),
    warnings: rows
      .filter((current) => current.status === 'concern')
      .map(({ dimension, findings, reported }) => ({
        dimension,
        findings,
        downgraded: reported === 'blocker',
      })),
    unverified: unverified(rows, blockOn),
    ...ran(parts.tests, evidence),
    log: { chars: log.chars, clipped: log.clipped },
    patch: { chars: patch.chars, clipped: patch.clipped },
    rationale: parts.rationale,
    conditions: [...parts.conditions],
  };
}

/** The result of a gate that could not establish what it gates: no-go, so it fails closed. */
export const refused = (
  reason: string,
  blockOn: Dimension[],
  window: Window,
  commands: ReturnType<typeof ran> = { tests: [], evidence: [] },
): ReleaseGateOutput => ({
  status: 'refused',
  reason,
  decision: 'no-go',
  decidedBy: 'code',
  allowed: ['no-go'],
  ...pinned(window),
  blockOn,
  dimensions: [],
  blockers: [],
  warnings: [],
  unverified: [],
  ...commands,
  log: { chars: 0, clipped: false },
  patch: { chars: 0, clipped: false },
  rationale: `no-go: ${reason}`,
  conditions: [],
});
