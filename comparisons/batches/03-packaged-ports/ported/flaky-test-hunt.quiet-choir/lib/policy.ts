// Pure rules: the history facts, merging the modalities' suspects with their corroboration, the
// suspect screen and cap, the argv substitution, the stress verdict, the fix plan and its digest,
// and the fixer's file ownership and coverage of the plan.
import { createHash } from 'node:crypto';
import type { WorktreeChange } from 'quiet-choir';
import type {
  Diagnosis,
  Flake,
  Found,
  History,
  Modality,
  PlanItem,
  Rejected,
  Run,
  Stress,
  Suspect,
  Unplanned,
} from '../contracts.js';

/**
 * The `git log` format lib/git.ts asks for: a record separator, then SHA, date, subject and body
 * separated by unit separators; `--name-only` appends the changed files after the last one.
 */
export const logFormat = '--format=%x1e%H%x1f%as%x1f%s%x1f%b%x1f';

const flakeWords =
  /\b(?:flak|deflak|retr(?:y|ies|ied)|skip|quarantin|intermittent|unstable|fix(?:es|ed)? (?:the )?(?:test|spec))/iu;

/** At most this many flake mentions are listed, and the first `patched` of them carry a diff. */
export const historyLimits = { mentions: 40, patched: 10, churn: 15, files: 12 } as const;

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
};

/**
 * The commits whose message mentions a flake, and the test files (those in `tests`, which Git
 * lists by the operator's globs) that changed in more than one of the scanned commits.
 */
export function historyFacts(log: string, tests: Set<string>) {
  const commits = log
    .split('\x1e')
    .filter((record) => record.trim())
    .map((record) => {
      const [sha = '', date = '', subject = '', body = '', names = ''] = record.split('\x1f');
      return { sha, date, subject, body: body.trim(), files: names.split('\n').filter(Boolean) };
    });
  const mentions = commits.filter((commit) => flakeWords.test(`${commit.subject}\n${commit.body}`));
  const counts = new Map<string, number>();
  for (const commit of commits)
    for (const file of new Set(commit.files))
      if (tests.has(file)) counts.set(file, (counts.get(file) ?? 0) + 1);
  const churn = [...counts]
    .filter(([, changes]) => changes > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([path, changes]) => ({ path, changes }));
  return {
    scanned: commits.length,
    mentions: mentions.slice(0, historyLimits.mentions).map((commit) => ({
      sha: commit.sha,
      date: commit.date,
      subject: commit.subject,
      body: commit.body ? oneLine(commit.body, 300) : null,
      files: commit.files.slice(0, historyLimits.files),
      unlistedFiles: Math.max(0, commit.files.length - historyLimits.files),
      patch: null as string | null,
    })),
    unlistedMentions: Math.max(0, mentions.length - historyLimits.mentions),
    churn: churn.slice(0, historyLimits.churn),
    unlistedChurn: Math.max(0, churn.length - historyLimits.churn),
  };
}

/**
 * Attach each patched commit's test-file diff from `git show --format=%x1e%H` output, cut to
 * `max` characters, and shorten every SHA for the prompt.
 */
export function withPatches(facts: History, shown: string, max = 2_000): History {
  const diffs = new Map(
    shown
      .split('\x1e')
      .filter((record) => record.trim())
      .map((record) => {
        const newline = record.indexOf('\n');
        const sha = (newline < 0 ? record : record.slice(0, newline)).trim();
        const diff = newline < 0 ? '' : record.slice(newline + 1).trim();
        return [sha, diff.length > max ? `${diff.slice(0, max)}\n[diff cut]` : diff] as const;
      }),
  );
  return {
    ...facts,
    mentions: facts.mentions.map((commit) => ({
      ...commit,
      sha: commit.sha.slice(0, 12),
      patch: diffs.get(commit.sha) || null,
    })),
  };
}

const keyOf = (found: Found) => `${found.file}::${found.test}`;

/**
 * One suspect per file and test, its evidence kept per modality, corroborated first. Corroboration
 * counts modalities: a sweep that names a test twice counts once (the upstream counted every
 * mention).
 */
export function merge(answers: { modality: Modality; suspects: Found[] }[]): Suspect[] {
  const byKey = new Map<string, Suspect>();
  for (const { modality, suspects } of answers)
    for (const found of new Map(suspects.map((s) => [keyOf(s), s])).values()) {
      const previous = byKey.get(keyOf(found));
      const evidence = { modality, evidence: found.evidence };
      byKey.set(keyOf(found), {
        test: found.test,
        file: found.file,
        evidence: [...(previous?.evidence ?? []), evidence],
        corroboration: (previous?.corroboration ?? 0) + 1,
      });
    }
  // A stable sort keeps discovery order within one corroboration level.
  return [...byKey.values()].sort((a, b) => b.corroboration - a.corroboration);
}

/**
 * The operator's test command runs a suspect's file, so an agent's choice of file must not choose
 * the program: the file must be tracked and match the operator's test-file globs. The test name
 * must not read as an option or span lines once it is substituted into the argv.
 */
export function screen(suspects: Suspect[], files: { tracked: Set<string>; tests: Set<string> }) {
  const reason = (suspect: Suspect): Rejected['reason'] | null =>
    !files.tracked.has(suspect.file)
      ? 'untracked-file'
      : !files.tests.has(suspect.file)
        ? 'not-a-test-file'
        : suspect.test.startsWith('-') || /[\0-\x1f]/u.test(suspect.test)
          ? 'unsafe-test-name'
          : null;
  return {
    kept: suspects.filter((suspect) => reason(suspect) === null),
    rejected: suspects.flatMap((suspect): Rejected[] => {
      const why = reason(suspect);
      return why ? [{ ...suspect, reason: why }] : [];
    }),
  };
}

