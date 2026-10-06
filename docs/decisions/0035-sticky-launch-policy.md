# 0035: Sticky launch policy in the run's launch metadata

- Status: accepted
- Issue: #136
- Builds on the harness configuration digest (#106) and the emitted `next` entries (#135).

## Context

A run started with `--harness fixture:f.json` or `--wait-mode block` lost both on resume.
`resumeCommand` and `next` entries omitted them, `workflow tick` could not select a fixture at all,
and a plain `resume` or `tick` of a fixture run fell back to the CLI harness and was refused for the
kind change. The record kept only `harness.kind` and, since #106, a digest of the CLI harness
configuration. The configuration itself may hold sensitive values and stays unrecorded.

## Decision

The CLI records a non-secret launch policy as the optional `WorkflowLaunch.policy`:
`{harness: {kind: 'cli' | 'fixture', fixtures?: [{name?, path, sha256}]}, waitMode}`. Fixture paths
are absolute (resolved against the command's working directory, as `--harness` already does), and
`sha256` digests the file's bytes. An unnamed entry is the global fixture and exists exactly when
the kind is `fixture`.

- **Where it lives.** `WorkflowLaunch` already holds the CLI-supplied "resume by ID" metadata. The
  policy is replaced only by an execution whose launch states one, so an explicit flag becomes the
  new sticky value. An execution whose launch has no policy keeps the recorded one, and
  `policy: null` clears it, which the CLI uses for a selection built from data. It is not part of
  the workflow fingerprint or of step identity, the field is optional, and `formatVersion` is
  unchanged. `src/workflow/runtime/model.ts` is untouched.
- **Inheritance.** `resume`, `execute --resume`, `answer --resume` and `tick` mark whether
  `--harness` was given (`inheritHarness`). Without it, the executor replaces the selection's kind
  and fixtures with the recorded ones before it builds any harness (rehearsal, fixture harness,
  accepted-replay preflight, adapters, configuration digest), keeping the invocation's
  `--harness-config`. Without `--wait-mode`, the recorded mode applies. A different kind still needs
  `--allow-harness-change`.
- **Configuration is not recorded.** Only its digest is (#106), so a run started with a custom
  `--harness-config` is refused by a plain resume or tick with a message naming `--harness-config`,
  and emitted commands never carry it.
- **Fixture changes warn.** A recorded fixture that is missing or unreadable fails with `usage.flag`
  and asks for an explicit `--harness`. Changed content is used with a warning naming the file and
  both digests, and the new digest is recorded. Fixtures only answer calls that have not completed;
  completed steps replay from the checkpoint, so editing a fixture between resumes is ordinary
  rehearsal iteration. A refusal could also be bypassed by the emitted `resumeCommand`, which passes
  `--harness` explicitly.
- **Tick suspends once.** Tick resumes every run with `waitModeOnce: 'suspend'`, which applies to
  that execution and leaves the recorded mode alone. Blocking one run's waits would hold the batch
  until its timeout; a later plain `resume` of a `block` run still blocks.
- **Emission.** `launchPolicyFlags` renders `--harness fixture:<abs>`,
  `--harness name=fixture:<abs>` and `--wait-mode block` for `resumeCommand` and every `resume`
  entry of `next`; defaults are omitted. `answerCommand` only delivers and carries none; forks are
  new launches.

## Consequences

- A plain `resume` of a run recorded by this build now uses its recorded selection rather than
  `cli`. Records without a policy (older builds, or runs no CLI execution launched) behave as
  before, and tick keeps forwarding its configuration only to runs that last executed with the CLI
  harness.
- An embedder execution whose launch has no policy keeps the recorded one (see the #258 amendment).
  A selection built from data rather than files (no recorded sources) records no policy, because a
  later resume could not reproduce it; the CLI reaches that state by passing `policy: null`.
- An older build reading a record with a policy ignores the field, and its next write drops it.

## Amendment: worktree flags (#152)

`--worktree-keep` and `--worktree-root` (on `execute`, `start` and `resume`) join the policy as an
optional `worktrees: { keep?, root? }`, with the root resolved to an absolute path. Only fields a
flag supplied are recorded, never the definition's `worktrees` values, so removing a flag later
cannot freeze a definition change into the record. Inheritance is per field: on every resume path
(`resume`, `execute --resume`, `answer --resume` and `tick`), an absent flag keeps the recorded
value. Tick therefore gets no worktree flags of its own; one per-tick value would apply a single
keep or root to every claimed run. The executor passes the effective fields as
`RunOptions.worktrees`, which override the definition, and `launchPolicyFlags` emits them on resume
commands. The policy schema is strict, so a build from before this amendment rejects a record whose
policy carries `worktrees`; that is acceptable for the 0.0.0 prototype, as when this ADR added the
policy.

## Amendment: embedder executions keep the policy (#258)

The first version replaced the whole launch on every execution, so an embedder whose
`RunOptions.launch` carried no policy erased what the CLI had recorded, and the next CLI resume fell
back to `cli` and suspend. `launch.policy` now merges three ways, as the `runBudget` caps do
([ADR 0053](0053-window-utilization-gate-suspends-until-reset.md)): absent keeps the recorded
policy, a `LaunchPolicy` replaces it, and `null` clears it. Every other launch field (`entrypoint`,
`tsconfig`, `sources`) is still replaced. `RunOptions.launch` takes the new `WorkflowLaunchOptions`
type; the record keeps `WorkflowLaunch` and never stores `null`, so the storage format,
`formatVersion`, `schemaRevision`, fingerprint and step identity are unchanged. A completed run's
replay returns before the record is touched and keeps the recorded launch, as before.

`null` exists because the CLI must still clear a policy it cannot reproduce. `launchPolicyOf`
returns no policy for a selection built from data, and if the old policy survived that execution,
the next plain resume would use a selection different from the one the run last ran under. The
executor therefore always states the policy and passes `null` when there is none.

One consequence: an embedder that resumes a CLI fixture run with a different harness kind now leaves
the fixture policy in the record, so a later plain CLI resume inherits the fixture selection and
needs `--harness` or `--allow-harness-change`. That is the run continuing as it started; an embedder
that wants the old behavior passes `policy: null`.
