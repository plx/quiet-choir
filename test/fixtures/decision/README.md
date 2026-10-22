# Legacy decision helper fixtures

`choose-v1-checkpoint.json` was generated with the source runtime (through `tsx`) at origin/main
`318b5e2` (extracted with `git archive 318b5e2 src`), before `decision(ctx, transport).choose` was
deprecated (#655). It pins that a `decision/1` step written by the helper before the deprecation
replays under the current runtime without calling its transport.

The generator ran this embedded definition with `runWorkflow`, state in a temporary directory, run
ID `choose-v1`, canonical cwd `/` and the fixed opaque source fingerprint `decision-choose`:

```ts
defineWorkflow({
  name: 'decision-choose',
  version: '1',
  input: z.null(),
  output: z.unknown(),
  async run(ctx) {
    await decision(ctx, () =>
      Promise.resolve({
        output: { answer: 'fix', probabilities: { fix: 0.75, skip: 0.25 } },
        usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.01 },
      }),
    ).choose('pick', { state: { ticket: 1 }, question: 'Route?', answers: ['fix', 'skip'] });
    throw new Error('fixture tail');
  },
});
```

The run holds one completed `decision/1` step (`pick`, `meta`
`{ integration: 'decision', op: 'choose' }`) followed by a workflow-body failure (`fixture tail`),
so a resume with a body that no longer throws completes it from the record. The step's identity is
the versioned constant `decision/1` with no callback text, so the resume does not depend on how a
test transformer prints a callback. The journal was empty after the failure compacted the snapshot,
so only `run.json` is checked in. Stack paths are scrubbed to `/fixture/...` and the file was
formatted with Prettier; nothing else was edited. `test/decision-choose-deprecation.test.ts`
installs it and resumes it with a transport that throws.

No inference was used and no test contacts an upstream decision service.
