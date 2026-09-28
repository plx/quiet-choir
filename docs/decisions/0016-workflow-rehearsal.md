# 0016: Rehearse ordinary workflows through fixture harnesses and a pure native planner

## Status

Accepted.

## Context

Static workflow validation cannot discover late step schemas, duplicate IDs, or dynamic branches.
Embedding a fake harness gave different source fingerprints from CLI execution, and handcrafted
process fakes often modeled native exit codes incorrectly. Replaying simulated outputs under a
native adapter also had no provenance guard.

## Decision

Attach required `HarnessRequest.call` identity inside an attempt, after computing the existing
semantic fingerprint. Keep `HarnessRequestInput` for pure planning and direct adapter use. Native
arguments and private-file descriptors are built once as JSON data; materialization owns temporary
files and output decoding. Rehearsal calls this planner but never its process runner or discovery.
Adapters remain outside the core. The core accepts live rehearsal hooks for local substitution and
schema diagnostics and skips durable sleeps when that explicit mode is active.

Fixture JSON uses ordered step globs, provider/attempt filters, and output/text/error alternatives.
Responses take the usual parsing, validation, and checkpoint path. A bounded deterministic schema
sampler supplies missing rehearsal values, requiring fixtures when it cannot satisfy constraints.
Local callbacks run unless explicitly stubbed. Rehearsal is execution of a path, not static
traversal, isolation, or an accurate estimate of every future call.

The executor manages a private temporary checkpoint directory. Resume previews copy record data,
never source owner locks or child registries; source/fork compatibility still applies. Ordinary
records save harness kind outside identity and require explicit authorization when it changes.
Legacy unlabelled format-6 records remain resumable, without asserting their adapter was native. The
format epoch and semantic identities remain unchanged. A captured parent-commit checkpoint verifies
that compatibility independently of newly created records.

Keep fake native CLIs and their capture job **repository-only**, under `test/bin` and `test/`. Do
not add `quiet-choir/testing` or another package export. Native captures follow fast-moving
installed CLI contracts and are development tooling; the deliberate root API supplies the portable
`FixtureHarness` and planner instead. The installed package continues to expose `src/index.ts`'s
compiled boundary. Both independent agent documentation plugins describe the same rehearsal loop
through skill-relative references.

## Consequences

Rehearsal catches errors only on the visited path. Minimal arrays, first enum/union choices, custom
refinements, and real local effects must remain explicit in reports and documentation. Failed
rehearsals preserve step/stack diagnostics in their output but remove temporary state on normal
exit. Reports contain full prompts and results; private artifact payloads are omitted.

Harness kinds guard accidental mixing, not adversarial adapters. Embedders need distinct kind names
for distinct simulation/native modes; old unlabelled runs cannot be retroactively classified.
Cumulative call identity enables fixture routing and stable external deduplication keys without
claiming that native agents deduplicate file edits.

Normal tests replay captured bytes through shipped scripts. The opt-in `test:contract` job uses
installed CLIs with fake credentials and isolated loopback APIs, checks semantic protocol/exit
contracts, and refreshes sanitized version-tagged captures. It makes no paid inference calls and
remains separate from the older paid Claude schema matrix. Custom `module:` loading remains #64.
