/**
 * Zod schemas for the data that recurs across workflows, so a workflow names a shared contract
 * instead of re-declaring it:
 *
 * - Input-side primitives such as {@link RepoPath}, {@link Sha}, {@link Key}, {@link Argv} and
 *   {@link limit}, for workflow inputs, outputs and local checks.
 * - Agent-output enums and records such as {@link Severity}, {@link Finding}, {@link WorkReport},
 *   {@link Plan} and {@link Refutation}, for structured agent calls.
 * - Builders for shapes known only at runtime: {@link oneOf}, {@link listOf} and {@link rubric}.
 *
 * Every record but {@link Receipt} (typed as the runtime's `WriteFileResult`) is a plain `z.object`
 * annotated with its exact Zod type, so `.shape`, `.extend()` and `.pick()` keep working, and each
 * schema exports its inferred type under the same name.
 *
 * The agent-output schemas follow rules that both harnesses' structured output accepts: an object
 * root, every property required (`.nullable()` where absence means something), no records, tuples
 * or format validators such as `.regex()`. Enums list their values in rank order, most severe or
 * important first ({@link Size} runs from smallest to largest). A schema's `.describe()` text is what the agent reads, and it is part of the
 * identity of every call that sends the schema, so released text does not change. The input-side
 * {@link Sha}, {@link ShortSha}, {@link Sha256}, {@link Key}, {@link Argv} and {@link Receipt} use
 * patterns or tuples: validate data with them, but do not request them from an agent.
 *
 * ```ts
 * import { z } from 'quiet-choir';
 * import * as std from 'quiet-choir/std';
 *
 * const { findings } = await ctx.roster.Reviewer.value('review', {
 *   prompt: 'Find defects in src/parser.ts.',
 *   schema: std.types.Findings,
 * });
 * const Ticket = std.types.Task.extend({ owner: z.string().min(1) });
 * const Input = z.object({ rounds: std.types.limit(3, 10) });
 * ```
 *
 * @module
 */
import { isAbsolute, win32 } from 'node:path';
import { z, type WriteFileResult } from '../index.js';

// ---------------------------------------------------------------------------------------------
// Input-side primitives
// ---------------------------------------------------------------------------------------------

/**
 * Whether `path` is a repository-relative path: 1 to 500 characters, not absolute on POSIX or
 * Windows, no drive-letter prefix (`C:/x`, `C:x`), no backslash or NUL, and no `.`, `..`, empty or
 * `.git` segment. `committedArtifact` in `std.exec` refuses any other path.
 *
 * @param path - The candidate path.
 * @returns Whether `path` follows the rule.
 */
export function isRepoPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 500 &&
    !path.startsWith('/') &&
    !isAbsolute(path) &&
    !win32.isAbsolute(path) &&
    !/^[A-Za-z]:/u.test(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => part !== '..' && part !== '.' && part !== '' && part !== '.git')
  );
}

/**
 * A repository-relative path that satisfies {@link isRepoPath}. The rule is a refinement, which
 * JSON Schema omits, so it is safe in agent output: the agent sees a described string and the
 * reply is still validated.
 */
export const RepoPath: z.ZodString = z
  .string()
  .min(1)
  .max(500)
  .refine(isRepoPath, 'Use a repository-relative path without dot segments or .git')
  .describe(
    'A path relative to the repository root, with forward slashes and no ./ or ../ segments, such as src/index.ts.',
  );
/** A {@link RepoPath} value. */
export type RepoPath = z.infer<typeof RepoPath>;

/** Input-side: a full Git object ID of 40 (SHA-1) or 64 (SHA-256) lowercase hex characters. */
export const Sha: z.ZodString = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)
  .describe('A full Git object ID: 40 (SHA-1) or 64 (SHA-256) lowercase hexadecimal characters.');
/** A {@link Sha} value. */
export type Sha = z.infer<typeof Sha>;

/** Input-side: a full or abbreviated Git object ID of 7 to 64 lowercase hex characters. */
export const ShortSha: z.ZodString = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/u)
  .describe('A full or abbreviated Git object ID: 7 to 64 lowercase hexadecimal characters.');
/** A {@link ShortSha} value. */
export type ShortSha = z.infer<typeof ShortSha>;

/** Input-side: a SHA-256 digest of 64 lowercase hex characters, as receipts carry it. */
export const Sha256: z.ZodString = z
  .string()
  .regex(/^[0-9a-f]{64}$/u)
  .describe('A SHA-256 digest: 64 lowercase hexadecimal characters.');
/** A {@link Sha256} value. */
export type Sha256 = z.infer<typeof Sha256>;

/**
 * Input-side: an ID-safe key, a letter or digit then up to 63 letters, digits, `.`, `_`, `:` or
 * `-`. Such a key is a clean step-ID segment, which `ctx.id` passes through unchanged.
 */
export const Key: z.ZodString = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u)
  .describe(
    'An ID-safe key: a letter or digit, then up to 63 letters, digits, dots, underscores, colons or hyphens.',
  );
