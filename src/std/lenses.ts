/**
 * Named lenses: a short key and a charter that tells one agent of a panel what to focus on. The
 * catalogs here feed the std patterns (`std.patterns.lensPanel`, `hunt`, `gate`, `tournament`,
 * `research`, `critiqueRevise`), one call per lens, so each agent looks at the same subject from a
 * different angle instead of repeating the others.
 *
 * | Catalog        | For                                              |
 * | -------------- | ------------------------------------------------ |
 * | `bugs`         | bug hunts (the default of `hunt`)                |
 * | `review`       | code review                                      |
 * | `security`     | security review                                  |
 * | `design`       | design proposals (the default of `tournament`)   |
 * | `research`     | research sources (the default of `research`)     |
 * | `release`      | release gates (the default of `gate`)            |
 * | `writing`      | prose review                                     |
 * | `evidence`     | where to look when investigating a failure       |
 * | `requirements` | writing or reviewing requirements                |
 * | `spec`         | writing or reviewing a technical specification   |
 * | `critique`     | critiquing a plan, specification or requirements |
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * const lenses = [
 *   ...std.lenses.review,
 *   std.lenses.lens('migrations', 'Schema and data migrations: order, reversibility, locks.'),
 * ];
 * const panel = await std.patterns.lensPanel(ctx, { id: 'review', team, lenses, subject, schema });
 * ```
 *
 * A lens key is a clean step-ID segment (`stepId(key) === key`), so a pattern uses it unchanged in
 * its step IDs and map keys, and keys stay unique within each catalog. Charters are prompt text and
 * so part of the identity of every call that sends them: they are fixed once released. Every
 * catalog and lens is frozen. {@link LensSchema} is the Zod schema of a lens, for workflow data and
 * the pattern result schemas.
 *
 * @module
 */
import { stepId, z } from '../index.js';

/** One angle on a subject: what a single agent of a panel examines. */
export interface Lens {
  /** A short, clean step-ID segment naming the lens, such as `concurrency`. */
  readonly key: string;
  /** What to examine through this lens, as prompt text. */
  readonly charter: string;
}

/**
 * The schema of a {@link Lens}, for workflow data and outputs that carry lenses, such as the
 * `failed` lenses of a `std.patterns.LensPanelResult`. It checks the shape only, two strings, and
 * strips any other member, so every lens a pattern accepts parses; {@link lens} is what checks a
 * key and a charter.
 */
export const LensSchema: z.ZodType<Lens> = z.object({ key: z.string(), charter: z.string() });

/**
 * Make a lens, checking that its key is a clean step-ID segment and its charter is not empty.
 *
 * @param key - The lens key: a letter or digit, then up to 63 letters, digits, `.`, `_`, `:` or
 *   `-`, as `stepId` leaves unchanged.
 * @param charter - What to examine through the lens, as prompt text.
 * @returns The frozen lens.
 * @throws TypeError - The key is not a clean step-ID segment, or the charter is empty.
 */
export function lens(key: string, charter: string): Lens {
  if (typeof key !== 'string' || !cleanSegment(key))
    throw new TypeError(
      `Lens key ${JSON.stringify(key)} must be a clean step-ID segment (stepId(key) === key): a letter or digit, then up to 63 letters, digits, ".", "_", ":" or "-".`,
    );
  if (typeof charter !== 'string' || charter.trim() === '')
    throw new TypeError(`Lens ${key} needs a nonempty charter.`);
  return Object.freeze({ key, charter });
}

/** Whether `key` passes through `stepId` unchanged. */
function cleanSegment(key: string): boolean {
  try {
    return stepId(key) === key;
  } catch {
    return false;
  }
}

/** Freeze a catalog of lenses, refusing duplicate keys. */
function catalog(entries: readonly (readonly [string, string])[]): readonly Lens[] {
  const lenses = entries.map(([key, charter]) => lens(key, charter));
  const keys = new Set(lenses.map((item) => item.key));
  if (keys.size !== lenses.length) throw new Error('A lens catalog has a duplicate key.');
  return Object.freeze(lenses);
}

/**
 * Eight bug classes for bug hunts, the default rotation of `std.patterns.hunt`: `error-handling`,
 * `boundaries`, `concurrency`, `resource-lifecycle`, `state-machines`, `contracts`,
 * `time-and-ordering` and `input-validation`.
 */
