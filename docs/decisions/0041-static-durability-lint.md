# 0041: Static durability lint at load time

- Status: accepted; amended by #339 (QC006 retired), #326 (identifier-bound zones and same-file
  helpers) and #327 (literal prefixes and within receivers)
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
  interface or class extending it), an intersection with it or a type parameter constrained to one
  of those, whatever it is called. Its nested functions belong to its body except callback zones:
  functions whose owning property, from the contextual type of the enclosing object literal, is
  declared on `StepDefinition.run`, `PollSource.observe`, `CommandPollSource.done` (or the matching
  members of `PollCallOptions`, the inferred `ctx.poll` overload's options, reported under those
  names) or `PollErrorPolicy.classify`/`retryAfterMs`. Nondeterministic APIs are resolved by their
  lib or `@types/node` declarations, never by text.
- **Rules.**
  - QC001: an effect, `ctx.scope` or `ctx.phase(title, body)` promise that is `void`ed or left as an
    expression statement, also through `.then`/`.catch`/`.finally`. The message says what the
    runtime does (it drains the operation and fails the run if it rejects) and asks for `await`.
  - QC002: in a workflow body outside callback zones, `Date.now()`, argument-less `new Date()` or
    `Date()`, `Math.random()`, `performance.now()`, `crypto.randomUUID` (global or `node:crypto`),
    `process.env`, or an `fs` `*Sync` call.
  - QC003: a durable call lexically inside a callback zone, and since #326 one in a same-file
    function a zone reaches by name (see the amendment below).
  - QC004: `Promise.race` or `Promise.any` (the global `PromiseConstructor`) whose argument contains
    a durable call or an identifier initialized from one.
  - QC005: a literal ID (string or no-substitution template) as the first argument of an effect on a
    resolved receiver (the `WorkflowContext` parameter, and since #327 a `const` view from
    `ctx.within(...)` or an inline `.within(...)` call; or `.claude`, `.codex`, `.agent(x)`,
    `.exec`, `.exec.json` on one), either inside a loop of its ID namespace (`for`, `for-in`,
    `for-of`, `while`, `do`, an array iteration or `sort`/`toSorted` callback, `Array.from` with a
    mapper, and until #339 a positional `ctx.map` mapper) or reused in that namespace. Since #327 a
    literal `ctx.scope` or `ctx.within` prefix created inside a loop is also reported, at the
    prefix, when a literal-ID effect runs under it (see the amendment below). The workflow function,
    a named-map mapper, a non-literal prefix and a child workflow each start a namespace; literal
    `ctx.scope` and `ctx.within` prefixes extend it to a path. Different branches of one
    `if`/`else`, `?:` or `switch` (when the earlier clause ends in `break`, `continue`, `return` or
    `throw`), and an `if` branch ending in `return` or `throw` versus code after that `if`, are
    exclusive and not reuse. Every occurrence after the first is reported.
  - QC006: a call resolving to a `@deprecated` `WorkflowContext.map` overload, detected through the
    JSDoc tag, so the rule disappears when #158 removes the positional overloads. Retired by #339;
    see the amendment below.
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
  after the build. Batch 01 needed reasoned QC006 suppressions for its positional maps until #339
  moved them to named maps with item-relative scopes, which keep its verified IDs.

## Consequences

Replay hazards are reported with a rule code and `file:line` before anything runs, and validate is a
usable gate for agents writing workflows. Execution is never blocked by the lint, so an in-flight
run whose source has a finding still resumes. A workflow that validated before can now fail
`validate` with exit 4; it needs a fix or a reasoned suppression.

The analysis is lexical and per function, with the same-file zone resolution of the
[#326 amendment](#amendment-identifier-bound-zones-and-same-file-helpers-326): it does not track
helpers across modules, and a nondeterministic read in a helper is still judged where the helper is
written. Since the [#327 amendment](#amendment-literal-prefixes-and-within-receivers-327) it checks
IDs on `const` within views and literal prefixes in loops, but not views passed to helpers or stored
in `let`, `var` or destructuring, and it does not cover `fs/promises` or `child_process` reads.
Runtime guards (duplicate IDs, nested effects, tracked-operation draining) remain the backstop.
Unused suppressions are not reported.

## Amendment: QC006 retired (#339)

#339 removed the positional `ctx.map` overloads, so no `@deprecated` map member is left for QC006 to
find. The rule is gone from `DURABILITY_RULES` and the lint, with its fixture and the lint's
positional-mapper loop branch; a positional call is now a type error and a runtime validation error.
The code QC006 is reserved and never reused, so an old suppression comment or report cannot be
mistaken for a new rule. Suppression parsing still accepts any `QCnnn`. Batch 01's parallel and
pipeline helpers use named maps whose mappers scope IDs relative to the item prefix, so their full
step IDs and verification records are unchanged and the corpus needs no suppressions. The lint
reports QC001-QC005.

## Amendment: identifier-bound zones and same-file helpers (#326)

A zone used to come only from a function literal written as the zone property. A callback defined as
a variable was judged in the workflow body (a QC002 false positive for
`const run = () => Date.now()` passed as `{ run }`), and a durable call in a helper called from a
callback was missed. The lint now resolves zones within one file, in two narrow ways, and keeps
today's behaviour for anything it cannot resolve. Neither can add a QC002 finding.

- **Identifier-bound zones.** A zone property (the same contextual-type test as for literals) whose
  value is an identifier, as `{ run }` or `run: name`, also through parentheses, `as`, `satisfies`
  and `!`, is a binding when the identifier names a same-file function: a function declaration with
  a body, or a `const` whose initializer is an arrow function or function expression. Imports,
  declarations in another file, `let`, `var`, parameters, destructuring, property accesses, call
  results and conditionals resolve to nothing. A bound function is exclusive when every other
  same-file reference to it is a binding or a direct recursive call in the function's own body, not
  in a nested function; it then gets the zone at its definition, so QC002 is skipped there. Any
  other reference (a call, an array, `typeof`, an assignment or argument inside its own body, a call
  inside a nested closure, an export specifier or `export default`; a named function expression's
  own name counts as a reference too) makes it shared: it keeps its body findings at the definition,
  so a real QC002 still reports, and it is also walked in the zone from its first binding, so a
  nested durable call reports QC003. An exported function whose only same-file references are
  bindings counts as exclusive; the lint does not guess at uses in other modules. If bindings give
  different zones, the first in source order names the zone.
- **Following helpers.** A direct call from a zone whose callee is a bare identifier naming a
  same-file function, resolved the same way, walks that function's body in the zone, so a durable
  call in it reports QC003, also through a chain of helpers. The body, not the function node, is
  walked, so a helper with a `WorkflowContext` parameter keeps the zone. Each function is walked
  once per file, which stops recursion and reports each nested call once. A helper keeps its own
  definition walk, so a QC002 in a helper that is only ever called from callbacks is still reported
  where it is written.
- **Messages.** A QC003 reached this way keeps its wording and names the entry point after the zone,
  as in `inside a StepDefinition.run callback (reached through record() from line 21)` or
  `(bound as run at line 12)`. A direct lexical finding is unchanged. The suppression comment goes
  on the line of the durable call inside the helper. A zone walk revisits nodes the definition walk
  also sees; duplicate findings at one position and rule are collapsed, keeping the first report.

Limits: same file only; direct identifier calls only, not method calls, imported functions or
callbacks passed as arguments (`items.map(helper)`); generator and async generator helpers, whose
call only creates an iterator; `const` and function declarations only; QC002 is still judged at a
helper's definition; an untyped options object stored in a variable (`const options = { run }`) is
still not a zone; and inside a followed helper, a nested function with a `WorkflowContext` parameter
starts a workflow body as before, ending the zone.

## Amendment: literal prefixes and within receivers (#327)

QC005 used to check only the root context: each workflow function, `ctx.scope` callback and
named-map mapper had an anonymous namespace, so a reused ID on a `ctx.within('a')` view and a
literal `ctx.within('x')` or `ctx.scope('x')` prefix inside a loop passed the lint and failed at run
time with `Duplicate step ID`. The lint now names namespaces the way the runtime names effects.

- **Namespace keys.** A namespace is a literal prefix path (`''`, `'a/'`, `'a/b/'`) in a tree.
  `ctx.scope('a', ...)` and `ctx.within('a')` compose the same path, as the runtime's name scopes
  do, so they share keys: sibling `ctx.scope('s', ...)` blocks, or a scope and a within with the
  same literal prefix, are one namespace, while `a/x` and `b/x`, or `a/c/x` and `a/x`, are not. The
  workflow function, a named-map item callback and any prefix that is not a string literal or
  no-substitution template start a fresh tree, which is unknown and never compared with anything
  outside it. A per-item prefix such as `ctx.within(ctx.id('item', item))` is therefore silent.
- **Receivers.** An effect's receiver resolves to a namespace when it is a root context parameter,
  an inline `X.within('a')` call on a resolved receiver, or a `const` initialized directly from a
  `within` call in the same visit of the same workflow function. A bound view follows the runtime's
  `NameScopes.bound`: its own calls use the path it was created with, except inside a scope or
  named-map callback launched through that view or a view derived from it, where they use the
  ambient (callback) path, as the descendant prefixes of `panel.map('people', ...)` do. Root
  receivers always use the ambient path. A `phase(title, body)` body also runs under its receiver's
  frame, so root calls in `a.phase(...)` use `a/`; an unresolved phase or scope receiver starts a
  fresh tree.
- **Loops.** Loop depth grows lexically: loop bodies, standard-library iteration callbacks and
  named-map item callbacks each add one. An effect is in a loop of its namespace when it is deeper
  than the depth its space was entered at. A `const` view created before a loop and used inside it,
  or a fixed-path view used in a root named-map callback, therefore reports the effect. A literal
  prefix created deeper than its receiver's space is a loop origin, inherited by literal
  descendants.
- **Report only when a literal ID runs under it.** A loop-origin prefix is reported once, at the
  scope or within call, when at least one literal-ID effect is recorded under it, with the message
  `Literal prefix 'x' in ctx.within(...) is inside a loop, so every iteration reuses the literal IDs under it (such as 'step' at line N)`.
  The ticket proposed flagging every literal prefix in a loop, but
  `for (item) ctx.scope('x', () => ctx.step(ctx.id(item), ...))` cannot collide, and this ADR keeps
  the lint silent on shapes it cannot prove hazardous. One finding on the prefix, rather than one
  per inner effect, keeps one suppression line and points at the fix. The in-loop message now reads
  "inside a loop of its ID namespace", since the receiver need not be the root context.

Limits: views are tracked only through `const` declarations initialized directly from a `within`
call, registered at their first visit outside a callback zone; `let`, `var`, destructuring,
parameters, reassignment, views passed to a helper and views used inside a nested function with its
own `WorkflowContext` parameter stay unknown and silent. A non-literal prefix is never compared with
its siblings, even when it is loop-invariant. The early-return exclusivity of #330 can now hide a
duplicate between two sibling literal scopes when the first callback returns early; that is a false
negative only.