/** A {@link Key} value. */
export type Key = z.infer<typeof Key>;

/**
 * Input-side: a command as an argument vector, a non-empty program then its arguments, run
 * without a shell. Its value is a `Command` for `ctx.exec`.
 */
export const Argv: z.ZodTuple<[z.ZodString], z.ZodString> = z
  .tuple([z.string().min(1)], z.string())
  .describe(
    'A command as an argument vector: the program, then its arguments, run without a shell.',
  );
/** An {@link Argv} value. */
export type Argv = z.infer<typeof Argv>;

/**
 * A bounded integer workflow input with a default, so an input object declares a limit in one line:
 * `z.int().min(min).max(max).default(defaultValue)`.
 *
 * @param defaultValue - The value an omitted input takes.
 * @param max - The largest accepted value.
 * @param min - The smallest accepted value; default 1.
 * @returns The integer schema with its default.
 * @throws TypeError - When an argument is not a safe integer.
 * @throws RangeError - Unless `min <= defaultValue <= max`.
 */
export function limit(defaultValue: number, max: number, min = 1): z.ZodDefault<z.ZodInt> {
  for (const [name, value] of [
    ['defaultValue', defaultValue],
    ['max', max],
    ['min', min],
  ] as const) {
    if (!Number.isSafeInteger(value))
      throw new TypeError(`limit ${name} must be a safe integer, got ${String(value)}`);
  }
  if (min > defaultValue || defaultValue > max)
    throw new RangeError(
      `limit needs min <= defaultValue <= max, got min ${String(min)}, defaultValue ${String(defaultValue)}, max ${String(max)}`,
    );
  return z.int().min(min).max(max).default(defaultValue);
}

// ---------------------------------------------------------------------------------------------
// Agent-output primitives and enums
// ---------------------------------------------------------------------------------------------

/** Non-empty text explaining a decision through the evidence behind it. */
export const Rationale: z.ZodString = z
  .string()
  .min(1)
  .describe('Why, citing the specific evidence that decided it.');
/** A {@link Rationale} value. */
export type Rationale = z.infer<typeof Rationale>;

/** Non-empty text with concrete support: references, output or quotes rather than a paraphrase. */
export const Evidence: z.ZodString = z
  .string()
  .min(1)
  .describe(
    'Concrete support: file:line references, command output or quoted text, not a paraphrase.',
  );
/** An {@link Evidence} value. */
export type Evidence = z.infer<typeof Evidence>;

/** Non-empty summary text. */
export const Summary: z.ZodString = z.string().min(1).describe('A brief plain-language summary.');
/** A {@link Summary} value. */
export type Summary = z.infer<typeof Summary>;

/** An integer score from 1 (poor) to 10 (excellent); {@link rubric} builds score sheets of it. */
export const Score: z.ZodInt = z
  .int()
  .min(1)
  .max(10)
  .describe('A score from 1 (poor) to 10 (excellent).');
/** A {@link Score} value. */
export type Score = z.infer<typeof Score>;

/** How serious a defect is: `critical`, `high`, `medium` or `low`, most severe first. */
export const Severity: z.ZodEnum<z.util.ToEnum<'critical' | 'high' | 'medium' | 'low'>> = z
  .enum(['critical', 'high', 'medium', 'low'])
  .describe(
    'critical: security hole, data loss or outage; high: wrong behavior on a common path; medium: wrong behavior on an uncommon path; low: minor or cosmetic.',
  );
/** A {@link Severity} value. */
export type Severity = z.infer<typeof Severity>;

/**
 * A three-step level, `high`, `medium` or `low`, for confidence, risk, value or priority. It has no
 * description, so describe the field that uses it.
 */
export const Level: z.ZodEnum<z.util.ToEnum<'high' | 'medium' | 'low'>> = z.enum([
  'high',
  'medium',
  'low',
]);
/** A {@link Level} value. */
export type Level = z.infer<typeof Level>;

/** Relative effort: `XS`, `S`, `M`, `L` or `XL`. */
export const Size: z.ZodEnum<z.util.ToEnum<'XS' | 'S' | 'M' | 'L' | 'XL'>> = z
  .enum(['XS', 'S', 'M', 'L', 'XL'])
  .describe(
    'Relative effort: XS (trivial), S (small), M (a focused change), L (a large change), XL (too large for one piece of work; split it).',
  );
/** A {@link Size} value. */
export type Size = z.infer<typeof Size>;

/** Whether a change is `mechanical` or `subtle`; pairs with the Mechanic and Surgeon tiers. */
export const Complexity: z.ZodEnum<z.util.ToEnum<'mechanical' | 'subtle'>> = z
  .enum(['mechanical', 'subtle'])
  .describe(
    'mechanical: the change is clear and local; subtle: it needs judgement about design, behavior or cross-cutting effects.',
  );
/** A {@link Complexity} value. */
export type Complexity = z.infer<typeof Complexity>;

