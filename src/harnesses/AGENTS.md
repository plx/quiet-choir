# Harness boundary

Adapters perform one fresh headless call through an installed CLI. The runtime owns durability,
validation, and replay; a returned session/thread ID is diagnostic metadata, never a resume token.
Authentication remains native; restricted configuration is the default. Enforce the resolved mode
without silently falling back to inherited configuration. Scrub host-session environment before
explicit set/unset edits, and keep values out of environment diagnostics. Managed policy and the
workflow's own TypeScript remain outside this configuration boundary.

Process exit zero alone is not success: Claude must report a successful terminal result; Codex must
report a completed turn and final agent message. Keep protocol parsing separate from process
ownership, output limits, and cancellation. Existing tests use protocol fixtures and fake
executables; they do not require paid agent calls.

Register spawned groups through HarnessInvocation before writing task input, including version
probes. Reap the group on every exit; bound inherited-pipe draining and post-KILL settlement. Record
cleanup warnings must not discard a valid protocol result. Keep records when reaping is uncertain;
OS identity mismatch must never authorize signaling a reused PID.

Parse Claude stream-json and Codex JSONL incrementally. Bound retained protocol state separately
from total stream bytes; skip oversized lines only with a recognized nonessential native header.
Await early session and raw-output callbacks before consuming more data; keep progress lossy.
Transcript files and retention belong to the runtime, never the native adapter.
