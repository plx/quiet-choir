# 0023: Resolve restricted harness configuration before identity

Status: accepted

## Context

Tool lists and filesystem sandboxes do not determine which native configuration a child loads.
Claude's headless trust behavior can run project hooks before an agent uses any tool. Parent session
variables also contaminate child attribution. Worktree isolation changes the checkout but does not
solve these problems.

## Decision

Resolve `restricted` as the default configuration mode in the core before fingerprinting, and
enforce provider-specific flags in `CliHarness`. Keep `inherit` explicit and classify it as exec
capability. Preserve the worktree isolation shorthand while adding an independent `worktree`
selector so profile configuration modes compose with checkout isolation.

Apply explicit environment set/unset edits after adapter-owned host-session scrubbing, retaining
authentication. Hash explicit edits and retain names/digests in diagnostic manifests. Keep live
environment values private to request execution. Observe inherited behavior-changing names through
the harness metadata port, warn on resumed name changes, and do not fingerprint rotating values.

Use the existing process environment port with a complete scrubbed snapshot and `inheritEnv:false`;
the generic process runner remains neutral so operator `ctx.exec` retains its own environment
contract. Do not silently downgrade restricted mode on unsupported binaries. Native managed policy
remains authoritative, and the two providers do not promise identical boundaries.

## Consequences

Project instructions/hooks/config no longer implicitly customize restricted Claude calls. Restore
only deliberate, fingerprinted settings/MCP/plugin/prompt inputs. Codex custom providers need
explicit configuration or inherit. Existing agent fingerprints may be incompatible with the new
default. Worktree snapshots remain runtime-owned, avoiding protected Git writes from agents.

Native fixture tests use dummy keys and loopback fake APIs, while ordinary CI uses fake executable
children and recorded evidence. OAuth evidence is separately identified as an earlier zero-cost
invalid-model probe. See [the contract and its limits](../harness-isolation.md).