/** How far a piece of work got: `done`, `partial`, `blocked` or `skipped`. */
export const WorkStatus: z.ZodEnum<z.util.ToEnum<'done' | 'partial' | 'blocked' | 'skipped'>> = z
  .enum(['done', 'partial', 'blocked', 'skipped'])
  .describe(
    'done: all of it was completed; partial: some of it; blocked: could not proceed; skipped: deliberately not attempted.',
  );
/** A {@link WorkStatus} value. */
export type WorkStatus = z.infer<typeof WorkStatus>;

/** The result of checking one criterion: `pass`, `fail`, `partial` or `unverifiable`. */
export const CheckStatus: z.ZodEnum<z.util.ToEnum<'pass' | 'fail' | 'partial' | 'unverifiable'>> = z
  .enum(['pass', 'fail', 'partial', 'unverifiable'])
  .describe(
    'pass: shown to hold; fail: shown not to hold; partial: holds only in part; unverifiable: could not be checked.',
  );
/** A {@link CheckStatus} value. */
export type CheckStatus = z.infer<typeof CheckStatus>;

/** One gate dimension's status: `pass`, `concern`, `blocker` or `cannot-check`. */
export const GateStatus: z.ZodEnum<z.util.ToEnum<'pass' | 'concern' | 'blocker' | 'cannot-check'>> =
  z
    .enum(['pass', 'concern', 'blocker', 'cannot-check'])
    .describe(
      'pass: no problem found; concern: a problem that should not block; blocker: a problem that must block; cannot-check: could not be assessed.',
    );
/** A {@link GateStatus} value. */
export type GateStatus = z.infer<typeof GateStatus>;

/** A release or merge decision: `go`, `conditional-go` or `no-go`. */
export const GateDecision: z.ZodEnum<z.util.ToEnum<'go' | 'conditional-go' | 'no-go'>> = z
  .enum(['go', 'conditional-go', 'no-go'])
  .describe(
    'go: proceed; conditional-go: proceed once the stated conditions are met; no-go: do not proceed.',
  );
/** A {@link GateDecision} value. */
export type GateDecision = z.infer<typeof GateDecision>;

/** The outcome of a vote on a claim: `confirmed`, `refuted` or `undecided`. */
export const Outcome: z.ZodEnum<z.util.ToEnum<'confirmed' | 'refuted' | 'undecided'>> = z
  .enum(['confirmed', 'refuted', 'undecided'])
  .describe('Whether a claim was confirmed, refuted or left undecided.');
/** An {@link Outcome} value. */
export type Outcome = z.infer<typeof Outcome>;

/** The kind of a change-log entry, user-facing kinds first. */
export const ChangeKind: z.ZodEnum<
  z.util.ToEnum<
    'feature' | 'fix' | 'breaking' | 'performance' | 'deprecation' | 'docs' | 'internal'
  >
> = z
  .enum(['feature', 'fix', 'breaking', 'performance', 'deprecation', 'docs', 'internal'])
  .describe(
    'feature: a new capability; fix: corrects a defect; breaking: an incompatible change users must adapt to; performance: faster or lighter with the same behavior; deprecation: marks something for removal; docs: documentation only; internal: no user-visible effect.',
  );
/** A {@link ChangeKind} value. */
export type ChangeKind = z.infer<typeof ChangeKind>;

/** The verdict of trying to falsify a hypothesis: `falsified`, `survives` or `untestable`. */
export const FalsificationVerdict: z.ZodEnum<
  z.util.ToEnum<'falsified' | 'survives' | 'untestable'>
> = z
  .enum(['falsified', 'survives', 'untestable'])
  .describe(
    'falsified: a checked prediction failed; survives: every checked prediction held; untestable: no prediction could be checked.',
  );
/** A {@link FalsificationVerdict} value. */
export type FalsificationVerdict = z.infer<typeof FalsificationVerdict>;

// ---------------------------------------------------------------------------------------------
// Agent-output records
// ---------------------------------------------------------------------------------------------

/** A short ID an agent assigns, such as `T1`: plain text, since agent output takes no patterns. */
function agentId(description: string): z.ZodString {
  return z.string().min(1).max(64).describe(description);
}

/** Non-empty agent text. */
function nonEmpty(description: string): z.ZodString {
  return z.string().min(1).describe(description);
}

/** A list of non-empty agent text. */
function nonEmptyList(description: string): z.ZodArray<z.ZodString> {
  return z.array(z.string().min(1)).describe(description);
}

