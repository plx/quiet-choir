# Porting a native Workflow script

A Claude Code [native Workflow](https://code.claude.com/docs/en/workflows) script is plain
JavaScript around `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args` and `budget`.
Porting it to quiet-choir keeps the same loops and branches and makes each agent call, command and
wait a durable named effect, checkpointed in a state directory you choose. Read
[workflow authoring](workflow-authoring.md) for the effect contract and the
[verified patterns](patterns.md) for complete recipes.

## Primitive map

| Native                                       | quiet-choir                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent(prompt)`                              | `ctx.claude.value(id, { prompt })` (or `ctx.codex`), with a stable, unique `id`. `text` and `object` return the full result with `output`, `usage` and `sessionId`                                                                                                                           |
| `agent(prompt, { schema })`                  | `ctx.claude.value(id, { prompt, schema })` or `ctx.claude.object`, with a Zod schema that is validated locally and typechecked                                                                                                                                                               |
| `null` from a failed agent                   | `onError: 'return'` on the call, which returns a `Settled` (`result.ok ? result.value : result.error`) that replays as data. Without it, a failure throws and fails the run resumably ([failure handling](workflow-authoring.md#failure-handling))                                           |
| `parallel(thunks)`                           | `ctx.map(id, items, { concurrency, onError: 'return' }, mapper)`, which runs every item and returns settled results in input order; add `cancelSiblings: true` to stop at the first failure. For a few different calls, `Promise.all` over distinct IDs. Never `Promise.race` a durable call |
| `pipeline(items, ...stages)`                 | A named `ctx.map` whose mapper awaits each stage in turn, as in the [per-item pipeline](patterns.md#per-item-pipeline): a failed stage resumes alone and sibling items keep their completed stages                                                                                           |
| `phase(title)`, `log(message)`               | `ctx.phase(title)` (or `ctx.phase(title, body)` for concurrent work) and `ctx.log(message, data?)`; neither affects replay identity                                                                                                                                                          |
| `args`                                       | The workflow's `input` Zod schema, passed with `--input JSON` and validated before any effect                                                                                                                                                                                                |
| `budget`                                     | A loop bounded in code (a `maxRounds` input), plus the run caps `--max-run-cost-usd` and `--max-run-agent-attempts`; see [a bounded loop under run caps](#a-bounded-loop-under-run-caps)                                                                                                     |
| `model`, `effort`                            | Per call, or in `defaults` and declared `profiles` (`claude: { model, effort }`, `codex: { model, effort }`), so roles carry their tier                                                                                                                                                      |
| `isolation: 'worktree'`                      | `worktree: true` on the call: a fresh checkout per attempt, captured and integrated with `ctx.merge` ([worktrees](worktrees.md))                                                                                                                                                             |
| `agentType`                                  | A declared profile with the role's tools, limits and prompt; see [an exec role](#an-exec-role-and-its-grant)                                                                                                                                                                                 |
| `workflow(name, args)`                       | `ctx.workflow(id, definition, input)`, a typed child with validated input and output, nested through `children` to any depth up to `--max-child-depth` ([typed child workflows](workflow-authoring.md#typed-child-workflows))                                                                |
| `resumeFromRunId`                            | Resume the same run ID (`workflow resume RUN`), from any shell. After an edit, accept it with `--resume --accept-code-change` or fork with `--fork-from RUN --reuse matching` ([recovery paths](durability.md#choose-a-recovery-path))                                                       |
| A clerk agent relaying a command's output    | `ctx.exec(id, argv)` or `ctx.exec.json(id, argv, { schema })`: no model, the output is checkpointed, and `quiet-choir/github` wraps `gh` reads, waits and writes                                                                                                                             |
| An agent that loops to wait for CI or review | `ctx.poll`, `ctx.wait` or `gh.waitChecks`/`gh.waitReview`: the run suspends (exit 75) and `workflow tick` resumes it ([durable waits](waits.md))                                                                                                                                             |
| A question for the user                      | `ctx.ask(id, { prompt, schema })`: the run suspends, `workflow answer` validates the answer, and resume continues in place ([durable questions](durability.md#durable-questions))                                                                                                            |

## Parity gotchas

- **Null on failure needs `onError: 'return'`.** A native `agent()`, `parallel` thunk or `pipeline`
  stage turns a terminal failure into `null`. A quiet-choir call or map throws unless it is settled.
  A caught throw is not a durable decision: the call can heal on resume and take the other branch.
- **The implicit `text` profile is far narrower than a native agent.** It has no Claude tools, 10
  turns, $0.50 and 5 minutes. A call that reads, edits or runs commands needs `readonly`, `edit` or
  a declared profile, and every write or exec role needs `--grant` at launch.
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

A native agent can run any shell command it is permitted to. In quiet-choir, declare the role, name
`Bash` in its tools, and narrow the allowed rules. `access: 'exec'` states the class the tools
imply. The same role is in the repository's agent profiles guide.

<!-- skills-check: example porting-exec-profile -->

```ts
import { defineWorkflow, z } from 'quiet-choir';

export default defineWorkflow({
  name: 'fix-tests',
  version: '1',
  input: z.object({ task: z.string() }),
  output: z.string(),
  profiles: {
    fixer: {
      extends: 'edit',
      access: 'exec',
      claude: {
        tools: ['Read', 'Grep', 'Glob', 'Edit', 'Bash'],
        allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Bash(npm test:*)', 'Bash(gh pr checks:*)'],
      },
    },
  },
  async run(ctx, { task }) {
    return ctx.claude.value('fix', { profile: 'fixer', prompt: task });
  },
});
```

Rehearse it with its grant; without `--grant fixer` (or `--grant exec`, or `--grant all`) the launch
is refused before any effect. Drop `--dry-run` to run it.

<!-- skills-check: example porting-exec-grant -->

```sh
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow execute "$QC_WORKFLOW" --run-id fix-1 \
  --state-dir "$QC_RUNS" --input '{"task":"Make npm test pass."}' --grant fixer --dry-run --json
```

## A bounded loop under run caps

Bound the loop in code, as native scripts bound theirs by `budget.remaining()`, and cap spend from
the command line. This is [loop until dry](patterns.md#loop-until-dry) with a round limit:

<!-- skills-check: example porting-budget-loop -->

```ts
import { defineWorkflow, z } from 'quiet-choir';

const findings = z.object({ findings: z.array(z.string()) });
export default defineWorkflow({
  name: 'bounded-hunt',
  version: '1',
  input: z.object({ target: z.string(), maxRounds: z.int().min(1).max(20) }),
  output: z.array(z.string()),
  async run(ctx, { target, maxRounds }) {
    const known: string[] = [];
    for (let round = 1; round <= maxRounds; round++) {
      const { findings: found } = await ctx.claude.value(ctx.id('find', round), {
        profile: 'readonly',
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

This repository's
[merge-down-pr.js](https://github.com/plx/quiet-choir/blob/main/.claude/workflows/merge-down-pr.js)
lands one pull request, and its execute-epic-ticket workflow takes one epic ticket to a merge. Both
are native scripts kept as porting references. Their clerk agents exist only because a native script
cannot run commands;
[`quiet-choir/github`](https://github.com/plx/quiet-choir/blob/main/docs/github.md) replaces most of
them with typed effects.

| Native step                                                                   | quiet-choir                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A clerk running a helper subcommand and relaying its JSON                     | `ctx.exec.json(id, argv, { schema })`                                                                                                                                        |
| Snapshotting the pull request, its threads, CI and alerts                     | `gh.pr.view`, `gh.pr.reviewThreads` and `gh.codeScanning.alerts`, keyed by head SHA                                                                                          |
| The gate's relay loop waiting for CI, Codex and CodeQL                        | `gh.waitChecks` and `gh.waitReview` with `codexReviewer()` and `codeqlReviewer()`, under IDs keyed by head SHA, as in the [CI-gated fix loop](patterns.md#ci-gated-fix-loop) |
| Replying to threads, filing follow-ups, opening the PR, rerunning CI, merging | Reconciled or conditional writes: `gh.thread.reply`, `gh.issue.create` with `parent`, `gh.pr.create`, `gh.checks.rerunFailed` and `gh.pr.merge` at the gated SHA             |
| Surveying the epic and picking the next ticket                                | `gh.epic.snapshot` and the pure `nextTicket`, one run per ticket as in the [ticket loop](patterns.md#ticket-loop)                                                            |
| A `needs-decision` result and a rerun with the maintainer's answer            | `ctx.ask`: the run suspends, and `workflow answer --resume` continues it in place                                                                                            |
| The landing child run with `workflow('merge-down-pr', ...)`                   | `ctx.workflow` with typed input and output, sharing the parent's journal                                                                                                     |
| Local checks in parallel with a reviewer                                      | `Promise.all` over `ctx.exec('check', ...)` and `ctx.claude.object('review', ...)`                                                                                           |
| Implementers that edit in a dedicated worktree                                | An `edit` or exec role with `worktree: true`, or a shared `ctx.worktree` handle for write, test and fix                                                                      |

Ticking an epic's checklist edits the issue body, which `quiet-choir/github` does not provide
because GitHub has no conditional body update; keep that in a step of your own, which is at least
once. For a failure-tolerant review panel, see the
[failure-tolerant panel](patterns.md#failure-tolerant-panel).
