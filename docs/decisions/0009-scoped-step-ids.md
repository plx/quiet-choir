# 0009: Compose explicit leaves with stable scope prefixes

**Status:** Accepted. Extends [0008](0008-scoped-fan-out.md) without changing checkpoint format 5.

## Context

Run-unique flat IDs force reusable helpers and nested fan-out to thread prefixes manually. Local
counter allocators can renumber calls by completion order and cross checkpoints on replay. Natural
keys such as filenames and finding titles often contain characters rejected by the ID grammar.

## Decision

Add `ctx.scope(prefix, callback)` and `ctx.within(prefix)`. A separate AsyncLocalStorage carries the
current naming prefix; it does not replace cancellation/operation ownership. Each effect captures
its full ID synchronously at invocation, before policy resolution or asynchronous work. Checkpoints,
events, duplicate checks, policy matching, and local idempotency keys all use that full ID.

Scope callbacks are owned operations. Invalid entry is an authoring error, while ordinary callback
failures retain normal catch/settle behavior. Scopes do not allocate IDs or journal callback
results. Leaves remain explicit. Never introduce completion-order or positional leaf counters.

`within` captures its prefix at creation. A binding token lets operations made through that view
inside its own scopes/maps retain descendant prefixes; calls from unrelated scopes use the lexical
prefix. Nested bindings retain ancestor tokens. This avoids dropping item scopes when a helper uses
the same bound context in a map callback. The view's signal is always read dynamically at
invocation.

Add `ctx.map(id, items, { concurrency, key?, onError?, version? }, mapper)`. Every item runs with
`mapId/key/` prepended; default keys are input indexes. Validate all keys, their uniqueness, and
combined prefixes before scheduling any mapper. Key callbacks must be deterministic and pure.
Meaningful keys help preserve names under reordering/filtering, but external collections still need
checkpointed inputs. Failure policies retain decision 0008's semantics.

A named settled map uses its full name as the item journal ID. Its fingerprint includes resolved
keys and the original mapper function, as well as inputs/version/cwd. Hashing a generated wrapper
instead would silently hide mapper changes. The deprecated positional overload remains available;
unscoped legacy effects and settled-map fingerprints remain unchanged. Adopting scopes changes IDs
and requires a new run or explicit fork; code acceptance cannot rename saved work.

`stepId(...parts)` and `ctx.id(...parts)` are identical pure helpers. Each clean segment up to 64
characters passes through; unsafe/long parts become a slug plus eight hex characters of SHA-256 over
the raw string. Each input part remains one segment. The helper preserves readable prefixes but does
not claim collision freedom; runtime uniqueness checks still apply.

Keep the full-ID limit at 200 characters. Increasing it would silently lengthen idempotency keys
passed to external systems. Oversized nesting reports a bounded full ID, scope, leaf, and invalid
position; authors can shorten nesting/labels. This also keeps unchanged format-5 checkpoints and
legacy names compatible. No migration or format bump is needed.

## Consequences

Helpers can use short semantic leaves without knowing their caller's prefix. A real pre-change
format-5 fixture and deliberately inverted completion-order tests guard backward compatibility and
stable replay. Scope and naming context have separate lifetimes and must both survive async work.

The bug-hunt port uses named maps and lexical contexts instead of `createPort`. It retains original
same-round duplicate candidates by computing explicit occurrence keys from the completed input array
before concurrency begins. Other ports retain their legacy adapters until their dedicated migration
work; the active fixture suite must keep passing and API snapshot metadata must advance.
