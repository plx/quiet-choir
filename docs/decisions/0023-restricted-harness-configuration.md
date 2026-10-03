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

## Amendment: `worktree` is the only checkout selector (#340, 2026-10)

The preserved shorthand left three spellings for one checkout: `isolation: 'worktree'` (or a handle
in `isolation`), `worktree: 'worktree'`, and `{ kind: 'worktree', base }` in either field. At 0.0.0
one spelling per concept (#158) outweighs keeping them, so the public types now say `isolation` is
only the configuration mode (`'restricted' | 'inherit'`) and an agent's `worktree` is
`true | { base?: WorktreeBase } | WorktreeHandle`. `WorktreeIsolation` and `AgentIsolation` are no
longer exported, and the harness kit's `resolveIsolation` declares only those public types.

The shorthand is removed from the types only. An internal legacy schema still accepts every old
spelling at runtime and normalizes it before identity, and `isolationIdentity` keeps its output (a
fresh checkout still hashes as `{ kind: 'worktree', base }`, its default base `HEAD`). The raw
`worktree` option never reaches the run record, so old and new spellings produce byte-identical step
fingerprints and base pin refs, and a checkpoint recorded with an old spelling resumes after the
source migrates, with no identity migration. Supplying both `worktree` and a legacy worktree
`isolation` still fails before the harness runs. Profiles keep accepting only a configuration mode
and never a checkout.
