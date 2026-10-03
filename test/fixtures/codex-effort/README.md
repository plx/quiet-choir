# Codex effort compatibility checkpoints

Both checkpoints were generated with the source runtime (through `tsx`) at origin/main `c73138f`,
before `reasoningEffort` was renamed to `effort` (#341). Each holds one completed fake Codex call
followed by a workflow-body failure (`fixture tail`), canonical cwd `/` and a fixed opaque source
fingerprint. Stack and transcript paths are scrubbed to `/fixture/...`; no transcript file exists.

- `pre-effort-checkpoint.json` (fingerprint `effort-compatibility`, run `pre-effort`) declares
  `scout: { extends: 'text', codex: { reasoningEffort: 'low' } }`, so its capability manifest
  carries the old key. Step `tuned` runs `ctx.codex.text('tuned', { prompt: 'a', profile: 'scout' })`
  under the saved policy rule `{ kind: 'codex', match: 'tuned', reasoningEffort: 'high' }` with
  `allowModelOverride`, so its attempt records `reasoningEffort: 'high'`.
- `pre-shared-effort-checkpoint.json` (fingerprint `effort-shared`, run `pre-shared-effort`) runs
  `ctx.codex.text('shared', { prompt: 'a', effort: 'low' })` with the old shared Codex `effort`,
  whose identity was `option.effort`. It pins the documented one-time identity change.

No test contacts an upstream model service.
