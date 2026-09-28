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
metadata, policy defaults, cancellation, and process registration unchanged. A logging failure is
best effort: it cannot invalidate an already completed external call. Use a private absolute log
path outside the worktree; new files use mode 0600 (existing permissions are not changed).

<!-- skills-check: example logging-harness -->

```ts
import { appendFile } from 'node:fs/promises';
import { CliHarness, type Harness } from 'quiet-choir';

export function loggingHarness(logFile: string, inner: Harness = new CliHarness()): Harness {
  const metadata = inner.metadata?.bind(inner);
  const policyDefaults = inner.policyDefaults?.bind(inner);
  return {
    ...(inner.kind === undefined ? {} : { kind: inner.kind }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(policyDefaults === undefined ? {} : { policyDefaults }),
    async invoke(request, invocation) {
      const response = await inner.invoke(request, invocation);
      try {
        await appendFile(
          logFile,
          JSON.stringify({
            provider: request.provider,
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
- Enforce resolved `timeoutMs` and every supported provider limit yourself. Core profile resolution
  supplies defaults but does not supervise an arbitrary adapter's internal transport.
- Use absolute `request.cwd`, not unresolved `request.options.cwd`.
- Return `sessionId` and every usage field as values or `null`, never undefined.
- Reject process and protocol failures, including reported failure with process exit 0.
- Perform one attempt only; retries belong to the core.
- Register children before sending task input, preserve OS birth identity, and release only after
  reaping, using the invocation port below.

Implement `Harness.invoke(request, invocation): Promise<HarnessResponse>`. The request carries a
`provider` discriminator (`claude` or `codex`), its typed `options`, an absolute `cwd`, and
`outputSchema` (JSON Schema or null for text), and `call: {runId, stepId, attempt, idempotencyKey}`.
The call identity is attached after fingerprinting; attempts accumulate across resume, while
`idempotencyKey` stays `runId/stepId`. Honor cancellation, reject process/protocol failures, and
return `{ text, sessionId, usage, diagnostics? }`. For structured calls, `text` must contain the
serialized JSON value; the runtime parses it, validates it, and checkpoints the result.

`HarnessInvocation` also optionally supplies resolved `policy`, requested `sessionId`,
`transcriptPath`, `onSession`, `onOutput`, and `onProgress`. Await `onSession(id)` at first sight
and `onOutput(stream, bytes)` for raw chunks; failures must stop the call as infrastructure errors.
Use `onOutput` for runtime-owned transcript caps/retention instead of writing directly to the path.
Send bounded lossy progress summaries, tolerate observer failures, and keep the full trace out of
memory. Metadata/version probes should not feed attempt transcripts. See
[streaming and evidence](agent-streaming.md).

The invocation supplies `signal`, `runId`, fully qualified `stepId`, `attempt`, and
`trackProcess({ pid, pgid, binary, cwd, startedAt, osStartTime })`. Register immediately after
spawn, await registration before sending task input, then await the returned `release()` after
confirming reaping. OS start time must identify process birth, not a current timestamp; use null if
unavailable. `pgid` equals the detached leader PID on POSIX and is null on Windows. Optional
`metadata(request, invocation)` receives the same port with the run's shared discovery signal, which
also aborts once no effect awaits the result. Registry failures abort as
`CheckpointError.operation: 'process'`; they cannot become retry or settled data. Embedders may pass
a `ProcessSupervisor` to `runWorkflow` and call its `forceKill()` from their own second-signal
handler. CLI signal handlers are not installed by the core. See [durability](durability.md).

The core resolves profile limits (text: five minutes, 10 Claude turns, $0.50) and tool/sandbox
defaults. Optional `Harness.policyDefaults(provider)` reports adapter-owned execution limits
(including binary/output cap/kill grace) without side effects. The core records reported limits,
overlays profiles, call-site fields and sticky rules, and sends the resolved limit values to
`invoke`. It does not invent adapter-specific defaults. Unknown adapter fields stay absent from
attempt policy; `requestedModel: null` means the native configuration chooses. Custom
implementations must enforce the supplied limits and settle on abort; otherwise draining can hang
while the run holds its lock. The core owns retries and removes `retry` and `onError` from the
adapter request.

The adapter owns one fresh invocation, not retries, run locks, or checkpoint storage. Missing usage
measurements and native IDs must be `null`, never `undefined`. An omitted usage field fails the step
after the call returns. Do not treat a process's zero exit status as sufficient if its protocol
reports failure. Throw the exported `ConfigurationError` for validation that fails before launch
(for example, a schema the provider cannot enforce): it rejects even under `onError: 'return'` and
is never retried, so a corrected call runs live on resume. Other thrown errors are effect failures.
Exercise adapters with fake executables and protocol fixtures before making real calls.

The provider union and `ctx.claude`/`ctx.codex` clients are currently fixed. A custom `Harness` can
replace their transport/integration; adding `ctx.someOtherProvider` requires an explicit core API
change. There is no runtime registry for arbitrary providers or middleware; storage is injected
through `RunOptions.store`.

## Reuse workflow logic

Ordinary async functions taking `WorkflowContext` are the extension mechanism for multi-step
helpers. Call them at the workflow level inside `ctx.scope('review', () => helper(ctx))`, or pass
`ctx.within('review')` for a lexical context. Helpers use explicit leaves; nested scopes/named maps
supply prefixes. Do not use a shared completion-order counter for IDs. Use `ctx.id(...)` for path or
title segments and `ctx.step` for individual local effects. Do not wrap a multi-step helper in
another durable step, and do not run effects at module import time.
