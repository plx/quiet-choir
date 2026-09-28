# 0019: Journal changes in private per-project run directories

## Status

Accepted. Supersedes the whole-record write/layout details in ADR 0002 and ADR 0018 and extends the
legacy read-only policy from ADR 0015 for original format-1 and current format-6 records.

## Context

Rewriting and flushing a growing checkpoint for every transition makes local fan-out pay serialized
full-record I/O. Questions, process ownership, artifacts, and future worktrees need a stable home.
State inside an agent's workspace is also exposed to ordinary Git cleanup. Earlier changes already
introduced record formats 2–6, launch metadata, and optional harness metadata discovery; reusing
format number 2 or introducing a second version-discovery port would be ambiguous.

## Decision

Use storage format 7 with `<stateDir>/<runId>/run.json`, an append-only `journal.jsonl`, and a local
owner lock. Keep replay engine contract 6 and existing effect fingerprints. Journal changed fields,
steps, and settled maps so all current diagnostics/outcomes are preserved. Coalesce concurrent saves
and fsync observable outcomes before resolving promises. Ordinary starts can be unsynced; durable
sleep deadlines and question registration cannot. Compact after status changes or approximately 4
MiB, committing the snapshot before truncation. Readers retry snapshot-sequence races, ignore only
incomplete final lines, and reject corrupt committed data. Writers repair torn tails under ownership
and retain existing checkpoint retry/failure precedence.

Default to a project-specific XDG state root keyed by canonical cwd. Explicit options, the
environment, and existing legacy run locations take precedence. Register default projects for
`list --all` and self-ignore newly created state containers. Store informational Node/engine
versions alongside existing launch and native harness metadata, outside semantic identity. Resume by
ID uses those launch paths; a different supplied entrypoint is refused before import.

Migrate compatible flat format-6 records under legacy and current locks acquired in that order. The
legacy guard is taken for every run, not only migrated ones, so a pre-format-7 binary starting the
same unused run ID in the same explicit state container is excluded; a fresh run publishes no legacy
marker. Retain the exact versioned backup and write a rejecting old-path marker before the new
snapshot. A pending marker supports interrupted initial migration; a completed marker cannot serve
as stale fallback state. Native children are owned by the current lock. Original format-1 records
use a separate original-identity replay bridge; unknown old timing/callback identity is never
fabricated. Intermediate private formats 2–5 retain read-only support.

Put owned writes behind `RunStore`/`OwnedRunStore`, with a file implementation and an injectable
in-memory seam for tests. File inboxes remain the question delivery protocol. Artifact directories
use bounded readable prefixes plus full hashes of exact IDs; diagnostic payloads are private,
unsynced, and never replay inputs. Worktree creation and transcript capture remain separate work.

## Consequences

Writes grow with changed data rather than repeated complete snapshots, and concurrent outcomes can
share a disk flush. Readers need the snapshot and journal, so `cat run.json` is not a live
inspection API. Run records remain ordinary inspectable JSON and no database dependency is
introduced.

At-least-once external effects, single-host ownership, source compatibility checks, operation
drains, and conservative orphan recovery remain. Unsynced starts can undercount attempts after power
loss. State outside a working tree avoids ordinary Git hygiene but cannot isolate an unsandboxed
same-user agent. The filesystem is still the answer trust boundary; this is not a scheduler or
service.

The acceptance suite measures write volume and concurrency, kills actual local runners, tests torn
and missing journals and compaction races, exercises both migration generations, verifies Git
cleanup behavior, and runs the compiled CLI without real inference. See [storage](../storage.md).
