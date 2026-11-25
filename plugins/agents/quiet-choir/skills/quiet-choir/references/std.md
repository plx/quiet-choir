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
| Decide yes or no by a vote of independent seats                   | `vote`                                    | [Merge vote](#merge-vote)                                    |
| Revise a draft until critics raise no issue                       | `critiqueRevise`                          | [Document polish](#document-polish)                          |
| Fix until a command passes, escalating to a stronger agent        | `fixUntilGreen`                           | [Fix the tests](#fix-the-tests)                              |
| Hand rejected or failed work from a mechanic to a surgeon         | `escalate`                                | [Escalation](#escalation)                                    |
| Compare independent proposals and pick one by rubric              | `tournament`                              | [Design tournament](#design-tournament)                      |
| Label items and pick the top few                                  | `classify`, `rank`                        | [Triage](#triage)                                            |
| Send a request down one of several branches                       | `route`                                   | [Routing](#routing)                                          |
| Summarize many items in chunks with stated coverage               | `mapReduce`                               | [Change log](#change-log)                                    |
| Plan a task graph and build it in dependency waves                | `decompose`, `taskCall`, `std.flow.waves` | [Plan and build](#plan-and-build)                            |
| Check a change against acceptance criteria                        | `checklist`                               | [Acceptance check](#acceptance-check)                        |
| Decide go, conditional go or no-go across dimensions              | `gate`                                    | [Release gate](#release-gate)                                |
| Find a root cause by trying to falsify hypotheses                 | `falsify`                                 | [Incident analysis](#incident-analysis)                      |
| Answer a question from cited sources                              | `research`                                | [Research](#research)                                        |
| Make independent edits in parallel worktrees and merge them       | `isolatedEdits`                           | [Parallel edits](#parallel-edits)                            |
| Get a human's approval of a plan before acting on it              | `approvedPlan`, `planCall`                | [Approved plan](#approved-plan)                              |
| Repeat a discovery round until it comes back dry                  | `std.flow.untilDry`                       | none; see `std.flow` below                                   |
| Revise until a reviewer approves                                  | `reviewRevise`                            | [Bounded review/revise](patterns.md#bounded-reviewrevise)    |
| Ask one panelist per item and keep a quorum                       | `tolerantPanel`                           | [Failure-tolerant panel](patterns.md#failure-tolerant-panel) |

## The pattern contract

Every pattern in `std.patterns` takes the context and one options object, and keeps the same
contract (ADR 0068 §4), except the older `reviewRevise` and `tolerantPanel`, which the
[cookbook](patterns.md) describes: neither takes `calls`, and `reviewRevise`'s `id` is optional.

- **`id` and step IDs.** `id` is required and the pattern runs under `ctx.scope(id, ...)`, so two
  calls with different IDs never collide. Each pattern's TSDoc lists the exact step IDs it records;
  they are listed below as well.
- **Teams.** `team` is a record of bound agents for the pattern's slots (`XTeam.from(record)` picks
  them from a larger record). The pattern checks the team before any effect, so an unfilled slot
  throws `Team slot <name> is not filled.` instead of being saved as a failed call. Fill a team from
  the same context view you pass to the pattern: an agent read from `ctx.within(p).roster` keeps the
  `p/` prefix wherever it is called.
- **Failures are data.** Where a failed agent is tolerated (a seat, a lens, a chunk, a critic), the
  pattern runs the calls in a settled map (or a single call with `onError: 'return'`, such as a fix
  or a route), so the failure is journaled and a resume replays the same decision instead of
  retrying it into a different one; the result counts the failure instead of returning a silently
  shorter list. A call the pattern cannot do without (a planner, a reducer, an author) throws, and a
  resume retries it.
- **`status` is health.** Every result's `status` is `complete`, or `degraded` exactly when a
  tolerated call failed; `failures` counts them beside the specific counters (`failedVotes`,
  `failedChunks`, ...). What the pattern decided is a named field: `outcome`, `verdict`, `decision`,
  `approved`, `answered`, `ended`, ... A pattern with only required calls (`rank`, `decompose`,
  `approvedPlan`) is always `complete`; `isolatedEdits` is also `degraded` by a violation or a
  conflict. `std.data.health(...)` combines results and counts into one status.
- **Result schemas.** Every result interface has a Zod schema of the same name in `std.patterns`
  (strict, all fields required), so `output: std.patterns.GateResult` returns a pattern's result as
  the workflow's output; most recipes below do. A generic one is a factory:
  `VerifyResult(std.types.Finding)`, `ClassifyResult(Issue, labels)`, `EscalateResult()`, ...
- **Fingerprints.** Settled-map items carry the rendered prompt and the calls' placement (`cwd`,
  `addDirs`, `worktree`), so changing a prompt, an input that a prompt shows, or where the calls run
  refuses to replay the completed calls. A change the items cannot show, such as a replacement
  `schema` or the model, tools or persona of the agent that fills a slot, needs a new value of the
  pattern's `version` option; otherwise the completed items are reused.
- **`calls`** (`CallDefaults`: `cwd`, `addDirs`, `worktree`, retry, deadlines, ...) is spread into
  every agent call the pattern makes. `fixUntilGreen` takes a shared checkout as its own `worktree`
  option instead (`calls.worktree` alone throws), and `isolatedEdits` refuses `calls.worktree`.
- **`prompts`** replaces a stage's default prompt: `prompts.<stage>` receives that stage's inputs
  and returns a string or a `Prompt` (`definePrompts`). The defaults are built with
  `std.text.brief`, and the prompt of a skeptical slot names its safe default (refute, vote no,
  untestable, not approved), which the `Skeptic`, `Critic` and `Judge` personas fall back to.
- **`concurrency`** (default 4) bounds each fan-out. Patterns that cap work (`maxCalls`, `reads`,
  `count`, `pick`) log what they leave out; `hunt`, `research` and `rank` also return it
  (`unverified`, `deferred`).
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
  Tester: std.roles.tester([...std.bash.nodeCheck]),
  Auditor: std.roles.withShell(std.roles.Reviewer, std.bash.gitRead),
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

| Role (`std.roles`)              | Use it for                                                            | Needs a grant |
| ------------------------------- | --------------------------------------------------------------------- | ------------- |
| `Clerk`                         | mechanical extraction, formatting, labeling                           | no            |
| `Writer`, `Scribe`              | prose from given facts (`Writer` has no tools)                        | no            |
| `Scout`, `Reader`               | surveys, inventories and plain reading                                | no            |
| `Researcher`                    | cited web research                                                    | no            |
| `Reviewer`                      | evidenced code review                                                 | no            |
| `Skeptic`, `Critic`, `Judge`    | refuting claims, critiquing drafts, judging candidates                | no            |
| `Planner`                       | grounded implementation plans                                         | no            |
| `CodexReader`, `CodexReviewer`  | the same reading and review through a read-only Codex sandbox         | no            |
| `Editor`, `Mechanic`, `Surgeon` | editing, implementing, and taking over subtle or failed work          | write         |
| `CodexEditor`, `CodexMechanic`  | the same through a workspace-write Codex sandbox                      | write         |
| `tester(rules)`, `fixer(rules)` | a tester shell, or a `Mechanic` with an edit shell                    | exec          |
| `withShell(role, rules)`        | any Claude file role with an allowlisted shell, tier and persona kept | exec          |

The three factories join `std.personas.ShellEtiquette` to the persona, and `withShell` gives an
`editShell` to a role that edits and a `shell` to one that reads. `std.rosters.readers` declares
every role that needs no grant, and `std.rosters.standard` declares every role but the factories.
Under `--require-grants`, a workflow on `readers` needs no `--grant` at all, but every write or exec
entry in a roster needs one even when the body never calls it, and a `shell` or `editShell` entry is
exec: declare only the roles a workflow calls.

## Data, helpers and flow

| Namespace    | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `std.types`  | strict, bounded, rehearsable output schemas (`Finding`, `Findings`, `Remediations`, `Refutation`, `Ballot`, `Critique`, `WorkReport`, `Plan`, `TaskList`, `CriterionResult`, `Assessment`, `Hypotheses`, `Leads`, `Claims`, `Questions`, `Changes`, ...), enums (`Severity`, `WorkStatus`, `GateDecision`, ...), `RepoPath` (a repository-relative path, safe in agent output), input-side schemas (`Sha`, `Argv`, `Commit`, `Criteria`, `limit(default, max, min)`) and builders (`oneOf`, `listOf`, `rubric`) |
| `std.lenses` | named charters for fan-out: `bugs`, `review`, `security`, `design`, `research`, `release`, `writing`, `evidence`, `requirements`, `spec`, `critique`, the `designRubric` criteria and `LensSchema`                                                                                                                                                                                                                                                                                                              |
| `std.data`   | pure helpers over results: `health`, `tally`, `majority`, `threshold`, `dedupeBy`, `fresh`, `corroborate`, `chunk`, `rotate`, `rankBy`, `bySeverity`, `rankCap`, `coverage`, `findingKey`, `topoWaves`, `digest`, ...; the `Health` and `Coverage` schemas                                                                                                                                                                                                                                                      |
| `std.text`   | prompt text: `brief` (task, context, guidance, output), `section`, `bullets`, `numbered`, `fence`, `promptText`, `clip`, `tail`, `stripAnsi`, `slug`, `firstSentence`; Markdown reports: `findings`, `checklist`, `gate`, `plan`, `commits`                                                                                                                                                                                                                                                                     |
| `std.exec`   | journaled commands and Git reads: `check` (an exit-code verdict), `git`, `head`, `status`, `assertClean`, `diff`, `diffStat`, `changedFiles`, `commits`, `log` (`types.Commit`s); `committedArtifact` publishes a file, and `json` formats prompt data                                                                                                                                                                                                                                                          |
| `std.flow`   | team-free control flow: `untilDry` (rounds until dry), `waves` (a dependency graph in settled waves), `each` (a settled map with a per-item result)                                                                                                                                                                                                                                                                                                                                                             |

Every agent-output schema in `std.types` has an object root and required fields (`.nullable()` for
absence) and passes Codex's strict check, and none uses a regex, so fixture rehearsal can synthesize
it. A schema of your own built from them should keep those rules. The Git range helpers refuse a
range that is empty, starts with `-` or contains NUL before running anything.

## Bug hunt

**Rule:** discover until dry, and verify every new finding before it counts. `hunt` runs rounds of
finders over a rotating window of lenses (`std.lenses.bugs` by default, `perRound` 3), deduplicates
findings by `std.data.findingKey`, and has `seats` skeptics (default 3) try to refute each new
finding in the same round. It ends `dry` after `patience` (default 2) consecutive rounds without a
new finding or a failed finder once every lens has run, `round-limit` after `rounds` (default 4), or
`call-limit` when `maxCalls` (finder calls plus skeptic seats) would be exceeded, as `ended` says;
the left-out findings are logged and returned as `unverified`. `findings` holds the confirmed
findings themselves, and `task` replaces the opening of the finder prompt. Steps:
`<id>/round/<n>/lens/<lens>/find` and `<id>/round/<n>/item/<key>/seat/<s>/verdict`. The recipe
returns the whole `HuntResult` as its output.

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
  // `findings` holds the confirmed bugs, most severe first; `ended` says why the hunt stopped.
  output: std.patterns.HuntResult,
  run: (ctx, { scope, rounds, maxCalls }) =>
    std.patterns.hunt(ctx, {
      id: 'hunt',
      team: { finder: ctx.roster.Reviewer, skeptic: ctx.roster.Skeptic },
      subject: scope,
      rounds,
      maxCalls,
    }),
});
```

**Cost:** per round, `perRound` finder calls plus `seats` calls per new finding, bounded by
`maxCalls`. Each outcome list (`confirmed`, `refuted`, `undecided`) is sorted most severe first, and
the status is `degraded` when a finder or a seat failed; a call cap does not degrade it.

## Code review

**Rule:** fan out by lens, then verify. `lensPanel` asks the `reader` slot once per lens
(`<id>/lens/<lens>/read`) for a typed answer and returns
`{ results, failed, quorum, failures, status }`. `verify` gives each item to `seats` skeptics
(`<id>/item/<key>/seat/<n>/verdict`) with the material the claim is about as `context` (`describe`
renders an item as its claim), and splits the items into `confirmed`, `refuted` and `undecided` by
`rule` (`'majority'` by default, `'unanimous'` or `{ atLeast }`). A read-only skeptic cannot run
`git`, so pass the diff, not just the range.

<!-- skills-check: example pattern-std-code-review -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-code-review',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1) }),
  output: z.object({ status: std.data.Health, findings: z.array(std.types.Finding) }),
  async run(ctx, { range }) {
    const diff = std.text.fence(await std.exec.diff(ctx, 'diff', range), 'diff');
    const panel = await std.patterns.lensPanel(ctx, {
      id: 'review',
      team: { reader: ctx.roster.Reviewer },
      lenses: std.lenses.review,
      task: `Review the changes in ${range} below for defects.`,
      subject: diff,
      schema: std.types.Findings,
    });
    const found = panel.results.flatMap((answer) => answer.value.findings);
    const verdicts = await std.patterns.verify(ctx, {
      id: 'verify',
      team: { skeptic: ctx.roster.Skeptic },
      items: std.data.dedupeBy(found, std.data.findingKey),
      context: `The changes in ${range}:\n\n${diff}`,
    });
    const findings = std.data.bySeverity(verdicts.confirmed.map((verdict) => verdict.item));
    return { status: std.data.health(panel, verdicts), findings };
  },
});
```

**Cost:** one call per lens plus `seats` per distinct finding. The recipe's status is
`std.data.health(panel, verdicts)`: `degraded` when a lens or a seat failed; the failures are
journaled and are not retried on resume.

## Merge vote

**Rule:** put one question, with no as its safe answer, to independent seats. `vote` asks the
`voter` slot `seats` times (default 3; `<id>/seat/<n>/ballot`, a `types.Ballot`) and decides by
`rule` with `std.data.tally`: `outcome` is `yes` when the yes votes reach the threshold, `no` when
they cannot even if every missing seat voted yes, and otherwise `undecided`. A failed seat counts as
missing, never as a vote, and degrades the status. The recipe asks `Skeptic` seats whether a range
is safe to merge, with its diff stat and diff as `context`, and needs every seat to say yes.

<!-- skills-check: example pattern-std-vote -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-vote',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1), seats: std.types.limit(3, 7) }),
  output: std.patterns.VoteResult,
  async run(ctx, { range, seats }) {
    const stat = await std.exec.diffStat(ctx, 'stat', range);
    const diff = std.text.fence(await std.exec.diff(ctx, 'diff', range), 'diff');
    return std.patterns.vote(ctx, {
      id: 'vote',
      team: { voter: ctx.roster.Skeptic },
      question: `Is the change in ${range} safe to merge, breaking no existing caller or behavior?`,
      context: `${std.text.section('Files', stat)}\n\n${std.text.section('Diff', diff)}`,
      seats,
      rule: 'unanimous', // A single no, or a failed seat, means the change is not cleared.
    });
  },
});
```

**Cost:** `seats` calls and two Git reads.

## Document polish

**Rule:** revise until every critic answers with no issue, or the rounds run out. `critiqueRevise`
asks one critic per lens (`<id>/round/<n>/lens/<lens>/critique`, or `<id>/round/<n>/critique`
without lenses) and has the author revise (`<id>/round/<n>/revise`) after each round with issues
except the last. A draft is `approved` only when every critic of the last round answered with no
issue; a round with a failed critic does not approve, and the status is `degraded` when a critic
failed in any round. Without `draft`, the author writes the first one (`<id>/draft`). The recipe
writes the file back only when the result is approved and changed, guarded by the hash it read, and
returns the result as `polish`.

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
    polish: std.patterns.CritiqueReviseResult,
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
    // Write only an approved change, and only over the content the critics read.
    if (!polish.approved || polish.draft === doc.content) return { polish, receipt: null };
    const receipt = await ctx.writeFile('write', file, polish.draft, { ifMatch: doc.sha256 });
    return { polish, receipt };
  },
});
```

**Cost:** at most `rounds` critique rounds (one call per lens) and `rounds - 1` revisions.

## Fix the tests

**Rule:** only the command decides green. `fixUntilGreen` runs the check (`<id>/check/0`), and after
each failure asks the `mechanic`, or the `surgeon` after the first `escalateAfter` rounds (by
default only in the last of `rounds`, which defaults to 3), to fix it (`<id>/fix/<n>` from 1, a
settled `types.WorkReport` call), then checks again (`<id>/check/<n>`). Each fixer sees the failure
and the earlier attempts, and is told not to weaken tests. `fixedBy` names the slot whose fix made
the check pass; it is null when no fix call did, as when the pass followed a failed fix call.
`outcome` is `green` only when the last check passed; the status is `degraded` when a fix call
failed. A check that cannot start, times out or is killed is not a verdict: it fails the run before
any fixer sees it, and a resume runs it again.

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
  // `outcome` is the check command's verdict; no agent report can make it green.
  output: std.patterns.FixUntilGreenResult,
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

## Escalation

**Rule:** escalate rejected or failed work, and let a check decide acceptance. `escalate` gives the
task to `start` for attempt 0 (the mechanic by default) and every later attempt to the surgeon
(`<id>/attempt/<n>/work`, a `types.WorkReport` unless you pass `schema`), up to `attempts` (default
2), until your `accept(value, slot, attempt)` returns `true`; a string is the problems the next
attempt is shown. `accept` runs inside the attempt's scope, so its own effects take other leaves,
such as `<id>/attempt/<n>/check`, and it runs again on resume: decide only from the value and
durable effects. `outcome` is `accepted` or `rejected`; a failed attempt call escalates like a
rejection and degrades the status. Attempts hand work on through the files, so share one checkout,
not a fresh worktree per call.

<!-- skills-check: example pattern-std-escalate -->

```ts
import { defineRoster, defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-escalate',
  version: '1',
  roster: defineRoster({ Mechanic: std.roles.Mechanic, Surgeon: std.roles.Surgeon }),
  input: z.object({
    task: z.string().min(1),
    check: std.types.Argv.default(['npm', 'test']),
    attempts: std.types.limit(2, 4),
  }),
  output: std.patterns.EscalateResult(),
  run: (ctx, { task, check, attempts }) =>
    std.patterns.escalate(ctx, {
      id: 'change',
      team: { mechanic: ctx.roster.Mechanic, surgeon: ctx.roster.Surgeon },
      task,
      attempts,
      // Accept only work reported done that passes the check, recorded as attempt/<n>/check.
      async accept(report) {
        if (report.status !== 'done') return `The work is ${report.status}: ${report.summary}`;
        const result = await std.exec.check(ctx, 'check', check);
        return result.passed || `${check.join(' ')} failed:\n\n${std.text.fence(result.output)}`;
      },
    }),
});
```

**Cost:** at most `attempts` calls, and one check per attempt whose report is done.

## Design tournament

**Rule:** independent proposals, anonymous judging, then synthesis. `tournament` asks one proposer
per entrant philosophy (`std.lenses.design` by default; `<id>/propose/<entrant>/proposal`, a
`types.Proposal`), has `judges` judges score every proposal against the rubric
(`std.lenses.designRubric` by default) under anonymous letters in a rotated order
(`<id>/judge/<n>/scores`), ranks by mean score, and has the synthesizer write the final design from
the winner with the best ideas of the others and any dissent (`<id>/synthesize`). It returns
`outcome: 'aborted'`, as data, when fewer than `minEntrants` proposals or no judge succeed.

<!-- skills-check: example pattern-std-design-tournament -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-design-tournament',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ brief: z.string().min(1), judges: std.types.limit(3, 7) }),
  output: std.patterns.TournamentResult,
  run: (ctx, { brief, judges }) =>
    std.patterns.tournament(ctx, {
      id: 'tournament',
      // A Planner proposes per design lens, Judges score blind, and a Planner builds on the winner.
      team: {
        proposer: ctx.roster.Planner,
        judge: ctx.roster.Judge,
        synthesizer: ctx.roster.Planner,
      },
      brief,
      judges,
    }),
});
```

**Cost:** one call per entrant, `judges` judge calls and one synthesis.

## Triage

**Rule:** label in batches, then rank only what matters. `classify` sends `chunk` items (default 10)
per call (`<id>/chunk/<n>/tag`) and splits them into `assignments`, `unlabeled` and `failed`, with
`counts` per label; `omitted` names the unlabeled items a reply left out, and `multi: true` allows
several labels. `rank` picks the best `pick` items by a criterion in one call (`<id>/rank`) and
makes no call when there are no more than `pick` (`ranked: false`). Both `key` options take
`(item, index)`. The recipe returns the classification as `labeled`.

<!-- skills-check: example pattern-std-triage -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

const Issue = z.object({ number: z.int().min(1), title: z.string(), body: z.string() });
const Labels = z.array(z.string().min(1)).min(1).default(['bug', 'feature', 'docs', 'question']);

export default defineWorkflow({
  name: 'std-triage',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ issues: z.array(Issue).min(1), labels: Labels, top: std.types.limit(5, 20) }),
  output: z.object({ labeled: std.patterns.ClassifyResult(Issue), urgent: z.array(Issue) }),
  async run(ctx, { issues, labels, top }) {
    const labeled = await std.patterns.classify(ctx, {
      id: 'classify',
      team: { tagger: ctx.roster.Clerk },
      items: issues,
      labels,
    });
    const ranked = await std.patterns.rank(ctx, {
      id: 'rank',
      team: { ranker: ctx.roster.Judge },
      items: labeled.assignments, // Unlabeled issues are left for a person to read.
      pick: top,
      criterion: 'How urgently it needs attention: the severity and reach of its impact.',
    });
    return { labeled, urgent: ranked.selected.map(({ item }) => item) };
  },
});
```

**Cost:** one call per batch of `chunk` items, then one ranking call.

## Routing

**Rule:** choose one branch by name, and fall back safely. `route` asks the `router` slot once
(`<id>/route`) to pick one key of `routes`, each mapped to when to take it; the reply is constrained
to those keys. With a `fallback`, a failed call is journaled and takes the fallback
(`fallback: true`, status `degraded`) instead of throwing. The workflow then branches on `route` in
plain code, each branch with its own step ID.

<!-- skills-check: example pattern-std-route -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

const routes = {
  question: 'Asks how something works or where it is; the code and its docs can answer it.',
  bug: 'Reports behavior that is broken or differs from what the docs promise.',
  feature: 'Asks for new behavior or a change to existing behavior.',
  unclear: 'Does not say enough to act on.',
};

export default defineWorkflow({
  name: 'std-route',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ request: z.string().min(1) }),
  output: z.object({ routed: std.patterns.RouteResult(routes), reply: z.string() }),
  async run(ctx, { request }) {
    const { Clerk, Reader, Reviewer, Planner, Writer } = ctx.roster;
    const options = { id: 'route', team: { router: Clerk }, subject: request, routes };
    const routed = await std.patterns.route(ctx, { ...options, fallback: 'unclear' });
    const ask = (task: string) => ({ prompt: std.text.brief({ task, context: request }) });
    const reply = await {
      question: () => Reader.value('answer', ask('Answer the question below, citing file:line.')),
      bug: () => Reviewer.value('diagnose', ask('Find the cause of the bug below, at file:line.')),
      feature: () => Planner.value('scope', ask('Scope the feature below; list open questions.')),
      unclear: () => Writer.value('clarify', ask('Ask its author what the request below lacks.')),
    }[routed.route]();
    return { routed, reply };
  },
});
```

**Cost:** one routing call and the chosen branch's calls.

## Change log

**Rule:** map in chunks, reduce once, and say what was not covered. `mapReduce` gives `chunk` items
(default 20) to each mapper call (`<id>/map/<k>/part`, where `<k>` is the chunk's first item key;
text or your `schema`), and one reducer call combines the successful parts (`<id>/reduce`). Coverage
is computed in code: the items of failed chunks are returned in `coverage.missing` and listed to the
reducer as not covered. When every chunk fails, the reducer is skipped, `result` is empty and the
status is `degraded`. The recipe reads the range with `std.exec.log` and keys each commit by its
SHA.

<!-- skills-check: example pattern-std-changelog -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-changelog',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1) }),
  // `result` holds the notes; `coverage.missing` lists the commits of chunks whose mapper failed.
  output: std.patterns.MapReduceResult(std.types.Changes),
  async run(ctx, { range }) {
    const commits = await std.exec.log(ctx, 'commits', range);
    return std.patterns.mapReduce(ctx, {
      id: 'notes',
      team: { mapper: ctx.roster.Scribe, reducer: ctx.roster.Writer },
      items: commits,
      key: (commit) => commit.sha,
      describe: (commit) => commit.subject,
      task: `Turn these commits from ${range} into change-log entries, one per distinct change.`,
      schema: std.types.Changes,
      reduce: 'Write Markdown release notes: breaking changes and migrations first, then by kind.',
    });
  },
});
```

**Cost:** `ceil(items / chunk)` mapper calls and one reducer call.

## Plan and build

**Rule:** a planned graph is checked in code before anything runs. `decompose` asks the planner for
a `types.TaskList` (`<id>/plan`) and checks it for repeated IDs, unknown dependencies and cycles; if
it fails, one repair call (`<id>/repair`) gets the problems, and a still-invalid list throws. It
returns the tasks, their dependency `waves` and whether it was `repaired`. `taskCall(task, goal)` is
the prompt and `types.WorkReport` schema for doing one task, and `std.flow.waves` runs the graph
(`<id>/wave/<n>/<task>/<leaf>`), skipping the dependents of a failed task. Throw from `run` on a
report that is not `done`, so a blocked task stops its dependents.

<!-- skills-check: example pattern-std-plan-and-build -->

```ts
import { defineRoster, defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

const Reports = z.array(std.types.WorkReport.nullable());

export default defineWorkflow({
  name: 'std-plan-and-build',
  version: '1',
  roster: defineRoster({ Planner: std.roles.Planner, Mechanic: std.roles.Mechanic }),
  input: z.object({ goal: z.string().min(1), maxTasks: std.types.limit(8, 30) }),
  output: std.types.TaskList.extend({ status: std.data.Health, reports: Reports }),
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
    const reports = build.results.map((item) => item.value);
    return { status: std.data.health(plan, build), tasks: plan.tasks, reports };
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
criterion against the `subject` (`<id>/criterion/<C>/check`, a `types.CriterionResult`); string
criteria get IDs `C1`, `C2`, .... The verdict is `not-done` if any criterion failed or is partial,
`done` if all passed, and otherwise `unverified`; `counts` tallies the statuses. The checker's safe
default is `unverifiable`, never `pass`. `types.Criteria` validates the criteria input.

<!-- skills-check: example pattern-std-acceptance -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-acceptance',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1), criteria: std.types.Criteria }),
  output: std.patterns.ChecklistResult,
  async run(ctx, { range, criteria }) {
    const diff = await std.exec.diff(ctx, 'diff', range);
    return std.patterns.checklist(ctx, {
      id: 'acceptance',
      team: { checker: ctx.roster.Reviewer },
      subject: `The change in ${range}, as git diff shows it:\n\n${std.text.fence(diff, 'diff')}`,
      criteria,
    });
  },
});
```

**Cost:** one call per criterion.

## Release gate

**Rule:** a blocker stands until skeptics refute it. `gate` has the assessor judge each dimension
(`std.lenses.release` by default; `<id>/dimension/<key>/assess`, a `types.Assessment`), then gives
each reported blocker to `seats` skeptics (default 1; `<id>/blocker/<key>/seat/<n>/verdict`). A
refuted blocker is downgraded to a concern. The decision is `no-go` for a confirmed or undecided
blocker, `conditional-go` for a concern, a downgrade, a dimension that could not be checked or a
failed assessor, and `go` otherwise. The recipe shows the range as `std.exec.log` rendered by
`std.text.commits` and a `std.exec.diffStat`.

<!-- skills-check: example pattern-std-release-gate -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-release-gate',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ range: z.string().min(1), seats: std.types.limit(1, 5) }),
  output: std.patterns.GateResult,
  async run(ctx, { range, seats }) {
    const commits = std.text.commits(await std.exec.log(ctx, 'commits', range));
    const stat = await std.exec.diffStat(ctx, 'stat', range);
    return std.patterns.gate(ctx, {
      id: 'gate',
      team: { assessor: ctx.roster.Reviewer, skeptic: ctx.roster.Skeptic },
      task: `Assess whether the release ${range} is ready to ship.`,
      subject: `${std.text.section('Commits', commits)}\n\n${std.text.section('Diff stat', stat)}`,
      seats, // Skeptics per reported blocker; a blocker they refute counts as a concern.
    });
  },
});
```

**Cost:** one call per dimension and `seats` calls per reported blocker.

## Incident analysis

**Rule:** try to falsify every hypothesis, not to confirm one. `falsify` asks the theorist for up to
`count` (default 4, at most 8) competing hypotheses with testable predictions (`<id>/theorize`),
then gives each to a falsifier (`<id>/hypothesis/<key>/falsify`, a `types.Falsification`) whose safe
default is `untestable`. Confidence is `high` for one survivor with every rival falsified, `medium`
for one survivor otherwise (a rival left open, or no rival), `split` for several survivors and
`none` for no survivor. What was observed goes in `context`, shown under `### Evidence`.

<!-- skills-check: example pattern-std-incident -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-incident',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ question: z.string().min(1), range: z.string().min(1), notes: z.string() }),
  output: std.patterns.FalsifyResult,
  async run(ctx, { question, range, notes }) {
    // The suspect range as evidence: its commits, oldest first, and the files they changed.
    const commits = std.text.commits(await std.exec.log(ctx, 'log', range));
    const stat = await std.exec.diffStat(ctx, 'stat', range);
    return std.patterns.falsify(ctx, {
      id: 'incident',
      team: { theorist: ctx.roster.Reviewer, falsifier: ctx.roster.Skeptic },
      question,
      context: [
        std.text.section(`Commits in ${range}`, commits),
        std.text.section('Files changed', stat),
        std.text.section('Notes', notes),
      ].join('\n\n'),
    });
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
`answered` is false and no synthesis runs; a failed scout or reader degrades the status.

<!-- skills-check: example pattern-std-research -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-research',
  version: '1',
  roster: std.rosters.readers,
  input: z.object({ question: z.string().min(1), reads: std.types.limit(6, 20) }),
  output: std.patterns.ResearchResult,
  // Researchers search the web from each default angle and read; the tool-free Writer cites.
  run: (ctx, { question, reads }) =>
    std.patterns.research(ctx, {
      id: 'research',
      team: {
        scout: ctx.roster.Researcher,
        reader: ctx.roster.Researcher,
        synthesizer: ctx.roster.Writer,
      },
      question,
      reads,
    }),
});
```

**Cost:** one call per angle, at most `reads` reads and one synthesis.

## Parallel edits

**Rule:** each edit gets a fresh worktree and may change only what it owns. `isolatedEdits` runs one
isolated call per item (`<id>/item/<key>/edit`), checks the captured change against the item's
`owns` paths (a rename is checked by both paths, `<id>/item/<key>/paths`), leaves a violating change
out, and merges the rest (`<id>/merge`, with your `merge` options; conflicts are reported by
default). Owned paths must be disjoint across items. The result maps merges, conflicts, violations
and failures back to item keys; a violation or conflict degrades the status as a failed edit does.

<!-- skills-check: example pattern-std-parallel-edits -->

```ts
import { defineRoster, defineWorkflow, z } from '../../src/index.js';
import * as std from '../../src/std/index.js';

export default defineWorkflow({
  name: 'std-parallel-edits',
  version: '1',
  roster: defineRoster({ Mechanic: std.roles.Mechanic }),
  input: z.object({ edits: z.array(std.types.Step).min(1).max(12), message: z.string().min(1) }),
  output: std.patterns.IsolatedEditsResult,
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

The workflow's checkout must be a Git working tree with a commit. Each edit starts from `base` (by
default `HEAD` when it starts), and under `--dry-run` every item is `unchanged`.

**Cost:** one isolated call per item and one merge. Under `--require-grants`, the editor needs a
write grant.

## Approved plan

**Rule:** a human approves the exact plan that is carried out. `approvedPlan` asks the planner for a
`types.Plan` (`<id>/round/<n>/plan`) and asks for approval of its digest (`<id>/round/<n>/approve`);
a rejection with a comment gets a revised plan, up to `revisions` times, and a rejection without one
stops; `outcome` says which (`approved`, `rejected`, `out-of-revisions`). `planCall(review, task)`
is the implementer's prompt and `types.WorkReport` schema, with the reviewer's comment; it throws
for a result that was not approved. The run suspends at each approval: answer it as in
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
    review: std.patterns.ApprovedPlanResult,
    report: std.types.WorkReport.nullable(),
  }),
  async run(ctx, { task, revisions }) {
    const team = { planner: ctx.roster.Planner };
    const review = await std.patterns.approvedPlan(ctx, { id: 'plan', team, task, revisions });
    // Only an approved plan is implemented; a rejected one is returned for the record.
    if (!review.approved) return { review, report: null };
    const call = std.patterns.planCall(review, task);
    return { review, report: await ctx.roster.Mechanic.value('implement', call) };
  },
});
```

**Cost:** one planning call per round and one implementation call.
