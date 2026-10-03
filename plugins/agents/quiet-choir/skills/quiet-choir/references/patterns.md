# Verified workflow patterns

Read this cookbook before writing loops, fan-out, failure handling, or waits. These are complete
checkout examples from `examples/patterns/`, tested with fake harnesses through failure and resume.
Every TypeScript/JSON fence is checked against its source file; each workflow is at most 30 lines.
Save it at that checkout location, or replace `../../src/index.js` with your
[runtime import](setup-and-cli.md#run-against-another-project). Do not run files from the plugin
cache as the target workspace.

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
| Keep a human decision attached to its saved plan          | [Human review](#human-review)                                |
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
  harness: z.enum(['claude', 'codex']),
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
      return ctx.agent(r.harness).value('verdict', options);
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
`onError: 'return'` saves each whole mapper outcome, including failures. This recipe returns
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
      { concurrency: 2, onError: 'return' },
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

**Rule:** a typed inline child validates its input/output, records its identity, and scopes every
effect. Named map keys separate files; `ctx.workflow` separates each review frame. `ctx.id(path)`
makes a stable legal item segment, not a filesystem security boundary.

<!-- skills-check: example pattern-reusable-helper -->

```ts
import { defineWorkflow, z } from '../../src/index.js';

const reviewFile = defineWorkflow({
  name: 'review-file',
  version: '1',
  input: z.object({ path: z.string().describe('File to review') }),
  output: z.string(),
  async run(ctx, input) {
    return ctx.claude.value('verdict', {
      profile: 'readonly',
      prompt: `Read and review this file: ${input.path}`,
    });
  },
});
export default defineWorkflow({
  name: 'reusable-helper',
  version: '2',
  children: [reviewFile],
  input: z.object({ paths: z.array(z.string()).max(8) }),
  output: z.array(z.string()),
  async run(ctx, input) {
    return ctx.map('files', input.paths, { concurrency: 2, key: (path) => ctx.id(path) }, (path) =>
      ctx.workflow('review', reviewFile, { path }),
    );
  },
});
```

**Cost:** one call per file; child frames add no inference. **Supersession:** implemented
[#63](https://github.com/plx/quiet-choir/issues/63) adds child identity, validated I/O and profile
delegation to the scoped-helper recipe. Plain function helpers can still use `within` or `scope`;
see [child workflows and discovery](child-workflows.md).

## Worktree per item

**Rule:** use runtime isolation when targets may overlap, commands observe concurrent edits, or a
failed writer's partial state is unsafe to reuse. Structural file sharding remains valid for
disjoint writers. Launch from the target repository with `--grant editor` when edits are authorized.
Git 2.38+ is required; embedded callers also supply `NodeProcessRunner` and may configure cache
policy.

<!-- skills-check: example pattern-worktrees -->

```ts
import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'worktrees',
  version: '2',
  input: z.object({ items: z.array(z.string()).max(8) }),
  output: z.object({ commit: z.string(), conflicts: z.array(z.string()) }),
  profiles: { editor: { extends: 'edit' } },
  async run(ctx, input) {
    const changes = await ctx.map(
      'items',
      input.items,
      { concurrency: 2, key: (item) => ctx.id(item) },
      async (item) => {
        const result = await ctx.codex.text('edit', {
          profile: 'editor',
          worktree: true,
          prompt: `Implement: ${item}`,
        });
        if (!result.worktree) throw new Error('Missing isolated change');
        return result.worktree;
      },
    );
    const result = await ctx.merge('integrate', changes);
    return { commit: result.commit, conflicts: result.conflicts.flatMap((c) => c.files) };
  },
});
```

**Cost:** one editing call per item plus opted-in retries; local Git preparation/capture/integration
makes no model calls. Each attempt gets a fresh detached checkout from its saved base. `ctx.merge`
integrates in input order into a run-owned ref; the source checkout is unchanged. Conflicts are data
and conflicting inputs are skipped. Use source commit IDs as well as filenames when designing a
repair loop: some structural conflicts have no path list. Default cleanup removes caches after
success and retains commit pins. **Supersession:** runtime isolation in
[#59](https://github.com/plx/quiet-choir/issues/59) replaces the manual helper and its dirty
retries. For shared write/test/fix handles, retention, explicit checkout publication, and
source-free cleanup, read [worktrees](worktrees.md).

## Polling and deadlines

**Rule:** if the body does not branch on an observation, it is not a step. Use `ctx.now` for a
recorded clock anchor and `ctx.poll` for read-only readiness checks. This example reads an absolute
status file containing `pending`, `success`, or `failure`; have its producer replace it atomically.
Its `onError` policy tolerates up to three consecutive `ENOENT` errors from a producer that deletes
and rewrites the file instead, and fails at once on anything else. Use `ctx.step` for a snapshot or
a selection over changing state, with an occurrence ID derived from replayed data. An incomplete
collection is an error, never “no work left.”

<!-- skills-check: example pattern-polling -->

```ts
import { readFile } from 'node:fs/promises';
import { defineWorkflow, z } from '../../src/index.js';

const Terminal = z.enum(['success', 'failure']);
// A producer that deletes and rewrites the file can briefly leave it missing.
const missing = (error: unknown) => (error as { code?: unknown }).code === 'ENOENT';
export default defineWorkflow({
  name: 'polling',
  version: '3',
  input: z.object({ file: z.string(), ms: z.int().min(1).max(60_000) }),
  output: z.enum(['success', 'failure', 'timeout']),
  async run(ctx, input) {
    const deadline = (await ctx.now('started-at')) + input.ms;
    const result = await ctx.poll('wait', {
      input: { file: input.file },
      schema: Terminal,
      deadline,
      every: 100,
      onError: { tolerate: 3, classify: (error) => (missing(error) ? 'transient' : 'fatal') },
      async observe({ signal }) {
        const state = (await readFile(input.file, { encoding: 'utf8', signal })).trim();
        if (state === 'success' || state === 'failure') return { done: true, value: state };
        if (state !== 'pending') throw new Error('Unknown check status');
        return { done: false, note: { state } };
      },
    });
    return result.by === 'deadline' ? 'timeout' : result.value;
  },
});
```

**Cost:** one clock step and one wait record, regardless of check count. Progress overwrites its
check count, last note, and next check time; only the terminal value determines the branch. There
are no agent calls. The demo's 100 ms interval stays in-process; an interval above 1000 ms parks
when no active sibling remains. Use `workflow tick` to resume when due, or `--wait-mode block` to
keep the process alive. Existing execution diagnostics can still grow across resumes.

`ctx.sleepUntil('release-at', deadline)` uses an absolute deadline from input or `ctx.now`.
`ctx.sleep('pause', ms)` pins a relative timeout once. Never compute a changing sleep duration from
`Date.now()` in the body. For competing signal/poll/deadline sources, use one `ctx.wait`: recorded
on-time signal wins, then a final poll (even after a missed deadline), then deadline. Never use
`Promise.race` over durable operations; replay completion order is not the original timing.
Observers must be read-only and cannot call context operations. Put reconciled writes in `ctx.step`.
See [durable waits](waits.md) for suspension, tick, and notifications.

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

Default reuse copies unchanged steps whose earlier causes were copied too. Add `--reuse matching`
for matching effects launched after a change, or `--invalidate 'answer/2'` to force an otherwise
reusable answer live. Omit input to inherit it. See [recovery](durability.md#choose-a-recovery-path)
for source edits and schema compatibility. **Cost:** only non-reused agent calls; a fresh run
without fork reuse repeats all calls. **Supersession:** manual output salvage was superseded by
implemented [#41](https://github.com/plx/quiet-choir/issues/41).

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
profile when appropriate; omitted models use native defaults under the chosen isolation mode. Keep
the schema small and put semantic constraints in the extraction prompt too.

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

## Human review

**Rule:** create a plan once, bind approval to its revision and content, and continue the same run.
The `ask`/`approve` effect saves the question and suspends only after active siblings finish. The
[operator loop](operating-runs.md#answer-a-suspended-run) delivers a schema-valid human answer and
resumes without changing input. This replaces returning a plan and starting another run with
`apply:true`, which could regenerate a different plan. No application or file edits happen in this
small recipe; an applying workflow must use the same saved `plan` after the approval branch.

<!-- skills-check: example pattern-human-review -->

```ts
import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'human-review',
  version: '1',
  input: z.object({ task: z.string(), revision: z.string() }),
  output: z.object({ approved: z.boolean(), plan: z.string() }),
  async run(ctx, input) {
    const plan = await ctx.codex.value('plan', {
      prompt: `Propose a short plan for ${input.task}; do not edit files.`,
    });
    const decision = await ctx.approve(ctx.id('approve', input.revision), {
      prompt: 'Accept this plan?',
      title: 'Plan review',
      details: Buffer.from(plan).subarray(0, 16_000).toString('utf8'),
      subject: { revision: input.revision, plan },
      audience: 'human',
    });
    return { approved: decision.approved, plan };
  },
});
```

**Cost:** one read-only planning call, one human decision, and zero repeated calls on compatible
resume. The fixture suspends, supplies an answer, fails the workflow tail, and proves that both plan
and decision replay. Await context operations: raw timers or detached I/O are invisible to
quiescence. Suspension does not enter `catch` or execute body `finally` blocks. An abandoned
question becomes `withdrawn` when the body completes; normal failures retain waiting questions.

## Commands and test verdicts

Run a trusted argv directly and branch on its actual exit code. With `onError: 'return'`, a failed
exit, signal or timeout becomes a settled result that replays on resume and keeps the exit code and
output tails; cancellation still rejects. Do not `try/catch` instead: resume reruns a caught
command. These commands have operator privileges. Agent-proposed commands need approval bound to
their saved plan before this call.

<!-- skills-check: example pattern-command-verdict -->

```ts
import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'command-verdict',
  version: '1',
  input: z.object({ argv: z.tuple([z.string().min(1)], z.string()) }),
  output: z.object({ green: z.boolean(), code: z.number().nullable() }),
  async run(ctx, input) {
    const result = await ctx.exec('prove', input.argv, { onError: 'return' });
    if (result.ok) return { green: true, code: result.value.code };
    return { green: false, code: result.error.code ?? null };
  },
});
```

## File snapshots and publication

Snapshot existing text, change it in code, and publish with an optimistic baseline guard. The write
receipt stores hashes, not content. Replaying the snapshot uses saved bytes. Concurrent unrelated
writers still need isolation/coordination.

<!-- skills-check: example pattern-file-update -->

```ts
import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'file-update',
  version: '1',
  input: z.object({ file: z.string(), prefix: z.string() }),
  output: z.object({ path: z.string(), sha256: z.string() }),
  async run(ctx, input) {
    const before = await ctx.readFile('snapshot', input.file);
    return ctx.writeFile('publish', input.file, input.prefix + before.content, {
      ifMatch: before.sha256,
    });
  },
});
```

## Hash guard for mutation

Preserve a regular UTF-8 file in a Git repository, including uncommitted CRLF bytes. Code restores
after one journaled body outcome. The body success or ordinary failure is terminal for this guard
ID; resume can retry a failed restore without rerunning it. Hard kill/cancellation is not rollback
or restore-before-body-retry. The caller supplies a trusted command; no agent calls are needed.

<!-- skills-check: example pattern-guard-mutation -->

```ts
import { defineWorkflow, guardFile, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'guard-mutation',
  version: '1',
  input: z.object({ file: z.string(), argv: z.tuple([z.string().min(1)], z.string()) }),
  output: z.number().nullable(),
  async run(ctx, input) {
    return guardFile(
      ctx,
      'mutation',
      input.file,
      async () => {
        const result = await ctx.exec('test', input.argv, { onError: 'return' });
        return result.ok ? result.value.code : (result.error.code ?? null);
      },
      { version: JSON.stringify(input.argv) },
    );
  },
});
```

## GitHub snapshots through gh

Use the installed `gh` authentication and an instance-qualified `HOST/OWNER/REPO`. Completed
snapshots replay; changing state needs fresh IDs or a read-only poll observer. This is a read
example, not a GitHub write authorization. Environment credentials remain inherited; do not put
tokens in argv.

<!-- skills-check: example pattern-github-snapshot -->

```ts
import { defineWorkflow, z } from '../../src/index.js';

export default defineWorkflow({
  name: 'github-snapshot',
  version: '1',
  input: z.object({ repo: z.string(), pr: z.int().positive() }),
  output: z.object({ headRefOid: z.string(), state: z.string() }),
  async run(ctx, input) {
    return ctx.exec.json(
      'pr-snapshot',
      ['gh', 'pr', 'view', String(input.pr), '-R', input.repo, '--json', 'headRefOid,state'],
      { schema: z.object({ headRefOid: z.string(), state: z.string() }) },
    );
  },
});
```

Full [command/file contracts](commands-files.md) cover caps, identity, process ownership, and
rehearsal.

## Traps

The original prototype made several of these fail only during replay. Current guards and APIs catch
or support more cases; the table describes the current runtime, not the old failure modes.
[Inspection](inspection.md#match-a-symptom-to-its-next-action) covers exact error templates. Rows
marked with a rule code are also reported before the run by the [durability lint](#durability-lint).

| Tempting code                                                                               | Current consequence                                                                                                               | Use instead                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catch a throwing durable call, then select a fallback or sentinel                           | The failed call can heal on resume and change a completed branch/input                                                            | [Latch](#latch-an-outcome) with `onError:'return'`, or fail and resume                                                                                              |
| Retry by incrementing IDs (`ask/0`, `ask/1`)                                                | An earlier call can heal and bypass later recorded effects                                                                        | Same-ID `retry` as in [latch](#latch-an-outcome)                                                                                                                    |
| Catch a map and assume its failure is a durable quorum decision                             | Catching no longer poisons the whole run, but replay can change an unjournaled decision                                           | [Tolerant panel](#failure-tolerant-panel); use [drain](#cross-harness-fan-outfan-in) for retryable failure                                                          |
| Race durable calls with `Promise.race` ([QC004](#qc004))                                    | Replay completion order can choose another branch; losing effects still need ownership/draining                                   | [Use one wait](#polling-and-deadlines) for readiness/deadlines, or an agent `timeoutMs` with `onError:'return'` for timeout decisions; do not race durable branches |
| Compute a sleep duration/deadline from a live body `Date.now()` ([QC002](#qc002))           | A later execution changes its dependency/identity                                                                                 | [Recorded clock and polling](#polling-and-deadlines)                                                                                                                |
| Read time/env/files/git diff in the body and place them in prompts ([QC002](#qc002))        | Replay sees changed inputs despite unchanged workflow input                                                                       | Record the read in a local step, as in [polling](#polling-and-deadlines), then build prompts from saved values                                                      |
| Supply undefined data indiscriminately                                                      | Undefined object members are omitted; roots, array elements/holes, classes, and non-JSON values still fail                        | [Small JSON extraction](#work-then-extract); filter arrays or use null deliberately                                                                                 |
| Use unrepresentable schemas (`z.void`, `z.undefined`, dates/bigints/transforms)             | Call-time JSON Schema conversion can fail even after top-level `validate`                                                         | [Work, then extract](#work-then-extract) with JSON shapes and string dates; [rehearse](#rehearse-for-free) the reached path                                         |
| Ban all Codex `.optional()` fields or assume strict mode accepts them unchanged             | Default compat now encodes optionals/arrays/records; strict mode still has narrower wire rules                                    | The [flat extraction schema](#work-then-extract) and [current Codex schema rules](codex.md#structured-output-and-protocol)                                          |
| Return a wider type than the schema                                                         | Schema-first typing now rejects wider callbacks before import; local validation still matters                                     | [Typed extraction](#work-then-extract) and [rehearsal](#rehearse-for-free); use the actual output schema, not casts                                                 |
| Start `void` chains or ignore a durable promise ([QC001](#qc001))                           | Owned operations drain, ignored failures reject, and new operations after closure are refused; unowned async chains remain unsafe | Await each stage as in the [per-item pipeline](#per-item-pipeline)                                                                                                  |
| Call `ctx.step`/`ctx.exec` inside a step `run` or a poll `observe`/`done` ([QC003](#qc003)) | The runtime rejects the nested durable call when the callback runs, after earlier effects already ran                             | The callback's own `context.exec`/`context.exec.json`, or move the call into the workflow body                                                                      |
| Reuse a literal effect ID, or put one in a loop ([QC005](#qc005))                           | `Duplicate step ID` at the second use                                                                                             | Unique IDs, `ctx.id(...)` per item, `ctx.within`/`ctx.scope`, or a named `ctx.map` as in the [per-item pipeline](#per-item-pipeline)                                |
| Raise limits by changing completed semantic inputs/model/tool grants                        | Limits/retry are now policy; semantic changes still invalidate terminal identity                                                  | Keep the [bounded loop](#bounded-reviewrevise), raise authorized sticky limits, and use [fork reuse](#salvage-an-old-run) for semantic edits                        |
| Run parallel editing calls in one checkout                                                  | Filesystem edits race and checkpoints cannot roll them back                                                                       | [Worktree per item](#worktree-per-item), with explicit ownership and grants                                                                                         |

For a tail-only code fix, first inspect what completed, then use explicit code acceptance or a fork.
A new ID alone repays agent calls; it does not imply salvage. Never treat paid effects as rolled
back because a checkpoint or schema validation failed.

### Durability lint

`workflow validate` runs a static lint after a clean type check and fails with exit 4
(`load.typecheck`) on any finding. `execute`, `resume`, `answer --resume`, `tick`, `check-resume`
and the runner behind `start` (in its log) print the same findings as warnings and continue;
`list-defs` lists such definitions and warns when it validates them. Each finding is
`path:line:col - error QCnnn: message` on stderr, or a
`{rule, category, file, line, column, message}` entry in the JSON `diagnostics`. Receivers are
resolved by type, so a renamed context parameter is still checked and an unrelated object with a
`step` method is not.

#### QC001

An effect, `ctx.scope` or `ctx.phase(title, body)` promise that is discarded: `void`ed or left as a
statement, also through `.then`/`.catch`/`.finally`. The runtime drains it and fails the run if it
rejects, but the workflow never sees its result. Await it, or collect it in `Promise.all`.

#### QC002

`Date.now()`, an argument-less `new Date()` or `Date()`, `Math.random()`, `performance.now()`,
`crypto.randomUUID()`, `process.env` or an `fs` `*Sync` call in the workflow body, outside a step
`run`, a poll `observe`/`done` and a poll `onError` callback. Use `ctx.now`, `ctx.readFile`,
`ctx.exec` or a `ctx.step`, or pass the value as workflow input.

#### QC003

A durable call (`ctx.step`, `ctx.exec`, an agent call and the other effects) lexically inside a step
`run`, a poll `observe`/`done` or a poll `onError` callback. Use the callback's `context.exec`, or
move the call into the body.

#### QC004

`Promise.race` or `Promise.any` over durable calls, directly or through a variable or an array built
from them. Use one [`ctx.wait`](#polling-and-deadlines) for a durable choice.

#### QC005

A literal effect ID (a string or plain template literal) on the root context (`ctx`, `ctx.claude`,
`ctx.codex`, `ctx.agent(name)`, `ctx.exec`, `ctx.exec.json`) used twice in one ID namespace, or
inside a loop: `for`, `while`, `do`, an array callback (`map`, `forEach`, `reduce`, `sort`, ...), or
`Array.from` with a mapper. The workflow function, a `ctx.scope` callback, a named-map mapper and a
child workflow each start a namespace. Reuse in different branches of one `if`/`else`, `?:` or
`switch`, or in an `if` branch that ends in `return`/`throw` versus code after it, is not reported.
Use `ctx.id(...)`, `ctx.within`, `ctx.scope` or a named map.

#### Suppress a finding

Put `// quiet-choir-ignore QC002 <reason>` (several rules: `QC002, QC005`) on its own line directly
before the reported line. It silences only the listed rules for findings that start on the next
line. The engine accepts a missing reason; this repository's `npm run durability:check` requires
one.

#### Limitations

The lint is lexical and per function. It does not follow helpers across calls, so a hazard inside a
function called from a callback is judged where it is written. It does not check literal `ctx.scope`
or `ctx.within` prefixes inside loops, IDs on a `ctx.within(...)` context, or reads through
`fs/promises` and `child_process`. Runtime guards still catch duplicate IDs and nested effects when
they execute.

## Workflow Lab acceptance recipes

[Batch 02](https://github.com/plx/quiet-choir/tree/main/comparisons/batches/02-idiomatic-ports)
expands these small recipes into six strict workflows using the same pinned upstream originals as
Batch 01. Its ports, notes, generated verification and paired F1–F5 matrix are maintained together.
The verifier uses inert agent replies with real temporary Git repositories, commands and SIGKILLs.
It measures replay and filesystem contracts, not agent quality or real billing savings.

| Port                     | Recipe demonstrated                                                                          | Fixture evidence                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `release-notes`          | Pin a Git manifest, constrain per-slice vocabularies, compute coverage and write exact bytes | Manifest equals Git; all calls are read-only; interrupted publication reuses completed calls         |
| `project-bootstrap`      | Approve a canonical saved plan, isolate writers, verify with command exits                   | Setter prompts match the approved plan; digests match; exit 7 prevents checkout publication          |
| `test-gap-filler`        | Keep a durable pristine snapshot and reconcile an interrupted mutation before retry          | Actual SIGKILL during a test, identity-checked orphan cleanup, byte-identical restoration            |
| `incident-investigation` | Use a Codex reader profile and independently check repository status                         | A deliberately dirty collector fails the run                                                         |
| `sdlc-orchestrator`      | Compose typed children and bind human redo answers to one stage                              | One run ID, saved child frames, stage-local answer, CLI exit 75 and inbox resume                     |
| `bug-hunt`               | Settle panels, retain missing votes and apply sticky admission gates                         | Failed skeptics stay undecided without another call; failed finders are never dry; higher-cap resume |

A plan digest must use canonical JSON: checkpoint transport may reorder object keys. Hashing plain
`JSON.stringify` output can change a reviewed plan's digest on replay even when its data is equal.
The mutation worker heals only pristine bytes or its own exact mutant; it refuses unknown external
edits. A `finally` block alone cannot recover from SIGKILL, and `guardFile` does not promise
restore-before-retry. Code and subprocesses still run with operator privileges.

When changing one of these primitives, update the corresponding Batch 02 port and fault row in the
same PR. The focused mutation port requires the caller to select a target and command; the compact
lifecycle children differ from the original specialist conductors. Their smaller call counts are not
evidence of equivalent work or model quality. See the per-port notes before copying a pattern.
