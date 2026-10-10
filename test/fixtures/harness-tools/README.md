# Codex tool item captures

- `codex-mcp-tool-success.json` and `codex-web-search-success.json` were captured on October 9, 2026
  with codex-cli 0.160.0 (the `version` field in each file). The tested range in
  `testedHarnessVersions.codex` is still 0.157.1 and is not widened by these captures. The same
  check, run with
  `npm exec --package @openai/codex@0.157.1 -- node test/harness-contract.mjs --tools`, also passes
  on 0.157.1 with identical item types and events, so the shapes did not change between the two
  versions.
- Both are streaming captures (`codex exec --json`) of the repository's loopback-only fake Responses
  API with a fresh `HOME` and `CODEX_HOME`, a dummy key and `request_max_retries = 0`. No upstream
  request is made and nothing is billed.
- `codex-mcp-tool-success.json` proves the `mcp_tool_call` item. The scenario's `config.toml`
  registers `[mcp_servers.fixture]`, a dependency-free stdio server
  (`test/contracts/mcp-server.mjs`) with one read-only `echo` tool. Codex 0.160 defers MCP tools
  behind `tool_search`, so the fake API answers the first request with a `tool_search_call`, then
  calls `echo` by the namespace and name that Codex offered, then answers with
  `hello from captured codex`. The capture holds an `item.started` (`in_progress`) and an
  `item.completed` (`completed`) for the same item id with `server: "fixture"` and `tool: "echo"`.
- `codex-web-search-success.json` proves the `web_search` item. `web_search = "live"` in
  `config.toml` makes Codex offer the hosted tool with `external_web_access: true`, which the
  capture asserts on the request. The fake API streams a `web_search_call` (added, then done with a
  `search` action). Codex emitted an `item.started` with an empty query and an `item.completed` with
  the query `quiet-choir contract fixture`. Both carry the id `ws_fixture`: Codex serializes the
  item object with `id` twice (first `item_0`, then `ws_fixture`), so a JSON parser sees
  `ws_fixture`.
- Sanitization: the temporary directory, the repository root and the Node executable path are
  replaced with `/fixture`, `/repo` and `/fixture/node`, UUIDs with a fixed value, loopback ports
  and fake keys with fixed values. The captures hold none of these paths, and every byte was
  reviewed.

The `--tools` job asserts the pairing and item fields above, that the built `HarnessStream` counts
exactly one tool use, and, without `--refresh`, that the event and item types match the checked-in
capture. A change in Codex's item shapes therefore fails the run.

Refresh with `npm run build && npm run test:contract -- --tools --refresh`, review both files, and
run `npm run test:contract -- --tools` once more. `test/harness.test.ts` replays these files through
`HarnessStream` and `CodexProtocol` without the CLI.
