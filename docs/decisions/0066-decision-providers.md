# 0066: Model decision services as providers of one shared protocol

- Status: proposed
- Issue: #20
- Builds on: [0027](0027-typed-harness-registry-and-integration-helpers.md) (one durable step per
  helper operation, lazy adapters, explicit configuration),
  [0025](0025-attempt-usage-and-run-budgets.md) (usage) and
  [0063](0063-bound-agents-and-typed-rosters.md) (roster entries)

## Context

Issue #20 asked for first-class support for TypeSafe AI's Jev, a model that answers typed questions
about a state instead of generating text. Since then the request shape has become a protocol with
several implementations. Jev's API takes a `state` and a map of named questions, each `noul`
(yes/no), `choice` (one of up to 255 options) or `score` (an ordered scale of 2 to 10 levels), and
returns one answer per question: a `noul` probability; a `choice` with per-option `probabilities`
and a derived `confidence`; or a `score` that may fall between levels, with per-level
`probabilities`, a `legend` and `confidence`; plus the serving `model` and token `usage`. Secondary
sources report several hosted and open models accepting the same request format, with small input
differences such as unsupported question kinds or option limits.

The current `quiet-choir/decision` subpath is a reference helper: `choice` only, a caller-supplied
transport, no configuration, no inspection labels beyond `meta`. ADR 0027 states it is not an
implementation of #20. ADR 0027 also decided that non-agent integrations are helpers that make
exactly one durable step per operation, rather than new context properties or effect kinds, and that
configuration is explicit.

Decisions belong in workflow control flow: routing before an agent runs, grading an artifact after
one, deciding whether a loop continues. They need typed answers, durable replay, configured
credentials, usage accounting and inspection, without a hand-written HTTP client per workflow.

## Decision

### 1. Model the protocol, not a vendor

`quiet-choir/decision` defines the question and answer types with the wire protocol's names:

```ts
const answers = await ctx.decide('triage', {
  state: ticket, // JSON; captured as replay input
  questions: {
    team: choice({
      instructions: 'Which team owns this?',
      options: { billing: null, infra: null },
    }),
    urgency: score({ instructions: 'How urgent?', levels: ['none', 'this week', 'today', 'now'] }),
    refund: noul({ instructions: 'Does the customer ask for a refund?' }),
  },
});
answers.team.choice; // 'billing' | 'infra'
answers.team.probabilities; // Record<'billing' | 'infra', number>, sums to one
answers.urgency.score; // number, may fall between levels
answers.refund.noul; // probability in [0, 1]
```

Option names infer the `choice` answer type; `score` answers carry `legend` and `probabilities`
keyed by level index; `noul` answers have no `confidence`, as in the protocol. Thresholds,
aggregation and fallbacks stay in TypeScript. A low-confidence answer is a result, not a failure.

### 2. Providers

```ts
const jev = jevCompatible({ name: 'jev', defaultModel: 'jev-latest' });
export default defineWorkflow({ ..., decisions: [jev], ... });
```

- `defineDecisionProvider({ name, revision, capabilities, transport })` declares a provider the way
  `defineHarness` declares a harness: a stable name, a semantic revision, declared `capabilities`
  (`kinds`, `maxOptions`, `levels: [min, max]`, `idempotencyKey`), and a transport that performs one
  request and returns the raw response. `jevCompatible(...)` is the built-in factory for any host
  that speaks the protocol: base URL, path (default `/v1/systemone`), an environment variable name
  for the bearer token, a default model, and capability overrides for hosts that lack a kind or cap
  options lower.
- Configuration is explicit, as in ADR 0027: `--harness-config` (or `RunOptions`) carries
  `decisions.<name>` with `baseUrl`, `apiKeyEnv` and `defaultModel`. The token is read from the
  named environment variable at request time and never enters source, records or logs. Factories are
  lazy: replay constructs no transport.
- `ctx.decide(id, { provider?, model?, state, questions, onError?, retry?, timeoutMs? })` selects
  the single declared provider when `provider` is omitted and requires it otherwise. A roster entry
  may be a decider, `{ decider: 'jev', model: 'jev-latest' }`, so
  `ctx.roster.Triage.decide(id, { state, questions })` is the bound form (ADR 0063).

### 3. One durable step per call

`ctx.decide` is implemented over the step path and records an ordinary step. Its identity is the
versioned constant `decision/2` plus its input: provider name and revision, the requested model, the
state and the questions. The result is the validated answers and the reported `model`. Replay
returns the saved answers and never re-requests. Usage is reported through `reportUsage` with the
provider and model as the usage identity; cost is unknown unless pricing configuration exists (#17).
The `meta` label is `{ integration: 'decision', op: 'decide', provider, model }`.

The requested model, which may be an alias such as `jev-latest`, is identity; the served model is a
recorded fact. That matches how harness model aliases are treated.

Runtime `retry` and `timeoutMs` apply as for any step. When the provider declares `idempotencyKey`,
the transport sends the step's idempotency key as a request header. HTTP 429 and 5xx responses
classify as `transient` like harness overload. Cancellation aborts the request through the step's
signal.

### 4. Validation before and after the request

Before any network: every question kind must be in the provider's `kinds`, `choice` options within
`maxOptions`, `score` levels within `levels`; a violation is a `ConfigurationError` naming the
question. After: the response is parsed with Zod; `choice` must be one of the options, each
probability map must sum to one within `1e-6`, and a `score` legend must match the levels. A
response that fails validation fails the attempt with the raw body retained as evidence.

### 5. Rehearsal and inspection

Fixtures gain a `decisions` section keyed by step ID with canned answers, validated like live ones,
so `rehearse` and fixture-driven tests run without credentials. `inspect` shows the provider, model,
each question's kind and headline answer, confidence where present, and usage. A conformance suite
runs `jevCompatible` against a fake loopback server for success, invalid answers, 429, 5xx, timeout
and cancellation, as the harness suite does for CLIs.

### 6. The reference helper

The transport-injected `decision(ctx, transport).choose(...)` helper is deprecated. Records with
identity `decision/1` stay replayable.

## Alternatives

- **Wrap the vendor SDK.** Rejected as the abstraction: it binds the design to one provider, and the
  request is a single JSON POST. A provider may still use an SDK inside its transport.
- **Keep the status quo helper and let each workflow inject a transport.** Rejected: every workflow
  rebuilds configuration and loses inspection and fixtures.
- **Model deciders as harnesses.** Rejected: harness options are prompt-shaped and produce agent
  records; a decision has no prompt, session, tools or working directory.
- **A new effect kind with its own record.** Rejected per ADR 0027: one ordinary step carries
  everything a decision needs.

## Consequences

- `ctx.decide` and `WorkflowDefinition.decisions` are additive core API; the Workflow Lab
  `apiSnapshot` hash is bumped. The provider declaration, question constructors, answer types and
  `jevCompatible` live under `quiet-choir/decision`.
- A multi-question call is one step, so a batch cannot be partially replayed; split calls when
  questions should settle independently.
- Compatibility claims about third-party hosts are not verified here. The conformance suite verifies
  this implementation against the protocol; a host's conformance is its own.
- Documentation: `docs/decision-providers.md` for the API and configuration, an opt-in live smoke
  test gated on credentials, and an example that routes before an agent runs and grades after one.
