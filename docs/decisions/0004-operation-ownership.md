# 0004: Own workflow operations until drained

## Status

Accepted.

## Context

A single snapshot of pending effects can miss work launched by immediate promise continuations.
Releasing the run lock before that work finishes lets it mutate the checkpoint without ownership.
Removing settled failures from the pending set also makes an ignored failure's outcome depend on
whether it settled before or after the workflow body returned. Request prechecks and rejecting async
observers can escape tracking entirely and terminate the host through unhandled rejections.

## Decision

Each public durable operation, including its prechecks, returns a tracked Promise. The Promise
subclass marks public `then` consumption; `await`, `.catch`, and Promise combinators use that path.
Its species is ordinary Promise. Internal bookkeeping bypasses the observation marker and attaches
rejection handling immediately. Agent helpers return this Promise directly instead of adopting it
through an async wrapper. Map orchestration is also tracked so delayed mappers retain ownership.

After the workflow body returns, drain pending operations repeatedly until none remain. Retain
rejected operation metadata separately from pending work and reject the run if an operation failed
without being observed. Awaited and caught failures keep their existing semantics. On failure, abort
and drain before releasing the lock. Async observer promises are handled independently and never
awaited; synchronous throws and async rejections are ignored.

After acquiring a run's writer lock, remove only its abandoned UUID-suffixed checkpoint temporary
files. Another active run's files and unrelated temporary data remain untouched.

## Consequences

Ignored direct operation failures now fail deterministically, including precheck failures that never
create a step record. Immediate continuations can launch effects safely during draining. Authors
must still await all operations: the runner does not own arbitrary detached async functions, timers,
or promises derived by user code. Consuming an operation transfers responsibility for the resulting
promise to its caller. A callback that never settles can still prevent draining.

This does not persist JavaScript error handling or continuations. Replay behavior for caught failed
effects remains a separate concern. Observers remain best-effort telemetry with no delivery
guarantee.
