# Harness failure captures

Captured during the September 26, 2026 runtime review, using Claude Code 2.1.283 and codex-cli
0.157.1. Each JSON file stores stdout/stderr bytes as strings, the observed exit code, and
expectations. Session IDs and UUIDs are replaced with a fixed UUID; tool IDs and local file paths
are replaced with fixture values. Protocol fields and error text are otherwise preserved.

- `claude-auth`, `claude-turn-limit`, `claude-budget-limit`, `claude-invalid-structured`: real
  Claude CLI against an isolated local fake Anthropic API. Invalid structured output retried until
  the turn limit. The reported costs come from fake token counts.
- `claude-unknown-model`, `codex-invalid-effort`: real CLIs with invalid model/effort settings,
  rejected before inference.
- `codex-rate-limit`: real Codex CLI against a local fake Responses API, reconnecting three times
  before emitting a terminal failure.

All seven captures exited 1. See [CONTRIBUTING](../../../CONTRIBUTING.md#harness-protocol-captures)
for refresh instructions. Tests replay them locally through fake executables.
