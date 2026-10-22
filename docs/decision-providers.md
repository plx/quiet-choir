# Decision providers

A decision provider answers typed questions about a JSON state instead of generating text
([ADR 0066](decisions/0066-decision-providers.md)). Use one where a workflow branches: route a
ticket before an agent runs, grade an agent's output after it, decide whether a loop continues.
`ctx.decide` makes one durable step per call. Replay returns the saved answers and never sends the
request again.

The authoring surface lives under `quiet-choir/decision`: the question constructors, provider
declarations, `jevCompatible`, `DecisionError` and the answer types. `ctx.decide` and
`WorkflowDefinition.decisions` are core API.

## The API

```ts
import { defineWorkflow, z } from 'quiet-choir';
import { choice, jevCompatible, noul, score } from 'quiet-choir/decision';

const jev = jevCompatible({
  name: 'jev',
  apiKeyEnv: 'TYPESAFE_API_KEY',
  defaultModel: 'jev-latest',
});

export default defineWorkflow({
  name: 'triage',
  version: '1',
  input: z.object({ ticket: z.string() }),
  output: z.enum(['billing', 'infra', 'human']),
  decisions: [jev],
  async run(ctx, input) {
    const answers = await ctx.decide('triage', {
      state: input, // JSON, captured as replay input
      questions: {
        team: choice({
          instructions: 'Which team owns this?',
          options: { billing: null, infra: null },
        }),
        urgency: score({
          instructions: 'How urgent?',
          levels: ['none', 'this week', 'today', 'now'],
        }),
        refund: noul({ instructions: 'Does the customer ask for a refund?' }),
      },
    });
    if (answers.team.confidence < 0.6 || answers.refund.noul > 0.5) return 'human';
    return answers.team.choice; // 'billing' | 'infra'
  },
});
```

- **`noul({ instructions, criteria? })`** asks a yes/no question. Its answer is `{ noul }`, the
  probability of yes in `[0, 1]`. `criteria` (`{ true, false }`) can describe what each answer
  means.
- **`choice({ instructions, options })`** picks one of up to 255 named options. Each option maps to
  a description, or to `null` when its name says enough. The answer is
  `{ choice, probabilities, confidence }`. The option names give the type of `choice` and the keys
  of `probabilities`, and the probabilities sum to one.
- **`score({ instructions, levels })`** places the state on an ordered scale of 2 to 10 levels,
  lowest first. The answer is `{ score, probabilities, legend, confidence }`. `score` is the
  probability-weighted level index and may fall between levels; `probabilities[i]` belongs to
  `legend[i]`.

Answers are inferred from the questions: `DecisionAnswers<typeof questions>` keys every answer like
its question, and `AnswerOf<Q>` is one answer's type. Only `choice` and `score` answers carry a
`confidence`. `noul` answers have none, as in the protocol. Thresholds, aggregation and fallbacks
stay in TypeScript, and a low-confidence answer is a result, not a failure. Branch on it in code.

`ctx.decide(id, { provider?, model?, state, questions, onError?, retry?, timeoutMs? })` takes:

- `provider`: a declared name. It may be omitted only when the workflow declares exactly one
  provider.
- `model`: the requested model, which may be an alias.
- `state`: the JSON the questions refer to.
- `questions`: at least one named question.

`onError: 'return'` gives a `Settled` result instead of a rejection, as for any step.

## Providers

A workflow lists its providers in `decisions`. Names are unique within the workflow and match
`/^[a-z][a-z0-9-]{0,31}$/`.

### `jevCompatible`

`jevCompatible(options)` is the built-in provider for any host that speaks the shared protocol. It
sends `POST <baseUrl><path>` with a JSON `{ model, state, questions }` body and an
`Authorization: Bearer` token.

