# 0059: Keep poll callback identity as loaded source text

- Status: accepted
- Issue: #321
- Amends the poll identity of [ADR 0020](0020-durable-waits-and-tick.md). Applies
  [ADR 0005](0005-step-identity-and-policy.md) and [ADR 0006](0006-code-change-recovery.md) to
  waits.

## Context

A wait's identity includes a digest of `Function.prototype.toString` of a poll's `observe` (of
`done` for a command poll), so it depends on how the loader that imported the callback prints it.
The CLI loads workflows through `tsx`. A test runner or embedder loads them through Vitest's
transform, Node's type stripping or a compiled build. A waiting poll started under one loader and
resumed under another reports "wait changed" although nothing was edited, and the message gave no
hint why.

A probe of one callback under `tsx`, Vitest 4 (oxc) and Node's type stripping produced three texts
that differ beyond whitespace and comments: quote style, `void 0` against `undefined`, constant
folding (`` `v ${x}` + 0x10 `` becomes `` `v ${x}16` `` under `tsx` and `+ 16` under Vitest), number
literal spelling and optional semicolons.

Local steps, `ctx.map` mappers and guard bodies hit the same text difference but can be recovered:
ADR 0006 lets the author accept a code change and keep completed effects. A waiting poll cannot be
recovered that way, because ADR 0020 pins waiting and completed wait identities even with
acceptance. The author's only options today are the ones listed below.

## Decision

Keep the digest unchanged: a poll's `observe` or `done` identity stays the digest of the callback's
source text as loaded. Existing records stay byte-identical, and `wait-schema.ts` does not change.
Two additions make the behavior visible.

- **Diagnose.** When a prior wait record exists and its fingerprint differs, the runtime recomputes
  the identity with the prior record's `wait.request.poll.observe` digest substituted into the new
  request. When that equals the prior fingerprint, the callback text is the only difference, and the
  refusal appends a hint after its unchanged sentence. Every other change keeps the original
  message, including a real edit that also changes another field. The check is pure and synchronous,
  and a record without `wait.request.poll` gets the plain message.
- **Document.** The TSDoc on `PollSource.observe` and `CommandPollSource.done`,
  [Callback source and loaders](../waits.md#callback-source-and-loaders), and both skill copies
  state the dependence, the symptom and the recovery paths.

## Alternatives considered

- **Normalize with a tokenizer (strip whitespace and comments).** Rejected. The probe shows the
  printings differ in tokens, not only in whitespace and comments, so a tokenizer cannot make them
  equal.
- **Canonical reprint (parse and re-emit through a bundled compiler).** Rejected. Every wait digest
  would then depend on that compiler's version, so a dependency bump would strand waiting polls the
  way a loader change does today. It would also change the digest of every recorded wait, so
  existing waiting polls would report "wait changed" on upgrade unless a dual-digest compatibility
  path were added. That is more risk than the problem justifies.
- **A public explicit identity option.** Deferred. Callback-free versioned identity is internal
  today: `identity: 'version'` for built-in steps (ADR 0005) and the internal `pollIdentityKey` for
  built-in poll helpers. Built-in helpers such as the GitHub waits already avoid the problem, and
  GitHub reviewer bots already accept an explicit `identity`. A public option would give up
  detection of real edits to the callback, which the ticket requires, so it is the follow-up if
  cross-loader resume becomes a real workflow need.

## Consequences

- A cross-loader resume of a waiting poll is still refused, now with a message naming the cause.
  Recovery: resume under the loader that started the run, fork the run (`--fork-from`,
  `RunOptions.forkFrom`; a fork waits afresh and reuses completed effects), or use a new wait ID.
  Tests that must cross loaders build the callback from fixed text, as `test/step-exec-workflow.ts`
  does.
- A bundled `tsx` or esbuild upgrade that changes how it prints a callback can strand a waiting poll
  started before the upgrade. Runs that finish before the upgrade are unaffected.
- The hint's check relies on whole-fingerprint equality, so it never claims a callback-only change
  when another identity field also changed.
- The loader dependence of local step callbacks, mappers, guard bodies and reviewer observers is
  unchanged and stays recoverable through ADR 0006.
