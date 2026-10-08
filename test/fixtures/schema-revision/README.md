# Record schema revision fixtures

`pre-revision-checkpoint.json` was generated with the source runtime (through `tsx`) at origin/main
`91a6d2f` (extracted with `git archive 91a6d2f src`), before run records carried a `schemaRevision`
(#167). It pins how a record written by a build without the field reads and resumes.

The generator ran this embedded definition with `runWorkflow`, state in a temporary directory, run
ID `pre-revision`, canonical cwd `/` and the fixed opaque source fingerprint `schema-revision`:

```ts
defineWorkflow({
  name: 'schema-revision',
  version: '1',
  input: z.null(),
  output: z.null(),
  async run(ctx) {
    await ctx.now('prepare');
    throw new Error('fixture tail');
  },
});
```

The run holds one completed local effect (`ctx.now('prepare')`) followed by a workflow-body failure
(`fixture tail`), so a resume with a body that no longer throws completes it without invoking
anything. `ctx.now` has a versioned identity (`now/1`) with no callback text, so the resume does not
depend on how a test transformer prints a callback. The journal was empty after the failure
compacted the snapshot, so only `run.json` is checked in. Stack paths are scrubbed to `/fixture/...`
and the file was formatted with Prettier; nothing else was edited. The read-view digest pinned in
`test/record-schema-revision.test.ts` was computed on the same unmodified main from this scrubbed,
formatted file.

`revision-one-checkpoint.json` was generated the same way at origin/main `33b6eac`, before the
`--max-window-utilization` gate (#168) changed the nested `runBudget` and `budgetStop` shapes in
revision 2. Its run ID is `revision-one`, and it ran this definition with `maxRunAgentAttempts: 0`
and a harness that throws if invoked, so it carries `schemaRevision: 1`, a two-cap `runBudget` and a
`maxRunAgentAttempts` `budgetStop` on step `call`:

```ts
defineWorkflow({
  name: 'schema-revision',
  version: '1',
  input: z.null(),
  output: z.null(),
  async run(ctx) {
    await ctx.now('prepare');
    await ctx.claude.text('call', { prompt: 'x' });
    return null;
  },
});
```

Stack paths are scrubbed to `/fixture/...` and the file was formatted with Prettier; its read-view
digest in `test/record-schema-revision.test.ts` was computed on the same unmodified main from this
file. No harness was invoked.

`revision-two-checkpoint.json` was generated the same way at origin/main `9d054b4`, before settled
child frames (#170) added the nested `onError` and `settled` fields to `children` in revision 3. Its
run ID is `revision-two`, and it ran this definition, so it carries `schemaRevision: 2`, one
completed declared child frame `child` owning the completed `child/stamp` effect, and a
workflow-body failure after the frame:

```ts
const child = defineWorkflow({
  name: 'stamp-child',
  version: '1',
  input: z.null(),
  output: z.null(),
  async run(ctx) {
    await ctx.now('stamp');
    return null;
  },
});
defineWorkflow({
  name: 'schema-revision',
  version: '1',
  input: z.null(),
  output: z.null(),
  children: [child],
  async run(ctx) {
    await ctx.workflow('child', child, null);
    throw new Error('fixture tail');
  },
});
```

The journal was empty, so only `run.json` is checked in. Stack paths are scrubbed to `/fixture/...`
and the file was formatted with Prettier; its read-view digest in
`test/record-schema-revision.test.ts` was computed on the same unmodified main from this file.

`revision-three-checkpoint.json` was generated the same way at origin/main `4c3ebf5`, before bounded
call-site Claude directories (#171) added the nested `claude.addDirRoots` profile field to
`capabilities` and the optional `addDirs` field to attempt request summaries in revision 4. Its run
ID is `revision-three`, and it ran this definition with the launch policy `[{ transcripts: 'off' }]`
(so no transcript path enters the record) and a stub harness whose `invoke` returns
`{ text: 'ok', sessionId: null }`. It carries `schemaRevision: 3`, a declared `reader` profile with
a static `claude.addDirs`, one completed Claude call `read` with its request summary and identity,
and a workflow-body failure after it:

```ts
defineWorkflow({
  name: 'schema-revision',
  version: '1',
  input: z.null(),
  output: z.null(),
  profiles: { reader: { extends: 'readonly', claude: { addDirs: ['docs'] } } },
  async run(ctx) {
    await ctx.claude.text('read', { prompt: 'x', profile: 'reader' });
    throw new Error('fixture tail');
  },
});
```

The journal was empty, so only `run.json` is checked in. Stack paths are scrubbed to `/fixture/...`
and the file was formatted with Prettier; its read-view digest in
`test/record-schema-revision.test.ts` was computed on the same unmodified main from this file. The
same main also produced the golden `profileGrantDigest` values pinned in `test/profiles.test.ts`.

`revision-four-checkpoint.json` was generated the same way at origin/main `7fa2348`, before
tolerated poll errors (#223) added the event type `wait.tolerated` to the nested `events` shape in
revision 5. Its run ID is `revision-four`, and it ran this definition (`pollIdentityKey` from
`src/workflow/runtime/poll-identity.ts`, so the wait's identity does not depend on how a test
transformer prints the observer), so it carries `schemaRevision: 4`, `phase` and `log` events, and a
suspended poll wait `ready` whose first check failed and was tolerated (`lastError` with
`consecutive: 1`, no `wait.tolerated` event):

```ts
defineWorkflow({
  name: 'schema-revision',
  version: '1',
  input: z.null(),
  output: z.unknown(),
  async run(ctx) {
    ctx.phase('watch');
    ctx.log('waiting', { n: 1 });
    return ctx.wait('ready', {
      poll: {
        input: null,
        schema: z.literal('ok'),
        every: 60_000,
        onError: { tolerate: 3 },
        observe: () => Promise.reject(new Error('HTTP 502: Bad Gateway')),
        [pollIdentityKey]: { helper: 'schema-revision', version: 1 },
      },
    });
  },
});
```

The run suspended with an empty journal, so only `run.json` is checked in; it has no stack paths,
and the file was formatted with Prettier. Its read-view digest in
`test/record-schema-revision.test.ts` was computed on the same unmodified main from this file. The
resume tests pin a clock after the saved `nextCheckAt`.

`revision-five-checkpoint.json` was generated the same way at origin/main `6a05a54`, before per-cwd
project instruction detection (#226) added the top-level `projectInstructions` field in revision 6.
Its run ID is `revision-five`, and it ran this definition with the launch policy
`[{ transcripts: 'off' }]` and a custom harness whose `metadata` returns binary `codex`, version
`0.157.1` and two `instructionSources` (a user entry `/home/fixture/.codex/AGENTS.md` with digest
`a` repeated 64 times and a project entry `/AGENTS.md` with digest `b` repeated 64 times, as builds
before revision 6 recorded them), and whose `invoke` returns `{ text: 'ok', sessionId: null }` for
step `read` and rejects with `fixture call failed` for step `write`:

```ts
defineWorkflow({
  name: 'schema-revision',
  version: '1',
  input: z.null(),
  output: z.null(),
  async run(ctx) {
    await ctx.codex.text('read', { prompt: 'x' });
    await ctx.codex.text('write', { prompt: 'y' });
    return null;
  },
});
```

It carries `schemaRevision: 5`, the `harnesses.codex` entry with both sources, one completed Codex
call `read` and the failed call `write`, so a resume replays `read` and runs `write` again. The
journal was empty, so only `run.json` is checked in. Stack paths are scrubbed to `/fixture/...` and
the file was formatted with Prettier; its read-view digest in `test/record-schema-revision.test.ts`
was computed on the same unmodified main from this file.

`revision-six-checkpoint.json` was generated the same way at origin/main `2c6be06`, before
repository skill and Claude instruction detection (#227) added the instruction source kind
`claude-md` to the nested `harnesses` and `projectInstructions` shapes in revision 7. Its run ID is
`revision-six`, and it ran the revision-five definition above with the launch policy
`[{ transcripts: 'off' }]` and a custom harness whose `projectInstructions` returns two project
sources (`/AGENTS.md`, kind `agents`, digest `b` repeated 64 times, and
`/.agents/skills/review/SKILL.md`, kind `skill`, digest `d` repeated 64 times), and whose `invoke`
returns `{ text: 'ok', sessionId: null }` for step `read` and rejects with `fixture call failed` for
step `write`. It carries `schemaRevision: 6`, a `projectInstructions` entry for harness `codex` and
cwd `/` with both sources, one completed Codex call `read` and the failed call `write`. The journal
was empty, so only `run.json` is checked in. Stack paths are scrubbed to `/fixture/...` and the file
was formatted with Prettier; its read-view digest in `test/record-schema-revision.test.ts` was
computed on the same unmodified main from this file.

`revision-seven-checkpoint.json` was generated the same way at origin/main `61fb951`, before child
frame redefinition (#240) added the nested `redefinitions` history to `children` in revision 8. Its
run ID is `revision-seven`, and it ran this definition, so it carries `schemaRevision: 7`, one
completed local effect `prepare` and one failed declared child frame `kid` (`kid@1`, no effects)
that failed the run:

```ts
const child = defineWorkflow({
  name: 'kid',
  version: '1',
  input: z.null(),
  output: z.null(),
  run: () => Promise.reject<null>(new Error('fixture tail')),
});
defineWorkflow({
  name: 'schema-revision',
  version: '1',
  input: z.null(),
  output: z.null(),
  children: [child],
  async run(ctx) {
    await ctx.now('prepare');
    await ctx.workflow('kid', child, null);
    return null;
  },
});
```

The journal was empty, so only `run.json` is checked in. Stack paths are scrubbed to `/fixture/...`
and the file was formatted with Prettier; its read-view digest in
`test/record-schema-revision.test.ts` was computed on the same unmodified main from this file.

`revision-eight-checkpoint.json` was generated the same way at origin/main `b707169`, before
registered harness `sensitiveOptions` (#247) added the nested `redacted.harnesses` profile field to
`capabilities` in revision 9. Its run ID is `revision-eight`, and it ran this definition with the
launch policy `[{ transcripts: 'off' }]` and `adapters: { vault }`, whose `invoke` returns
`{ text: 'ok', sessionId: null }`:

```ts
const vault = defineHarness({
  name: 'vault',
  revision: 1,
  options: z.object({ prompt: z.string(), token: z.string().optional() }),
  capabilities: { structuredOutput: 'none' },
  access: () => 'none',
});
defineWorkflow({
  name: 'schema-revision',
  version: '1',
  input: z.null(),
  output: z.null(),
  harnesses: [vault],
  profiles: { keeper: { harnesses: { vault: { token: 'fixture-token' } } } },
  async run(ctx) {
    await ctx.agent('vault').text('read', { prompt: 'x', profile: 'keeper' });
    throw new Error('fixture tail');
  },
});
```

It carries `schemaRevision: 8`, the plaintext `token` under
`capabilities.profiles.keeper.harnesses`, one completed `vault` call `read` and a workflow-body
failure after it; `fixture-token` appears nowhere else in the record. The journal was empty, so only
`run.json` is checked in. Stack paths are scrubbed to `/fixture/...` and the file was formatted with
Prettier; its read-view digest in `test/record-schema-revision.test.ts` was computed on the same
unmodified main from this file.

`revision-nine-checkpoint.json` was generated the same way at origin/main `8acf024`, before
cause-aware next entries (#284) added the top-level `recoveryCause` in revision 10. Its run ID is
`revision-nine`, and it ran this definition with the launch policy `[{ transcripts: 'off' }]` and a
harness whose `invoke` throws if called:

```ts
defineWorkflow({
  name: 'schema-revision',
  version: '1',
  input: z.null(),
  output: z.null(),
  async run(ctx) {
    await ctx.now('prepare');
    await ctx.claude.text('edit', { prompt: 'x', profile: 'edit' });
    return null;
  },
});
```

It carries `schemaRevision: 9`, one completed local effect `prepare`, a grant failure on `edit` (the
built-in `edit` profile requires a write grant, so no harness was invoked) and the grant
`recoveryHint`, but no `recoveryCause`. The journal was empty, so only `run.json` is checked in.
Stack paths are scrubbed to `/fixture/...` and the file was formatted with Prettier; its read-view
digest in `test/record-schema-revision.test.ts` was computed on the same unmodified main from this
file.

`revision-ten-checkpoint.json` was generated the same way at origin/main `7d02b96`, before
owner-side inbox rejections (#289) added the nested optional `issues` list to `question.rejections`
in revision 11. Its run ID is `revision-ten`, and it ran this definition, then delivered the answer
`3` with `writeAnswer` (`by: 'agent:fixture'`; the writer's JSON Schema check cannot see the
refinement) and resumed once so the owner quarantined the delivery:

```ts
defineWorkflow({
  name: 'schema-revision',
  version: '1',
  input: z.null(),
  output: z.number(),
  run: (ctx) =>
    ctx.ask('even', {
      prompt: 'Even number?',
      schema: z.number().refine((n) => n % 2 === 0, 'Must be even'),
    }),
});
```

It carries `schemaRevision: 10` and a suspended `ask` `even` with one plain-text rejection
(`{ at, error, file }`, the multi-line Zod JSON message, no `issues`). The journal was empty, so
only `run.json` is checked in. It has no stack paths, and the file was formatted with Prettier; its
read-view digest in `test/record-schema-revision.test.ts` was computed on the same unmodified main
from this file. No harness or inference was used.

`record-keys.json` lists the top-level run-record keys of each schema revision. Adding or changing a
persisted run-level field adds a revision there and bumps `SUPPORTED_SCHEMA_REVISION`; a revision
that only changes a nested shape repeats the previous key list. See `docs/storage.md`.

No inference was used and no test contacts an upstream model service.
