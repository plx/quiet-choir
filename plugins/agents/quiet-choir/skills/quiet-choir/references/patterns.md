# Verified workflow patterns

Read this cookbook before writing loops, fan-out, failure handling, or waits. These are complete
checkout examples from `examples/patterns/`, tested with fake harnesses through failure and resume.
Every TypeScript/JSON fence is checked against its source file; each workflow is at most 30 lines.
Save it at that checkout location, or replace `../../src/index.js` with your
[runtime import](setup-and-cli.md#run-against-another-project). The worktree example also needs the
[complete helper module](worktree-helper.md) beside it. Do not run files from the plugin cache as
the target workspace.

Agent recipes make real calls with the normal CLI harness. Start with
[fixture rehearsal](#rehearse-for-free) or `--dry-run --json`; local callbacks still perform real
I/O unless stubbed. Use the
[launch-directory and external-state rules](../SKILL.md#run-a-first-workflow-against-a-project). The
tests' fake responses prove replay behavior, not the quality of a model's review or edits.

| Need                                                      | Recipe                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| Combine Claude and Codex reviews; retry failed reviewers  | [Cross-harness fan-out/fan-in](#cross-harness-fan-outfan-in) |
| Preserve a quorum decision despite failed reviewers       | [Failure-tolerant panel](#failure-tolerant-panel)            |
| Discover until no new findings appear                     | [Loop until dry](#loop-until-dry)                            |
| Run sequential stages for each item                       | [Per-item pipeline](#per-item-pipeline)                      |
| Stop revising after approval or a round limit             | [Bounded review/revise](#bounded-reviewrevise)               |
| Reuse a helper without ID collisions                      | [Scoped helper](#reusable-helper)                            |
| Isolate parallel file edits                               | [Worktree per item](#worktree-per-item)                      |
| Wait with a stable deadline                               | [Polling and deadlines](#polling-and-deadlines)              |
| Reuse old completed work after a fix                      | [Salvage with a fork](#salvage-an-old-run)                   |
| Freeze a failure before selecting a fallback              | [Latch an outcome](#latch-an-outcome)                        |
| Retry a small extraction without repeating expensive work | [Work, then extract](#work-then-extract)                     |
| Test before native calls                                  | [Rehearse for free](#rehearse-for-free)                      |
| Recognize tempting but unsafe code                        | [Traps](#traps)                                              |

## Cross-harness fan-out/fan-in

**Rule:** use stable reviewer keys and named effects; merge the returned input-order array in plain
code. Default drain lets started siblings finish before a failure rejects. A compatible resume
retries unfinished reviewers and reuses completed siblings. Set the run-wide `--max-agents`
independently of this map's local concurrency.

<!-- skills-check: example pattern-cross-harness -->

```ts
import { defineWorkflow, z } from '../../src/index.js';

const Reviewer = z.object({
  id: z.string(),
  provider: z.enum(['claude', 'codex']),
  lens: z.string(),
});
const Verdict = z.object({ approved: z.boolean(), reason: z.string() });
export default defineWorkflow({
  name: 'cross-harness',
  version: '1',
  input: z.object({ topic: z.string(), reviewers: z.array(Reviewer).max(8) }),
  output: z.array(Verdict),
  async run(ctx, input) {
    return ctx.map('panel', input.reviewers, { concurrency: 2, key: (r) => ctx.id(r.id) }, (r) => {
      const options = { prompt: `${r.lens}: ${input.topic}`, schema: Verdict };
      return r.provider === 'claude'
        ? ctx.claude.value('verdict', options)
        : ctx.codex.value('verdict', options);
    });
  },
});
```

**Cost:** one call per reviewer, plus retried attempts. A slow started sibling can delay failure.
**Supersession:** no replacement is planned for ordinary fan-in. The former catch-every-mapper
workaround was superseded by drain/scoped cancellation in
[#43](https://github.com/plx/quiet-choir/issues/43).

## Failure-tolerant panel

**Rule:** when failure participates in a quorum or fallback decision, journal that decision.
`onError: 'settle'` saves each whole mapper outcome, including failures. This recipe returns
`quorum:false` as data when too few reviewers succeed. Cancellation, configuration errors,
checkpoint failures, and authoring guards still reject instead of becoming votes. Use the preceding
drain recipe when failed reviewers should be retried on resume.

<!-- skills-check: example pattern-tolerant-panel -->

```ts
import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'tolerant-panel',
  version: '1',
  input: z.object({ topic: z.string(), lenses: z.array(z.string()).min(1).max(8) }),
  output: z.object({ quorum: z.boolean(), answers: z.array(z.string()) }),
  async run(ctx, input) {
    const results = await ctx.map(
      'panel',
      input.lenses,
      { concurrency: 2, onError: 'settle' },
      (lens) => ctx.claude.value('review', { prompt: `${lens}: ${input.topic}` }),
    );
    const answers = results.flatMap((result) => (result.ok ? [result.value] : []));
    return { quorum: answers.length > input.lenses.length / 2, answers };
  },
});
```

**Cost:** one call per lens. Saved failed votes cost no new calls on resume; intentionally retrying
them requires a new run/fork with appropriate invalidation. **Supersession:** the manual catch/latch
panel was superseded by implemented [#43](https://github.com/plx/quiet-choir/issues/43) and
[#42](https://github.com/plx/quiet-choir/issues/42); this uses those primitives.

## Loop until dry

**Rule:** round IDs, prompts, and the break condition depend only on input and recorded answers.
Deduplicate findings in plain code, stop on no new findings, and keep a hard round bound even if the
agent keeps inventing more. The strings are examples; use stable domain IDs for real findings.

<!-- skills-check: example pattern-loop-until-dry -->

```ts
import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'loop-until-dry',
  version: '1',
  input: z.object({ topic: z.string(), rounds: z.int().min(1).max(10) }),
  output: z.array(z.string()),
  async run(ctx, input) {
    const known: string[] = [];
    for (let round = 0; round < input.rounds; round++) {
      const result = await ctx.claude.value(`hunt/${String(round)}`, {
        prompt: `${input.topic}; list new findings beyond ${JSON.stringify(known)}.`,
        schema: z.object({ findings: z.array(z.string()) }),
      });
      const fresh = [...new Set(result.findings)].filter((finding) => !known.includes(finding));
      if (fresh.length === 0) break;
      known.push(...fresh);
    }
    return known;
  },
});
```

**Cost:** at most `rounds` calls per successful execution path, plus retries of unfinished calls.
Replays reuse earlier hunts, including the empty final answer. **Supersession:** none planned;
ordinary loops remain the API.

## Per-item pipeline

**Rule:** one mapper owns a sequence of named stages. Await each stage so a later stage cannot run
before its dependencies commit. This example proposes patches as text; applying parallel file edits
belongs in [separate worktrees](#worktree-per-item).

<!-- skills-check: example pattern-per-item-pipeline -->

```ts
import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'per-item-pipeline',
  version: '1',
  input: z.object({ tasks: z.array(z.string()).max(8) }),
  output: z.array(z.object({ approved: z.boolean(), patch: z.string() })),
  async run(ctx, input) {
    return ctx.map('fix', input.tasks, { concurrency: 2 }, async (task) => {
      const plan = await ctx.claude.value('plan', { prompt: `Plan this task: ${task}` });
      const patch = await ctx.codex.value('implement', {
        prompt: `Propose a patch as text, without editing files: ${task}\n${plan}`,
      });
      const check = await ctx.claude.value('check', {
        prompt: `Review this proposed patch: ${patch}`,
        schema: z.object({ approved: z.boolean() }),
      });
      return { approved: check.approved, patch };
    });
  },
});
```

**Cost:** three calls per item, with completed stages and sibling items reusable on resume.
**Superseded when:** [#18](https://github.com/plx/quiet-choir/issues/18) supplies a higher-level
pipeline-stage API; explicit async stages are the current form.

## Bounded review/revise

**Rule:** each round has fixed IDs; exhaustion is a valid output, not an exception that forces a new
attempt at the same already-rejected draft. The final round reviews without producing an unreviewed
revision afterward.

<!-- skills-check: example pattern-review-revise -->

```ts
import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'review-revise',
  version: '1',
  input: z.object({ draft: z.string(), rounds: z.int().min(1).max(10) }),
  output: z.object({ approved: z.boolean(), draft: z.string() }),
  async run(ctx, input) {
    let draft = input.draft;
    for (let round = 0; round < input.rounds; round++) {
      const review = await ctx.codex.value(`review/${String(round)}`, {
        prompt: `Review this draft: ${draft}`,
        schema: z.object({ approved: z.boolean(), feedback: z.string() }),
      });
      if (review.approved) return { approved: true, draft };
      if (round + 1 < input.rounds) {
        draft = await ctx.claude.value(`revise/${String(round)}`, {
          prompt: `Revise ${draft} using this feedback: ${review.feedback}`,
        });
      }
    }
    return { approved: false, draft };
  },
});
```

**Cost:** at most `rounds` reviews and `rounds - 1` revisions, plus retries. Approval exits early. A
failed later effect can resume without reviewing earlier rounds again. **Supersession:** none
planned; ordinary bounded loops remain the API.

## Reusable helper

**Rule:** helpers receive a context scoped by their caller and use explicit leaf IDs. Calling this
helper for another file cannot collide with its earlier `verdict`. `ctx.id(path)` makes a stable
legal item segment; it does not read the file or make the path a security boundary.

<!-- skills-check: example pattern-reusable-helper -->

```ts
import { defineWorkflow, z, type WorkflowContext } from '../../src/index.js';

async function reviewFile(ctx: WorkflowContext, path: string): Promise<string> {
  return ctx.claude.value('verdict', {
    profile: 'readonly',
    prompt: `Read and review this file: ${path}`,
  });
}
export default defineWorkflow({
  name: 'reusable-helper',
  version: '1',
  input: z.object({ paths: z.array(z.string()).max(8) }),
  output: z.array(z.string()),
  async run(ctx, input) {
    return ctx.map('files', input.paths, { concurrency: 2, key: (path) => ctx.id(path) }, (path) =>
      reviewFile(ctx.within('review'), path),
    );
  },
});
```

**Cost:** one call per file; scopes add no agent calls. **Supersession:** manual prefix-threading
was superseded by implemented [#44](https://github.com/plx/quiet-choir/issues/44). This uses
`within` inside a named map; `ctx.scope` is the dynamic equivalent.

## Worktree per item

**Rule:** parallel editing calls need distinct directories. Copy the
[worktree helper](worktree-helper.md) to `worktree-helper.ts` beside this workflow. It creates a
branch/path from the root, run ID, and item, reuses only a matching registered worktree, and refuses
changed ownership or an unrelated path. Supply absolute `repo` and `root`, keep `root` outside the
target worktree, use unique run IDs for that root, and launch with `--grant editor` when edits are
authorized. The durable step creates the worktree and records its path; every execution then
revalidates ownership before the editing call, because a replayed step would skip the check.

<!-- skills-check: example pattern-worktrees -->

```ts
import { defineWorkflow, z } from '../../src/index.js';
import { ensureWorktree } from './worktree-helper.js';

const Input = z.object({ repo: z.string(), root: z.string(), items: z.array(z.string()).max(8) });
export default defineWorkflow({
  name: 'worktrees',
  version: '1',
  input: Input,
  output: z.array(z.string()),
  profiles: { editor: { extends: 'edit' } },
  async run(ctx, input) {
    const { repo, root } = input;
    return ctx.map(
      'items',
      input.items,
      { concurrency: 2, key: (item) => ctx.id(item) },
      async (item) => {
        const setup = { repo, root, runId: ctx.runId, item };
        const cwd = await ctx.step('worktree', {
          input: setup,
          schema: z.string(),
          run: ({ signal }) => ensureWorktree({ ...setup, signal }),
        });
        await ensureWorktree({ ...setup, signal: ctx.signal });
        return ctx.codex.value('edit', { profile: 'editor', cwd, prompt: `Implement: ${item}` });
      },
    );
  },
});
```

**Cost:** one worktree/branch and one editing call per item, plus retries. Created branches,
worktrees, and file edits remain after cancellation; no cleanup/reset is automatic. A partial Git
operation may require inspection before retry. The unjournaled ownership check runs on every
execution, so a resume after the edit completed also refuses a changed worktree. **Superseded
when:** [#59](https://github.com/plx/quiet-choir/issues/59) provides supported worktree
coordination.

## Polling and deadlines

**Rule:** record the clock once, then use its fixed deadline inside a single local effect. This
runnable example reads an absolute status file containing `pending`, `success`, or `failure`. Have
the producer replace the file atomically. Replace that read with a signal-aware CI/API query for
real use; select an appropriate polling interval (the file demo uses 100 ms). Terminal state wins
when observed; a still-pending state past the deadline returns `timeout` as data. Pending polls are
not separate durable steps.

<!-- skills-check: example pattern-polling -->

```ts
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { defineWorkflow, z } from '../../src/index.js';

const Result = z.enum(['success', 'failure', 'timeout']);
export default defineWorkflow({
  name: 'polling',
  version: '1',
  input: z.object({ file: z.string(), ms: z.int().min(1).max(60_000) }),
  output: Result,
  async run(ctx, input) {
    const clock = { input: null, schema: z.number(), run: () => Date.now() };
    const deadline = (await ctx.step('started-at', clock)) + input.ms;
    return ctx.step('wait', {
      input: { file: input.file, deadline },
      schema: Result,
      async run({ signal }): Promise<z.infer<typeof Result>> {
        for (;;) {
          const state = (await readFile(input.file, { encoding: 'utf8', signal })).trim();
          if (state === 'success' || state === 'failure') return state;
          if (state !== 'pending') throw new Error('Unknown check status');
          if (Date.now() >= deadline) return 'timeout';
          await wait(100, undefined, { signal });
        }
      },
    });
  },
});
```

**Cost:** two checkpointed effects regardless of poll count, repeated reads while pending, and a
live process while waiting. Interrupting the wait leaves it retryable against the original deadline;
no agent calls occur. **Superseded when:** the wait/deadline work tracked by
[#55](https://github.com/plx/quiet-choir/issues/55) and
[#57](https://github.com/plx/quiet-choir/issues/57) provides the supported replacement. Do not
compute a changing `ctx.sleep` duration in the body.

## Salvage an old run

**Rule:** use checkpoint-aware fork reuse instead of copying arbitrary `readRun` outputs into a new
workflow. This small sequential workflow lets you fail the third call, then reuse the first two in a
new run. The source remains unchanged; reused results still pass compatibility checks.

<!-- skills-check: example pattern-salvage -->

```ts
import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'salvage',
  version: '1',
  input: z.object({ topics: z.array(z.string()).max(8) }),
  output: z.array(z.string()),
  async run(ctx, input) {
    const answers: string[] = [];
    for (const [index, topic] of input.topics.entries()) {
      answers.push(await ctx.claude.value(`answer/${String(index)}`, { prompt: topic }));
    }
    return answers;
  },
});
```

With the same launch directory and state, choose a fresh target ID:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow execute "$QC_CHECKOUT/examples/patterns/salvage.workflow.ts" \
  --run-id salvaged --fork-from original --state-dir "$QC_RUNS" --json
```

Default reuse is the unchanged prefix. Add `--reuse matching` for matching effects beyond a change,
or `--invalidate 'answer/2'` to force an otherwise reusable answer live. Omit input to inherit it.
See [recovery](durability.md#choose-a-recovery-path) for source edits and schema compatibility.
**Cost:** only non-reused agent calls; a fresh run without fork reuse repeats all calls.
**Supersession:** manual output salvage was superseded by implemented
[#41](https://github.com/plx/quiet-choir/issues/41).

## Latch an outcome

**Rule:** persist the failure that selects the fallback. `onError: 'return'` freezes the final
outcome after allowed retries. A healed primary cannot erase a completed fallback on resume. The
retry policy uses the same ID and retries only classified rate limits; cancellations, configuration
errors, and checkpoint failures never latch; keep process/authentication/permission kinds out of
`retry.on`.

<!-- skills-check: example pattern-latch -->

```ts
import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'latch',
  version: '1',
  input: z.object({ topic: z.string() }),
  output: z.object({ source: z.enum(['primary', 'fallback']), answer: z.string() }),
  async run(ctx, input) {
    const primary = await ctx.claude.value('primary', {
      prompt: input.topic,
      onError: 'return',
      retry: { maxAttempts: 2, delayMs: 1, on: ['rate-limit'] },
    });
    if (primary.ok) return { source: 'primary', answer: primary.value };
    const answer = await ctx.codex.value('fallback', { prompt: input.topic });
    return { source: 'fallback', answer };
  },
});
```

**Cost:** up to two primary attempts for a rate limit, otherwise one, plus one fallback call if
needed. Replaying a saved failure pays for neither branch again. **Supersession:** the manual "call
then record a latch" workaround was superseded by implemented
[#42](https://github.com/plx/quiet-choir/issues/42). Retry policy is supported by
[#40](https://github.com/plx/quiet-choir/issues/40).

## Work, then extract

**Rule:** checkpoint the expensive investigation before requesting a small structured result. A
schema failure can then retry extraction alone. Choose an approved lower-cost extraction model in a
profile when appropriate; omitted models inherit native configuration. Keep the schema small and put
semantic constraints in the extraction prompt too.

<!-- skills-check: example pattern-work-then-extract -->

```ts
import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'work-then-extract',
  version: '1',
  input: z.object({ task: z.string() }),
  output: z.object({ summary: z.string(), ready: z.boolean() }),
  async run(ctx, input) {
    const report = await ctx.codex.value('work', { profile: 'readonly', prompt: input.task });
    return ctx.claude.value('extract', {
      prompt: `Extract a concise summary and readiness decision from this report: ${report}`,
      schema: z.object({ summary: z.string(), ready: z.boolean() }),
    });
  },
});
```

**Cost:** one investigation and one extraction, plus repeated extraction attempts on failure. A
failed investigation still starts a fresh native session when retried. **Superseded when:**
[#23](https://github.com/plx/quiet-choir/issues/23) supplies applicable native-session recovery.
[#33](https://github.com/plx/quiet-choir/issues/33) already preserves failure diagnostics/usage, but
does not resume a native session. Use the
[logging decorator](extensions.md#keep-raw-responses-when-local-validation-fails) if raw successful
adapter output must survive a later local validation failure.

## Rehearse for free

**Rule:** test the same schemas and control flow with fixture responses before native calls. This
workflow's two reached calls are covered by the fixture file below; unmatched calls fail rather than
silently falling through to a paid harness.

<!-- skills-check: example pattern-rehearse -->

```ts
import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'rehearse',
  version: '1',
  input: z.object({ topic: z.string() }),
  output: z.object({ approved: z.boolean() }),
  async run(ctx, input) {
    const draft = await ctx.claude.value('draft', { prompt: `Draft: ${input.topic}` });
    return ctx.codex.value('review', {
      prompt: `Review: ${draft}`,
      schema: z.object({ approved: z.boolean() }),
    });
  },
});
```

Save the matching `rehearse.fixtures.json` alongside the workflow:

<!-- skills-check: example pattern-rehearse-fixtures -->

```json
{
  "version": 1,
  "calls": [
    { "step": "draft", "text": "A fixture draft." },
    { "step": "review", "output": { "approved": true } }
  ]
}
```

From the target directory, with absolute golden-path variables set:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow execute "$QC_CHECKOUT/examples/patterns/rehearse.workflow.ts" \
  --run-id rehearsal --state-dir "$QC_RUNS" --input '{"topic":"durability"}' \
  --harness "fixture:$QC_CHECKOUT/examples/patterns/rehearse.fixtures.json" --json
```

**Cost:** no agent spend in fixture mode; imports/local callbacks still run. Fixtures cover only the
branches they reach. **Supersession:** ad hoc embedding/PATH-shim rehearsal was superseded by
implemented [#51](https://github.com/plx/quiet-choir/issues/51). Native contract probes still use
repository fake APIs/CLIs; failing shims must exit nonzero (normally 1). Use `.mjs`/ESM shims or an
explicit CommonJS package for `require`, rather than an extensionless `require` shim under
`"type":"module"`. See [rehearsal](rehearsal.md) for the complete loop.

## Traps

The original prototype made several of these fail only during replay. Current guards and APIs catch
or support more cases; the table describes the current runtime, not the old failure modes.
[Inspection](inspection.md#match-a-symptom-to-its-next-action) covers exact error templates.

| Tempting code                                                                   | Current consequence                                                                                                               | Use instead                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catch a throwing durable call, then select a fallback or sentinel               | The failed call can heal on resume and change a completed branch/input                                                            | [Latch](#latch-an-outcome) with `onError:'return'`, or fail and resume                                                                                                      |
| Retry by incrementing IDs (`ask/0`, `ask/1`)                                    | An earlier call can heal and bypass later recorded effects                                                                        | Same-ID `retry` as in [latch](#latch-an-outcome)                                                                                                                            |
| Catch a map and assume its failure is a durable quorum decision                 | Catching no longer poisons the whole run, but replay can change an unjournaled decision                                           | [Tolerant panel](#failure-tolerant-panel); use [drain](#cross-harness-fan-outfan-in) for retryable failure                                                                  |
| Race durable calls with `Promise.race`                                          | Replay completion order can choose another branch; losing effects still need ownership/draining                                   | [Poll inside one step](#polling-and-deadlines) for readiness/deadlines, or an agent `timeoutMs` with `onError:'return'` for timeout decisions; do not race durable branches |
| Compute a sleep duration/deadline from a live body `Date.now()`                 | A later execution changes its dependency/identity                                                                                 | [Recorded clock and polling](#polling-and-deadlines)                                                                                                                        |
| Read time/env/files/git diff in the body and place them in prompts              | Replay sees changed inputs despite unchanged workflow input                                                                       | Record the read in a local step, as in [polling](#polling-and-deadlines), then build prompts from saved values                                                              |
| Supply undefined data indiscriminately                                          | Undefined object members are omitted; roots, array elements/holes, classes, and non-JSON values still fail                        | [Small JSON extraction](#work-then-extract); filter arrays or use null deliberately                                                                                         |
| Use unrepresentable schemas (`z.void`, `z.undefined`, dates/bigints/transforms) | Call-time JSON Schema conversion can fail even after top-level `validate`                                                         | [Work, then extract](#work-then-extract) with JSON shapes and string dates; [rehearse](#rehearse-for-free) the reached path                                                 |
| Ban all Codex `.optional()` fields or assume strict mode accepts them unchanged | Default compat now encodes optionals/arrays/records; strict mode still has narrower wire rules                                    | The [flat extraction schema](#work-then-extract) and [current Codex schema rules](codex.md#structured-output-and-protocol)                                                  |
| Return a wider type than the schema                                             | Schema-first typing now rejects wider callbacks before import; local validation still matters                                     | [Typed extraction](#work-then-extract) and [rehearsal](#rehearse-for-free); use the actual output schema, not casts                                                         |
| Start `void` chains or ignore a durable promise                                 | Owned operations drain, ignored failures reject, and new operations after closure are refused; unowned async chains remain unsafe | Await each stage as in the [per-item pipeline](#per-item-pipeline)                                                                                                          |
| Raise limits by changing completed semantic inputs/model/tool grants            | Limits/retry are now policy; semantic changes still invalidate terminal identity                                                  | Keep the [bounded loop](#bounded-reviewrevise), raise authorized sticky limits, and use [fork reuse](#salvage-an-old-run) for semantic edits                                |
| Run parallel editing calls in one checkout                                      | Filesystem edits race and checkpoints cannot roll them back                                                                       | [Worktree per item](#worktree-per-item), with explicit ownership and grants                                                                                                 |

For a tail-only code fix, first inspect what completed, then use explicit code acceptance or a fork.
A new ID alone repays agent calls; it does not imply salvage. Never treat paid effects as rolled
back because a checkpoint or schema validation failed.
