# Porting a native Workflow script

A Claude Code [native Workflow](https://code.claude.com/docs/en/workflows) script is plain
JavaScript around `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args` and `budget`.
Porting it to quiet-choir keeps the same loops and branches and makes each agent call, command and
wait a durable named effect, checkpointed in a state directory you choose. A script with a helper
CLI, a tier map and long prompts ports to a [package](packages.md): the roster replaces the tier
map, markdown templates replace the prompt literals and durable steps replace the helper. Read
[workflow authoring](workflow-authoring.md) for the effect contract and the
[verified patterns](patterns.md) for complete recipes.

## Primitive map

| Native                                                                        | quiet-choir                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent(prompt)`                                                               | `ctx.roster.Name.value(id, { prompt })` on a [roster](agent-calls.md#roster) entry, with a stable, unique `id`. A one-off call with options no entry names is raw `ctx.claude.value` (or `ctx.codex`). `text` and `object` return the full result with `output`, `usage` and `sessionId`                                |
| `agent(prompt, { schema })`                                                   | `ctx.roster.Name.value(id, { prompt: prompts.X(params), schema })`, with a Zod schema that is validated locally and typechecked (or `.object` for the wrapper)                                                                                                                                                          |
| The `TIER` map of `{ model, effort }`                                         | Roster entries, so each role carries its tier: `Mechanic: { ...std.claude.Edit, ...std.tiers.Mechanic }` ([packages](packages.md#roster)); the native tiers (clerk, copyist, scribe, mechanic, planner, skeptic, surgeon) are `std.tiers`                                                                               |
| Multi-line prompt template literals                                           | `prompts/*.md` templates indexed by `definePrompts`, with typed Zod params, shared `_fragments/` and load-time checks ([prompt templates](prompts.md), [packages](packages.md#prompts)); the template text is an execution dependency                                                                                   |
| Choosing an agent tier by complexity or kind                                  | A `defineTeam` slot (`mechanic`, `surgeon`) filled from the roster at the call site: `const fixer = hard ? team.surgeon : team.mechanic` ([teams](packages.md#teams))                                                                                                                                                   |
| An agent that routes or grades; a `needs-decision` rerun with `args.decision` | `ctx.decide` or a roster decider (`ctx.roster.Name.decide`) for automatic routing ([decision providers](decisions.md)), `ctx.ask` for a human answer; the answer is part of the replayed run, not a new argument                                                                                                        |
| `null` from a failed agent                                                    | `onError: 'return'` on the call, which returns a `Settled` (`result.ok ? result.value : result.error`) that replays as data. Without it, a failure throws and fails the run resumably ([failure handling](workflow-authoring.md#failure-handling))                                                                      |
| `parallel(thunks)`                                                            | `ctx.map(id, items, { concurrency, onError: 'return' }, mapper)`, which runs every item and returns settled results in input order; add `cancelSiblings: true` to stop at the first failure. For a few different calls, `Promise.all` over distinct IDs. Never `Promise.race` a durable call                            |
| `pipeline(items, ...stages)`                                                  | A named `ctx.map` whose mapper awaits each stage in turn, as in the [per-item pipeline](patterns.md#per-item-pipeline): a failed stage resumes alone and sibling items keep their completed stages                                                                                                                      |
| `phase(title)`, `log(message)`                                                | `ctx.phase(title)` (or `ctx.phase(title, body)` for concurrent work) and `ctx.log(message, data?)`; neither affects replay identity                                                                                                                                                                                     |
| `args`                                                                        | The workflow's `input` Zod schema, passed with `--input JSON` and validated before any effect                                                                                                                                                                                                                           |
| `budget`                                                                      | A loop bounded in code (a `maxRounds` input), plus the run caps `--max-run-cost-usd` and `--max-run-agent-attempts`; see [a bounded loop under run caps](#a-bounded-loop-under-run-caps)                                                                                                                                |
| `model`, `effort`                                                             | On the roster entry (`{ harness: 'claude', model, effort }`), so roles carry their tier; a raw call may still set them per call                                                                                                                                                                                         |
| `isolation: 'worktree'`                                                       | `worktree: true` on the call: a fresh checkout per attempt, captured and integrated with `ctx.merge` ([worktrees](worktrees.md))                                                                                                                                                                                        |
| `agentType`                                                                   | A roster entry with the role's tools, limits and standing prompt; see [an exec role](#an-exec-role-and-its-grant)                                                                                                                                                                                                       |
| `workflow(name, args)`, `workflow({ scriptPath }, args)`                      | `ctx.workflow(id, definition, input)` with an imported definition, a typed child with validated input and output, nested through `children` to any depth up to `--max-child-depth` ([typed child workflows](workflow-authoring.md#typed-child-workflows)); in a package the child is another workflow module it imports |
| A script plus its helper CLI (`.mjs`)                                         | A `*.quiet-choir` package: control flow in `workflows/`, the helper's subcommands as versioned `ctx.step` effects in `lib/`, schemas in `contracts.ts`, so the script and its tool are one fingerprinted unit ([packages](packages.md))                                                                                 |
| A verified clerk/copyist relay (nonces, FNV hashes, `recopyist`)              | Versioned `ctx.step` or `ctx.exec` effects, with no model: the output is checkpointed and typed, so nothing needs a nonce, a hash or a second read ([worked example](packages.md#worked-example-merge-down))                                                                                                            |
| `until` stage stops                                                           | An `until` enum input that returns a `stopped` result early; the schema validates it before any effect                                                                                                                                                                                                                  |
| State files and a worktree under a root                                       | A `root` input; durable steps read before they write, so a retried step finds the state the last attempt left ([packages](packages.md#fingerprinting-and-resume): keep that root outside the package)                                                                                                                   |
| `resumeFromRunId`                                                             | Resume the same run ID (`workflow resume RUN`) from the launch directory, in any shell or session. After an edit, accept it with `--resume --accept-code-change` or fork with `--fork-from RUN --reuse matching` ([recovery paths](durability.md#choose-a-recovery-path))                                               |
| A clerk agent relaying a command's output                                     | `ctx.exec(id, argv)` or `ctx.exec.json(id, argv, { schema })`: no model, the output is checkpointed, and `quiet-choir/github` wraps `gh` reads, waits and writes                                                                                                                                                        |
| An agent that loops to wait for CI or review                                  | `ctx.poll`, `ctx.wait` or `gh.waitChecks`/`gh.waitReview`: the run suspends (exit 75) and `workflow tick` resumes it ([durable waits](waits.md))                                                                                                                                                                        |
| A question for the user                                                       | `ctx.ask(id, { prompt, schema })`: the run suspends, `workflow answer` validates the answer, and resume continues in place ([durable questions](durability.md#durable-questions))                                                                                                                                       |

## Parity gotchas

- **Null on failure needs `onError: 'return'`.** A native `agent()`, `parallel` thunk or `pipeline`
  stage turns a terminal failure into `null`. A quiet-choir call or map throws unless it is settled.
  A caught throw is not a durable decision: the call can heal on resume and take the other branch.
- **A precondition is a step, not a read.** A native script's check runs again on every launch. In
  quiet-choir a completed `git status` (or any read) replays its value, so a body throw on a dirty
  checkout fails every resume. Throw from a `ctx.step` callback that runs the command through
  `context.exec` ([commands and files](commands-files.md)).
- **The text baseline is far narrower than a native agent.** A raw call has no Claude tools, 10
  turns, $0.50 and 5 minutes. A call that reads, edits or runs commands needs a roster entry or a
  bound agent, and under `requireGrants` every write or exec entry needs `--grant` at launch.
- **Context is restricted.** quiet-choir calls run Claude restricted by default, without CLAUDE.md
  and project instructions, discovered MCP servers, user plugins and skills, or auto-memory. Native
  agents get CLAUDE.md and the session's MCP tools. Put the rules a call needs in its prompt, or opt
  back in through `mcpServers`, `settings`, `plugins`, `agents`, `systemPrompt`,
  `appendSystemPrompt` or an `inherit` role ([harness isolation](harness-isolation.md)).
- **No `Date.now()` in the body.** Native scripts cannot call it; quiet-choir can, but a live read
  changes on replay. Record time with `ctx.now(id)` and derive deadlines from it.
- **Edit and relaunch is a fork.** Native resume reuses the longest unchanged prefix of agent calls.
  quiet-choir refuses a changed completed step on resume; fork with `--reuse matching` to keep every
  matching completed effect, or `--reuse prefix` (the default) for causal reuse.
- **There is no token budget.** Native `budget` is a hard ceiling that makes further `agent()` calls
  throw. quiet-choir caps reported cost and agent attempts per run; cost is not a hard ceiling, and
  live usage totals must not drive replay-sensitive branches ([run caps](usage-budgets.md)).
- **IDs are the contract.** Every effect needs a stable ID that is unique in the run; inside a loop
  derive it with `ctx.id(...)` from replayed data, such as a round number or a head SHA.

## An exec role and its grant

A native agent can run any shell command it is permitted to. In quiet-choir, declare a roster entry,
name `Bash` in its tools, and narrow the allowed rules. Access is derived from those tools, so the
entry does not declare it. By default the entry runs as declared; an operator who wants a
launch-time grant opts in with `--require-grants` (or `requireGrants: true`). The same entry is in
the repository's roster guide.

<!-- skills-check: example porting-exec-roster -->

```ts
import { defineRoster, defineWorkflow, z } from 'quiet-choir';

const roster = defineRoster({
  Fixer: {
    harness: 'claude',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Bash'],
    allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Bash(npm test:*)', 'Bash(gh pr checks:*)'],
    maxTurns: 40,
    maxBudgetUsd: 5,
    timeoutMs: 1_800_000,
  },
});

export default defineWorkflow({
  name: 'fix-tests',
  version: '1',
  roster,
  input: z.object({ task: z.string() }),
  output: z.string(),
  async run(ctx, { task }) {
    return ctx.roster.Fixer.value('fix', { prompt: task });
  },
});
```

Rehearse it under `--require-grants` with its grant; there, without `--grant Fixer` (or
`--grant exec`, or `--grant all`) the launch is refused before any effect. Drop `--dry-run` to run
it.

<!-- skills-check: example porting-exec-grant -->

```sh
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow execute "$QC_WORKFLOW" --run-id fix-1 \
  --state-dir "$QC_RUNS" --input '{"task":"Make npm test pass."}' --require-grants --grant Fixer \
  --dry-run --json
```

## A bounded loop under run caps

Bound the loop in code, as native scripts bound theirs by `budget.remaining()`, and cap spend from
the command line. This is [loop until dry](patterns.md#loop-until-dry) with a round limit:

<!-- skills-check: example porting-budget-loop -->

```ts
import { defineRoster, defineWorkflow, z } from 'quiet-choir';

const findings = z.object({ findings: z.array(z.string()) });
const roster = defineRoster({
  Hunter: {
    harness: 'claude',
    tools: ['Read', 'Grep', 'Glob'],
    maxTurns: 25,
    maxBudgetUsd: 2,
    timeoutMs: 900_000,
  },
});
export default defineWorkflow({
  name: 'bounded-hunt',
  version: '1',
  roster,
  input: z.object({ target: z.string(), maxRounds: z.int().min(1).max(20) }),
  output: z.array(z.string()),
  async run(ctx, { target, maxRounds }) {
    const known: string[] = [];
    for (let round = 1; round <= maxRounds; round++) {
      const { findings: found } = await ctx.roster.Hunter.value(ctx.id('find', round), {
        prompt: `Find bugs in ${target}. Already known: ${JSON.stringify(known)}.`,
        schema: findings,
      });
      const fresh = found.filter((item) => !known.includes(item));
      if (!fresh.length) break;
      known.push(...fresh);
    }
    return known;
  },
});
```

<!-- skills-check: example porting-budget-caps -->

```sh
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow execute "$QC_WORKFLOW" --run-id hunt-1 \
  --state-dir "$QC_RUNS" --input '{"target":"src","maxRounds":8}' \
  --max-run-cost-usd 5 --max-run-agent-attempts 8 --json
```

A reached cap refuses new attempts, lets admitted ones finish, and fails the run with
`RunBudgetExceededError`. The body cannot catch it, and `onError: 'return'` does not settle it. To
continue, resume the same run with a higher cap, such as
`workflow resume hunt-1 --state-dir "$QC_RUNS" --max-run-agent-attempts 16 --json`: completed rounds
replay without new spend. Unknown and Codex costs are not priced, and active calls can overshoot the
cost cap, so pair it with the attempt cap.

## Porting the reference workflows

This repository's native
[merge-down-pr.js](https://github.com/plx/quiet-choir/blob/657334c8b994ba6c0166347c4e61cefef4a54a50/.claude/workflows/merge-down-pr.js)
landed one pull request, and its execute-epic-ticket workflow took one epic ticket to a merge. Both
native scripts were retired in favor of packages (the link shows the last version of the first). The
first is ported: `packages/merge-down.quiet-choir` is a [package](packages.md) whose
[worked example](packages.md#worked-example-merge-down) shows the layout and measures the result.
Its native steps became:

- the tier map, a roster in `roster.ts` (`Reviewer` and `Judge` local, `Mechanic`, `Surgeon` and
  `Scribe` from `std.tiers`);
- twelve multi-line template literals, markdown templates in `prompts/` with typed parameters;
- the choice of a fixer by complexity, and of a conflict resolver by PR kind, the `FixTeam` and
  `ResolveTeam` slots;
- the helper CLI and its clerk relay, versioned durable steps in `lib/` (git, check suite, local
  review, landing) that cost no model call, plus `quiet-choir/github` for the reads, waits and
  writes;
- stage stops and the state root, the `until` and `root` inputs;
- a rehearsal case per path, run by `npm run packages:rehearse`.

The execute-epic-ticket workflow is ported too, as `packages/execute-epic-ticket.quiet-choir` (the
native original is
[execute-epic-ticket.js](https://github.com/plx/quiet-choir/blob/657334c8b994ba6c0166347c4e61cefef4a54a50/.claude/workflows/execute-epic-ticket.js)),
with the same map. Its clerk agents existed only because a native script cannot run commands;
[`quiet-choir/github`](extensions.md#service-helper-pattern) replaces most of them with typed
effects.

| Native step                                                                   | quiet-choir                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A clerk running a helper subcommand and relaying its JSON                     | `ctx.exec.json(id, argv, { schema })`, or a versioned `ctx.step` in the package's `lib/`                                                                                     |
| Snapshotting the pull request, its threads, CI and alerts                     | `gh.pr.view`, `gh.pr.reviewThreads` and `gh.codeScanning.alerts`, keyed by head SHA                                                                                          |
| The gate's relay loop waiting for CI, Codex and CodeQL                        | `gh.waitChecks` and `gh.waitReview` with `codexReviewer()` and `codeqlReviewer()`, under IDs keyed by head SHA, as in the [CI-gated fix loop](patterns.md#ci-gated-fix-loop) |
| Replying to threads, filing follow-ups, opening the PR, rerunning CI, merging | Reconciled or conditional writes: `gh.thread.reply`, `gh.issue.create` with `parent`, `gh.pr.create`, `gh.checks.rerunFailed` and `gh.pr.merge` at the gated SHA             |
| Surveying the epic and picking the next ticket                                | `gh.epic.snapshot` and the pure `nextTicket`, one run per ticket as in the [ticket loop](patterns.md#ticket-loop)                                                            |
| A `needs-decision` result and a rerun with the maintainer's answer            | `ctx.ask`: the run suspends, and `workflow answer --resume` continues it in place; `ctx.decide` or a roster decider when a provider may answer                               |
| The landing child run with `workflow('merge-down-pr', ...)`                   | `ctx.workflow` with the imported definition (the merge-down package's workflow), typed input and output, sharing the parent's journal                                        |
| Parallel publish: the PR text and the follow-up filing at once                | `Promise.all` over a roster call and the `gh.issue.create` writes, under distinct IDs                                                                                        |
| Local checks in parallel with a reviewer                                      | `Promise.all` over `ctx.exec('check', ...)` and `ctx.roster.Reviewer.object('review', ...)`                                                                                  |
| Implementers that edit in a dedicated worktree                                | An editor roster entry (a `FixTeam`-style slot for mechanic versus surgeon) with `worktree: true`, or a shared `ctx.worktree` handle for write, test and fix                 |

Ticking an epic's checklist edits the issue body, which `quiet-choir/github` does not provide
because GitHub has no conditional body update; keep that in a step of your own, which is at least
once. For a failure-tolerant review panel, see the
[failure-tolerant panel](patterns.md#failure-tolerant-panel).
