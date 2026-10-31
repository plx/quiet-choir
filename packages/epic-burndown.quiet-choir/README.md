# epic-burndown.quiet-choir

A quiet-choir [package](../../docs/packages.md) with one workflow, `epic-burndown`, that burns an
epic down by running the
[execute-epic-ticket package](../execute-epic-ticket.quiet-choir/README.md)'s `execute-epic-ticket`
workflow once per ticket, as a typed inline child, until the epic is done or a run returns a status
a person must act on. It is the burn-down orchestrator that execute-epic-ticket's README refers to
("the burn-down orchestrator acts on the returned statuses").

```
epic-burndown.quiet-choir/
  package.ts                 definePackage: name epic-burndown, entry epic-burndown
  workflows/epic-burndown.ts control flow only; declares execute-epic-ticket in `children`
  contracts.ts               input, the record, and the statuses that continue the loop
  tsconfig.json              maps quiet-choir, quiet-choir/github and quiet-choir/std to src/
```

## Run it

```sh
npm ci && npm run build
node bin/run.js workflow execute packages/epic-burndown.quiet-choir \
  --run-id burndown-<EPIC>-1 --wait-mode block --input @burndown.json
```

`burndown.json` holds `ticketInput` (an execute-epic-ticket input without `ticket` and `decision`)
and an optional `maxTickets` (default 25). The run's working directory is the repository the epic
belongs to, as for execute-epic-ticket.

## How it works

- Each run `n` is `ctx.workflow('run/<n>', executeEpicTicket, input)`. A new frame surveys the epic
  afresh, so it picks the ticket the previous run left next: in-flight work first, then a finished
  split, then the first ready ticket.
- The loop continues after `landed`, `closed-obsolete`, `closed-split` and `split`. It ends at
  `epic-done`, and stops at any other status (`stalled`, `blocked`, `needs-decision`, `held`,
  `stopped`, `pr-open`), recording it in `stoppedBy`. Handle the cause, then start a new run with a
  new run ID: everything already landed or closed is skipped by the survey.
- The follow-up epic a run found or created is passed to the next run.
- A child failure (an error, not a status) fails the burn-down run resumably:
  `workflow resume <run-id>` replays the completed children and continues the failed one.
- Every child uses the same `root`, one at a time, which is what execute-epic-ticket's single
  worktree requires.

## Result

`epic`, `status` (`epic-done`, `stopped` or `max-tickets`), `runs` (per run: the ticket, its status,
the PR, the merge commit, the headline and the blocked stage and reason), `stoppedBy`,
`followupEpic`, the last survey's `remaining` counts and a `headline`.

## Known limitations

- No rehearsal case yet: the package is validated and typechecked, and its child is rehearsed by
  execute-epic-ticket's cases.
- Tickets run one at a time; there is no parallelism across tickets (execute-epic-ticket's worktree
  serves one unfinished run at a time).