/** A located defect: where it is, how serious, the evidence and the concrete failure it causes. */
export const Finding: z.ZodObject<{
  /** A one-line statement of the defect, at most 200 characters. */
  title: z.ZodString;
  /** The repository-relative file that contains the defect (a {@link RepoPath}). */
  file: z.ZodString;
  /** The 1-based line of the defect, or null when no single line applies. */
  line: z.ZodNullable<z.ZodInt>;
  /** How serious the defect is. */
  severity: typeof Severity;
  /** The code, output or quote that shows the defect. */
  evidence: z.ZodString;
  /** The concrete inputs or state that trigger the defect, and the wrong outcome they cause. */
  failureScenario: z.ZodString;
}> = z.object({
  title: z.string().min(1).max(200).describe('A one-line statement of the defect.'),
  file: RepoPath.describe('The repository-relative path of the file that contains the defect.'),
  line: z
    .int()
    .min(1)
    .nullable()
    .describe('The 1-based line of the defect, or null when no single line applies.'),
  severity: Severity,
  evidence: Evidence.describe(
    'The code, output or quote that shows the defect, with file:line references.',
  ),
  failureScenario: nonEmpty(
    'The concrete inputs or state that trigger the defect, and the wrong outcome they cause.',
  ),
});
/** A {@link Finding} value. */
export type Finding = z.infer<typeof Finding>;

/** Up to 20 {@link Finding}s; an empty list is a valid answer. */
export const Findings: z.ZodObject<{
  /** The defects found, most severe first; may be empty. */
  findings: z.ZodArray<typeof Finding>;
}> = z.object({
  findings: z
    .array(Finding)
    .max(20)
    .describe('The defects found, most severe first. An empty list is a valid answer.'),
});
/** A {@link Findings} value. */
export type Findings = z.infer<typeof Findings>;

/** A skeptic's verdict on one claim: `refuted` unless the evidence shows the claim holds. */
export const Refutation: z.ZodObject<{
  /** True when the claim is wrong or unestablished; false only when the evidence shows it holds. */
  refuted: z.ZodBoolean;
  /** Why, citing the evidence. */
  reasoning: z.ZodString;
}> = z.object({
  refuted: z
    .boolean()
    .describe(
      'true when the claim is wrong or the evidence does not establish it; false only when the evidence shows it holds.',
    ),
  reasoning: Rationale,
});
/** A {@link Refutation} value. */
export type Refutation = z.infer<typeof Refutation>;

/** One seat's yes or no vote on a question, with its reasoning. */
export const Ballot: z.ZodObject<{
  /** The vote: true for yes, false for no. */
  yes: z.ZodBoolean;
  /** Why, citing the evidence. */
  reasoning: z.ZodString;
}> = z.object({
  yes: z.boolean().describe('Your vote: true for yes, false for no.'),
  reasoning: Rationale,
});
/** A {@link Ballot} value. */
export type Ballot = z.infer<typeof Ballot>;

/**
 * A reviewer's approval with free-text feedback. It carries no descriptions and is exactly
 * `z.object({ approved: z.boolean(), feedback: z.string() })`, the schema `reviewRevise` in
 * `std.patterns` sends, so either can replace the other without changing a call's identity.
 */
export const Approval: z.ZodObject<{
  /** Whether the reviewer approves. */
  approved: z.ZodBoolean;
  /** What to change; may be empty, typically when approved. */
  feedback: z.ZodString;
}> = z.object({ approved: z.boolean(), feedback: z.string() });
/** An {@link Approval} value. */
export type Approval = z.infer<typeof Approval>;

/** One repairable problem: where it is, what is wrong and the concrete fix. */
export const Issue: z.ZodObject<{
  /** Where the problem is: a section, a file:line or a requirement. */
  where: z.ZodString;
  /** What is wrong. */
  problem: z.ZodString;
  /** The concrete change that resolves it. */
  fix: z.ZodString;
}> = z.object({
  where: nonEmpty('Where the problem is: a section, a file:line or a requirement.'),
  problem: nonEmpty('What is wrong, specifically.'),
  fix: nonEmpty(
    'The concrete change that resolves it: the rewrite or an exact instruction, not "clarify".',
  ),
});
/** An {@link Issue} value. */
export type Issue = z.infer<typeof Issue>;

/** A critic's reply: up to 20 {@link Issue}s, where an empty list approves. */
export const Critique: z.ZodObject<{
  /** Problems that must be fixed, most important first; empty to approve. */
  issues: z.ZodArray<typeof Issue>;
}> = z.object({
  issues: z
    .array(Issue)
    .max(20)
    .describe(
      'Problems that must be fixed, most important first. An empty list approves the work.',
    ),
});
/** A {@link Critique} value. */
export type Critique = z.infer<typeof Critique>;

/** An implementer's report of a piece of work. Trust a command, not this report, for success. */
export const WorkReport: z.ZodObject<{
  /** How far the work got. */
  status: typeof WorkStatus;
  /** What was done, and what remains. */
  summary: z.ZodString;
  /** Repository-relative paths of the changed files, at most 100. */
  files: z.ZodArray<z.ZodString>;
  /** What stopped the work from finishing; empty when nothing did. */
  blockers: z.ZodArray<z.ZodString>;
  /** Assumptions, deviations and follow-ups; empty when none. */
  notes: z.ZodArray<z.ZodString>;
}> = z.object({
  status: WorkStatus,
  summary: Summary.describe('What you did, and what remains.'),
  files: z
    .array(z.string().min(1))
    .max(100)
    .describe('Repository-relative paths of the files you changed.'),
  blockers: nonEmptyList('What stopped you from finishing; empty when nothing did.'),
  notes: nonEmptyList(
    'What the next reader should know: assumptions, deviations and follow-ups; empty when none.',
  ),
});
/** A {@link WorkReport} value. */
export type WorkReport = z.infer<typeof WorkReport>;

