# Harness boundary

Adapters perform one fresh headless call through an installed CLI. The runtime owns durability,
validation, and replay; a returned session/thread ID is diagnostic metadata, never a resume token.
These subprocesses inherit authentication and harness configuration, so invocation flags do not
isolate hooks, MCP servers, or the workflow's own TypeScript.

Process exit zero alone is not success: Claude must report a successful terminal result; Codex must
report a completed turn and final agent message. Keep protocol parsing separate from process
ownership, output limits, and cancellation. Existing tests use protocol fixtures and fake
executables; they do not require paid agent calls.
