# Durable questions and approvals

`ctx.ask(id, { prompt, schema, ... })` is a named effect answered outside the process.
`ctx.approve(id, options)` fixes the answer schema to `{ approved: boolean, comment?: string }`.
Both compose with ordinary loops, scopes, and named maps. Each answer is untrusted workflow data.

```ts
const decision = await ctx.approve(`approve/${revision}`, {
  prompt: 'Apply this plan?',
  title: 'Plan review',
  details: renderedPlan,
  subject: { revision, plan },
  audience: 'human',
});
if (decision.approved) await applyPlan(ctx, plan);
```

Keep plan creation, approval, and application in the same run. A resumed workflow reuses the saved
plan and answer. Changing input to start a separate “apply” run can create a different plan. See the
runnable [human-review recipe](../examples/patterns/human-review.workflow.ts), and the Workflow
Lab's bootstrap and SDLC acceptance ports.

## Question identity

The fingerprint covers kind, prompt, details, choices (including order, labels and descriptions),
audience, subject, title, and draft-7 JSON Schema. A question cannot change under the same ID, even
while unanswered. Code acceptance never bypasses this check. Put a revision in the ID and subject
when a later decision concerns different content. Answered questions revalidate and return saved
data; a new fork asks fresh questions rather than importing another run's approvals.

`prompt` is one line, at most 1024 characters. `title` is at most 12 characters. `details` is at
most 16 KiB of UTF-8. Up to four choices may suggest schema-valid values; labels are at most 100
characters and descriptions 1024. Choices are suggestions: the schema decides whether other answers
are valid. `audience` defaults to `any` and also accepts `human` or `agent`. Optional `subject` is
lossless JSON. `schema` must support the same JSON Schema conversion as ordinary durable steps;
transforms that cannot be exported are rejected.

## Suspend and resume

An unanswered question saves an `ask` step with status `waiting`. Agent calls, local steps,
checkpoint writes, and active observations already in flight continue. Once there is no active
effect or registration, the runner checks stability across two macrotask turns, scans the inbox, and
checks again before suspending. Pure promise continuations drain first. A waiting mapper retains its
concurrency slot, so later items may not have started yet.

Suspension abandons the workflow continuation; it never rejects `ask`. `try/catch` cannot turn a
suspension into a fallback result, and map failure policies do not abort siblings. Body `finally`
and `using` cleanup do not run as part of suspension. Put owned work and necessary cleanup inside
durable effects. Await only context operations for asynchronous workflow work: a raw timer or
detached task is invisible and can cause early suspension. Late continuations cannot launch effects
after the run closes. `ctx.sleep` now shares the wait coordinator: long sleeps park, while waits due
within 1000 ms stay live. See [durable waits](waits.md).

If the body resolves while questions remain open, they become `withdrawn`; drains do not hang on
abandoned questions. A body failure retains waiting questions and follows the ordinary failure path
after active work drains. Real cancellation still cancels the run (CLI exit 130); suspension does
not send a cancellation signal.