- `name`: the provider name.
- `baseUrl`: the host, `http` or `https`. It is optional here, because the operator can supply it
  (see [configuration](#configuration)).
- `path`: defaults to `/v1/systemone`.
- `apiKeyEnv`: the environment variable that holds the token.
- `defaultModel`: the model requested when a call names none.
- `revision`: defaults to 1.
- `capabilities`: overrides of the defaults (all three kinds, 255 options, 2 to 10 levels, no
  idempotency key). Use them for a host that lacks a kind, caps options lower or accepts an
  idempotency key.

HTTP failures map to `DecisionError` kinds:

| Response                     | Kind              | Retried by `on: ['transient']` |
| ---------------------------- | ----------------- | ------------------------------ |
| 429                          | `rate-limit`      | yes                            |
| 5xx                          | `overloaded`      | yes                            |
| 401                          | `authentication`  | no                             |
| 403                          | `permission`      | no                             |
| other 4xx                    | `invalid-request` | no                             |
| network or client error      | `unknown`         | no                             |
| `timeoutMs` elapsed          | `timeout`         | yes                            |
| 2xx body that fails to parse | `schema`          | no                             |

The step's idempotency key is sent as an `Idempotency-Key` header only when
`capabilities.idempotencyKey` is true. The key stays the same across retries and resume. A response
body over 1 MiB is cancelled once it passes that size and fails with its status's kind (`schema` for
a 2xx); the prefix is kept as evidence. Evidence on a failed attempt is capped at 256 KiB. A
response that echoes the token, literally or JSON-escaped, is redacted before its text reaches an
error message, evidence or validation. A body that is never parsed and still carries the token
`\u`-escaped is withheld.

### `defineDecisionProvider`

`defineDecisionProvider({ name, revision, capabilities, defaultModel?, transport })` declares any
other provider. `transport` is a factory: it gets the operator configuration and returns a function
that performs one request.

```ts
import { DecisionError, defineDecisionProvider } from 'quiet-choir/decision';

export const local = defineDecisionProvider({
  name: 'local',
  revision: 1,
  capabilities: {
    kinds: ['noul', 'choice'],
    maxOptions: 16,
    levels: [2, 10],
    idempotencyKey: false,
  },
  defaultModel: 'local-1',
  transport:
    (configuration) =>
    async (request, { signal }) => {
      const response = await fetch(`${configuration.baseUrl ?? 'http://127.0.0.1:8080'}/decide`, {
        method: 'POST',
        body: JSON.stringify(request.body),
        signal,
      });
      if (!response.ok)
        throw new DecisionError({
          provider: 'local',
          kind: 'unknown',
          status: response.status,
          message: 'failed',
        });
      return { body: await response.json() };
    },
});
```

The transport gets `request` (`model`, `state`, `questions` and the ready-made wire `body`) and a
context with the step's `signal` and `idempotencyKey` (null unless the provider declares
`idempotencyKey`). It returns `{ body, rawText? }` in wire shape, where each answer carries its
question's `type`. Throw a `DecisionError` for a provider failure and a `ConfigurationError` for
missing configuration. A declaration is plain frozen data, checked structurally, so a CLI workflow
that loads its own copy of the subpath still works. Bump `revision` when the provider's answers
change meaning: it is part of every decision's identity.

## Configuration

The operator configures a provider under `decisions.<name>` in `--harness-config` (JSON, `@file`, or
`QUIET_CHOIR_HARNESS_CONFIG`). An embedder passes `RunOptions.decisionConfigurations`:

```json
{
  "decisions": {
    "jev": {
      "baseUrl": "https://decisions.example",
      "apiKeyEnv": "JEV_TOKEN",
      "defaultModel": "jev-1.13"
    }
  }
}
```

Each field set there (`baseUrl`, `apiKeyEnv`, `defaultModel`) replaces the declaration's own value.
The model a call requests is the call's `model`, then `decisions.<name>.defaultModel`, then the
declaration's `defaultModel`. The token is read from the named variable when the request is sent. It
never enters source, records, events or logs. A missing base URL, an unset token variable or a token
that is not a valid header value is a configuration failure: the step stays unfinished, it is never
retried or settled, and resuming after the fix runs the decision live.

Transport factories are lazy. The runtime calls one at most once per run, before the first live
request, so replay, `--dry-run` and fixture runs construct no transport and need no configuration.

## Identity and replay

`ctx.decide` records an ordinary step. Its identity is the versioned constant `decision/2` plus the
provider name and revision, the requested model, the state and the questions. The recorded output is
the validated answers plus the served `model`. The requested model is identity, so changing an alias
such as `jev-latest` starts a new decision. The served model is a recorded fact, as with harness
model aliases. The step's `meta` is `{ integration: 'decision', op: 'decide', provider, model }`; a
roster call adds `roster`.

