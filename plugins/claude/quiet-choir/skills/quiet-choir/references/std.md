# Standard library

`quiet-choir/std` is the opt-in, batteries-included layer over the public API: roster entries, typed
data, prompt and data helpers, team-free control flow and team-typed patterns. A workflow that uses
it spends its lines on what is specific to it; every recipe below is a complete workflow of at most
30 lines. Nothing in the library is registered with the runtime: each piece is an ordinary
composition of public context methods, so the
[execution contract](../SKILL.md#keep-the-execution-contract) and the [cookbook rules](patterns.md)
apply unchanged.

<!-- skills-check: fragment; reason: the import line alone -->

```ts
import * as std from 'quiet-choir/std';
```

The recipes import `../../src/std/index.js` from the checkout, as the [cookbook](patterns.md)
explains. Each one is tested with a scripted harness through failure and resume; the fake replies
prove replay behaviour, not the quality of a model's work.

| Need                                                              | Pattern                                   | Recipe                                                       |
| ----------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| Find defects until no new ones appear, and verify each one        | `hunt`                                    | [Bug hunt](#bug-hunt)                                        |
| Review from several lenses, then let skeptics refute the findings | `lensPanel`, `verify`                     | [Code review](#code-review)                                  |
| Decide yes or no by a vote of independent seats                   | `vote`                                    | [Code review](#code-review) (same shape)                     |
| Revise a draft until critics raise no issue                       | `critiqueRevise`                          | [Document polish](#document-polish)                          |
| Fix until a command passes, escalating to a stronger agent        | `fixUntilGreen`, `escalate`               | [Fix the tests](#fix-the-tests)                              |
| Compare independent proposals and pick one by rubric              | `tournament`                              | [Design tournament](#design-tournament)                      |
| Label items, pick the top few, or route to one branch             | `classify`, `rank`, `route`               | [Triage](#triage)                                            |
| Summarize many items in chunks with stated coverage               | `mapReduce`                               | [Change log](#change-log)                                    |
| Plan a task graph and build it in dependency waves                | `decompose`, `taskCall`, `std.flow.waves` | [Plan and build](#plan-and-build)                            |
| Check a change against acceptance criteria                        | `checklist`                               | [Acceptance check](#acceptance-check)                        |
| Decide go, conditional go or no-go across dimensions              | `gate`                                    | [Release gate](#release-gate)                                |
| Find a root cause by trying to falsify hypotheses                 | `falsify`                                 | [Incident analysis](#incident-analysis)                      |
| Answer a question from cited sources                              | `research`                                | [Research](#research)                                        |
| Make independent edits in parallel worktrees and merge them       | `isolatedEdits`                           | [Parallel edits](#parallel-edits)                            |
| Get a human's approval of a plan before acting on it              | `approvedPlan`, `planCall`                | [Approved plan](#approved-plan)                              |
| Repeat a discovery round until it comes back dry                  | `std.flow.untilDry`                       | [Loop until dry](patterns.md#loop-until-dry)                 |
| Revise until a reviewer approves                                  | `reviewRevise`                            | [Bounded review/revise](patterns.md#bounded-reviewrevise)    |
| Ask one panelist per item and keep a quorum                       | `tolerantPanel`                           | [Failure-tolerant panel](patterns.md#failure-tolerant-panel) |

## The pattern contract

Every function in `std.patterns` takes the context and one options object, and keeps the same
contract (ADR 0068 §4):

- **`id` and step IDs.** `id` is required and the pattern runs under `ctx.scope(id, ...)`, so two
  calls with different IDs never collide. Each pattern's TSDoc lists the exact step IDs it records;
  they are listed below as well.
- **Teams.** `team` is a record of bound agents for the pattern's slots (`XTeam.from(record)` picks
  them from a larger record). The pattern checks the team before any effect, so an unfilled slot
  throws `Team slot <name> is not filled.` instead of being saved as a failed call. Fill a team from
  the same `ctx` you pass to the pattern: an agent bound from another context (a child, a scope)
  records its calls there.
- **Failures are data.** Where a failed agent is tolerated (a seat, a lens, a chunk, a critic), the
  pattern runs the calls in a settled map, so the failure is journaled and a resume replays the same
  decision instead of retrying it into a different one. Results carry a `status` and failure counts
  (`failedVotes`, `failedChunks`, ...), never a silently shorter list. A call the pattern cannot do
  without (a planner, a reducer, an author) throws, and a resume retries it.
- **Fingerprints.** Settled-map items carry the rendered prompt and the calls' placement (`cwd`,
  `addDirs`, `worktree`), so changing a prompt, an input that a prompt shows, or where the calls run
  refuses to replay the completed calls. A change the items cannot show, such as a replacement
  `schema`, needs a new `version` string.
- **`calls`** (`CallDefaults`: placement, `cwd`, `addDirs`, retry, `timeoutMs`, ...) is spread into
  every agent call the pattern makes.
- **`prompts`** replaces a stage's default prompt: `prompts.<stage>` receives that stage's inputs
  and returns a string or a `Prompt` (`definePrompts`). The defaults are built with
  `std.text.brief`, and the prompt of a skeptical slot names its safe default (refute, vote no,
  untestable, not approved), which the `Skeptic`, `Critic` and `Judge` personas fall back to.
- **`concurrency`** (default 4) bounds each fan-out. Patterns that cap work (`maxCalls`, `reads`,
  `count`) log what they leave out and return it.
- **Released text is identity.** Default prompts, schemas, personas and lenses are part of the
  fingerprint of the calls that use them; the library changes them only by adding new names.

## Roster inventory

Spread a capability, a tier, limits and a persona, in that order, or use a complete role:

```ts
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Reviewer: std.roles.Reviewer,
  Skeptic: std.roles.Skeptic,
  Mechanic: std.roles.Mechanic,
  Tester: {
    ...std.claude.shell([...std.bash.nodeCheck]),
    ...std.tiers.Mechanic,
    ...std.limits.Standard,
    ...std.personas.Tester,
    appendSystemPrompt: std.personas.join(
      std.personas.Tester.appendSystemPrompt,
      std.personas.ShellEtiquette,
    ),
  },
});
```

| Axis           | Values                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `std.claude`   | `Text` (no tools), `ReadOnly`, `Web` (read-only plus web search and fetch), `Edit`, `shell(rules)` and `editShell(rules)` (Bash narrowed to an allowlist) |
| `std.codex`    | `Text`, `ReadOnly`, `Edit` (sandbox modes); Codex has no standing prompt, so prepend persona text to the prompt                                           |
| `std.bash`     | rule sets for `shell`: `gitRead`, `ghRead`, `files`, `nodeCheck`, `npmRun(...)`, `pythonCheck`, `cargoCheck`, `goCheck`, `gitCommit`, `gitRebase`, ...    |
| `std.tiers`    | `Clerk`, `Copyist`, `Scribe`, `Mechanic`, `Planner`, `Skeptic`, `Surgeon`, `Judge` (Claude model and effort)                                              |
| `std.limits`   | `Brief`, `Standard`, `Extended`, `Hour`, `Long` (turns, budget and timeout)                                                                               |
| `std.personas` | standing prompts that state a role's stance once; `join` combines texts, and `ShellEtiquette` explains an allowlisted shell                               |

| Role (`std.roles`)              | Use it for                                                    | Needs a grant |
| ------------------------------- | ------------------------------------------------------------- | ------------- |
| `Clerk`                         | mechanical extraction, formatting, labeling                   | no            |
| `Writer`, `Scribe`              | prose from given facts (`Writer` has no tools)                | no            |
| `Scout`, `Reader`               | surveys, inventories and plain reading                        | no            |
| `Researcher`                    | cited web research                                            | no            |
| `Reviewer`                      | evidenced code review                                         | no            |
| `Skeptic`, `Critic`, `Judge`    | refuting claims, critiquing drafts, judging candidates        | no            |
| `Planner`                       | grounded implementation plans                                 | no            |
| `CodexReader`, `CodexReviewer`  | the same reading and review through a read-only Codex sandbox | no            |
| `Editor`, `Mechanic`, `Surgeon` | editing, implementing, and taking over subtle or failed work  | write         |
| `CodexEditor`, `CodexMechanic`  | the same through a workspace-write Codex sandbox              | write         |

`std.rosters.readers` declares every role that needs no grant, and `std.rosters.standard` declares
all of them. Under `--require-grants`, a workflow on `readers` needs no `--grant` at all.

## Data, helpers and flow

| Namespace    | What it holds                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `std.types`  | strict, bounded, rehearsable output schemas (`Finding`, `Findings`, `Refutation`, `Ballot`, `Critique`, `WorkReport`, `Plan`, `TaskList`, `Criterion`, `Assessment`, `Hypotheses`, `Leads`, `Claims`, `Changes`, ...), enums (`Severity`, `WorkStatus`, `GateDecision`, ...), input primitives (`RepoPath`, `Sha`, `Argv`, `limit(default, max, min)`) and builders (`oneOf`, `listOf`, `rubric`) |
| `std.lenses` | named charters for fan-out: `bugs`, `review`, `security`, `design`, `research`, `release`, `writing`, and the `designRubric` criteria                                                                                                                                                                                                                                                             |
| `std.data`   | pure helpers over results: `tally`, `majority`, `threshold`, `dedupeBy`, `fresh`, `corroborate`, `chunk`, `rotate`, `rankBy`, `bySeverity`, `rankCap`, `coverage`, `findingKey`, `topoWaves`, `digest`, ...                                                                                                                                                                                       |
| `std.text`   | prompt text: `brief` (task, context, guidance, output), `section`, `bullets`, `numbered`, `fence`, `promptText`, `clip`, `tail`, `stripAnsi`, `slug`, `firstSentence`                                                                                                                                                                                                                             |
| `std.exec`   | journaled Git and command reads: `git`, `json`, `check` (an exit-code verdict), `head`, `status`, `assertClean`, `diff`, `changedFiles`, `commits`, `committedArtifact`                                                                                                                                                                                                                           |
| `std.flow`   | team-free control flow: `untilDry` (rounds until dry), `waves` (a dependency graph in settled waves), `each` (a settled map with a per-item result)                                                                                                                                                                                                                                               |

Every agent-output schema in `std.types` has an object root and required fields (`.nullable()` for
absence) and passes Codex's strict check, and none uses a regex, so fixture rehearsal can synthesize
it. A schema of your own built from them should keep those rules.

## Bug hunt

**Rule:** discover until dry, and verify every new finding before it counts. `hunt` runs rounds of
finders over a rotating window of lenses (`std.lenses.bugs` by default, `perRound` 3), deduplicates
findings by `std.data.findingKey`, and has `seats` skeptics (default 3) try to refute each new
finding in the same round. It ends `dry` after `patience` rounds without a new finding once every
lens has run, `round-limit` after `rounds`, or `call-limit` when `maxCalls` (finder calls plus
skeptic seats) would be exceeded; the left-out findings are logged and returned as `unverified`.
Steps: `<id>/round/<n>/lens/<lens>/find` and `<id>/round/<n>/item/<key>/seat/<s>/verdict`.

<!-- skills-check: example pattern-std-bug-hunt -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-bug-hunt',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({
    scope: z.string().min(1),
    rounds: std.types.limit(4, 10),
    maxCalls: std.types.limit(80, 400),
  }),
  output: z.object({ status: z.string(), rounds: z.int(), findings: z.array(std.types.Finding) }),
  async run(ctx, { scope, rounds, maxCalls }) {
    const hunt = await std.patterns.hunt(ctx, {
      id: 'hunt',
      team: { finder: ctx.roster.Reviewer, skeptic: ctx.roster.Skeptic },
      subject: scope,
      rounds,
      maxCalls,
    });
    // Each outcome list is already sorted most severe first.
    return {
      status: hunt.status,
      rounds: hunt.rounds,
      findings: hunt.confirmed.map((v) => v.item),
    };
  },
});
```

**Cost:** per round, `perRound` finder calls plus `seats` calls per new finding, bounded by
`maxCalls`. Each outcome list (`confirmed`, `refuted`, `undecided`) is sorted most severe first.

## Code review

**Rule:** fan out by lens, then verify. `lensPanel` asks the `reader` slot once per lens
(`<id>/lens/<lens>/read`) for a typed answer and returns `{ results, failed, quorum, status }`.
`verify` gives each item to `seats` skeptics (`<id>/item/<key>/seat/<n>/verdict`) with the material
the claim is about as `context`, and splits the items into `confirmed`, `refuted` and `undecided` by
`rule` (`'majority'` by default, `'unanimous'` or `{ atLeast }`). A read-only skeptic cannot run
`git`, so pass the diff, not just the range. `vote` is the same seat panel for one question
(`<id>/seat/<n>/ballot`, `types.Ballot`), returning `outcome: 'yes' | 'no' | 'undecided'`.

<!-- skills-check: example pattern-std-code-review -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-code-review',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1) }),
  output: z.object({ status: z.string(), findings: z.array(std.types.Finding) }),
  async run(ctx, { range }) {
    const diff = std.text.fence(await std.exec.diff(ctx, 'diff', range), 'diff');
    const { results, failed } = await std.patterns.lensPanel(ctx, {
      id: 'review',
      team: { reader: ctx.roster.Reviewer },
      lenses: std.lenses.review,
      task: `Review the changes in ${range} below for defects.`,
      subject: diff,
      schema: std.types.Findings,
    });
    const found = results.flatMap((answer) => answer.value.findings);
    const verdicts = await std.patterns.verify(ctx, {
      id: 'verify',
      team: { skeptic: ctx.roster.Skeptic },
      items: std.data.dedupeBy(found, std.data.findingKey),
      context: `The changes in ${range}:\n\n${diff}`,
    });
    const status = failed.length + verdicts.failedVotes === 0 ? 'complete' : 'degraded';
    return { status, findings: std.data.bySeverity(verdicts.confirmed.map((v) => v.item)) };
  },
});
```

**Cost:** one call per lens plus `seats` per distinct finding. The status is `degraded` when a lens
or a seat failed; the failures are journaled and are not retried on resume.

## Document polish

**Rule:** revise until every critic answers with no issue, or the rounds run out. `critiqueRevise`
asks one critic per lens (`<id>/round/<n>/lens/<lens>/critique`, or `<id>/round/<n>/critique`
without lenses) and has the author revise (`<id>/round/<n>/revise`) after each round with issues
except the last. A draft is approved only when every critic answered; a failed critic leaves the
draft unapproved (`degraded` if it was the last round). Without `draft`, the author writes the first
one (`<id>/draft`). The recipe writes the file back only when the result is approved and changed,
guarded by the hash it read.

<!-- skills-check: example pattern-std-doc-polish -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-doc-polish',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ file: std.types.RepoPath, rounds: std.types.limit(2, 5) }),
  output: z.object({
    status: z.enum(['approved', 'open-issues', 'degraded']),
    issues: z.array(std.types.Issue),
    receipt: std.types.Receipt.nullable(),
  }),
  async run(ctx, { file, rounds }) {
    const doc = await ctx.readFile('read', file);
    const polish = await std.patterns.critiqueRevise(ctx, {
      id: 'polish',
      team: { critic: ctx.roster.Critic, author: ctx.roster.Writer },
      brief: `Polish the Markdown document ${file} for its readers, keeping its scope and voice.`,
      draft: doc.content,
      lenses: std.lenses.writing,
      rounds,
    });
    const changed = polish.approved && polish.draft !== doc.content;
    const receipt = changed
      ? await ctx.writeFile('write', file, polish.draft, { ifMatch: doc.sha256 })
      : null;
    return { status: polish.status, issues: polish.issues, receipt };
  },
});
```

**Cost:** at most `rounds` critique rounds (one call per lens) and `rounds - 1` revisions.

## Fix the tests

**Rule:** only the command decides green. `fixUntilGreen` runs the check (`<id>/check/0`), and after
each failure asks the `mechanic`, or the `surgeon` from round `escalateAfter` on, to fix it
(`<id>/fix/<n>`, a settled `types.WorkReport` call), then checks again (`<id>/check/<n>`). Each
fixer sees the failure and the earlier attempts, and is told not to weaken tests. `escalate` is the
general ladder: attempt 0 goes to `start` (the mechanic by default), every later attempt to the
surgeon (`<id>/attempt/<n>/work`), until your `accept(value)` returns `true`.

<!-- skills-check: example pattern-std-fix-tests -->

```ts
import { defineRoster, defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-fix-tests',
  version: '1',
  roster: defineRoster({ Mechanic: std.roles.Mechanic, Surgeon: std.roles.Surgeon }),
  input: z.object({
    check: std.types.Argv.default(['npm', 'test']),
    rounds: std.types.limit(3, 6),
    task: z.string().min(1).optional(),
  }),
  output: z.object({
    status: z.enum(['green', 'red']),
    rounds: z.int(),
    fixedBy: z.enum(['mechanic', 'surgeon']).nullable(),
    checks: z.array(std.types.CheckOutcome),
    failedFixes: z.int(),
  }),
  run: (ctx, input) =>
    std.patterns.fixUntilGreen(ctx, {
      id: 'fix',
      team: { mechanic: ctx.roster.Mechanic, surgeon: ctx.roster.Surgeon },
      ...input,
    }),
});
```

**Cost:** at most `rounds` fix calls and `rounds + 1` checks. A failed fix call is journaled and the
loop moves on to the next check; `failedFixes` counts them.

## Design tournament

**Rule:** independent proposals, anonymous judging, then synthesis. `tournament` asks one proposer
per entrant philosophy (`std.lenses.design` by default; `<id>/propose/<entrant>/proposal`, a
`types.Proposal`), has `judges` judges score every proposal against the rubric
(`std.lenses.designRubric` by default) under anonymous letters in a rotated order
(`<id>/judge/<n>/scores`), ranks by mean score, and has the synthesizer write the final design from
the winner with the best ideas of the others and any dissent (`<id>/synthesize`). It aborts, as
data, when fewer than `minEntrants` proposals or no judge succeed.

<!-- skills-check: example pattern-std-design-tournament -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-design-tournament',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ brief: z.string().min(1), judges: std.types.limit(3, 7) }),
  output: z.object({
    status: z.enum(['complete', 'degraded', 'aborted']),
    winner: z.string().nullable(),
    design: z.string().nullable(),
    standings: z.array(z.object({ entrant: z.string(), score: z.number().nullable() })),
    dissent: z.array(z.string()),
  }),
  async run(ctx, { brief, judges }) {
    const { Planner, Judge } = ctx.roster;
    const result = await std.patterns.tournament(ctx, {
      id: 'tournament',
      team: { proposer: Planner, judge: Judge, synthesizer: Planner },
      brief,
      judges,
    });
    const standings = result.standings.map(({ entrant, score }) => ({ entrant, score }));
    const { status, design, dissent } = result;
    return { status, winner: result.winner?.entrant ?? null, design, standings, dissent };
  },
});
```

**Cost:** one call per entrant, `judges` judge calls and one synthesis.

## Triage

**Rule:** label in batches, then rank only what matters. `classify` sends `chunk` items per call
(`<id>/chunk/<n>/tag`) and splits them into `assignments`, `unlabeled` and `failed`, with `counts`
per label; `multi: true` allows several labels. `rank` picks the best `pick` items by a criterion in
one call (`<id>/rank`) and makes no call when there are no more than `pick`. `route` picks one route
by name (`<id>/route`); with a `fallback`, a failed call falls back instead of throwing.

<!-- skills-check: example pattern-std-triage -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

const Issues = z.array(z.object({ number: z.int().min(1), title: z.string(), body: z.string() }));
const Labels = z.array(z.string().min(1)).min(1).default(['bug', 'feature', 'docs', 'question']);
const Counts = z.array(z.object({ label: z.string(), count: z.int() }));

export default defineWorkflow({
  name: 'std-triage',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ issues: Issues.min(1), labels: Labels, top: std.types.limit(5, 20) }),
  output: z.object({ status: z.string(), counts: Counts, urgent: Issues, unlabeled: Issues }),
  async run(ctx, { issues, labels, top }) {
    const { status, counts, assignments, unlabeled } = await std.patterns.classify(ctx, {
      id: 'classify',
      team: { tagger: ctx.roster.Clerk },
      items: issues,
      labels,
    });
    const ranked = await std.patterns.rank(ctx, {
      id: 'rank',
      team: { ranker: ctx.roster.Judge },
      items: assignments,
      pick: top,
      criterion: 'How urgently it needs attention: the severity and reach of its impact.',
    });
    return { status, counts, urgent: ranked.selected.map(({ item }) => item), unlabeled };
  },
});
```

**Cost:** one call per batch of `chunk` items, then one ranking call.

## Change log

**Rule:** map in chunks, reduce once, and say what was not covered. `mapReduce` gives `chunk` items
(default 20) to each mapper call (`<id>/map/<k>/part`, text or your `schema`) and one reducer call
the successful parts (`<id>/reduce`). Coverage is computed in code: the items of failed chunks are
returned in `coverage.missing` and listed to the reducer as not covered. When every chunk fails, the
reducer is skipped and the status is `failed`.

<!-- skills-check: example pattern-std-changelog -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-changelog',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1) }),
  output: z.object({ status: z.string(), notes: z.string(), missing: z.array(std.types.Sha) }),
  async run(ctx, { range }) {
    const shas = await std.exec.commits(ctx, 'commits', range);
    const log = await std.exec.git(ctx, 'subjects', ['log', '--format=%H %s', range, '--']);
    const lines = log.split('\n');
    // Coverage is computed from the chunks that succeeded: a failed chunk's commits are missing.
    const notes = await std.patterns.mapReduce(ctx, {
      id: 'notes',
      team: { mapper: ctx.roster.Scribe, reducer: ctx.roster.Writer },
      items: shas,
      describe: (sha) => lines.find((line) => line.startsWith(sha)) ?? sha,
      task: `Turn these commits from ${range} into change-log entries, one per distinct change.`,
      schema: std.types.Changes,
      reduce: 'Write Markdown release notes: breaking changes and migrations first, then by kind.',
    });
    return { status: notes.status, notes: notes.result, missing: notes.coverage.missing };
  },
});
```

**Cost:** `ceil(items / chunk)` mapper calls and one reducer call.

## Plan and build

**Rule:** a planned graph is checked in code before anything runs. `decompose` asks the planner for
a `types.TaskList` (`<id>/plan`) and checks it for repeated IDs, unknown dependencies and cycles; if
it fails, one repair call (`<id>/repair`) gets the problems, and a still-invalid list throws. It
returns the tasks and their dependency `waves`. `taskCall(task, goal)` is the prompt and
`types.WorkReport` schema for doing one task, and `std.flow.waves` runs the graph
(`<id>/wave/<n>/<task>/<leaf>`), skipping the dependents of a failed task. Throw from `run` on a
report that is not `done`, so a blocked task stops its dependents.

<!-- skills-check: example pattern-std-plan-and-build -->

```ts
import { defineRoster, defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-plan-and-build',
  version: '1',
  roster: defineRoster({ Planner: std.roles.Planner, Mechanic: std.roles.Mechanic }),
  input: z.object({ goal: z.string().min(1), maxTasks: std.types.limit(8, 30) }),
  output: std.types.TaskList.extend({
    status: z.string(),
    reports: z.array(std.types.WorkReport.nullable()),
  }),
  async run(ctx, { goal, maxTasks }) {
    const team = { planner: ctx.roster.Planner };
    const plan = await std.patterns.decompose(ctx, { id: 'plan', team, goal, maxTasks });
    const build = await std.flow.waves(ctx, {
      id: 'build',
      items: plan.tasks,
      key: (task) => task.id,
      dependsOn: (task) => task.dependsOn,
      concurrency: 1, // The tasks share one checkout, so each wave runs them one at a time.
      run: async (task) => {
        const report = await ctx.roster.Mechanic.value('work', std.patterns.taskCall(task, goal));
        if (report.status === 'done') return report;
        throw new Error(`${task.id} is ${report.status}: ${report.summary}`); // Skips dependents.
      },
    });
    return { status: build.status, tasks: plan.tasks, reports: build.results.map((r) => r.value) };
  },
});
```

A rehearsal's synthesized task list names dependencies that do not exist, so the recipe ships a
fixture for its planner call:

<!-- skills-check: example pattern-std-plan-and-build-fixtures -->

```json
{
  "version": 1,
  "calls": [
    {
      "step": "plan/plan",
      "output": {
        "tasks": [
          {
            "id": "T1",
            "title": "Parse the --json flag",
            "description": "Accept --json in the export command's argument parser.",
            "acceptance": ["export --json is accepted"],
            "dependsOn": [],
            "size": "S"
          },
          {
            "id": "T2",
            "title": "Print the export as JSON",
            "description": "Write the export as JSON to stdout when --json is set.",
            "acceptance": ["export --json prints valid JSON"],
            "dependsOn": ["T1"],
            "size": "M"
          },
          {
            "id": "T3",
            "title": "Document the flag",
            "description": "Describe --json in the export command's help text.",
            "acceptance": ["export --help mentions --json"],
            "dependsOn": ["T1"],
            "size": "XS"
          }
        ]
      }
    }
  ],
  "unmatched": "synthesize"
}
```

**Cost:** one or two planning calls and one call per task.

## Acceptance check

**Rule:** a change is done only when every criterion passed. `checklist` asks the checker about each
criterion (`<id>/criterion/<C>/check`, a `types.CriterionResult`); string criteria get IDs `C1`,
`C2`, .... The verdict is `not-done` if any criterion failed or is partial, `done` if all passed,
and otherwise `unverified`. The checker's safe default is `unverifiable`, never `pass`.

<!-- skills-check: example pattern-std-acceptance -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

const Criteria = z.array(z.union([z.string().min(1), std.types.Criterion])).min(1);
const Results = z.array(
  z.object({ criterion: std.types.Criterion, result: std.types.CriterionResult.nullable() }),
);

export default defineWorkflow({
  name: 'std-acceptance',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1), criteria: Criteria }),
  output: z.object({
    verdict: z.enum(['done', 'not-done', 'unverified']),
    status: z.enum(['complete', 'degraded']),
    results: Results,
  }),
  async run(ctx, { range, criteria }) {
    const diff = await std.exec.diff(ctx, 'diff', range);
    const { verdict, status, results } = await std.patterns.checklist(ctx, {
      id: 'acceptance',
      team: { checker: ctx.roster.Reviewer },
      target: `The change in ${range}, as git diff shows it:\n\n${std.text.fence(diff, 'diff')}`,
      criteria,
    });
    return { verdict, status, results };
  },
});
```

**Cost:** one call per criterion.

## Release gate

**Rule:** a blocker stands until skeptics refute it. `gate` has the assessor judge each dimension
(`std.lenses.release` by default; `<id>/dimension/<key>/assess`, a `types.Assessment`), then gives
each reported blocker to `seats` skeptics (`<id>/blocker/<key>/seat/<n>/verdict`). A refuted blocker
is downgraded to a concern. The decision is `no-go` for a confirmed or undecided blocker,
`conditional-go` for a concern, a downgrade, a dimension that could not be checked or a failed
assessor, and `go` otherwise.

<!-- skills-check: example pattern-std-release-gate -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-release-gate',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1), seats: std.types.limit(1, 5) }),
  output: z.object({
    decision: std.types.GateDecision,
    status: z.enum(['complete', 'degraded']),
    reasons: z.array(z.string()),
  }),
  async run(ctx, { range, seats }) {
    // `--end-of-options` keeps a range such as `--output=x` from being read as an option.
    const git = (id: string, ...args: [string, ...string[]]) =>
      std.exec.git(ctx, id, [...args, '--end-of-options', range, '--']);
    const commits = await git('commits', 'log', '--format=%h %s');
    const stat = await git('stat', 'diff', '--stat');
    const { decision, status, reasons } = await std.patterns.gate(ctx, {
      id: 'gate',
      team: { assessor: ctx.roster.Reviewer, skeptic: ctx.roster.Skeptic },
      task: `Assess whether the release ${range} is ready to ship.`,
      subject: `${std.text.section('Commits', commits)}\n${std.text.section('Diff stat', stat)}`,
      seats,
    });
    return { decision, status, reasons };
  },
});
```

**Cost:** one call per dimension and `seats` calls per reported blocker.

## Incident analysis

**Rule:** try to falsify every hypothesis, not to confirm one. `falsify` asks the theorist for up to
`count` competing hypotheses with testable predictions (`<id>/theorize`), then gives each to a
falsifier (`<id>/hypothesis/<key>/falsify`, a `types.Falsification`) whose safe default is
`untestable`. Confidence is `high` for one survivor with every rival falsified, `medium` when rivals
remain open, `split` for several survivors and `none` for no survivor.

<!-- skills-check: example pattern-std-incident -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-incident',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ question: z.string().min(1), range: z.string().min(1), notes: z.string() }),
  output: z.object({
    confidence: z.enum(['high', 'medium', 'split', 'none']),
    status: z.enum(['complete', 'degraded']),
    survivors: z.array(std.types.Hypothesis),
  }),
  async run(ctx, { question, range, notes }) {
    // `--end-of-options` keeps a range such as `--output=x` from being read as an option.
    const args = ['--stat', '--date=iso', '--format=%h %ad %s', '--end-of-options', range, '--'];
    const log = await std.exec.git(ctx, 'log', ['log', ...args]);
    const { confidence, status, survivors } = await std.patterns.falsify(ctx, {
      id: 'incident',
      team: { theorist: ctx.roster.Reviewer, falsifier: ctx.roster.Skeptic },
      question,
      evidence: `${std.text.section(`Commits in ${range}`, log)}\n\n${std.text.section('Notes', notes)}`,
    });
    return { confidence, status, survivors };
  },
});
```

**Cost:** one theorist call and one call per hypothesis.

## Research

**Rule:** cite or leave it out. `research` sends a scout per angle (`std.lenses.research` by
default; `<id>/scout/<angle>/leads`), deduplicates the leads and reads the best `reads` of them,
preferring leads more than one scout named (`<id>/read/<key>/claims`), and has the synthesizer
answer from the numbered claims only (`<id>/synthesize`). Leads past `reads` are returned as
`deferred`; leads whose read failed are `unread` and named to the synthesizer. With no claim at all,
the status is `unanswered` and no synthesis runs.

<!-- skills-check: example pattern-std-research -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-research',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ question: z.string().min(1), reads: std.types.limit(6, 20) }),
  output: z.object({
    status: z.enum(['complete', 'degraded', 'unanswered']),
    answer: z.string(),
    sources: z.array(std.types.Lead),
  }),
  async run(ctx, { question, reads }) {
    // Researchers search the web from each default angle and read; the tool-free Writer cites.
    const { status, answer, sources } = await std.patterns.research(ctx, {
      id: 'research',
      team: {
        scout: ctx.roster.Researcher,
        reader: ctx.roster.Researcher,
        synthesizer: ctx.roster.Writer,
      },
      question,
      reads,
    });
    return { status, answer, sources };
  },
});
```

**Cost:** one call per angle, at most `reads` reads and one synthesis.

## Parallel edits

**Rule:** each edit gets a fresh worktree and may change only what it owns. `isolatedEdits` runs one
isolated call per item (`<id>/item/<key>/edit`), checks the captured change against the item's
`owns` paths (a rename is checked by both paths, `<id>/item/<key>/paths`), leaves a violating change
out, and merges the rest (`<id>/merge`, with your `merge` options; conflicts are reported by
default). Owned paths must be disjoint across items. The result maps merges, conflicts, violations
and failures back to item keys.

<!-- skills-check: example pattern-std-parallel-edits -->

```ts
import { defineRoster, defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-parallel-edits',
  version: '1',
  roster: defineRoster({ Mechanic: std.roles.Mechanic }),
  input: z.object({ edits: z.array(std.types.Step).min(1).max(12), message: z.string().min(1) }),
  output: z.object({
    status: z.enum(['complete', 'degraded']),
    commit: z.string().nullable(),
    merged: z.array(z.string()),
    conflicts: z.array(z.string()),
    violations: z.array(z.object({ key: z.string(), files: z.array(z.string()) })),
    unchanged: z.array(z.string()),
    failed: z.array(z.string()),
  }),
  run: (ctx, { edits, message }) =>
    std.patterns.isolatedEdits(ctx, {
      id: 'edits',
      team: { editor: ctx.roster.Mechanic },
      items: edits,
      key: (edit) => edit.id,
      task: (edit) => edit.description,
      owns: (edit) => edit.files, // Each edit may change only its own files, so the merge is clean.
      merge: { strategy: 'squash', commit: { message } },
    }),
});
```

**Cost:** one isolated call per item and one merge. The editor needs a write grant.

## Approved plan

**Rule:** a human approves the exact plan that is carried out. `approvedPlan` asks the planner for a
`types.Plan` (`<id>/round/<n>/plan`) and asks for approval of its digest (`<id>/round/<n>/approve`);
a rejection with a comment gets a revised plan, up to `revisions` times, and a rejection without one
stops. `planCall(review, task)` is the implementer's prompt and `types.WorkReport` schema, with the
reviewer's comment. The run suspends at each approval: answer it as in
[human review](patterns.md#human-review).

<!-- skills-check: example pattern-std-approved-plan -->

```ts
import { defineRoster, defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-approved-plan',
  version: '1',
  roster: defineRoster({ Planner: std.roles.Planner, Mechanic: std.roles.Mechanic }),
  input: z.object({ task: z.string().min(1), revisions: std.types.limit(2, 5, 0) }),
  output: z.object({
    status: z.enum(['approved', 'rejected', 'out-of-revisions']),
    plan: std.types.Plan,
    report: std.types.WorkReport.nullable(),
  }),
  async run(ctx, { task, revisions }) {
    const review = await std.patterns.approvedPlan(ctx, {
      id: 'plan',
      team: { planner: ctx.roster.Planner },
      task,
      revisions,
    });
    const { status, plan } = review;
    if (!review.approved) return { status, plan, report: null };
    const report = await ctx.roster.Mechanic.value(
      'implement',
      std.patterns.planCall(review, task),
    );
    return { status, plan, report };
  },
});
```

**Cost:** one planning call per round and one implementation call.
