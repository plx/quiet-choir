# Runtime invariants

The checkpoint is a ledger of named effects, not a saved call stack. On resume, the body replays;
completed effects return saved, revalidated JSON. Step IDs, fingerprints, and the check for skipped
recorded steps jointly guard replay compatibility. The CLI supplies the source fingerprint; an
embedded caller must supply its own.

An effect can succeed externally before its checkpoint commits. Preserve the at-least-once contract
and stable run/step idempotency keys; atomic checkpoint writes cannot make external actions atomic.

One local writer owns each run. Cancellation and mapper failures abort and drain active effects
before releasing ownership. Observers cannot invalidate a committed effect. Changes to scheduling,
serialization, or locking should preserve these relationships, including on failure paths. The
durability rationale is in [ADR 0002](../../../docs/decisions/0002-durable-external-workflows.md).
