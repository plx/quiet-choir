// A loopback stand-in for a decision protocol host (ADR 0066 section 5): scripted responses, a
// request counter, header and body capture, and requests held open until the client disconnects.
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One scripted reply; `hold` never answers, so the client must abort. */
export type FakeReply =
  | {
      readonly status?: number;
      /** JSON body; `text` wins when both are given. */
      readonly body?: unknown;
      readonly text?: string;
    }
  | { readonly hold: true };

/** A request the server received. */
export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

/** A running fake host. */
export interface FakeDecisionServer {
  /** Base URL, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Every received request, in order. */
  readonly requests: readonly FakeRequest[];
  /** Number of received requests. */
  readonly count: number;
  /** Replies for the next requests, in order; the last one repeats once the queue is drained. */
  script(...replies: FakeReply[]): void;
  /** Resolves when a held request arrives. */
  readonly held: Promise<void>;
  /** Resolves when a held request's connection closes. */
  readonly disconnected: Promise<void>;
  close(): Promise<void>;
}

/** Start a fake host. A request without the expected bearer token gets a 401. */
export async function startFakeDecisionServer(token: string): Promise<FakeDecisionServer> {
  const requests: FakeRequest[] = [];
  let queue: FakeReply[] = [{ status: 500, text: 'unscripted' }];
  let resolveHeld = (): void => undefined;
  let resolveDisconnected = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });
  const disconnected = new Promise<void>((resolve) => {
    resolveDisconnected = resolve;
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Kept as text.
      }
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body,
      });
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ detail: 'bad token' }));
        return;
      }
      const reply = queue.length > 1 ? queue.shift() : queue[0];
      if (reply === undefined || 'hold' in reply) {
        response.on('close', () => {
          resolveDisconnected();
        });
        resolveHeld();
        return;
      }
      response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      response.end(reply.text ?? JSON.stringify(reply.body ?? null));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    get count() {
      return requests.length;
    },
    script(...replies) {
      queue = replies;
    },
    held,
    disconnected,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
