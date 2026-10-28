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

/** One suspect per file and test, its evidence kept per modality, corroborated first. */
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
 * The verdict is arithmetic over what code observed: a command that could not start is
 * could-not-run, no failure is stable, every run failing is always-fails, and anything between is
 * flaky. Timeouts and signals count as failures; a stress timeout is a timing symptom.
 */
export function summarize(argv: Stress['argv'], outcomes: Run[], sample: string | null): Stress {
  const failures = outcomes.filter((run) => run.outcome !== 'pass').length;
  const durations = (passed: boolean) =>
    outcomes.flatMap((run) =>
      (run.outcome === 'pass') === passed && run.durationMs !== null ? [run.durationMs] : [],
    );
  return {
    argv,
    runs: outcomes.length,
    failures,
    verdict: outcomes.some((run) => run.outcome === 'error')
      ? 'could-not-run'
      : failures === 0
        ? 'stable'
        : failures === outcomes.length
          ? 'always-fails'
          : 'flaky',
    outcomes,
    sample,
    medianPassMs: median(durations(true)),
    medianFailMs: median(durations(false)),
  };
}

/** The last characters of a failing run's output, the diagnostician's failure evidence. */
export const tail = (text: string, max = 1_500) => (text.length > max ? text.slice(-max) : text);

/**
 * Diagnosed flakes with a named mechanism. A fix without a mechanism is a retry in disguise, so an
 * `unknown` diagnosis is reported but never planned.
 */
export const fixPlan = (confirmed: Flake[]): PlanItem[] =>
  confirmed.flatMap(({ test, file, diagnosis }) =>
    diagnosis && diagnosis.mechanism !== 'unknown' ? [planItem(test, file, diagnosis)] : [],
  );
const planItem = (test: string, file: string, diagnosis: Diagnosis): PlanItem => ({
  test,
  file,
  mechanism: diagnosis.mechanism,
  proposedFix: diagnosis.proposedFix,
  files: [...new Set([file, ...diagnosis.files])],
});

/** The SHA-256 of the approved plan text, in the form the fixer receives it. */
export const planDigest = (plan: string): string => createHash('sha256').update(plan).digest('hex');

/**
 * The fixer's change, with the files it touched outside the approved plan (renames included) and
 * the approved fixes it left untouched: an unchanged tree can pass a re-stress by chance.
 */
export function owned(change: WorktreeChange | undefined, plan: PlanItem[]) {
  if (!change) throw new Error('Fixer did not produce an isolated receipt');
  const approved = new Set(plan.flatMap((item) => item.files));
  const touched = new Set(change.files.map((file) => file.path));
  const refusedFiles = change.files
    .filter((file) => !approved.has(file.path) || file.status === 'renamed')
    .map((file) => file.path);
  const untouched = plan
    .filter((item) => !item.files.some((file) => touched.has(file)))
    .map(({ test, file }) => ({ test, file }));
  return { change, refusedFiles, untouched };
}

/** A bounded preview for the approval question; the subject carries the whole plan. */
export const preview = (text: string): string =>
  Buffer.from(text).subarray(0, 15_000).toString('utf8');
