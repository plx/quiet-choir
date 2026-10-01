# Child workflows and discovery

`ctx.workflow(id, definition, input, options?)` runs a typed child inside the current run. The child
validates input before effects and output before returning. Its effects share the root's agent
concurrency, cost/attempt budgets, cancellation, storage and working directory. It creates no extra
agent session merely by entering a frame. See the runnable
[reusable review recipe](../examples/patterns/reusable-helper.workflow.ts).

Declare `children: [reviewWorkflow]` on the parent to enable
`ctx.workflow('review', 'review-workflow-name', input)`. Name dispatch checks only that parent's
declarations and returns JSON; direct definition calls preserve inferred output types. It does not
search the filesystem registry. Plain function helpers remain useful with `ctx.scope` or
`ctx.within`; a typed workflow adds validated I/O, a recorded version, profile delegation and a
visible frame. Do not wrap a child or a multi-effect helper in `ctx.step`.

## Identity and replay

Each frame in `run.children` records its local label, child name/version, parent, depth,
input/schema digests, timestamps and status. Every context operation runs under the child's
namespace, including questions, waits, files, commands and worktrees. Long child paths compact
deterministically to a SHA-256 namespace; recorded parent links preserve the readable tree. Ordinary
scopes and historical effect IDs retain their existing spellings.

Resume reruns child bodies, reusing their named effects. A child is not a separately cached output
or a JavaScript continuation. Its name, version, validated input and I/O schemas must still match;
source acceptance does not waive these checks. Completed runs with frames also revisit the body so
embedded callers cannot silently change a direct child's version. Removing a completed empty frame
is detected even if it contained no effects.

Inside a settled map, every invoked child must appear in its immediate parent's `children`
declaration. A committed mapper is not invoked again: its saved child ownership is reclaimed, and
the declared tree permits version/schema checks before replay skips it. Dynamic undeclared children
remain supported outside settled maps; their own declaration trees are validated, like the root's,
before their frames start. As with the root, library callers must supply an appropriate code
fingerprint or bump versions for semantic body/dependency changes; the CLI hashes local source.

A child failure is catchable, and its frame remains failed even if the parent completes. When a
resumed body no longer invokes a frame that is still running, parked, failed or cancelled, a
successful completion marks it `superseded` (terminal; `finishedAt` is the supersession time and the
earlier `error` is kept). A skipped frame that holds a completed or settled-failed step, or a
completed frame, still fails the run as a control-flow change. A frame that the completing body
invoked but never awaited is `cancelled` instead. If a fixed child's frame failed, keep its name,
version, input and schemas and resume with `--accept-code-change`; changing them is refused.
Completed leaf effects survive. An ordinary caught child failure is retried by replaying its body;
use settled effects/maps when the fallback decision itself must be durable. Infrastructure and
unobserved operation failures retain the runtime's existing fatal rules. A child question can
suspend the whole run at quiescence, then resume under the same frame after an answer arrives.

`RunOptions.maxChildDepth` defaults to 8, with root depth zero. `--max-child-depth N` on execute or
resume sets the sticky guard; zero prohibits child entry. Recursion is allowed and counts toward the
guard. The refusal shows the workflow chain, and a raised cap resumes existing effects. It is
policy, outside identity; `execute --policy-reset` restores the default before explicit overrides.

## Profiles and observation

Child roles map to parent roles of the same name by default. `options.profiles` maps a child's role
to a differently named parent role. Declared/default child requirements are checked before child
effects. Tools, permissions, sandbox and native escape controls cannot exceed the delegated role;
opaque controls require matching configuration. Missing or insufficient roles fail explicitly.
Optional built-ins that the parent cannot delegate disappear from the child's available roles, so a
grandchild cannot recover them. Raw call-site capabilities are checked too, even with
`strictProfiles: false`.

Child models/effort inherit the mapped parent's values when omitted. Parent profile limit overrides
pass through role mappings, and child call limits are bounded by the delegated parent limits. Child
profile definitions remain the source of its requested tools; mapping never promotes it to
additional parent tools. A delegated role that fails on permission denials stays failing: a child
role that omits `onPermissionDenied` inherits `fail`, and an explicit child profile or Claude call
`warn` is refused. Workflow JavaScript remains trusted operator code, not a security sandbox.

Events carry `frame`; `child.started`, `child.completed` and `child.failed` follow frame saves, and
`child.superseded` follows `run.completed` for each frame the completed run retired. Phase/log
observations retain their frame, and imperative phase updates stay local to each child.
`inspect --json` includes the raw `children` ledger. Text inspection and compact JSON show the tree
with status, step counts, reported usage, unknown costs and phases. Frame totals include
descendants, so do not add every row together. Child records use individual journal changes rather
than rewriting the entire child collection. Storage remains format 7 with replay contract 6.

## Describe, discover and execute

Definitions accept optional `description`, `whenToUse`, `phases: [{ title, detail? }]` and
`children`. These descriptions stay outside runtime identity, although CLI source hashing still
notices edits. Use required Zod fields for required input, and `.describe()` for field guidance.
Missing required input fails before a new run record or agent call; returning `{error: ...}` is an
ordinary successful output and should not replace input validation.

`workflow validate FILE --json` includes input/output JSON Schemas, descriptions, phases, profiles,
capabilities and a declared child tree, without each harness's option JSON Schema (pass
`--harness-schemas` to include them; `list-defs --json` follows the same rule). Recursive
declarations end in `recursive: true` reference nodes. Inline children have `entrypoint: null` when
no source entrypoint is known.

```sh
quiet-choir workflow list-defs ./examples/patterns --json
quiet-choir workflow execute reusable-helper --registry-dir ./examples/patterns \
  --input '{"paths":["src/index.ts"]}' --max-child-depth 8
```

`execute`'s argument is a file unless it looks like a bare name (no `/` or `\`, no `.ts`/`.tsx`/
`.mts`/`.cts` extension, and no matching filesystem entry); pass `--registry-dir` to always resolve
it as a registered name instead, including one that contains `/` or otherwise matches a local path.
An unrecognized name fails with `Unknown workflow name`.

`list-defs [DIR…]` defaults to the current directory, recursively discovers `*.workflow.ts`, and
rejects duplicate names. It skips generated/state/dependency directories and does not follow
directory symlinks. These are trusted imports; module top-level code must have no workflow effects.
The private metadata cache under `$XDG_CACHE_HOME/quiet-choir/definitions` (default
`~/.cache/quiet-choir/definitions`) checks source/dependency/config fingerprints and existing
package manifests/locks. `--refresh` forces revalidation and imports. Descriptions should be static;
use refresh if external configuration affects module exports. Cache failure falls back to
validation. Execution always loads the selected module anew and verifies its registered name.

Separate-run `ctx.child`, linked-run IDs and a `run` wait source remain later work tracked by
[#57](https://github.com/plx/quiet-choir/issues/57) and
[#18](https://github.com/plx/quiet-choir/issues/18). They are not implemented by inline composition.
No scheduler or distributed worker is introduced.