/** The stress slots go to the most corroborated suspects; the rest are reported, never dropped. */
export const cap = (suspects: Suspect[], max: number) => ({
  stressed: suspects.slice(0, max),
  skipped: suspects.slice(max),
});

/**
 * The operator's pass pattern for one test, its {test} replaced by the escaped name, or null when
 * the operator set none.
 */
export const passFor = (pattern: string | null, test: string): RegExp | null =>
  pattern === null
    ? null
    : new RegExp(
        pattern.replaceAll('{test}', () => test.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&')),
        'u',
      );

/** The operator's argv with {file} and {test} replaced literally (no `$` patterns). */
export const argvFor = (
  template: readonly [string, ...string[]],
  { file, test }: { file: string; test: string },
) =>
  template.map((arg) => arg.replaceAll('{file}', () => file).replaceAll('{test}', () => test)) as [
    string,
    ...string[],
  ];

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? null)
    : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
};

/**
 * The verdict is arithmetic over what code observed: a command that could not start, or a passing
 * exit without the operator's passPattern, is could-not-run; no failure is stable, every run
 * failing is always-fails, and anything between is flaky. Timeouts and signals count as failures;
 * a stress timeout is a timing symptom.
 */
export function summarize(
  argv: Stress['argv'],
  outcomes: Run[],
  samples: { sample: string | null; passSample: string | null },
): Stress {
  const failures = outcomes.filter((run) => run.outcome !== 'pass').length;
  const durations = (passed: boolean) =>
    outcomes.flatMap((run) =>
      (run.outcome === 'pass') === passed && run.durationMs !== null ? [run.durationMs] : [],
    );
  return {
    argv,
    runs: outcomes.length,
    failures,
    verdict: outcomes.some((run) => run.outcome === 'error' || run.outcome === 'unmatched')
      ? 'could-not-run'
      : failures === 0
        ? 'stable'
        : failures === outcomes.length
          ? 'always-fails'
          : 'flaky',
    outcomes,
    ...samples,
    medianPassMs: median(durations(true)),
    medianFailMs: median(durations(false)),
  };
}

/** The last characters of a run's output: a failure's evidence, or what a pass ran. */
export const tail = (text: string, max = 1_500) => (text.length > max ? text.slice(-max) : text);

/**
 * Diagnosed flakes with a named mechanism. A fix without a mechanism is a retry in disguise, so an
 * `unknown` diagnosis is reported, and listed by `unplanned`, but never planned. (The upstream
 * applied every proposed fix whatever its mechanism.)
 */
export const fixPlan = (confirmed: Flake[]): PlanItem[] =>
  confirmed.flatMap((flake) =>
    flake.diagnosis && flake.diagnosis.mechanism !== 'unknown'
      ? [planItem(flake, flake.diagnosis)]
      : [],
  );
/** The confirmed flakes `fixPlan` leaves out, with the reason. */
export const unplanned = (confirmed: Flake[]): Unplanned[] =>
  confirmed.flatMap(({ test, file, diagnosis }): Unplanned[] =>
    !diagnosis
      ? [{ test, file, reason: 'undiagnosed' }]
      : diagnosis.mechanism === 'unknown'
        ? [{ test, file, reason: 'unknown-mechanism' }]
        : [],
  );
/**
 * The measurement and the diagnosis, so the human approves the evidence along with the edit, and
 * exactly the files the diagnosis named: a fix the diagnosis put in the code under test does not
 * also license an edit (a retry, a skip) to the test file.
 */
const planItem = ({ test, file, stress }: Flake, diagnosis: Diagnosis): PlanItem => ({
  test,
  file,
  failures: stress.failures,
  runs: stress.runs,
  mechanism: diagnosis.mechanism,
  confidence: diagnosis.confidence,
  explanation: diagnosis.explanation,
  proposedFix: diagnosis.proposedFix,
  files: [...new Set(diagnosis.files)],
});

/** The SHA-256 of the approved plan text, in the form the fixer receives it. */
export const planDigest = (plan: string): string => createHash('sha256').update(plan).digest('hex');

/**
 * The fixer's change, with the files it touched outside the approved plan and the approved fixes
 * it left untouched: an unchanged tree can pass a re-stress by chance. Every rename is refused, as
 * the fix prompt says: a fix edits approved files in place, and a rename deletes its source (the
 * receipt's `from`) even when its destination is approved. Plan paths are relative to the working
 * directory, while receipt paths are repository-relative, so `prefix` (the working directory's
 * `git rev-parse --show-prefix`) joins the two.
 */
export function owned(change: WorktreeChange | undefined, plan: PlanItem[], prefix: string) {
  if (!change) throw new Error('Fixer did not produce an isolated receipt');
  const inRepo = (path: string) => `${prefix}${path}`;
  const approved = new Set(plan.flatMap((item) => item.files.map(inRepo)));
  const touched = new Set(change.files.map((file) => file.path));
  const refusedFiles = change.files
    .filter((file) => !approved.has(file.path) || file.status === 'renamed')
    .map((file) => file.path);
  const untouched = plan
    .filter((item) => !item.files.some((file) => touched.has(inRepo(file))))
    .map(({ test, file }) => ({ test, file }));
  return { change, refusedFiles, untouched };
}

/**
 * The approval details: the plan, cut at a character boundary below the question's 16 KiB limit,
 * with a marker naming what was cut. The subject and the digest carry the whole plan.
 */
export function preview(text: string, max = 15_000): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  let end = max;
  // Back off UTF-8 continuation bytes, so the cut never splits a character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  const cut = String(bytes.length - end);
  return `${bytes.subarray(0, end).toString('utf8')}\n[${cut} more bytes cut; the subject and its digest cover the whole plan]`;
}
