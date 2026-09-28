# Native streaming captures

Claude Code 2.1.283 and Codex CLI 0.157.1 generated these fixtures against loopback fake APIs, with
fresh temporary homes/configuration and dummy authentication. No paid inference is involved. Paths,
UUIDs, request IDs and credentials are scrubbed before writing the fixtures.

Claude uses `--print --output-format stream-json --verbose`, including the structured-output case.
The probe verifies that the requested `--session-id` matches init/result while
`--no-session-persistence` remains enabled. Startup command metadata precedes initialization;
synthetic tests additionally cover native events after the terminal result.

Build first, then use `npm run test:contract -- --stream` to verify the current native contract. Add
`--refresh` only when deliberately replacing the captures. Historical single-envelope captures
remain in the adjacent `harness/` directory.