`retry` and `timeoutMs` are policy, never identity. `retry: { maxAttempts: 3, on: ['transient'] }`
retries 429 and 5xx responses and timeouts. `timeoutMs` bounds each attempt, and cancellation aborts
the request through the step's signal.

One call is one step. A call with several questions settles as a whole and replays as a whole, so
split the questions that should settle independently into separate calls.

## Validation

Before any request, the questions are checked against the provider's `capabilities`. Every kind must
be one the provider accepts, choice options must be within `maxOptions` and score levels within
`levels`. A violation is a `ConfigurationError` naming the question, and nothing is sent.

After the request, the response is parsed against the questions:

- every question must be answered;
- each answer's `type` must match its question;
- a `choice` must be one of the options;
- probability maps must be complete and sum to one within `1e-6`;
- a `score` legend must equal the levels.

A response that fails these checks fails its attempt with a `DecisionError` of kind `schema`. The
issues and the raw body stay on the attempt as evidence. `DecisionError` carries `provider`, `kind`,
`status`, `rawText`, `responseTruncated` and `issues`, and is recognized across module instances.

## Usage

Every attempt reports usage under its provider and model: the provider's token counts,
`costUsd: null` and the raw usage object as `reported`. `usageSummary.byProvider` groups it per
provider and, under `byModel`, per served model (`'(unknown)'` when the provider reported none). An
attempt counts under its provider as soon as its request is dispatched. A configuration failure
before the request reports nothing. See [usage and budgets](usage-and-budgets.md).

## Walkthrough: decide, then act

The cookbook recipe
[`decide-then-act.workflow.ts`](../examples/patterns/decide-then-act.workflow.ts) routes a support
ticket with a decider, drafts a reply with a tool-less agent, then grades the reply with a second
decider. Its support module [`deciders.ts`](../examples/patterns/deciders.ts) holds the data:

```ts
export const jev = jevCompatible({
  name: 'jev',
  apiKeyEnv: 'TYPESAFE_API_KEY',
  defaultModel: 'jev-latest',
});

export const deskRoster = defineRoster({
  Triage: { decider: 'jev', description: 'Routes a support ticket before any agent runs.' },
  Grader: { decider: 'jev', description: 'Grades a drafted reply against its ticket.' },
  Responder: { harness: 'claude', tools: [], maxTurns: 5, maxBudgetUsd: 1, timeoutMs: 600_000 },
});

export const route = choice({ instructions: '…', options: { answer: null, escalate: '…' } });
export const resolved = noul({ instructions: 'Does the reply resolve the ticket?' });
```

`jevCompatible` names no `baseUrl`, so the operator supplies the host with
`--harness-config '{"decisions":{"jev":{"baseUrl":"https://..."}}}'`. The workflow declares
`decisions: [jev]` and `roster: deskRoster`, and its body:

1. Calls `ctx.roster.Triage.decide('triage', { state: input, questions: { route } })`.
2. Returns `{ outcome: 'escalated' }` without running the agent when the route is `escalate` or its
   confidence is below `minConfidence` (0.7). That threshold is ordinary code, and the conservative
   branch is the fallback.
3. Otherwise drafts the reply with `ctx.roster.Responder.value('reply', …)`. The entry has no tools,
   so `--require-grants` asks for no grant.
4. Grades it with
   `ctx.roster.Grader.decide('grade', { state: { ticket, reply }, questions: { resolved } })`. This
   is the step `ctx.decide('grade', { provider: 'jev', … })` records, plus `meta.roster: 'Grader'`.
5. Returns `sent` when `resolved.noul >= 0.9` and `needs-review` otherwise.

Rehearse it with no host and no token:

```sh
npm run cli -- workflow execute examples/patterns/decide-then-act.workflow.ts --run-id desk \
  --input '{"ticket":"I forgot my password."}' \
  --harness fixture:examples/patterns/decide-then-act.fixtures.json
npm run --silent cli -- workflow inspect desk
```

The fixture file answers the agent call `reply` under `calls` and both decisions under `decisions`.
`inspect` then lists `triage` and `grade` with their provider, requested and served models, each
question's headline answer and confidence, and tokens. `test/decide-then-act.test.ts` runs the
recipe under `--harness fixture`, under `--dry-run` with and without the file, and with a
low-confidence triage answer that escalates.