export const bugs: readonly Lens[] = catalog([
  [
    'error-handling',
    'Errors that are swallowed, reported as success, stripped of their cause or retried forever, ' +
      'fallible calls with no handling, and failures that leave partial state behind.',
  ],
  [
    'boundaries',
    'Off-by-one errors, empty and single-element inputs, the largest and smallest values, ' +
      'overflow, rounding, encoding and Unicode edge cases, and both ends of every range.',
  ],
  [
    'concurrency',
    'Races, lost updates, deadlocks, unawaited promises, shared mutable state, reentrancy, and ' +
      'code that assumes an order the scheduler does not guarantee.',
  ],
  [
    'resource-lifecycle',
    'Files, handles, processes, timers, listeners, locks and temporary data that leak, are ' +
      'released twice, are used after release, or are not cleaned up on the error path.',
  ],
  [
    'state-machines',
    'Invalid or missing state transitions, states that can never be left, flags that contradict ' +
      'each other, and code that acts on stale or half-updated state.',
  ],
  [
    'contracts',
    'Callers and callees that disagree about types, units, nullability, ownership, ordering or ' +
      'error conventions, broken invariants, and documented behavior the code does not have.',
  ],
  [
    'time-and-ordering',
    'Clock and time-zone assumptions, timeouts and deadlines, retries without backoff, the order ' +
      'of events and messages, and stale caches or replayed work.',
  ],
  [
    'input-validation',
    'Malformed or untrusted input that reaches logic unchecked: unexpected types, sizes or ' +
      'characters, injection, path traversal, and validation done after use or at only one of ' +
      'several entry points.',
  ],
]);

/**
 * Five code review dimensions: `correctness`, `security`, `performance`, `maintainability` and
 * `tests`.
 */
export const review: readonly Lens[] = catalog([
  [
    'correctness',
    'Whether the code does what it is meant to on every path: logic errors, wrong conditions, ' +
      'unhandled cases and regressions in existing behavior.',
  ],
  [
    'security',
    'Injection, missing authentication or authorization checks, secrets in code or logs, unsafe ' +
      'deserialization, path traversal and trust placed in unvalidated input.',
  ],
  [
    'performance',
    'Needless work on hot paths: repeated I/O or queries, quadratic loops over large inputs, ' +
      'unbounded memory growth, and blocking calls where the code should not wait.',
  ],
  [
    'maintainability',
    'Code that is hard to change safely: duplication, misleading names or comments, tangled ' +
      'responsibilities, and abstractions that do not fit the problem.',
  ],
  [
    'tests',
    'Whether tests cover the changed behavior, including its failure paths and edge cases, and ' +
      'whether they would fail if the code were wrong.',
  ],
]);

/**
 * Seven security review angles: `injection`, `access-control`, `secrets`, `data-exposure`,
 * `untrusted-input`, `supply-chain` and `cryptography`.
 */
export const security: readonly Lens[] = catalog([
  [
    'injection',
    'Untrusted data that reaches a shell, query, template, file path, regular expression or ' +
      'interpreter without escaping or parameterization.',
  ],
  [
    'access-control',
    'Missing or bypassable authentication and authorization checks, privilege escalation, and ' +
      'objects reachable through identifiers the caller should not control.',
  ],
  [
    'secrets',
    'Credentials, tokens and keys in code, configuration, logs, error messages or URLs, and ' +
      'secrets handed to processes or services that do not need them.',
  ],
  [
    'data-exposure',
    'Sensitive data returned, logged, cached or stored beyond what is needed, or sent without ' +
      'encryption.',
  ],
  [
    'untrusted-input',
    'Parsing of untrusted files, archives, URLs and serialized data: unsafe deserialization, ' +
      'archive path traversal, server-side request forgery and resource exhaustion.',
  ],
  [
    'supply-chain',
    'Dependencies, downloads, install scripts and build steps that run code from sources that are ' +
      'unpinned, unverified or more trusted than they need to be.',
  ],
  [
    'cryptography',
    'Weak or homemade cryptography, predictable randomness for security values, missing ' +
      'integrity checks, and certificate or signature validation that can be skipped.',
  ],
]);

/**
 * Four design philosophies for design tournaments, the default entrants of
 * `std.patterns.tournament`: `ship-simplest`, `evolvability`, `data-first` and `operability-first`.
 * Each charter is a designer's stance, written to the agent that proposes under it.
 */
