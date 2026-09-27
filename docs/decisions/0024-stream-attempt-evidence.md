# 0024: Stream native output through runtime-owned attempt evidence

## Status

Accepted.

## Context

Buffered native output hides activity and session IDs until process exit, counts noisy command
output against the answer budget, and loses responses rejected by local validation. Transcript
ownership must preserve the existing separation between adapters, durable orchestration, and process
reaping.

## Decision

Adapters parse native JSONL incrementally and retain bounded protocol state. The shared process
runner applies per-pipe async backpressure and an independent total byte cap. It drains pending
callbacks before releasing process ownership. Claude uses stream-json with verbose output; final
success is decided after the process and stream finish, allowing post-result events.

Extend the existing two-argument HarnessInvocation with optional policy, predicted session,
transcript receipt/path and output/session/progress callbacks. The runtime owns transcript
lifecycle, durable early session saves, validation evidence, and retention. Its optional
`OwnedRunStore.transcript` port supplies an `AgentTranscriptWriter`; FileRunStore owns filesystem
allocation and custom stores can supply other writers. Stores without that port must disable
transcripts explicitly. Raw output callbacks write bounded JSONL/base64 files; progress observers
remain lossy and unjournaled. Storage failures preserve their infrastructure classification, even
when they occur inside native output delivery.

Store a random run salt and derive Claude attempt UUIDs before spawn. Append evidence to the
existing attemptHistory rather than introducing a competing attempt log. Keep native persistence
disabled and make no conversation-resume claim. Preserve failed response evidence before local
JSON/Zod validation, and delete on-failure transcripts only after durable success.

Expose caps and retention through execution policy, outside identity. Extensible diagnostics use a
loose JSON result schema. Permission-denial fail/warn selection is semantic because it changes
whether the workflow receives a successful value.

## Consequences

The diagnostics field causes one result-schema fingerprint change for existing agent steps; future
keys do not. Live progress adds no journal entries. Session updates and attempt settlement remain
durable, while transcripts hold raw sensitive data under private run storage. Total stream, retained
protocol, and transcript limits are independent. Oversized events are skipped only when their
bounded native headers are recognized as nonessential. Usage normalization and native conversation
recovery remain separate work.

See [streaming and attempt evidence](../agent-streaming.md) for settings, file encoding, limits,
compatibility guidance, and verified native fixtures.
