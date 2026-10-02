# 0041: Static durability lint at load time

- Status: accepted
- Issue: #154

## Context

`workflow validate` type-checked, imported and described a definition but never looked at the
workflow body. Replay hazards therefore passed validation: branching on `existsSync`, `Date.now()`
in step input, `Promise.race` over durable calls, durable calls nested in step callbacks, reused or
looped literal IDs, a dropped effect promise and the deprecated positional `ctx.map`. Some of these
fail at run time, but only when the second occurrence or the nested call executes, after earlier
effects already ran. The others (nondeterministic reads, races, an unawaited effect that succeeds)
never fail at all; they change control flow or step identity on resume. The Traps table in the
skill's `references/patterns.md` described them, but nothing enforced it.

## Decision

Add a static lint, `src/workflow/typecheck/durability-lint.ts`, that the loader runs after a type
check with no errors and before import.

- **Shape.** `lintDurability(program)` is a pure function of the `ts.Program` the type check already
  built (no second program, no I/O, clock or process access; an ESLint block enforces it). It
  returns plain-data findings `{rule, file, line, column, message}` sorted by file, line, column and
  rule. `TypeScriptExecutor` runs it only when constructed with `durabilityLint: true` and returns
  the findings as `TypecheckResult.durability`. The workflow executor turns it on;
  `workflow typecheck`, `configuration doctor` and the embedding API keep it off. `TypecheckPlan` is
  unchanged, because it is digested into registry cache keys and persisted in launch records.
- **Scope.** Every non-declaration source file of the program outside `node_modules` and outside
  quiet-choir's own tree. That tree is the `src/` or `dist/` root above the file declaring
  `interface WorkflowContext` (`workflow/runtime/model.ts` or `.d.ts`), so repository fixtures and
  examples that import `../src/index.js` never lint the runtime, while their local helpers are
  linted.
- **Resolution by type.** A call is a quiet-choir call when its resolved signature is declared as a
  member of `WorkflowContext`, `AgentClient`, `RegisteredAgentClient` or `ExecFunction` in a
  `workflow/runtime/*.ts` or `.d.ts` file, so both `src` and an installed `dist` work.
  `StepExecFunction` (a callback's `context.exec`) is never durable. Effects are `step`, `sleep`,
  `sleepUntil`, `now`, `wait`, `poll`, `ask`, `approve`, `readFile`, `writeFile`, `workflow`,
  `merge`, `worktree`, `map`, an exec call, `exec.json` and client `value`, `text` and `object`. A
  workflow function is any function with a parameter of type `WorkflowContext`, a subtype (an
  interface or class extending it) or an intersection with it, whatever it is called. Its nested
  functions belong to its body except callback zones: functions whose owning property, from the
  contextual type of the enclosing object literal, is declared on `StepDefinition.run`,
  `PollSource.observe`, `CommandPollSource.done` or `PollErrorPolicy.classify`/`retryAfterMs`.
  Nondeterministic APIs are resolved by their lib or `@types/node` declarations, never by text.
- **Rules.**
  - QC001: an effect, `ctx.scope` or `ctx.phase(title, body)` promise that is `void`ed or left as an
    expression statement, also through `.then`/`.catch`/`.finally`. The message says what the
    runtime does (it drains the operation and fails the run if it rejects) and asks for `await`.
  - QC002: in a workflow body outside callback zones, `Date.now()`, argument-less `new Date()` or
    `Date()`, `Math.random()`, `performance.now()`, `crypto.randomUUID` (global or `node:crypto`),
    `process.env`, or an `fs` `*Sync` call.
  - QC003: a durable call lexically inside a callback zone.
  - QC004: `Promise.race` or `Promise.any` (the global `PromiseConstructor`) whose argument contains
    a durable call or an identifier initialized from one.
  - QC005: a literal ID (string or no-substitution template) as the first argument of an effect on a
    root receiver (the `WorkflowContext` parameter, or `.claude`, `.codex`, `.agent(x)`, `.exec`,
    `.exec.json` on it; never through `.within(...)`), either inside a loop of its ID namespace
    (`for`, `for-in`, `for-of`, `while`, `do`, an array iteration or `sort`/`toSorted` callback,
    `Array.from` with a mapper, a positional `ctx.map` mapper) or reused in that namespace. The
    workflow function, a `ctx.scope` callback, a named-map mapper and a child workflow each start a
    namespace. Different branches of one `if`/`else`, `?:` or `switch` (when the earlier clause ends
    in `break`, `continue`, `return` or `throw`), and an `if` branch ending in `return` or `throw`
    versus code after that `if`, are exclusive and not reuse. Every occurrence after the first is
    reported.
  - QC006: a call resolving to a `@deprecated` `WorkflowContext.map` overload, detected through the
    JSDoc tag, so the rule disappears when #158 removes the positional overloads.
- **Suppression.** A line consisting of `// quiet-choir-ignore QCnnn[, QCnnn] <reason>` directly
  before a finding's line silences the listed rules for findings that start on that line. It is
  matched with a linear regular expression. The engine accepts a missing reason; the repository's
  corpus gate requires one.
- **Severity per command.** `workflow validate` fails on any finding with `load.typecheck` (exit 4)
  before import. `ValidateWorkflowPlan.durabilityLint: 'warn'` downgrades that; `list-defs` and
  execution by name use it, so their definitions stay listed and runnable, and the registry drops
  `diagnostics` from cached results so fresh and cached entries are identical. Every other loading
  plan (execute, resume, `answer --resume`, the runner behind `start`, tick, check-resume) logs each
  finding at `warn` as `path:line:col - warning QCnnn: message` and continues. One pure formatter
  serves the executor log and the CLI.
- **JSON shape.** Lint findings share the failure's existing `diagnostics` array as
  `{rule, category, file, line, column, message}`, told apart from compiler entries by `rule` versus
  `code` and `filePath`. They never mix, because the lint runs only after a clean type check. A
  sibling array was rejected: every consumer would have to check two places. A successful validate
  result carries `diagnostics: []`.
- **Corpus gate.** `npm run durability:check` (`scripts/check-durability-lint.mjs`) builds one
  program per tsconfig, with the same `configuredProgram` construction and lint as validate, over
  `examples/`, `examples/patterns/` and both Workflow Lab batches' ported workflows. It fails on any
  finding, type error or reasonless suppression, and runs in `npm run check` and the CI static job
  after the build. Batch 01's positional maps keep their legacy IDs behind reasoned QC006
  suppressions, because the named form would change the IDs and journals its verification records.

## Consequences

Replay hazards are reported with a rule code and `file:line` before anything runs, and validate is a
usable gate for agents writing workflows. Execution is never blocked by the lint, so an in-flight
run whose source has a finding still resumes. A workflow that validated before can now fail
`validate` with exit 4; it needs a fix or a reasoned suppression.

The analysis is lexical and per function. It does not track helpers across calls (a hazard in a
function called from a step callback is judged where it is written, and a step `run` defined as a
separate variable is not a callback zone), does not check literal `ctx.scope` or `ctx.within`
prefixes inside loops or IDs on a `ctx.within(...)` context, and does not cover `fs/promises` or
`child_process` reads. Runtime guards (duplicate IDs, nested effects, tracked-operation draining)
remain the backstop. Unused suppressions are not reported.
