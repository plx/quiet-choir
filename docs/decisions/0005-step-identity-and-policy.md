# 0005: Separate step identity from execution policy

## Status

Accepted. Supersedes the all-options/retry compatibility rule in ADR 0002; other durability and
ownership guarantees remain in force.

## Context

Timeout, turn, and budget failures saved no reusable result, yet increasing their limits made the
old opaque fingerprint incompatible. CLI source fingerprints also prevented editing a constant.
Renaming failed steps could perform more writes before the skipped-step gate permanently rejected
the run. Limits need an explicit, inspectable recovery path that retains completed work.

## Decision

Hash semantic components independently: kind, local dependencies or agent prompt, result schema,
explicit model/effort, resolved cwd, and remaining capabilities. Completed effects enforce these
hashes and name changed components. Timeout, Claude turns/budget, retry, and adapter process limits
are execution policy. They never invalidate completed results. An unfinished identity may change;
preserve its old hashes and timestamp and emit `step.redefined` after saving. On successful body
replay, unvisited unfinished records become `superseded`; unvisited completed records still fail.

Resolve policy in the core from adapter-reported defaults, call-site values, then ordered matching
run overrides. Adapters report defaults through optional `Harness.policyDefaults`; the core never
imports an adapter or invents defaults a custom harness did not declare. Reported binary, output
cap, and kill grace are diagnostics for the adapter's enforced configuration. Unknown native model
configuration remains `requestedModel: null`. Adapters must honor resolved limits in requests.

Overrides are plain data in run options and CLI plans. Validate all rules before effects; append new
rules to saved ones, with later fields winning. A reset clears saved rules and their model
permission first. New model/effort overrides require explicit authorization, retained for bare
resumes. They change only unfinished attempts, without changing source identity or rerunning
completed calls. Capability changes cannot be policy overrides. Rules are matched as steps are
visited; warnings for unmatched rules describe only that path and are saved for inspection. Profiles
will add another precedence layer in their own change; unknown rule fields are rejected.

Each started attempt saves its fingerprint, fully resolved runtime retry policy, known adapter
limits, value sources, requested model/effort, timestamps, and outcome. Start persistence precedes
the external action. A `running` attempt after interruption has unknown external outcome. Existing
failed-attempt usage metadata is retained; this is not a complete cost ledger. Agent retries now use
the same runtime mechanism as local retries and default to one attempt.

CliHarness defaults become 25 Claude turns and a 900,000 ms deadline; the $0.25 Claude per-call
spend guard stays. Higher limits do not make repeating edits safe. There is no Codex dollar cap.

New checkpoints use format version 2. Version 1 is readable for inspection but cannot resume here.
Its opaque hash cannot be separated reliably, and incomplete old attempt policy must not be
invented. Refusal leaves checkpoint bytes unchanged and points to the original runtime or a new run
ID. This is acceptable for the private 0.0.0 prototype; no migration engine is introduced.

## Consequences

A CLI resume can recover failed limits without touching source or redoing completed effects.
Embedded call-site limit edits also work when the caller's run fingerprint stays compatible. Source
edits, workflow identity, input, and cwd remain governed by existing run-level checks; code
compatibility is separate work. Repeated effects remain at least once, with no rollback. Policy and
requested models now appear in plaintext checkpoints, while prompts and dependency values remain
represented by hashes (unless the workflow separately stores them in results).