## Fixtures and dry runs

`ctx.decide` never reaches its provider under `--dry-run` or `--harness fixture`. The global fixture
file answers decisions in a `decisions` object keyed by full step ID: `{ answers, model?, usage? }`,
or `{ error, kind? }` for a failure. Answers go through the same validation as a live response.
Under `--harness fixture`, a decision without an entry is a configuration error unless
`"unmatched": "synthesize"` is set. `--dry-run` synthesizes every unmatched decision: the first
option and lowest level with confidence 1, and noul 0. `workflow fixtures RUN` exports completed
decisions as entries. See [decision fixtures](rehearsal.md#decision-fixtures).

## Inspect and events

`workflow inspect` lists each completed decision step with a `decision` summary:
`{ op, provider, requestedModel, servedModel, questions, usage }`, with one
`{ name, kind, answer, level?, confidence? }` entry per question. The step's `step.completed` event
line carries a compact form:
`decision jev jev-latest->jev-1.13 140/9 tok 1 att: route=answer c0.85`. See
[observability](observability.md).

## Roster decider entries

A roster entry can be a decider, `{ decider: 'jev', model?, description? }`, naming one of the
workflow's `decisions`. `ctx.roster.Triage.decide(id, { state, questions })` is then `ctx.decide`
with the provider and model fixed. It records the same identity plus `meta.roster`, a label that is
never identity. `workflow validate --json` lists deciders under `workflow.deciders`. See
[decider entries](roster.md#decider-entries).

## The deprecated `decision().choose` helper

The transport-injected `decision(ctx, transport).choose(id, { state, question, answers })` helper,
and its `DecisionTransport`, `DecisionQuestion` and `DecisionAnswer` types, are deprecated. They
will be removed no earlier than the next release. Building the helper emits one `DeprecationWarning`
per process, with code `QUIET_CHOIR_DECISION_CHOOSE`, even when several module instances load the
subpath. `node --no-deprecation` silences it and `--throw-deprecation` turns it into an error, as
for any Node deprecation.

Its steps keep identity `decision/1`, the same input, schema and `meta`
(`{ integration: 'decision', op: 'choose' }`). Completed `decision/1` steps therefore replay without
calling the transport, and `inspect` still summarizes them with op `choose`. They are not exported
as decision fixtures. `test/decision-choose-deprecation.test.ts` resumes a record written before the
deprecation.

To migrate, declare a provider for the service and replace the call:

```ts
// Before: one choice, a hand-written transport.
const { answer } = await decision(ctx, transport).choose('route', {
  state: ticket,
  question: 'Which team?',
  answers: ['billing', 'infra'],
});

// After: a declared provider (decisions: [jev]) and a typed choice question.
const { team } = await ctx.decide('route', {
  state: ticket,
  questions: {
    team: choice({ instructions: 'Which team?', options: { billing: null, infra: null } }),
  },
});
const answer = team.choice;
```

The new call has a different identity (`decision/2`), so a run that completed the old step and is
resumed with the new code runs the decision once, live. Keep the old call in place until those runs
have finished.

## Live contract test

`npm run test:contract:decision` (after `npm run build`) makes one real request: a single `noul`
question about the state `'ping'`, the cheapest request there is. It is opt-in and never part of
`npm test`, `npm run check` or CI. It reads the token from `TYPESAFE_API_KEY`, or from the variable
`decisions.jev.apiKeyEnv` names in `QUIET_CHOIR_HARNESS_CONFIG`. Without a token it prints
`decision live contract: skipped (...)` and exits 0. The repository records no host URL. With a
token set, `decisions.jev.baseUrl` is required, and without it the script fails with a configuration
message:

```sh
npm run build
QUIET_CHOIR_HARNESS_CONFIG='{"decisions":{"jev":{"baseUrl":"https://..."}}}' \
  TYPESAFE_API_KEY=... npm run test:contract:decision
```

It checks that the answer is a probability in `[0, 1]` and prints the requested and served models
and the token counts. This only checks one host against this implementation; it does not establish
that the host conforms to the protocol.