The CLI exits **75** with `kind: "workflow.run.suspended"`, `runId`, `stateDir`, `pending`,
`resumeCommand`, and a compact `summary` of the saved run (the whole `run` with `--full`). Pending
entries include presentation, schema, fingerprint, rejections, and an `answerCommand` argument
vector. For a human question, that vector ends with `--by human:<NAME>`: ask the human, then replace
`<NAME>` with the name they give. `answer` and inbox ingestion refuse the unreplaced placeholder
(`answer_author`), and non-human questions carry no `--by`. Both argument vectors start with the
launcher that produced them: `node` plus the checkout's absolute `bin/run.js` in no-install mode, or
`quiet-choir` when it is installed on PATH, so they run unchanged from any directory (see
[next commands](cli-contract.md#next-commands)). Embedded `runWorkflow` and `listPending` callers
may pass `commandLauncher`; without it the vectors start with `quiet-choir`. Exit 75 stops `&&`
chains. The lock is released after saving suspension and draining owned writes/children.

```sh
quiet-choir workflow pending --state-dir /absolute/runs --json
quiet-choir workflow answer RUN review/0 --state-dir /absolute/runs \
  --json '{"approved":true}' --by 'human:Pat'
quiet-choir workflow resume RUN --state-dir /absolute/runs --json
```

`answer --json VALUE` takes the answer JSON and also selects JSON output (`--value VALUE` is an
alias with human output). Invalid answers exit 2 (`answer.invalid`) with `error.details.issues`, a
list of `{code, path, message}` (`path` is `["approved"]` for a non-boolean `approved`; synthetic
codes `answer_not_json`, `question_schema_invalid`, `answer_author` and `answer_too_large` have path
`[]`), so a caller can re-ask for the right field; the library `AnswerError` carries the same
`issues`. An unknown, withdrawn, completed, or already delivered question exits 3
(`answer.conflict`), as does a delivery whose run `workflow rm` removed meanwhile; that delivery is
withdrawn while its path still holds an envelope addressed to the removed run
([storage](storage.md#removing-runs)). Successful delivery exits 0. `--resume` on `answer` combines
delivery with resume and returns the resumed outcome. If resume fails, the delivery remains queued;
run `resume` after fixing the cause, without answering again.

`pending` lists only rows still awaiting an answer: a row whose answer is already queued, and rows
of failed, cancelled or completed runs, are hidden (counted in `hidden`); `pending --all` lists
them. Each row carries `runStatus`, `delivery` (`{state: "none" | "queued", at, by}`, null for a
poll or deadline wait) and `next`, a resume command for a queued row of a suspended or failed run.
The library `listPending` stays unfiltered. `pending` and early answer validation read checkpoints
without typechecking or importing workflow code. `codeChanged` compares stored source bytes and is
null for embedded records without source paths. It is an early drift hint, not a compatibility
guarantee. Check changed code before asking a human to review stale context. `resume RUN` uses the
stored absolute entrypoint, compiler configuration, and run cwd; code still passes the usual load
and compatibility gates. Use `--accept-code-change` for an intentional compatible edit; it refuses
without changes, leaving the question waiting, when the edit changed a completed step. Existing
records without launch metadata still use `execute FILE --resume --run-id RUN`. Harness
configuration and admission overrides are invocation choices, not saved authentication; provide the
same fixture/native selection as needed.

A `--dry-run` rehearsal also stops at unanswered questions; it never fabricates human approval. Its
suspended document includes a `rehearsal` report and null `stateDir`, `resumeCommand`, and
`answerCommand` values because temporary state has been removed. Start a real run to request the
decision. Work beyond the question has not been rehearsed.

## Inbox protocol and trust

The inbox is `<stateDir>/<runId>/inbox/`. Filenames combine the first 100 characters of
`encodeURIComponent(stepId)`, `--`, and the full SHA-256 over canonical JSON of the exact ID string,
followed by `.answer.json`. Case variants remain distinct on case-insensitive filesystems, and the
bounded filename leaves room for quarantine suffixes. Runs migrated from the flat layout keep
delivering to `<stateDir>/<runId>.inbox/` under the format-6 filename: `encodeURIComponent(stepId)`
when it is at most 180 characters, otherwise `~sha256-` and the same digest, followed by
`.answer.json`. Every writer of such a run, before or after an upgrade, links to one final path, so
the first link wins; as before the upgrade, that name does not separate case variants on
case-insensitive filesystems. Owners also scan the other name and inbox for older deliveries. See
[storage](storage.md) for layout, defaults, and migration.

An envelope is `{ value, by, at, questionFingerprint, runCreatedAt }`. `runCreatedAt` is the
`createdAt` of the run the writer addressed; the owner rejects a delivery whose `runCreatedAt`
differs from its own, so an answer meant for a removed run never resolves a later run that reuses
the ID. Envelopes from older writers omit it and are still accepted. The writer validates lossless
JSON and the stored schema, creates a private temporary file, flushes it, and links it exclusively
to the final path, then flushes the directory. Writers never acquire the run lock. Only one
concurrent delivery wins; the temporary name is removed afterward. Files use 0600 and new
directories 0700. Envelopes are capped at 1 MiB. These modes do not repair existing directory
permissions.

Only the run owner ingests answers. It polls every 200 ms while questions are open, and scans again
at quiescence. It checks the envelope, fingerprint, run generation, attribution, and actual Zod
schema, then saves the answer and `question.resolution` before continuing the body. JSON Schema
loses refinements, so early validation cannot replace this authoritative check. Invalid deliveries
move to `.rejected.<uuid>.json`; the last 20 explanations appear in `question.rejections` and
`pending`. Submit a corrected answer after rejection. Accepted files remain beside the checkpoint
for audit.

`by` is self-asserted. A human question requires `human:<name>` as a guardrail; it is not proof that
a human answered. Filesystem access is the trust boundary. Calling agents must ask the human and
carry back their answer, never invent a human attribution. Delivery can race with withdrawal: a
success means queued delivery, while authoritative acceptance belongs to the owner. The ledger is
still at least once; no inbox write makes later filesystem or external mutations transactional.

## Embedding

`runWorkflow` returns `WorkflowResult<T>`, either `WorkflowRun<T>` with `status: 'completed'` and
typed `output`, or `SuspendedRun` with `status: 'suspended'`, `output: null`, and `pending`. Narrow
on `status` before reading output fields. `assertCompleted(result)` is a convenience for callers
whose workflow cannot suspend. Failures still throw `WorkflowRunError` when saved.

`writeAnswer({ stateDir, runId, stepId, value, by? })` delivers an answer;
`listPending({ stateDir })` lists all waiting questions and general waits. Optional
`RunOptions.launch` contains absolute `entrypoint`, nullable absolute `tsconfig`, and optional
absolute-path-to-SHA-256 `sources`, and a `policy` that is kept when omitted, replaced by a
`LaunchPolicy` and cleared by `null` ([launch policy](cli-contract.md#launch-policy)). Without
launch metadata a suspended embedded run has `resumeCommand: null`; resume through the embedding
application. The core never imports these paths. There is no daemon, blocking answerer or
authentication service. For a signal with a deadline, use `ctx.wait`; see [waits](waits.md).
