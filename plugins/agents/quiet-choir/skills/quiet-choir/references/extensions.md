# Embedding and extensions

## Embed the runtime

The public entry point exports `defineWorkflow`, `z`, `runWorkflow`, `readRun`, `CliHarness`, and
their public types. `runWorkflow` validates the definition's data but does not typecheck/import a
file for you. It resolves with `WorkflowResult<T>`: a completed typed run or a suspended run with
`pending` and `output:null`; narrow `status` before reading output fields. It throws on failure.
Recorded execution failures with a successful final save throw `WorkflowRunError` with the saved
`run`, root `stepId`, and original rejection in `cause`. Callers matching `HarnessError`,
`FanOutError`, or their own error type should inspect that cause. Storage failures can leave an
older record. `RunRefusedError` exposes stable `run.*` codes, and `WorkflowInputError` retains
schema issues and the validator cause. Earlier loading/compatibility errors need not create or alter
a run.

Supply these execution options as needed:

- `runId`: required; reuse it only with `resume: true`.
- `input`: must match the schema; omit on resume to reuse saved input. New embedded runs receive
  undefined when omitted, whereas the CLI defaults to `{}`; both inherit source input for a fork.
- `forkFrom`: new-run source with optional `stateDir`, `reuse`, and `invalidate`; source input is
  inherited if omitted. Source checkpoints are read-only. Do not combine this with resume.
- `acceptCodeChange`: explicit source/schema acceptance on resume; `strictReplay` stops at early
  ordering divergence. See [durability](durability.md#choose-a-recovery-path).
- `resume`: set true to continue; otherwise an existing run gives `Run X already exists`.
- `cwd`: defaults to `process.cwd()` and must match the original run on resume.
- `stateDir`: resolves against `cwd`; precedence is explicit option, `QUIET_CHOIR_STATE_DIR`,
  existing legacy run, then the external XDG project root. Retain the absolute path for inspection.
- `store`: injectable `RunStore`, defaulting to `FileRunStore`. Its owned handle supplies read,
  append, compact, artifact directories, process registration, and release. Local effects can use an
  in-memory implementation. File stores expose their bound absolute `stateDir`; a separate option
  must match. Questions require the filesystem inbox protocol and refuse stores without it.
- `policy`, `policyReset`, `allowModelOverride`: sticky execution rules, reset, and explicit model
  override authorization; see [durability](durability.md).
- `harness`, `signal`, `fingerprint`, and `onEvent`: integration, cancellation, code compatibility,
  and observer dependencies. `source: { hash, files }` can replace the opaque `fingerprint` for
  detailed code diagnostics; do not supply both. Local-only workflows need no harness.

`writeAnswer({ stateDir, runId, stepId, value, by? })` delivers through the lock-free inbox;
`listPending({ stateDir })` reads waiting questions without importing code. Optional `launch`
metadata (absolute entrypoint/tsconfig and source hashes) enables CLI resume by ID; embedded runs
without it return `resumeCommand:null`. Resume those through the same embedding application.

`readRun({ runId, cwd, stateDir })` shares execution's path resolution and storage default;
`resolveStateDir({ cwd, stateDir })` returns the absolute directory.

The core validates explicit agent options before recording a step, using exported
`claudeOptionsSchema` and `codexOptionsSchema`. These schemas are also used by `CliHarness` and add
no defaults. Undefined object members are omitted recursively. Invalid remaining data names the
boundary, step and JSON path; invalid options name the field and value. Correcting an option before
its step was recorded permits an embedded resume when the other compatibility checks still match.
CLI source edits change the code fingerprint and require explicit acceptance or a new run/fork.

This complete embedding example uses a new temporary state directory each time, so it can run twice
without colliding with its previous run:

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertCompleted, defineWorkflow, runWorkflow, z, type Harness } from 'quiet-choir';

const workflow = defineWorkflow({
  name: 'adapter-example',
  version: '1',
  input: z.object({}),
  output: z.object({ label: z.string() }),
  async run(ctx) {
    const result = await ctx.codex.object('label', {
      prompt: 'Return a short label.',
      schema: z.object({ label: z.string() }),
    });
    return result.output;
  },
});

const fixtureHarness: Harness = {
  async invoke(_request, { signal }) {
    signal.throwIfAborted();
    return {
      text: JSON.stringify({ label: 'fixture' }),
      sessionId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
    };
  },
};

