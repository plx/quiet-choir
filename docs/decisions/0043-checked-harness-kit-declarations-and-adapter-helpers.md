# 0043: Checked harness-kit declarations and shared adapter helpers

- Status: accepted
- Issue: #157 (first slice; conformance changes and per-harness policy fields moved to #169)
- Amends: [0023](0023-restricted-harness-configuration.md) (the host-session scrub list)

## Context

`tsconfig.build.json` sets `stripInternal`, and `src/harness-kit.ts` re-exported 16 helpers whose
declarations were tagged `@internal`. The published `harness-kit.d.ts` therefore named members that
did not exist: a consumer got TS2305 with `skipLibCheck: false` and a silent `any` with it. The root
entry had the same fault, which `decision.d.ts` pulls in: `store.d.ts` re-exported the internal
`lockRun`, and the public `ClaudeAdapter`/`CodexAdapter` extended an internal `BuiltinAdapter`.
Nothing compiled a consumer against the declarations, so none of this was caught.

A third adapter also had to copy what the built-ins keep internal: JSONL framing with a byte bound,
host-session environment scrubbing (`runProcess` inherits `process.env` by default), the
`onSession`-once, `onOutput` tee and throttled `onProgress` contracts, a standalone invocation for
`invoke(request, signal)` without one, and the undocumented `QUIET_CHOIR_OUTPUT_LIMIT` code that the
runtime maps to the `output-limit` kind. `structuredOutput: 'prompted'` was accepted by the schemas
but had no defined meaning. The exact-name scrub list also missed host variables seen in practice,
such as `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_PLUGIN_DATA` and `CODEX_COMPANION_SESSION_ID`.

## Decision

**Every public re-export survives `stripInternal`.** The 16 helpers (and `HarnessEvidence`, which
`attachHarnessEvidence` takes) lose `@internal` and become documented public API; none is dropped,
because built-in adapters import them from the harness kit (see [architecture](../architecture.md)).
`lockRun` stays internal in its own tagged re-export statement, which `stripInternal` removes whole.
`BuiltinAdapter` is exported as a type only, the shared base of the two public adapters.

**A test compiles a consumer of the published declarations.** `test/public-types.test.ts` emits
declarations with `tsconfig.build.json` into a temporary package (vitest runs before the build), and
compiles a consumer that resolves `quiet-choir`, `quiet-choir/harness-kit` and
`quiet-choir/decision` through the `exports` map. The consumer references every runtime export of
the three entry points with a `NotAny` check, under `--strict --skipLibCheck false`, which also
checks every declaration file and so covers type-only re-exports. Any diagnostic fails the test. A
negative case strips a synthetic re-export and expects TS2305, so the check cannot pass vacuously.

**The kit exports the adapter helpers the built-ins use.**

- `JsonLines`: byte-bounded JSONL framing with awaited line callbacks; an oversized line throws the
  output-limit error unless `skipOversized` accepts its prefix.
- `childEnvironment(edits?, scrub?, parent?)`: the scrubbed, edited child environment and a
  names-only summary, for `runProcess` with `inheritEnv: false`.
- `createInvocationStream({ invocation, stdout })`: `stdout`/`stderr` consumers for `runProcess`
  that tee to `onOutput` before the downstream parser, `session(id)` that awaits `onSession` once
  and counts it reported only after it resolves, and `progress(event)` that always delivers the
  first `init`, otherwise throttles to one event per 100 ms, and swallows observer errors.
  `HarnessStream` delegates to it, so built-ins and third adapters share one implementation. It
  takes no harness name: the plumbing is protocol-neutral.
- `standaloneInvocation(request, signal)`: identity, signal and a no-op `trackProcess`, for direct
  `invoke` calls. `HarnessAdapter.invoke` keeps its optional invocation.
- `outputLimitError(message)` and `outputLimitCode`: the output-limit contract is a plain `Error`
  whose `code` is `'QUIET_CHOIR_OUTPUT_LIMIT'`, not a class, because `errorKind` already reads
  `code` across module instances. `runProcess`, `JsonLines` and `errorKind` share the one constant.
- `promptedStructuredOutput(schema)`: a prompt suffix embedding the JSON Schema, and an extractor
  that takes the whole answer, else the last json or untagged fence that parses, else the first
  balanced object or array value that parses (trying every bracket as a start, the delimiter that
  matches the schema's top-level type first), and returns it re-serialized. No JSON throws a
  `SyntaxError`, which classifies as `schema` like the runtime's own parse.

**`'prompted'` changes nothing in the runtime.** The runner handles `'prompted'` exactly like
`'native'`: it passes `outputSchema`, JSON-parses `response.text` and validates it with the step's
Zod schema. It never rewrites prompts, because prompt option names belong to each harness. The value
tells discovery and authors that the adapter, not the CLI, enforces the schema, normally with
`promptedStructuredOutput`.

**The scrub matches patterns.** It removes `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`,
`TRACEPARENT`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_TURN_ID`, and every `CLAUDE_PLUGIN_*`,
`CODEX_INTERNAL_*`, `CODEX_COMPANION_*` and `CLAUDE_CODE_*` name except `CLAUDE_CODE_USE_*`,
`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_CODE_SUBAGENT_MODEL`.
Authentication and config-home names stay. `scrubEnv` still adds exact names, `false` still disables
scrubbing, explicit `env.set` still applies afterward, and `summary.scrubbed` lists every removed
name. `ctx.exec` keeps inheriting the full environment.

## Consequences

- Adapter authors get real types for every kit export, and a future `@internal` on a re-exported
  declaration fails the suite instead of shipping `any`.
- The newly public helpers are API: changing their signatures or semantics is a public change.
- More host variables are removed from built-in children and doctor probes, including behavior
  settings such as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, consistent with restricted-by-default. A caller
  that relied on one restores it with `env.set`, or disables scrubbing with `scrubEnv: false`.
- Moved to #169: conformance passing a recording `HarnessInvocation` (registration before input,
  session, transcript, timeout, rate-limit and environment scenarios) with negative adapter tests,
  and recording only the policy fields a custom harness declares.
