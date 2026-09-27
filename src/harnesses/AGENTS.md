# Harness boundary

Adapters perform one fresh headless call through an installed CLI. The runtime owns durability,
validation, and replay; a returned session/thread ID is diagnostic metadata, never a resume token.
These subprocesses inherit authentication and harness configuration, so invocation flags do not
isolate hooks, MCP servers, or the workflow's own TypeScript.

Process exit zero alone is not success: Claude must report a successful terminal result; Codex must
report a completed turn and final agent message. Keep protocol parsing separate from process
ownership, output limits, and cancellation. Existing tests use protocol fixtures and fake
executables; they do not require paid agent calls.

Register spawned groups through HarnessInvocation before writing task input, including version
probes. Reap the group on every exit; bound inherited-pipe draining and post-KILL settlement. Record
cleanup warnings must not discard a valid protocol result. Keep records when reaping is uncertain;
OS identity mismatch must never authorize signaling a reused PID.
