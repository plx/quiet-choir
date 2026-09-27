# Storage compatibility captures

`v1.json` was produced by `runWorkflow` and `store.ts` from commit `a6a7b82` using the current
pinned Zod dependency. It contains a completed local callback (`7`), a fake Claude response
(`legacy answer`, two input/three output tokens and zero cost), a zero-duration durable sleep, then
a workflow-tail failure. No native CLI, credentials, or inference were involved.

The embedded workflow used name `legacy-v1`, version `1`, `z.null()` input, `z.string()` output,
opaque fingerprint `legacy-source`, run ID `legacy`, and synthetic cwd
`/quiet-choir/legacy-project`. Its effect contracts are exercised in `test/journal.test.ts`. The
capture retains original format-one fingerprints and bytes; tests copy it to temporary state before
migration.