/** An agent's report of running checks: whether all passed, a summary and each failure. */
export const Verification: z.ZodObject<{
  /** True only when every check passed. */
  passed: z.ZodBoolean;
  /** What was checked and the overall result. */
  summary: z.ZodString;
  /** Each failure; empty when passed. */
  failures: z.ZodArray<
    z.ZodObject<{
      /** What failed: the check or command, and the error it reported. */
      description: z.ZodString;
      /** Repository-relative paths of the files involved; empty when unknown. */
      files: z.ZodArray<z.ZodString>;
    }>
  >;
}> = z.object({
  passed: z.boolean().describe('true only when every check passed.'),
  summary: Summary.describe('What was checked, and the overall result.'),
  failures: z
    .array(
      z.object({
        description: nonEmpty('What failed: the check or command, and the error it reported.'),
        files: nonEmptyList('Repository-relative paths of the files involved; empty when unknown.'),
      }),
    )
    .describe('Each failure; empty when passed.'),
});
/** A {@link Verification} value. */
export type Verification = z.infer<typeof Verification>;

/** One step of a {@link Plan}. */
export const Step: z.ZodObject<{
  /** A short unique ID, such as `S1`. */
  id: z.ZodString;
  /** What to change, and why. */
  description: z.ZodString;
  /** Repository-relative paths the step changes or creates. */
  files: z.ZodArray<z.ZodString>;
}> = z.object({
  id: agentId('A short unique step ID, such as S1.'),
  description: nonEmpty('What to change, and why.'),
  files: nonEmptyList('Repository-relative paths this step changes or creates.'),
});
/** A {@link Step} value. */
export type Step = z.infer<typeof Step>;

/** An implementation plan: the approach, 1 to 20 ordered steps, risks and proving commands. */
export const Plan: z.ZodObject<{
  /** The approach, in a few sentences. */
  summary: z.ZodString;
  /** The steps, in order; 1 to 20. */
  steps: z.ZodArray<typeof Step>;
  /** What could go wrong, and how it would show. */
  risks: z.ZodArray<z.ZodString>;
  /** Commands that prove the change works. */
  checks: z.ZodArray<z.ZodString>;
}> = z.object({
  summary: Summary.describe('The approach, in a few sentences.'),
  steps: z.array(Step).min(1).max(20).describe('The steps, in order.'),
  risks: nonEmptyList('What could go wrong, and how it would show; empty when none.'),
  checks: nonEmptyList('Commands that prove the change works, such as npm test.'),
});
/** A {@link Plan} value. */
export type Plan = z.infer<typeof Plan>;

/** One task of a backlog, with acceptance conditions and the IDs of the tasks it depends on. */
export const Task: z.ZodObject<{
  /** A short unique ID, such as `T1`. */
  id: z.ZodString;
  /** A one-line imperative title, at most 120 characters. */
  title: z.ZodString;
  /** What to do, with the context needed to start. */
  description: z.ZodString;
  /** At least one observable condition that shows the task is done. */
  acceptance: z.ZodArray<z.ZodString>;
  /** IDs of the tasks that must be finished first; empty when none. */
  dependsOn: z.ZodArray<z.ZodString>;
  /** Relative effort. */
  size: typeof Size;
}> = z.object({
  id: agentId('A short unique task ID, such as T1.'),
  title: z.string().min(1).max(120).describe('A one-line imperative title.'),
  description: nonEmpty('What to do, with the context needed to start.'),
  acceptance: z
    .array(z.string().min(1))
    .min(1)
    .describe('Observable conditions that show the task is done.'),
  dependsOn: z
    .array(z.string().min(1).max(64))
    .describe('IDs of the tasks that must be finished first; empty when none.'),
  size: Size,
});
/** A {@link Task} value. */
export type Task = z.infer<typeof Task>;

/** A planner's backlog: 1 to 30 {@link Task}s. */
export const TaskList: z.ZodObject<{
  /** The tasks; 1 to 30. */
  tasks: z.ZodArray<typeof Task>;
}> = z.object({
  tasks: z
    .array(Task)
    .min(1)
    .max(30)
    .describe('The tasks, each small enough to finish and review on its own.'),
});
/** A {@link TaskList} value. */
export type TaskList = z.infer<typeof TaskList>;

/** An acceptance criterion and how to check it; workflow data more often than agent output. */
export const Criterion: z.ZodObject<{
  /** A short unique ID, such as `C1`. */
  id: z.ZodString;
  /** A condition that must hold. */
  criterion: z.ZodString;
  /** How to check it; may be empty to leave it to the checker. */
  how: z.ZodString;
}> = z.object({
  id: agentId('A short unique criterion ID, such as C1.'),
  criterion: nonEmpty('A condition that must hold.'),
  how: z
    .string()
    .describe(
      'How to check it: a command, a test or what to inspect; empty to leave it to the checker.',
    ),
});
/** A {@link Criterion} value. */
export type Criterion = z.infer<typeof Criterion>;

