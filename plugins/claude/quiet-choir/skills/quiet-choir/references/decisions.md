# Decision providers

Use a decision provider when a workflow branches on a judgment about JSON state: route before an
agent runs, grade an agent's output, decide whether a loop continues. A provider answers typed
questions (`noul`, `choice`, `score`) with probabilities instead of text. `ctx.decide` makes one
durable step per call. Replay returns the saved answers and never sends the request again.

## Declare, configure, decide

```ts
import { defineWorkflow, z } from 'quiet-choir';
import { choice, jevCompatible, noul } from 'quiet-choir/decision';

// No baseUrl here: the operator sets decisions.jev.baseUrl. The token is read at request time.
const jev = jevCompatible({
  name: 'jev',
  apiKeyEnv: 'TYPESAFE_API_KEY',
  defaultModel: 'jev-latest',
});
const team = choice({
  instructions: 'Which team owns this ticket?',
  options: { billing: null, infra: 'Outages, deploys and access.' },
});
const refund = noul({ instructions: 'Does the customer ask for a refund?' });

export default defineWorkflow({
  name: 'route',
  version: '1',
  decisions: [jev],
  input: z.object({ ticket: z.string() }),
  output: z.enum(['billing', 'infra', 'human']),
  async run(ctx, input) {
    const answers = await ctx.decide('route', { state: input, questions: { team, refund } });
    // Thresholds are ordinary code; a low-confidence answer is a result, not a failure.
    if (answers.team.confidence < 0.7 || answers.refund.noul > 0.5) return 'human';
    return answers.team.choice;
  },
});
```

- **Questions.** `noul({ instructions, criteria? })` answers `{ noul }`, the probability of yes.
  `choice({ instructions, options })` answers `{ choice, probabilities, confidence }`, and the
  option names type `choice`. `score({ instructions, levels })` answers
  `{ score, probabilities, legend, confidence }` on 2 to 10 levels, lowest first. Only `choice` and
  `score` carry `confidence`.
- **The call.**
  `ctx.decide(id, { provider?, model?, state, questions, onError?, retry?, timeoutMs? })`.
  `provider` may be omitted only when the workflow declares one provider. `retry` and `timeoutMs`
  are policy; `retry: { maxAttempts: 3, on: ['transient'] }` retries 429, 5xx and timeouts.
- **Configuration.** The operator passes `--harness-config` (JSON, `@file` or
  `QUIET_CHOIR_HARNESS_CONFIG`) with
  `{"decisions":{"jev":{"baseUrl":"https://...","apiKeyEnv":"...","defaultModel":"..."}}}`. An
  embedder passes `RunOptions.decisionConfigurations`. A missing base URL or an unset token is a
  fatal configuration failure: the step stays unfinished, and a resume after the fix runs it. The
  token never enters records or logs. Never put it in `state`.
- **Other hosts.**
  `defineDecisionProvider({ name, revision, capabilities, defaultModel?, transport })` declares a
  provider with your own transport. Bump `revision` when its answers change meaning.

## Identity

The step's identity is `decision/2` over the provider name and revision, the requested model, the
state and the questions. The served model is a recorded fact, not identity. Changing the state, a
question, the model alias or the provider revision starts a new decision. One call is one step and
settles as a whole, so split questions that should settle independently.

Before the request, questions are checked against the provider's capabilities; a violation is a
`ConfigurationError`. A response that fails validation (an unknown option, probabilities that do not
sum to one, a missing answer) fails its attempt with a `DecisionError` of kind `schema`, with the
body kept as evidence. HTTP 429 is `rate-limit`, 5xx is `overloaded`, 401 `authentication`, 403
`permission` and other 4xx `invalid-request`.

## Roster deciders

A roster entry can name a provider instead of a harness. The call then takes only `state`,
`questions` and policy, and records the same step as `ctx.decide` plus `meta.roster`:

<!-- skills-check: fragment; reason: A roster module and one call in a body; the workflow declares decisions: [jev] and roster, and has ctx, input and route in scope. -->

```ts
const roster = defineRoster({
  Triage: { decider: 'jev', description: 'Routes support tickets.' },
});
// In the body of a workflow with decisions: [jev] and roster:
const triage = await ctx.roster.Triage.decide('triage', { state: input, questions: { route } });
```

A decider entry needs no grant and cannot fill a team slot. The
[decide, then act](patterns.md#decide-then-act) recipe routes with one decider, drafts with a
tool-less agent and grades with a second decider.

## Rehearse and inspect

Decisions never call their provider under `--dry-run` or `--harness fixture`. Answer them in the
global fixture file's `decisions` object, keyed by full step ID:

```json
{
  "version": 1,
  "calls": [],
  "decisions": {
    "route": {
      "answers": {
        "team": {
          "choice": "billing",
          "probabilities": { "billing": 0.9, "infra": 0.1 },
          "confidence": 0.9
        },
        "refund": { "noul": 0.1 }
      },
      "model": "jev-1.13"
    }
  }
}
```

Fixture answers are validated like live ones. Under `--harness fixture`, an unmatched decision is a
configuration error unless the file sets `"unmatched": "synthesize"`. `--dry-run` synthesizes
unmatched decisions: the first option with confidence 1, and noul 0. Rehearse each branch your
thresholds select with its own fixture. See [decision fixtures](rehearsal.md#decision-fixtures).

`workflow inspect` prints each completed decision step as
`completed ID  decision PROVIDER MODEL -> SERVED`, with one line per question carrying its answer
and confidence; `--json` has the same data under `steps[].decision`. Usage is grouped per provider
and served model. See [inspection](inspection.md).

## The deprecated helper

`decision(ctx, transport).choose(id, { state, question, answers })` is deprecated and emits a
`DeprecationWarning` with code `QUIET_CHOIR_DECISION_CHOOSE` once per process. Do not write new
calls. Its completed `decision/1` steps keep replaying without calling the transport. Replacing it
with `ctx.decide` changes the identity (`decision/2`), so resuming a run that already completed the
old step under the same ID is refused with `StepIdentityChangedError` (`run.incompatible`, even with
`--accept-code-change`). Keep the `choose` call until those runs finish, start a new run, or fork
(`--fork-from RUN --reuse matching --invalidate <step id>`), which runs the new decision once, live.
