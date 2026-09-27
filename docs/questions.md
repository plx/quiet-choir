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
checkpoint writes, and sleeps already in flight continue. Once there is no active effect or
registration, the runner checks stability across two macrotask turns, scans the inbox, and checks
again before suspending. Pure promise continuations drain first. A waiting mapper retains its
concurrency slot, so later items may not have started yet.

Suspension abandons the workflow continuation; it never rejects `ask`. `try/catch` cannot turn a
suspension into a fallback result, and map failure policies do not abort siblings. Body `finally`
and `using` cleanup do not run as part of suspension. Put owned work and necessary cleanup inside
durable effects. Await only context operations for asynchronous workflow work: a raw timer or
detached task is invisible and can cause early suspension. Late continuations cannot launch effects
after the run closes. `ctx.sleep` still keeps the process active; suspendable general waits are
separate work.

If the body resolves while questions remain open, they become `withdrawn`; drains do not hang on
abandoned questions. A body failure retains waiting questions and follows the ordinary failure path
after active work drains. Real cancellation still cancels the run (CLI exit 130); suspension does
not send a cancellation signal.

The CLI exits **75** with `kind: "workflow.run.suspended"`, `runId`, `stateDir`, `pending`,
`resumeCommand`, and the saved `run`. Pending entries include presentation, schema, fingerprint,
rejections, and an `answerCommand` argument vector. Exit 75 stops `&&` chains. The lock is released
after saving suspension and draining owned writes/children.

```sh
quiet-choir workflow pending --state-dir /absolute/runs --json
quiet-choir workflow answer RUN review/0 --state-dir /absolute/runs \
  --json '{"approved":true}' --by 'human:Pat'
quiet-choir workflow resume RUN --state-dir /absolute/runs --json
```

`answer --json VALUE` takes the answer JSON and also selects JSON output (`--value VALUE` is an
alias with human output). Invalid answers exit 2 (`answer.invalid`); an unknown, withdrawn,
completed, or already delivered question exits 3 (`answer.conflict`). Successful delivery exits 0.
`--resume` on `answer` combines delivery with resume and returns the resumed outcome. If resume
fails, the delivery remains queued; run `resume` after fixing the cause, without answering again.

`pending` and early answer validation read checkpoints without typechecking or importing workflow
code. `codeChanged` compares stored source bytes and is null for embedded records without source
paths. It is an early drift hint, not a compatibility guarantee. Check changed code before asking a
human to review stale context. `resume RUN` uses the stored absolute entrypoint, compiler
configuration, and run cwd; code still passes the usual load and compatibility gates. Use
`--accept-code-change` for an intentional compatible edit. Existing records without launch metadata
still use `execute FILE --resume --run-id RUN`. Harness configuration and admission overrides are
invocation choices, not saved authentication; provide the same fixture/native selection as needed.

A `--dry-run` rehearsal also stops at unanswered questions; it never fabricates human approval. Its
suspended document includes a `rehearsal` report and null `stateDir`, `resumeCommand`, and
`answerCommand` values because temporary state has been removed. Start a real run to request the
decision. Work beyond the question has not been rehearsed.

## Inbox protocol and trust

The inbox is `<stateDir>/<runId>/inbox/`. Filenames combine the first 100 characters of
`encodeURIComponent(stepId)`, `--`, and the full SHA-256 over canonical JSON of the exact ID string,
followed by `.answer.json`. Case variants remain distinct on case-insensitive filesystems, and the
bounded filename leaves room for quarantine suffixes. Owners also scan legacy deliveries after
migration. See [storage](storage.md) for layout, defaults, and migration.

An envelope is `{ value, by, at, questionFingerprint }`. The writer validates lossless JSON and the
stored schema, creates a private temporary file, flushes it, and links it exclusively to the final
path, then flushes the directory. Writers never acquire the run lock. Only one concurrent delivery
wins; the temporary name is removed afterward. Files use 0600 and new directories 0700. Envelopes
are capped at 1 MiB. These modes do not repair existing directory permissions.

Only the run owner ingests answers. It polls every 200 ms while questions are open, and scans again
at quiescence. It checks the envelope, fingerprint, attribution, and actual Zod schema, then saves
the answer and `question.resolution` before continuing the body. JSON Schema loses refinements, so
early validation cannot replace this authoritative check. Invalid deliveries move to
`.rejected.<uuid>.json`; the last 20 explanations appear in `question.rejections` and `pending`.
Submit a corrected answer after rejection. Accepted files remain beside the checkpoint for audit.

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
`listPending({ stateDir })` lists all waiting questions. Optional `RunOptions.launch` contains
absolute `entrypoint`, nullable absolute `tsconfig`, and optional absolute-path-to-SHA-256
`sources`. Without launch metadata a suspended embedded run has `resumeCommand: null`; resume
through the embedding application. The core never imports these paths. There is no daemon, blocking
answerer, question deadline/default, or authentication service.
