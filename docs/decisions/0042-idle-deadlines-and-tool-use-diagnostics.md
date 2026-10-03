# 0042: Idle deadlines and tool-use diagnostics from the attempt stream

- Status: accepted
- Issue: #109 (carried over from #45; builds on #61 streaming)
- Amends: [0007](0007-durable-failure-outcomes.md) (a new kind in the transient set) and
  [0010](0010-agent-profiles-and-grants.md) (`expectsToolUse` default, `idleTimeoutMs`)

## Context

Profiles resolved `expectsToolUse`, but nothing read it: a role that should inspect or edit files
could finish without one tool call and leave no signal. `idleTimeoutMs` was rejected, because before
streaming there was no way to measure idleness, and an accepted but unenforced limit would mislead.
Streaming (#61) now parses native output incrementally, so both can be built on the attempt's own
stream. Live evidence from #109 also showed that a successful Codex attempt recorded
`cliVersion: null` although version discovery had found it, because the stream's null overwrote the
discovered value.

## Decision

**Idle deadline at the process layer.** `ProcessRequest.idleTimeoutMs` is enforced by `runProcess`,
beside the wall-clock `timeoutMs`:

- The timer is armed when the input has been written to stdin, after durable process registration.
  Registration is a checkpoint save that can be slow under load, and the child cannot produce
  protocol output before it has its input. Child startup therefore counts as idle time.
- Every stdout or stderr chunk re-arms it, so output that keeps streaming is never ended, however
  long the call runs.
- quiet-choir's own backpressure never counts. When the timer fires while a stream consumer (the
  parser or transcript) still holds a chunk, it re-arms instead of killing, and each delivery's
  settlement re-arms it.
- On expiry the attempt stops like the wall deadline: SIGTERM to the group, SIGKILL after
  `killGraceMs`, with code `QUIET_CHOIR_IDLE_TIMEOUT` and the message
  `<binary> produced no output for <n>ms (idleTimeoutMs).` The timer is cleared on leader exit and
  at settlement, so a draining leftover group is reaped by the ordinary cleanup.
- `CliHarness` passes the resolved value through its plan. A registered adapter can honor it the
  same way, because `runProcess` is public through `harness-kit`.

`idleTimeoutMs` is execution policy with the same sources and precedence as `timeoutMs`: workflow
`defaults`, profiles, call options, `--profile name.idleTimeoutMs=N` (`profileOverrides`) and
`--policy` rules for agent kinds. Rules with `kind: 'step'` or `'exec'` reject it, and a registered
harness profile block rejects it like the other limits. It never enters step identity (explicitly in
`agentIdentity`, in the legacy built-in identity, and in the built-in definitions' `policy` lists),
so it can be raised on resume. Child delegation clamps it to the parent's ceiling. It is off by
default; no built-in profile sets it.

**A distinct `idle-timeout` kind.** A stall is not a wall-clock overrun, and `retry.on` must be able
to target one without the other, so `errorKind()` maps `QUIET_CHOIR_IDLE_TIMEOUT` to a new
`idle-timeout` kind rather than `timeout`. It joins the transient set (`'transient'` and the failure
document's `retryable`): a stalled stream is usually a hung connection or provider stall, the same
class as `timeout`. The trade-off is documented: a tool or reasoning stretch that stays silent
longer than the deadline fails the same way on every retry, so the deadline must exceed the longest
silent stretch. The runner adds a resume hint like the turn and budget hints:
`Retry: --resume --profile <p>.idleTimeoutMs=<2n>`, plus a `--policy` note when a step rule set it.

**Counting tool use in the stream parser.** Progress events are throttled to one per 100 ms and
lossy, so a count built from them would be wrong. `HarnessStream` counts while parsing every line
and reports `toolUses` in its diagnostics, which reach `attemptHistory[].diagnostics`, failure
evidence and `agent.finished`:

- Claude: each assistant `tool_use` content block, deduplicated by block ID. The synthetic
  `StructuredOutput` tool, through which Claude Code delivers `--json-schema` output, is excluded
  for structured calls.
- Codex: each distinct `command_execution`, `file_change`, `mcp_tool_call` or `web_search` item,
  counted when first seen (`item.started`, or `item.completed` without a prior start); an item
  without an ID counts on completion.
- The ID sets are bounded; past the bound the count can only grow, never cause a warning.

**Warning, not failing.** After a completed attempt, the runner records the step warning
`no-tool-use: Profile <name> expects tool use, but the <harness> attempt completed without a tool call.`
when the profile's `expectsToolUse` is true, the attempt reported `toolUses: 0`, and the call
exposed tools (a Claude call with an empty tool list cannot use one). A missing or non-numeric count
means unknown and never warns, so registered adapters, rehearsal and fixtures stay silent unless
they report a count. The completed `agent.finished` event carries the step's `warnings`, the CLI
logs the tool-use warning at warn level, and `inspect` shows `tools N` and the warnings on agent
rows.

**A new `expectsToolUse` default.** The old default (`access !== 'none'`) made the built-in `text`
profile expect tools, because Codex read-only still has a shell (aggregate access `read`). Every
text call would then warn. The default is now "grants more than the text baseline": any Claude tool,
or a Codex sandbox beyond read-only. `text` resolves to false, `readonly` and `edit` to true, a
profile that only adds Codex `workspace-write` to true, and one that only restates Codex read-only
to false; an explicit value always wins. The value appears in resolved manifests but is not compared
on resume and is not part of grant pins, so the change needs no migration.

**Keeping discovered metadata.** Merging adapter diagnostics into an attempt keeps a known
`cliVersion` or `model` when the adapter reports null.

## Consequences

- Behavior without `idleTimeoutMs` is unchanged, and no persisted identity changes: the field was
  rejected until now, so no record contains it.
- Persisted manifests for `text` (and profiles that only restate the text baseline) now show
  `expectsToolUse: false`; manifests are rewritten on every execution and never compared.
- The compact `--events` stream and `workflow events` do not carry tool counts or warnings yet;
  `agent.finished` is not a stream event type there.
- Idle deadlines cover agent attempts only, not `ctx.exec`, poll commands or step callbacks. There
  is no per-call `expectsToolUse` and no mode that fails on zero tool use.
- Codex item type names come from codex-cli 0.157.1; `mcp_tool_call` and `web_search` have no
  captured fixture. If native protocols rename tool events, counts can drop to zero and warn
  falsely; they never fail an attempt.