const run = await runWorkflow(workflow, {
  runId: 'adapter-example',
  stateDir: await mkdtemp(join(tmpdir(), 'qc-example-')),
  input: {},
  harness: fixtureHarness,
  fingerprint: 'adapter-example-v1',
});
assertCompleted(run);
console.log(run.output.label);
```

This fake harness performs no paid calls. Use `new CliHarness()` for real installed CLIs. Its
options are `claudeBinary`, `codexBinary`, `maxRetainedBytes` (default 8 MiB), `maxStreamBytes`
(default 1 GiB), legacy `maxOutputBytes` (retention alias), and `killGraceMs` (default 3000 ms
between SIGTERM and SIGKILL). Those adapter settings are not automatically added to the workflow
fingerprint; account for semantic changes in your version or caller-supplied fingerprint.

For CLI rehearsals, use `--harness fixture:./fixtures.json` or `--dry-run`; no embedding wrapper is
needed. The public `FixtureHarness` accepts the same ordered fixture rules. `CliHarness.plan()`
accepts `HarnessRequestInput` and returns pure argv/private-file data without spawning or writing.
Adapter kinds are persisted outside identity; switching them on resume/fork needs
`allowHarnessChange: true`. Use explicit distinct `kind` names for custom modes. See
[rehearsal](rehearsal.md) for the loop, synthesis limits, and repository-only fake native CLIs.

## Keep raw responses when local validation fails

This decorator logs a completed adapter response before core JSON/Zod validation. It forwards kind,
metadata, project instruction detection, policy defaults, cancellation, and process registration
unchanged. A logging failure is best effort: it cannot invalidate an already completed external
call. Use a private absolute log path outside the worktree; new files use mode 0600 (existing
permissions are not changed).

<!-- skills-check: example logging-harness -->

```ts
import { appendFile } from 'node:fs/promises';
import { CliHarness, type Harness } from 'quiet-choir';

