# Usage captures

- `claude-session-usage.json` preserves the complete usage and modelUsage fields from the existing
  Claude Code 2.1.283 runtime-review capture, September 26, 2026. The source was
  `.context/scratch/harness/claude-raw.json`; result content and IDs are replaced, and unrelated
  timing/session fields omitted. This is historical paid-call evidence, reused without new
  inference. Model totals give 22,605 input, 812 output (including 560 thinking) and USD 0.0128752.
- `codex-usage-success.json` was captured with codex-cli 0.157.1, fresh configuration, dummy keys,
  and the repository's loopback-only fake Responses API. It verifies nonzero pass-through for total
  input, cache read, cache write, output and reasoning. It does not establish a disjoint cache-write
  partition or a billed price. Refresh only this fixture with
  `npm run test:contract -- --usage --refresh` after building.
- `pre-usage-checkpoint.json` was generated with the compiled runtime at parent commit
  `8c6effd530c11a4565d14dcb01fe2dd0fbe62de0`, before rich usage validation. It contains one
  completed fake Claude call followed by a workflow-body failure, canonical cwd `/` and a fixed
  opaque source fingerprint. Stack paths are scrubbed. It proves completed agent identity survives
  this change.

No test contacts an upstream model service. Current usage semantics and uncertainty are documented
in [usage and budgets](../../../docs/usage-and-budgets.md).