export const design: readonly Lens[] = catalog([
  [
    'ship-simplest',
    'You favor the simplest design that fully meets the brief today: the fewest moving parts, ' +
      'new concepts and dependencies, leaving future needs to future changes.',
  ],
  [
    'evolvability',
    'You favor a design that stays easy to change: clear boundaries, small interfaces, and seams ' +
      "where the brief's likely next requirements would land.",
  ],
  [
    'data-first',
    'You start from the data: its shape, ownership, invariants and lifecycle. You choose a model ' +
      'that makes invalid states hard to represent and let the code and interfaces follow from it.',
  ],
  [
    'operability-first',
    'You favor a design that is easy to run, observe and recover: clear failure modes, safe ' +
      'rollout and rollback, useful diagnostics and bounded resource use.',
  ],
]);

/**
 * Five source angles for research, the default angles of `std.patterns.research`:
 * `official-docs`, `source-code`, `issues-and-discussions`, `independent-analysis` and
 * `alternatives`.
 */
export const research: readonly Lens[] = catalog([
  [
    'official-docs',
    "The project's own documentation, specifications, release notes and changelogs, for the " +
      'version in question.',
  ],
  [
    'source-code',
    'The source code, tests and commit history of the projects involved, as the ground truth for ' +
      'what the software actually does.',
  ],
  [
    'issues-and-discussions',
    'Issue trackers, pull requests, mailing lists and forums, for known bugs, workarounds and the ' +
      'reasoning behind decisions.',
  ],
  [
    'independent-analysis',
    'Benchmarks, papers, audits and write-ups from outside the project, weighed by their evidence ' +
      'and their date.',
  ],
  [
    'alternatives',
    'Competing tools and approaches to the same problem, and how they compare on the question at ' +
      'hand.',
  ],
]);

/**
 * Six release gate dimensions, the default dimensions of `std.patterns.gate`: `tests`,
 * `compatibility`, `security`, `performance`, `docs` and `operability`.
 */
export const release: readonly Lens[] = catalog([
  [
    'tests',
    'Whether the test suite passes and covers the changes in this release, including their ' +
      'failure paths.',
  ],
  [
    'compatibility',
    'Breaking changes to public APIs, configuration, data formats, storage or supported ' +
      'platforms, and whether each one has a documented migration path.',
  ],
  [
    'security',
    'Whether the release introduces vulnerabilities, exposes secrets or data, or ships ' +
      'dependencies with known advisories.',
  ],
  [
    'performance',
    'Regressions in latency, throughput, memory use or startup time on the paths the release ' +
      'changes.',
  ],
  [
    'docs',
    'Whether the user-facing documentation, changelog and upgrade notes describe what changed.',
  ],
  [
    'operability',
    'Whether the release can be deployed, monitored and rolled back safely: migrations, ' +
      'configuration defaults, logging and failure modes.',
  ],
]);

/** Four writing review dimensions: `accuracy`, `completeness`, `clarity` and `structure`. */
export const writing: readonly Lens[] = catalog([
  [
    'accuracy',
    'Every claim matches its sources: no unsupported statements, wrong names, numbers or ' +
      'versions, and no examples that would not work.',
  ],
  [
    'completeness',
    'Everything the brief asks for is covered, and nothing the reader needs in order to act is ' +
      'missing.',
  ],
  [
    'clarity',
    'Plain, precise wording a reader understands on the first pass: no ambiguity, unexplained ' +
      'jargon or needlessly long sentences.',
  ],
  [
    'structure',
    'Ordered for the reader: the most important information first, related points together, and ' +
      'headings and lists where they help.',
  ],
]);

/**
 * Five sources of evidence for investigating a failure or a change in behavior: `diffs`, `logs`,
 * `config`, `dependencies` and `recent-changes`. Each charter names what to read and what to look
 * for in it.
 */
export const evidence: readonly Lens[] = catalog([
  [
    'diffs',
    'The code changes in question, hunk by hunk: what each alters in behavior, which callers, ' +
      'tests and data it affects, and what it removes or stops handling.',
  ],
  [
    'logs',
    'Application, test and CI logs and error output: the first error rather than the ones it ' +
      'causes, stack traces, timestamps, and the conditions under which each message appears.',
  ],
  [
    'config',
    'Configuration files, environment variables, feature flags and build or deploy settings: ' +
      'defaults, overrides, differences between environments, and values the code reads but ' +
      'nothing sets.',
  ],
  [
    'dependencies',
    'Manifests and lockfiles: the versions actually resolved, recent upgrades and their ' +
      'changelogs, known issues in those versions, and duplicate or conflicting copies of a ' +
      'package.',
  ],
  [
    'recent-changes',
    'The history of the affected code: what changed recently, when the behavior started, and ' +
      'which commit, merge or deploy introduced it, through the log, blame and a bisectable range.',
  ],
]);