export function loggingHarness(logFile: string, inner: Harness = new CliHarness()): Harness {
  const metadata = inner.metadata?.bind(inner);
  const projectInstructions = inner.projectInstructions?.bind(inner);
  const policyDefaults = inner.policyDefaults?.bind(inner);
  return {
    ...(inner.kind === undefined ? {} : { kind: inner.kind }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(projectInstructions === undefined ? {} : { projectInstructions }),
    ...(policyDefaults === undefined ? {} : { policyDefaults }),
    async invoke(request, invocation) {
      const response = await inner.invoke(request, invocation);
      try {
        await appendFile(
          logFile,
          JSON.stringify({
            harness: request.harness,
            call: request.call,
            text: response.text,
            sessionId: response.sessionId,
            usage: response.usage,
          }) + '\n',
          { mode: 0o600 },
        );
      } catch (error) {
        console.error('Could not append harness response log:', error);
      }
      return response;
    },
  };
}
```

Only returned responses are logged here. A thrown protocol/process failure instead exposes
`HarnessError` diagnostics; this wrapper is a separate response log. Runtime-owned raw transcripts
and lossy `onEvent` progress are described in [streaming](agent-streaming.md). Repeated attempts
append repeated records. The caller chooses retention and access permissions.

## Resume if present, otherwise start

Read and execute with the same absolute `cwd` and `stateDir`. Only ENOENT means a new run;
permission, corrupt-record, and other errors must propagate. The writer lock still guards the race
between this read and execution, so simultaneous starters can refuse safely rather than overwrite
one another.

<!-- skills-check: example resume-or-start -->

```ts
import { readRun, runWorkflow, type Harness, type WorkflowDefinition } from 'quiet-choir';

export async function resumeOrStart<TInput, TOutput>(
  workflow: WorkflowDefinition<TInput, TOutput>,
  options: {
    runId: string;
    cwd: string;
    stateDir: string;
    input: unknown;
    fingerprint: string;
    harness?: Harness;
  },
) {
  const { input, ...shared } = options;
  let exists = true;
  try {
    await readRun(shared);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') exists = false;
    else throw error;
  }
  return runWorkflow(workflow, {
    ...shared,
    resume: exists,
    ...(exists ? {} : { input }),
  });
}
```

The caller must update `fingerprint` for meaningful code/dependency changes. Local callback source
is part of step identity, but values captured by closures and external helpers are not fully
represented by a constant caller fingerprint. Supply step `input`/`version` for those dependencies;
do not assume a constant like `review-v3` detects all edits. The CLI computes source hashes for you.
This recipe deliberately omits input on resume so it reuses the saved input.

## Implement an integration

Before using a custom harness, verify this contract with fake responses/processes:

- Settle promptly when `invocation.signal` aborts; otherwise draining holds the run lock
  indefinitely.
- Enforce resolved `timeoutMs` and every supported harness limit yourself. Core profile resolution
  supplies defaults but does not supervise an arbitrary adapter's internal transport.
- Use absolute `request.cwd`, not unresolved `request.options.cwd`.
- Return `sessionId` as a value or null. Usage may be missing or partial; the runtime normalizes
  missing measurements to null and preserves JSON-compatible extra fields.
- Reject process and protocol failures, including reported failure with process exit 0.
- Perform one attempt only; retries belong to the core.
- Register children before sending task input, preserve OS birth identity, and release only after
  reaping, using the invocation port below.

Implement `Harness.invoke(request, invocation): Promise<HarnessResponse>`. The request carries a
`harness` name and semantic `revision`, its typed `options`, an absolute `cwd`, and `outputSchema`
(JSON Schema or null for text), and `call: {runId, stepId, attempt, idempotencyKey}`. The same run
ID, step ID, attempt and idempotency key are also direct request fields. The call identity is
attached after fingerprinting; attempts accumulate across resume, while `idempotencyKey` stays
`runId/stepId`. Honor cancellation, reject process/protocol failures, and return
`{ text, sessionId, usage?, diagnostics? }`. For structured calls, `text` must contain the
serialized JSON value; the runtime parses it, validates it, and checkpoints the result.

`HarnessInvocation` also optionally supplies resolved `policy`, requested `sessionId`,
`transcriptPath`, `onSession`, `onOutput`, and `onProgress`. Await `onSession(id)` at first sight
and `onOutput(stream, bytes)` for raw chunks; failures must stop the call as infrastructure errors.
Use `onOutput` for runtime-owned transcript caps/retention instead of writing directly to the path.
Send bounded lossy progress summaries, keep the full trace out of memory, and swallow observer
exceptions: after the first `init` event at most one progress event per 100 ms may reach
`onProgress`, and an exception it throws must not fail the call (`createInvocationStream` does
both). Metadata/version probes should not feed attempt transcripts. See
[streaming and evidence](agent-streaming.md).

The invocation supplies `signal`, `runId`, fully qualified `stepId`, `attempt`, and
`trackProcess({ pid, pgid, binary, cwd, startedAt, osStartTime })`. Register immediately after
spawn, await registration before sending task input, then await the returned `release()` after
confirming reaping. OS start time must identify process birth, not a current timestamp; use null if
unavailable. `pgid` equals the detached leader PID on POSIX and is null on Windows. Optional
`metadata(request, invocation)` receives the same port with the run's shared discovery signal, which
also aborts once no effect awaits the result. Optional `projectInstructions(request, invocation)`
gets the same signal once per distinct `request.cwd`, isolation mode and env edits per run
invocation (so possibly several times per `cwd`) and returns the instruction files that call loads
there (`{ sources, warnings? }`, paths and digests) or `undefined`; the run records them in
`projectInstructions`, one entry per harness and `cwd` that later detections in the invocation add
to, and a rejection only adds a warning. Registry failures abort as
`CheckpointError.operation: 'process'`; they cannot become retry or settled data. Embedders may pass
a `ProcessSupervisor` to `runWorkflow` and call its `forceKill()` from their own second-signal
handler. CLI signal handlers are not installed by the core. See [durability](durability.md).

The core resolves profile limits (text: five minutes, 10 Claude turns, $0.50) and tool/sandbox
defaults. Optional `Harness.policyDefaults(harness)` reports adapter-owned execution limits
(including binary/output cap/kill grace) without side effects. The core records reported limits,
overlays profiles, call-site fields and sticky rules, and sends the resolved limit values to
`invoke`. It does not invent adapter-specific defaults. Unknown adapter fields stay absent from
attempt policy; `requestedModel: null` means the native configuration chooses. Custom
implementations must enforce the supplied limits and settle on abort; otherwise draining can hang
while the run holds its lock. The core owns retries and removes `retry` and `onError` from the
adapter request.

The adapter owns one fresh invocation, not retries, run locks, or checkpoint storage. Native IDs
must be values or null. Missing usage/measurements become null without failing a valid response;
extra JSON fields remain in the result and attempt record. See
[usage and budgets](usage-budgets.md). Do not treat a process's zero exit status as sufficient if
its protocol reports failure. Throw the exported `ConfigurationError` for validation that fails
before launch (for example, a schema the provider cannot enforce): it rejects even under
`onError: 'return'` and is never retried, so a corrected call runs live on resume. Other thrown
errors are effect failures. Exercise adapters with fake executables and protocol fixtures before
making real calls.

`workflow execute` imports workflow and adapter code in a separate module instance, with its own
copy of `quiet-choir` and `quiet-choir/harness-kit`. The exported error classes (`HarnessError`,
`ConfigurationError`, `ExecError`, `CancelledError` and the rest) and `attachHarnessEvidence` still
work across that boundary: the runtime classifies them as it does embedded, and `instanceof` on them
is reliable in workflow code, including for errors the runtime throws, such as `ctx.exec`'s
`ExecError`.

Register a third harness with
`defineHarness({ name, revision, options, capabilities, createAdapter })` and
`defineWorkflow({ harnesses: [definition], ... })`. The strict Zod object schema owns its option
names, and its object-level refinements check each complete call after profile merging (profile
entries are checked field by field); `ctx.agent(name)` infers options and removes structured methods
when `structuredOutput: 'none'`. Claude/Codex shorthands remain available. A model-service option
may be called `provider`; the request's harness name identifies the adapter instead.

`HarnessAdapter.invoke(request, signal, invocation?)` performs one attempt. Runtime calls supply the
optional ownership context. Lookup is `RunOptions.adapters[name]`, then the legacy catch-all
`harness`, then `definition.createAdapter(harnessConfigurations[name] ?? {})`. Factories stay unused
on replay; a throwing factory fails the step as a `ConfigurationError`, never a settled outcome.
Fresh missing adapters, including those of declared children a resumed or forked run never reached
at that declaration path, and duplicate names fail before effects; recorded names and revisions must
still be declared. Increment revision when recorded options change meaning. New records have
`kind: 'agent'`, harness and revision; preceding built-in records normalize on read, and their
revision-one fingerprint hashes remain stable.

Package profiles use `profiles.<role>.harnesses.<name>`. Declare `capabilityKeys` and a pure
`access` classifier accepting partial profile options; without a classifier access defaults to exec.
Strict profiles own capability controls: `defineHarness` keeps a literal `capabilityKeys` list as a
tuple type, so a strict workflow's `ctx.agent(name)` options omit those keys and a raw call fails
typecheck (a widened `string[]` list, an omitted list or explicit `<N, O, C>` type arguments stay
permissive at type level; the runtime still rejects the keys). Child calls cannot exceed delegated
roles. `policy` lists option keys excluded from semantic identity; adapter defaults and operator
configuration are also outside identity. `sensitiveOptions` lists option keys (tokens, headers,
connection strings) that checkpoints, `workflow validate --json` and `check-resume --json` show only
as `redacted.harnesses.<name>.<key>` (`{ sha256, keys? }`, `keys` for objects); live calls, grant
pins and step identity keep the raw values. `defineHarness` rejects unknown and duplicate keys and
those that never reach a manifest: `prompt`, `model`, `env` and call options profiles cannot set.
Step records, prompts and argv are not redacted. Custom adapters must enforce the resolved policy
supplied in the invocation context. `maxTurns` and `maxBudgetUsd` reach a registered harness, in its
attempt policy record, `invocation.policy` and request options, only when its options schema
declares them; otherwise profile, override and delegated values for them are not applied or recorded
(and `--dry-run` does not warn about them). `timeoutMs` and the other limits are unaffected.

Import `runProcess`, `createFakeBinary`, and `assertHarnessConformance` from
`quiet-choir/harness-kit`. Pass `invocation.trackProcess` to the process runner so registration
precedes input. The conformance suite passes the adapter a recording `HarnessInvocation` in every
scenario and requires caller-supplied fakes for thirteen scenarios, in order: `text`, `structured`,
`missing-usage`, `protocol-error` (failure on exit zero), `nonzero-stdout`, `abort`,
`registration-before-input`, `session`, `transcript`, `timeout`, `rate-limit`, `env` and `progress`.
The fixture receives `(scenario, probe)`; the probe holds absolute paths of marker files the fake
writes, so the suite needs no knowledge of your protocol:

- `probe.started`: create it as soon as the fake starts. `registration-before-input` holds
  `trackProcess` open for 250 ms after it appears.
- `probe.input`: create it when stdin first yields data or reaches EOF. It must not appear during
  that hold, and `release()` must be called once, after the process group is reaped and before
  `invoke` settles.
- `probe.environment`: write `JSON.stringify(Object.keys(process.env))` in `env`.

`session` must return a nonempty `sessionId` and call `onSession` exactly once with it before
settling (no scenario may call it twice). `transcript` requires the fixture's `expectedStdout`, the
exact stdout the fake writes, which must equal the bytes passed to `onOutput('stdout', ...)`.
`timeout` sets a short limit (`timeoutMs`, default 250) on both `request.options.timeoutMs` and
`invocation.policy.timeoutMs`; the fake hangs like `abort`, and the call must reject with error kind
`timeout` without the signal being aborted. `rate-limit` fakes a native failure carrying HTTP status
429, which must reject with kind `rate-limit` (a `HarnessError` whose failure has `apiStatus` 429,
or kind `'rate-limit'`). `env` sets `CLAUDECODE`, `CLAUDE_CODE_BRIDGE_SESSION_ID`,
`CLAUDE_PLUGIN_DATA`, `CODEX_COMPANION_SESSION_ID` and `CODEX_COMPANION_TRANSCRIPT_PATH` in
`process.env`, none of which may reach the fake, and restores them afterwards; do not run the suite
concurrently with other environment-sensitive code in the same process. In `progress` the fake emits
a quick burst of native activity (at least two progress-producing events, no delay), then succeeds
with `options.text`; the suite's `onProgress` observer throws after recording each event, and the
call must still resolve. At least one event must be delivered, so the fake must emit activity the
adapter reports through `onProgress`. Every scenario also checks the throttle: apart from the first
`init` event, deliveries must come at least 80 ms apart (the 100 ms bound with 20 ms of slack). A
failure is an `AssertionError` whose message starts `Conformance scenario <name>:`. Never point the
suite at a paid agent installation. `ClaudeAdapter` and `CodexAdapter` pass it; `CliHarness` remains
their compatibility dispatcher and rejects unknown names.

The kit also exports the helpers the built-in adapters use, so a third adapter need not copy them:

- `childEnvironment(edits?, scrub?)` returns the child `env` with host agent-session variables
  scrubbed and explicit edits applied (see [harness isolation](harness-isolation.md)). Pass it to
  `runProcess` with `inheritEnv: false`; otherwise `runProcess` overlays the host environment.
- `new JsonLines(maxLineBytes, onLine, skipOversized?)` frames JSONL stdout and awaits `onLine` for
  each nonblank line. An oversized line fails with the output-limit error unless `skipOversized`
  accepts its first bytes as a nonessential line.
- `createInvocationStream({ invocation, stdout })` returns `stdout` and `stderr` consumers for
  `runProcess`'s `stream` option, which tee raw bytes to `onOutput` before your parser sees them,
  plus `session(id)`, which awaits `onSession` once for the first ID (call it before consuming more
  output), and `progress(event)`, which always delivers the first `init`, otherwise keeps at most
  one event per 100 ms and swallows observer errors.
- `standaloneInvocation(request, signal)` supplies identity, signal and a no-op `trackProcess` when
  `invoke` is called without an invocation.
- `outputLimitError(message)` reports an exceeded byte budget. The contract is the error's `code`:
  any `Error` whose `code` is `'QUIET_CHOIR_OUTPUT_LIMIT'` (`outputLimitCode`) is recorded with the
  `output-limit` kind, distinct from malformed protocol output. `runProcess` and `JsonLines` throw
  it for their own limits.
- `promptedStructuredOutput(schema)` implements `capabilities: { structuredOutput: 'prompted' }` for
  a CLI that cannot enforce a schema. Append its `instructions` to the prompt when
  `request.outputSchema` is not null, and return `extract(answer)` as `text`; it takes the whole
  answer, the last json fence, or the first balanced object or array that parses (trying the
  delimiter that matches the schema's top-level type first), and throws a `SyntaxError` (kind
  `schema`) when there is none. The runtime treats `'prompted'` exactly like `'native'`: it passes
  `outputSchema`, then parses and Zod-validates `response.text`, and never rewrites prompts.

Every value and type the kit, the root entry, `quiet-choir/decision` and `quiet-choir/github` export
is type-checked against the published declarations with `skipLibCheck: false`, so none resolves to
`any`.

CLI package config uses `--harness-config '{"harnesses":{"third":{"binary":"third-cli"}}}'` or
`@file` / `QUIET_CHOIR_HARNESS_CONFIG`. Override selected names with repeatable
`--harness third=fixture:FILE`; global fixture/dry-run modes remain available. Adapter code comes
from trusted workflow imports, never package-name discovery. `configuration doctor --workflow FILE`
lists registrations and calls optional zero-inference probes. A helper generic over an unresolved
registry can lose structured-client inference; prefer a concrete registry or a narrow context port.

## Reuse workflow logic

Use `ctx.workflow(id, childDefinition, input)` for a typed child with recorded name/version,
validated I/O, a scoped namespace and delegated profiles. Declare `children` for name dispatch and
for any child used inside a settled map. The root run owns its waits, budgets and concurrency; see
[child workflows and discovery](child-workflows.md).

Ordinary async functions taking `WorkflowContext` are the extension mechanism for multi-step
helpers. Call them at the workflow level inside `ctx.scope('review', () => helper(ctx))`, or pass
`ctx.within('review')` for a lexical context. Helpers use explicit leaves; nested scopes/named maps
supply prefixes. Do not use a shared completion-order counter for IDs. Use `ctx.id(...)` for path or
title segments and `ctx.step` for individual local effects. Do not wrap a multi-step helper in
another durable step, and do not run effects at module import time.

## Service helper pattern

Use ordinary helper functions for decisions, GitHub and Linear operations. Each operation should
make exactly one `ctx.step`, `ctx.exec` or `ctx.wait` at workflow level. Inside that step's callback
or wait's observer, run `gh` and other commands through `context.exec`, which the run owns and
rehearses but does not checkpoint, never through `child_process` (see
[commands inside a callback](commands-files.md#commands-inside-a-callback-or-observer)).
`StepDefinition.meta` can label `{ integration: 'decision', op: 'choose' }`, and `ExecOptions.meta`
labels a helper's `ctx.exec` the same way, without affecting replay identity. Explicit
inputs/version capture meaningful service-operation changes; pass the stable idempotency key to
services that support deduplication. Never put credentials in inputs or metadata.

`quiet-choir/decision` exports `decision(ctx, transport).choose(id, question)` as a reference with
an injected transport and a validated answer and normalized probability distribution. It is not a
JEV SDK adapter. It snapshots the question when `choose` is called and gives every attempt a fresh
copy of that recorded input, so later caller or transport mutations never reach the service. The
callback's `reportUsage(usage)` replaces cumulative usage for that attempt and saves it with its
outcome, including local validation failure. Reports after the callback returns reject. Inspect
separates `integrationUsage`/`byIntegration` from agent totals; helpers do not consume agent attempt
slots, while reported cost contributes to the next agent's cost gate. Replay makes no transport
call.

`quiet-choir/github` exports `github(ctx, { repo })` with typed reads (`repo.info`, `pr.view`,
`pr.list`, `pr.reviewThreads`, `issue.view`, `codeScanning.alerts`). Each read is one
`ctx.exec.json` over `gh api` argv with your ID, labelled `{ integration: 'github', op }`;
authentication stays in `gh`. A truncated connection throws `IncompleteCollectionError` and is never
checkpointed, and code scanning that is not set up returns `status: 'unavailable'`. A completed read
replays forever under its ID, so observe new state with a fresh ID keyed by round or head SHA. See
[GitHub snapshots](patterns.md#github-snapshots-through-gh) and [GitHub reads](github.md).

Its waits `gh.waitChecks(id, { pr, sha, timeoutMs })`, `gh.waitPr(id, { pr, sha, until })` and
`gh.waitReview(id, { pr, sha, since, reviewers })` are one `ctx.poll` each, so one `wait` record
however many checks, and are head-pinned: `success`, `clean` and `merged` are reported only for
`sha`, any other head ends with `head-moved` (after an optional `staleGraceMs` for an ancestor
view), and a closed pull request with `closed`. They tolerate a bounded run of transient gh errors
and return `timeout` at the deadline; `waitChecks`' `requiredChecks` names checks that must register
before a successful rollup counts. Reviewers are `ReviewerBot` adapters (`name`, `login`, `reads`, a
pure `observe(activity, context)` returning `pending`, `running`, `clean`, `findings` or `error`,
with a note kept in the wait's checkpoint); `codexReviewer()` keeps Codex's two-check debounce and
`codeqlReviewer({ settleMs })` counts alerts that land after the CodeQL check. Take `since` from
`ctx.now` after pushing `sha`. See [GitHub waits](github.md#waits).

Its writes are one version-identified `ctx.step` each (`github.comment/1` and so on), so pass the
full workflow context (`github(ctx, ...)` needs `exec`, `poll` and `step`).
`gh.comment(id, { number, body })`, `gh.thread.reply(id, { threadId, body, resolve? })` and
`gh.issue.create(id, { title, body, labels?, parent? })` append the marker
`<!-- quiet-choir:RUN/STEP -->` and search for it before writing, so a retry or resume after a crash
finds the earlier write; a reply resolves bot threads by default and human threads only with
`resolve: true`, and a `parent` is read before the issue is created (a missing one throws), a new
issue is linked at once, and a found issue's parent is looked up (another parent throws).
`issue.create` searches only the viewer's issues, so keep one `gh` account across a retry or resume.
`gh.issue.close(id, { number, comment?, reason? })`, `gh.issue.reopen(id, { number, comment? })` and
`gh.alert.dismiss(id, { number, comment, reason? })` read the state and act only when it still needs
to change, returning `acted: false` or `dismissed: false` otherwise; GitHub has no `If-Match`, so a
concurrent change between the read and the write is not detected. Bodies go to gh on stdin. Pass
`{ retry: { maxAttempts: 3 } }` as the third argument; the writes are safe to repeat. A fork
re-posts writes its source left unfinished, and a rehearsed `issue.reopen` skips. See
[GitHub writes](github.md#writes).

Pull request writes use only `gh api`. `gh.pr.create(id, { head, base, title, body, draft? })`
returns the pull request carrying its marker in any state and base, else an open one for the
same-repository `head` and `base`, and opens one only when there is neither.
`gh.pr.edit(id, { number, expectHead, title?, body?, base? })` patches only differing fields of an
open pull request still at `expectHead`, otherwise returning `reason: 'closed'` or `'head-moved'`.
`gh.pr.merge(id, { number, sha, method? })` sends `PUT .../pulls/N/merge` with `sha` (never
`gh pr merge`, auto-merge or a queue): already merged at `sha` returns the merge commit with
`acted: false` and no second `PUT`, merged elsewhere throws, and `closed`, `head-moved` (also
GitHub's 409) or `not-mergeable` (GitHub's 405) come back as `{ merged: false, reason }`. Check the
base, threads and alerts yourself first. `gh.checks.rerunFailed(id, { sha, attempt, attempts? })`
reruns failed runs at or below the run attempt you saw failing and skips runs past it, so pass the
round number. Pass `attempts` (run ID to the attempt you saw that run fail) when runs failed at
different attempts: a mapped run is rerun only at exactly its attempt, so none is rerun twice. A
rehearsed edit or merge reports `head-moved`. See [merging](github.md#merging).

Its epic read `gh.epic.snapshot(id, { number })` is one `ctx.exec.json` (one `gh api graphql`) that
returns the epic's sub-issues with state, labels, linked pull requests, blocked-by relations,
"Depends on #N" lines and the viewer's `<!-- epic:split a,b -->` markers, in the epic body's
checklist order; an epic without sub-issues falls back to its `- [ ] #N` checklist (fenced and
inline code ignored). Any truncated connection, or fewer sub-issues than GitHub counts, throws
`IncompleteCollectionError`. The pure `nextTicket(snapshot, { order?, holdLabels?, outside? })`
picks the first `in-flight` item (an open linked pull request), else a `close-split` parent, else
the first `ready` one, and lists every other open item in `skipped` with its reason (`waiting`,
`held`, `split`, `other-repository`, `not-a-sub-issue`, or a later `ready`); `done` is true only
when nothing is open. Pass `headRefPrefix` (for example `'epic-172/'`) to `epic.snapshot` to also
link open same-repository, non-fork pull requests on a branch named `<prefix><N>` or
`<prefix><N>-...` to item N (off by default; the read throws above 100 open pull requests). A
dependency outside the epic counts as open until you read it: pass the `gh.issue.view` results for
`outsideReferences(snapshot)` as `outside`. Key the snapshot by round (`ctx.id('epic', n, round)`)
to see fresh state. See [epics](github.md#epics).
