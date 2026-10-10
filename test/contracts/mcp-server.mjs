// Dependency-free stdio MCP server for zero-cost Codex contract captures. It speaks newline-
// delimited JSON-RPC 2.0, offers one read-only `echo` tool and never writes anything but protocol
// messages to stdout.
import { createInterface } from 'node:readline';

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function handle(message) {
  const { id, method, params } = message;
  // Notifications (no id) never get a response.
  if (id === undefined || id === null) return;
  switch (method) {
    case 'initialize':
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'quiet-choir-contract-fixture', version: '0.0.0' },
        },
      });
    case 'ping':
      return send({ id, result: {} });
    case 'tools/list':
      return send({
        id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo a fixed string for the contract capture.',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      });
    case 'tools/call':
      return send({ id, result: { content: [{ type: 'text', text: 'fixture echo' }] } });
    default:
      return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
  handle(message);
});
lines.on('close', () => process.exit(0));