/**
 * Five angles for writing or reviewing requirements: `stories`, `edge-cases`, `non-functional`,
 * `foundations` and `instrumentation`.
 */
export const requirements: readonly Lens[] = catalog([
  [
    'stories',
    'Who the users are and what each needs to do: stories with a goal and a reason, the main ' +
      'flows end to end, and acceptance conditions that show each story is met.',
  ],
  [
    'edge-cases',
    'Empty, missing, duplicate, oversized and conflicting input, partial failure, concurrent use, ' +
      'permissions and undo: what the user sees and what the system must do in each case.',
  ],
  [
    'non-functional',
    'Performance, scale, availability, security, privacy, accessibility and compatibility, each ' +
      'stated as a measurable target rather than an adjective.',
  ],
  [
    'foundations',
    'What must exist before the work can start or ship: data, interfaces, infrastructure, ' +
      'migrations, work owned by other teams, and decisions that are still open.',
  ],
  [
    'instrumentation',
    'How success and failure will be observed: the metrics, events, logs and alerts to add, the ' +
      'baseline to compare against, and who watches them after release.',
  ],
]);

/**
 * Five angles for writing or reviewing a technical specification: `data-model`, `api-contracts`,
 * `architecture`, `edge-semantics` and `operations`.
 */
export const spec: readonly Lens[] = catalog([
  [
    'data-model',
    'Entities, fields, types, keys and relationships, the invariants each must keep, who owns and ' +
      'writes each piece of data, and how existing data migrates to the new shape.',
  ],
  [
    'api-contracts',
    'Every interface the design exposes or consumes: requests, responses, errors, versioning, ' +
      'idempotency, pagination and limits, precise enough to implement both sides apart.',
  ],
  [
    'architecture',
    'The components and their responsibilities, how they communicate, where state lives, and how ' +
      'the design fits the existing system without duplicating or bypassing it.',
  ],
  [
    'edge-semantics',
    'Exact behavior under retries, timeouts, partial failure, concurrent writes, reordering, ' +
      'duplicates, and empty or maximum sizes, and what each component guarantees when another ' +
      'fails.',
  ],
  [
    'operations',
    'How the design is deployed, configured, monitored and rolled back: rollout order, feature ' +
      'flags, migrations, capacity, alerts and the runbook for its likely failures.',
  ],
]);

/**
 * Four angles for critiquing a plan, specification or set of requirements before work starts:
 * `ambiguity`, `scope`, `feasibility` and `testability`.
 */
export const critique: readonly Lens[] = catalog([
  [
    'ambiguity',
    'Statements two readers could implement differently: vague terms, undefined names, unstated ' +
      'units or defaults, requirements that conflict, and decisions left implicit.',
  ],
  [
    'scope',
    'Whether the work is the right size: goals and non-goals stated, nothing the goal needs left ' +
      'out, nothing included that it does not need, and a first version that stands on its own.',
  ],
  [
    'feasibility',
    'Whether it can work as written: technical constraints, dependencies and ordering, effort ' +
      'against the time and people available, and the riskiest assumption it rests on.',
  ],
  [
    'testability',
    'Whether every requirement can be checked: observable acceptance conditions, the test or ' +
      'measurement that would show each one holds, and what cannot be verified as written.',
  ],
]);

/**
 * The criteria of a design scorecard, the default rubric of `std.patterns.tournament`: each value
 * describes what a 1 to 10 score on that criterion measures (pass it to `std.types.rubric`).
 */
export const designRubric: Readonly<
  Record<'fitness' | 'simplicity' | 'evolvability' | 'operability', string>
> = Object.freeze({
  fitness:
    "How completely and correctly the design meets the brief's requirements and constraints.",
  simplicity: 'How few moving parts, concepts and dependencies the design needs for what it does.',
  evolvability: 'How easily the design absorbs the likely next requirements without a rewrite.',
  operability: 'How easy the design is to deploy, observe, debug and recover when it fails.',
});