/** The result of checking one {@link Criterion}. */
export const CriterionResult: z.ZodObject<{
  /** Whether the criterion holds. */
  status: typeof CheckStatus;
  /** What shows the status. */
  evidence: z.ZodString;
}> = z.object({ status: CheckStatus, evidence: Evidence });
/** A {@link CriterionResult} value. */
export type CriterionResult = z.infer<typeof CriterionResult>;

/** One factual claim with its source and, where there is one, the exact supporting quote. */
export const Citation: z.ZodObject<{
  /** One factual claim. */
  claim: z.ZodString;
  /** Where it is established: a file:line, URL, commit SHA or log line. */
  source: z.ZodString;
  /** The exact supporting text, or null when there is nothing to quote. */
  quote: z.ZodNullable<z.ZodString>;
}> = z.object({
  claim: nonEmpty('One factual claim.'),
  source: nonEmpty('Where it is established: a file:line, URL, commit SHA or log line.'),
  quote: z
    .string()
    .min(1)
    .nullable()
    .describe('The exact supporting text, or null when there is nothing to quote.'),
});
/** A {@link Citation} value. */
export type Citation = z.infer<typeof Citation>;

/** A reader's reply: up to 20 {@link Citation}s; an empty list is a valid answer. */
export const Claims: z.ZodObject<{
  /** Claims that bear on the question, each with its source; may be empty. */
  claims: z.ZodArray<typeof Citation>;
}> = z.object({
  claims: z
    .array(Citation)
    .max(20)
    .describe(
      'Claims that bear on the question, each with its source. An empty list is a valid answer.',
    ),
});
/** A {@link Claims} value. */
export type Claims = z.infer<typeof Claims>;

/** A source worth reading and what it should reveal. */
export const Lead: z.ZodObject<{
  /** What to read: a URL, repository path, package or identifier. */
  ref: z.ZodString;
  /** What it should reveal. */
  why: z.ZodString;
}> = z.object({
  ref: nonEmpty('What to read: a URL, repository path, package or identifier.'),
  why: nonEmpty('What it should reveal.'),
});
/** A {@link Lead} value. */
export type Lead = z.infer<typeof Lead>;

/** A scout's reply: up to 10 {@link Lead}s, best first. */
export const Leads: z.ZodObject<{
  /** The most promising sources, best first; at most 10. */
  leads: z.ZodArray<typeof Lead>;
}> = z.object({
  leads: z.array(Lead).max(10).describe('The most promising sources, best first.'),
});
/** A {@link Leads} value. */
export type Leads = z.infer<typeof Leads>;

/** A candidate explanation with the mechanism and 1 to 5 checkable predictions. */
export const Hypothesis: z.ZodObject<{
  /** A short unique ID, such as `H1`. */
  id: z.ZodString;
  /** The proposed cause, in one sentence. */
  cause: z.ZodString;
  /** How that cause produces what was observed. */
  mechanism: z.ZodString;
  /** Checkable observations that must hold if the hypothesis is true; 1 to 5. */
  predictions: z.ZodArray<z.ZodString>;
}> = z.object({
  id: agentId('A short unique hypothesis ID, such as H1.'),
  cause: nonEmpty('The proposed cause, in one sentence.'),
  mechanism: nonEmpty('How that cause produces what was observed.'),
  predictions: z
    .array(z.string().min(1))
    .min(1)
    .max(5)
    .describe('Observations that must hold if the hypothesis is true, each one checkable.'),
});
/** A {@link Hypothesis} value. */
export type Hypothesis = z.infer<typeof Hypothesis>;

/** A theorist's reply: 1 to 8 competing {@link Hypothesis} entries. */
export const Hypotheses: z.ZodObject<{
  /** Distinct competing explanations, most plausible first; 1 to 8. */
  hypotheses: z.ZodArray<typeof Hypothesis>;
}> = z.object({
  hypotheses: z
    .array(Hypothesis)
    .min(1)
    .max(8)
    .describe('Distinct competing explanations, most plausible first.'),
});
/** A {@link Hypotheses} value. */
export type Hypotheses = z.infer<typeof Hypotheses>;

/** A falsifier's verdict on one {@link Hypothesis}, with what was checked. */
export const Falsification: z.ZodObject<{
  /** Whether the hypothesis was falsified, survives or could not be tested. */
  verdict: typeof FalsificationVerdict;
  /** Why, citing the evidence. */
  reasoning: z.ZodString;
  /** Each prediction checked, and what was found. */
  checked: z.ZodArray<z.ZodString>;
}> = z.object({
  verdict: FalsificationVerdict,
  reasoning: Rationale,
  checked: nonEmptyList('Each prediction you checked, and what you found.'),
});
/** A {@link Falsification} value. */
export type Falsification = z.infer<typeof Falsification>;

