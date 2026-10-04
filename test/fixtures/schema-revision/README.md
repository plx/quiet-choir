# Record schema revision fixtures

`pre-revision-checkpoint.json` was generated with the source runtime (through `tsx`) at origin/main
`91a6d2f`, before run records carried a `schemaRevision` (#167). It pins how a record written by a
build without the field reads and resumes.

The generator ran this embedded definition with `runWorkflow`, state in a temporary directory, run
ID `pre-revision`, canonical cwd `/` and the fixed opaque source fingerprint `schema-revision`:

```ts
defineWorkflow({
  name: 'schema-revision',
  version: '1',
  input: z.null(),
  output: z.null(),
  async run(ctx) {
    await ctx.step('prepare', { input: { n: 1 }, schema: z.number(), run: () => 2 });
    throw new Error('fixture tail');
  },
});
```

The run holds one completed local step (`prepare`, output `2`) followed by a workflow-body failure
(`fixture tail`), so a resume with a body that no longer throws completes it without invoking
anything. The journal was empty after the failure compacted the snapshot, so only `run.json` is
checked in. Stack paths are scrubbed to `/fixture/...` and the file was formatted with Prettier;
nothing else was edited. The read-view digest pinned in `test/record-schema-revision.test.ts` was
computed on the same unmodified main from this scrubbed, formatted file.

`record-keys.json` lists the top-level run-record keys of each schema revision. Adding or changing a
persisted run-level field adds a revision there and bumps `SUPPORTED_SCHEMA_REVISION`; see
`docs/storage.md`.

No inference was used and no test contacts an upstream model service.
