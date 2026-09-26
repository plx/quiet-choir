# Spike research

Research date: 2026-09-07. The reference installation was Claude Code `2.1.252`. The API details
below were checked against its bundled `workflow-authoring` reference and the official
documentation. They do not depend on an LLM's recollection of the API.

## What carries over from dynamic workflows

Claude's workflow script coordinates agents outside the main conversation. JavaScript holds the
branches, loops, and intermediate results. A saved script has literal `meta` metadata and structured
`args`. Its runtime provides progress reporting and saves agent results for replay. Scripts cannot
load modules or access Node APIs, and clock/randomness APIs are blocked to preserve replay. On
relaunch, completed results are reused in agent-start order until a failed agent or changed prompt
invalidates the remaining suffix. Saved results belong to the Claude session and are available after
resuming that session. See the [official workflow guide](https://code.claude.com/docs/en/workflows).

The installed authoring reference confirms these calls:

| Claude API                   | Behavior                                                                                                             | Prototype counterpart                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `agent(prompt, options)`     | Returns text or JSON Schema output; model, effort, phase, custom agent type, and worktree isolation are optional     | `ctx.claude.text/object` and `ctx.codex.text/object` have separate options and infer structured output from Zod |
| `pipeline(items, ...stages)` | Each item advances through its stages independently; callbacks receive the previous result, original item, and index | A `ctx.map` callback uses ordinary `await` for its stages, with explicit concurrency                            |
| `parallel(thunks)`           | Waits for all tasks; failed tasks become `null`                                                                      | Ordinary TypeScript composition; failures throw and can be handled explicitly                                   |
| `phase`, `log`               | Update the in-harness progress display                                                                               | Run and step records expose execution state; no equivalent phase UI yet                                         |
| `workflow(nameOrRef, args)`  | Runs a child workflow with shared limits; nesting is limited to one level                                            | Reusable TypeScript functions compose operations using distinct step IDs                                        |
| `budget`                     | Shares a token ceiling across a turn's workflows                                                                     | Claude has a per-call USD limit; there is no equivalent cross-harness token budget                              |

Claude's `agent`, `pipeline`, and `parallel` return `null` for certain failures. This prototype uses
exceptions, so failure cannot silently look like a missing finding. Its checkpoints use explicit
names rather than positions: a successful sibling can remain reusable when another sibling fails.
Workflow compatibility is guarded by an explicit version, matching step inputs, and, for CLI runs, a
fingerprint of the entrypoint and its reachable local source files.

## Headless integration findings

Claude supports `-p --output-format json`; text is in `result`, and `--json-schema` puts validated
data in `structured_output`. The envelope includes session and usage metadata. See
[programmatic usage](https://code.claude.com/docs/en/headless) and
[structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs).

A small real invocation used Haiku, low effort, no tools, and a $0.12 budget. It failed before
inference because the existing OAuth session had expired and could not refresh. Its reported cost
and token usage were zero. The observed response had **both** `subtype: "success"` and
`is_error: true`, with `terminal_reason: "api_error"` and exit status 1. The adapter must inspect
process status and the error field, rather than treating the subtype as sufficient evidence of
success. This attempt verifies the failure path, not a successful Claude completion.

The September 26 review (Claude 2.1.283, Codex 0.157.1) confirmed that real terminal errors normally
exit 1 with the reason on stdout, often with empty stderr. The adapter now classifies stdout even on
nonzero exit, unwraps Codex API errors, and throws an exported `HarnessError` carrying process
status, protocol diagnostics, session metadata, and reported usage. Failed-attempt usage is retained
in the checkpoint across resumes. A parsed error also fails on exit 0; an exit-1 success envelope
still fails and retains its usage. Deadline, cancellation, and output-limit kills may have no
terminal envelope and cannot recover unreported usage. Sanitized captures and refresh instructions
are in [CONTRIBUTING](../CONTRIBUTING.md#harness-protocol-captures).

Installed CLI help confirms that `--tools ''` disables built-in tools, `--strict-mcp-config`
excludes ambient MCP configuration, and `dontAsk` is available as a permission mode. It also states
that `--bare` never reads OAuth or keychain credentials, so bare mode would prevent the intended
subscription authentication. Native session IDs are diagnostic metadata here; workflow resume reuses
our checkpoints and starts a fresh harness session for an unfinished agent call.

## Durability boundary

The prototype recovers completed steps across local process restarts. It does not checkpoint a
JavaScript stack. The workflow function reruns from the beginning, so code outside durable
operations must be deterministic and free of side effects. Step dependencies and results must be
JSON values; local effects declare their inputs and validate results with a schema. Callers must
await every durable operation, including operations started concurrently.

A step can finish an external action and crash before its result reaches durable storage. Resuming
then repeats it. Use the provided idempotency key when the external system supports deduplication,
or make the effect safe to repeat. There are no automatic agent retries, distributed workers,
server, or background scheduler. A durable sleep remembers its wake time but still needs a running
process to wake. [ADR 0002](decisions/0002-durable-external-workflows.md) records these choices.

## Structured schema contract (2026-09-26)

The 15-shape matrix in `test/fixtures/codex-schema-matrix.json` was generated with Zod 4.5.4 and
checked against codex-cli 0.157.1 and Claude Code 2.1.283. Sanitized results and all Claude attempt
measurements are in `test/fixtures/schema-contract-results.json`; refresh commands are in
[CONTRIBUTING](../CONTRIBUTING.md#harness-protocol-captures).

Codex's invalid-effort probes made no inference calls: all ten rejected native shapes matched the
local checker (including nested/nullable optionals), and all fourteen supported compatibility
encodings passed schema validation. Tuples remain local errors in compatibility mode. Five native
positive controls (nullable/default/union/minimum length/wrapped array) also passed. Fake-process
and runtime tests verify decoding and original-Zod validation, including recursive references,
nullable optionals, duplicate record keys, and local refinements.

Claude returned valid structured results for eleven original shapes, including optionals, enum
records, loose objects, and tuples. Non-object roots (array, string, and root discriminated union)
were rejected before inference with `input_schema.type` errors; the adapter now checks only that
observed root restriction for Claude. String-keyed records were **inconclusive**: the CLI accepted
the request but exhausted three turns without a valid structured result, including a retry with
ordinary keys. That is not evidence of API schema rejection, so no Claude record lint is applied.
Three initial calls hit the $0.02 budget; selected retries used $0.05. All nineteen Claude attempts
reported about $0.29 total (see the exact sum in the results file). These live checks are opt-in;
normal tests use local fixtures and never call paid harnesses.