/** One gate dimension's assessment: its status, a summary and the supporting evidence. */
export const Assessment: z.ZodObject<{
  /** The dimension's status. */
  status: typeof GateStatus;
  /** The assessment, in a few sentences. */
  summary: z.ZodString;
  /** Specific support for the status. */
  evidence: z.ZodArray<z.ZodString>;
}> = z.object({
  status: GateStatus,
  summary: Summary.describe('The assessment, in a few sentences.'),
  evidence: nonEmptyList(
    'Specific support for the status: file:line references, command output or quotes.',
  ),
});
/** An {@link Assessment} value. */
export type Assessment = z.infer<typeof Assessment>;

/** One change-log entry: its kind, a summary, the commits behind it and any migration. */
export const Change: z.ZodObject<{
  /** The kind of change. */
  kind: typeof ChangeKind;
  /** One line describing the change for its readers. */
  summary: z.ZodString;
  /** The commits that make the change; at least one. */
  shas: z.ZodArray<z.ZodString>;
  /** Whether users of the software can notice it. */
  userVisible: z.ZodBoolean;
  /** What users must do to adopt it, or null when nothing. */
  migration: z.ZodNullable<z.ZodString>;
}> = z.object({
  kind: ChangeKind,
  summary: nonEmpty('One line describing the change for its readers.'),
  shas: z.array(z.string().min(1)).min(1).describe('The commits that make this change.'),
  userVisible: z.boolean().describe('Whether users of the software can notice it.'),
  migration: z
    .string()
    .min(1)
    .nullable()
    .describe('What users must do to adopt it, or null when nothing.'),
});
/** A {@link Change} value. */
export type Change = z.infer<typeof Change>;

/** A change-log writer's reply: one {@link Change} per distinct change. */
export const Changes: z.ZodObject<{
  /** One entry per distinct change. */
  changes: z.ZodArray<typeof Change>;
}> = z.object({
  changes: z
    .array(Change)
    .describe('One entry per distinct change; group commits that make the same change.'),
});
/** A {@link Changes} value. */
export type Changes = z.infer<typeof Changes>;

/** A design proposal: a title, a summary, the full design in Markdown, tradeoffs and risks. */
export const Proposal: z.ZodObject<{
  /** A short name for the proposal. */
  title: z.ZodString;
  /** The idea, in a few sentences. */
  summary: z.ZodString;
  /** The full design, in Markdown. */
  design: z.ZodString;
  /** What the design gives up, and for what. */
  tradeoffs: z.ZodArray<z.ZodString>;
  /** What could go wrong with it. */
  risks: z.ZodArray<z.ZodString>;
}> = z.object({
  title: nonEmpty('A short name for the proposal.'),
  summary: Summary.describe('The idea, in a few sentences.'),
  design: nonEmpty('The full design, in Markdown.'),
  tradeoffs: nonEmptyList('What this design gives up, and for what.'),
  risks: nonEmptyList('What could go wrong with it.'),
});
/** A {@link Proposal} value. */
export type Proposal = z.infer<typeof Proposal>;

/** A drafted issue for a tracker such as GitHub; agent output, not an API shape. */
export const IssueDraft: z.ZodObject<{
  /** A specific one-line title, at most 120 characters. */
  title: z.ZodString;
  /** The issue body in Markdown. */
  body: z.ZodString;
  /** The issue's label. */
  label: z.ZodEnum<z.util.ToEnum<'bug' | 'enhancement' | 'documentation'>>;
  /** The number of an existing issue this duplicates, or null. */
  duplicateOf: z.ZodNullable<z.ZodInt>;
}> = z.object({
  title: z.string().min(1).max(120).describe('A specific one-line title.'),
  body: nonEmpty('The issue body in Markdown: context, the problem and the expected outcome.'),
  label: z
    .enum(['bug', 'enhancement', 'documentation'])
    .describe(
      'bug: a defect; enhancement: a new capability or improvement; documentation: documentation only.',
    ),
  duplicateOf: z
    .int()
    .min(1)
    .nullable()
    .describe('The number of an existing issue this duplicates, or null.'),
});
/** An {@link IssueDraft} value. */
export type IssueDraft = z.infer<typeof IssueDraft>;

/** A reviewer's reply at a checkpoint: continue, redo the stage with the answer, or stop. */
export const ReviewReply: z.ZodObject<{
  /** Whether to continue, redo the stage or stop. */
  decision: z.ZodEnum<z.util.ToEnum<'continue' | 'redo' | 'stop'>>;
  /** An answer or feedback for the next step; may be empty. */
  answer: z.ZodString;
}> = z.object({
  decision: z
    .enum(['continue', 'redo', 'stop'])
    .describe(
      'continue: proceed; redo: repeat the stage using the answer; stop: end the workflow.',
    ),
  answer: z.string().describe('An answer or feedback for the next step; may be empty.'),
});
/** A {@link ReviewReply} value. */
export type ReviewReply = z.infer<typeof ReviewReply>;

/**
 * What `check` in `std.exec` returns for a command: whether it passed, its exit, and the end of its
 * output. Plain JSON, so it also fits workflow outputs.
 */
