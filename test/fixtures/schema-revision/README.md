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

`record-keys.json` lists the top-level run-record keys of each schema revision. Adding or changing a
persisted run-level field adds a revision there and bumps `SUPPORTED_SCHEMA_REVISION`; a revision
that only changes a nested shape repeats the previous key list. See `docs/storage.md`.

No inference was used and no test contacts an upstream model service.