export const CheckOutcome: z.ZodObject<{
  /** Whether the command succeeded with an accepted exit code. */
  passed: z.ZodBoolean;
  /** The exit code, or null when the process did not exit normally. */
  code: z.ZodNullable<z.ZodInt>;
  /** The signal that ended the process, or null. */
  signal: z.ZodNullable<z.ZodString>;
  /** The end of the combined stdout and stderr, or the failure message when there was none. */
  output: z.ZodString;
  /** Whether `output` leaves out part of what the command printed. */
  truncated: z.ZodBoolean;
}> = z.object({
  passed: z.boolean().describe('Whether the command succeeded with an accepted exit code.'),
  code: z
    .int()
    .nullable()
    .describe('The exit code, or null when the process did not exit normally.'),
  signal: z.string().nullable().describe('The signal that ended the process, or null.'),
  output: z
    .string()
    .describe(
      'The end of the combined stdout and stderr, or the failure message when there was none.',
    ),
  truncated: z.boolean().describe('Whether output leaves out part of what the command printed.'),
});
/** A {@link CheckOutcome} value. */
export type CheckOutcome = z.infer<typeof CheckOutcome>;

/** The receipt of `ctx.writeFile` or `committedArtifact` in `std.exec`, for workflow outputs. */
export const Receipt: z.ZodType<WriteFileResult> = z.object({
  path: z.string().min(1),
  sha256: Sha256,
  bytes: z.int().min(0),
  previousSha256: Sha256.nullable(),
});
/** A {@link Receipt} value, the same type as `WriteFileResult`. */
export type Receipt = z.infer<typeof Receipt>;

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

/**
 * An enum of runtime keys, typed by the keys, such as `oneOf(items.map((item) => item.key))` to
 * constrain an agent's answer to known items. `z.enum` would accept the list too; this refuses an
 * empty or repeated one up front.
 *
 * @typeParam K - The keys, as a non-empty tuple.
 * @param keys - The allowed values, in order.
 * @returns `z.enum(keys)`.
 * @throws TypeError - When `keys` is empty or repeats a key.
 */
export function oneOf<const K extends readonly [string, ...string[]]>(
  keys: K,
): z.ZodEnum<z.util.ToEnum<K[number]>> {
  if (keys.length === 0) throw new TypeError('oneOf needs at least one key');
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key))
      throw new TypeError(`oneOf keys must be unique; ${JSON.stringify(key)} repeats`);
    seen.add(key);
  }
  return z.enum(keys);
}

/**
 * An object-rooted list of `item`, `{ items: item[] }` with at most `max` entries, for agent output
 * that is a list (structured output needs an object root).
 *
 * @typeParam T - The item schema.
 * @param item - The schema of each entry.
 * @param max - The most entries, a positive integer.
 * @param description - The `items` description the agent reads; omitted, `items` has none.
 * @returns `z.object({ items: z.array(item).max(max) })`.
 * @throws TypeError - When `max` is not a positive safe integer.
 */
export function listOf<T extends z.ZodType>(
  item: T,
  max: number,
  description?: string,
): z.ZodObject<{
  /** The entries, at most `max`. */
  items: z.ZodArray<T>;
}> {
  if (!Number.isSafeInteger(max) || max < 1)
    throw new TypeError(`listOf max must be a positive integer, got ${String(max)}`);
  const items = z.array(item).max(max);
  return z.object({ items: description === undefined ? items : items.describe(description) });
}

/**
 * A score sheet: one {@link Score} per criterion, described by the criterion's text, and a
 * {@link Rationale}. Keys keep the record's order.
 *
 * ```ts
 * const Scores = std.types.rubric({
 *   fitness: 'How well it solves the problem.',
 *   simplicity: 'How little it adds.',
 * });
 * // { scores: { fitness: number; simplicity: number }; rationale: string }
 * ```
 *
 * @typeParam K - The criterion keys.
 * @param criteria - Each criterion's key and the description its score carries.
 * @returns `z.object({ scores: z.object({ [key]: Score.describe(criteria[key]) }), rationale })`,
 * where `rationale` is {@link Rationale}.
 * @throws TypeError - When `criteria` is empty.
 */
export function rubric<const K extends string>(
  criteria: Readonly<Record<K, string>>,
): z.ZodObject<{
  /** One score per criterion, each from 1 (poor) to 10 (excellent). */
  scores: z.ZodObject<Record<K, z.ZodInt>>;
  /** Why the scores are what they are, citing specifics. */
  rationale: z.ZodString;
}> {
  const keys = Object.keys(criteria) as K[];
  if (keys.length === 0) throw new TypeError('rubric needs at least one criterion');
  const scores = Object.fromEntries(
    keys.map((key) => [key, Score.describe(criteria[key])]),
  ) as Record<K, z.ZodInt>;
  return z.object({
    scores: z.object(scores).describe('Each criterion scored from 1 (poor) to 10 (excellent).'),
    rationale: Rationale,
  });
}
