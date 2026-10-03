import type { AgentDiagnostics, AgentProgress } from '../harness-kit.js';
import type { HarnessInvocation, JsonValue } from '../harness-kit.js';
import { ClaudeProtocol, CodexProtocol, type ProtocolOutcome } from './protocol.js';
import { parseClaudeRateLimitEvent } from '../workflow/runtime/rate-limit.js';
import { codexItemHeader, irrelevantLine, ProtocolLines, retainedLimit } from './lines.js';

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function short(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, 256).replace(/\p{Cc}/gu, ' ') : null;
}
function names(value: unknown): string[] {
  return Array.isArray(value)
    ? value.slice(0, 128).flatMap((item: unknown) => {
        const name = short(typeof item === 'string' ? item : object(item)?.['name']);
        return name === null ? [] : [name];
      })
    : [];
}
/** Codex item types that are tool calls (live 0.157.1 evidence in #109). */
const codexToolItems = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);
/** Bound for deduplication sets; a protocol that exceeds it can only overcount, never warn. */
const maxTrackedIds = 4096;

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Native JSONL state, bounded diagnostics and lossy progress; no filesystem ownership. @internal */
export class HarnessStream {
  public readonly protocol: ClaudeProtocol | CodexProtocol;
  readonly #lines: ProtocolLines;
  readonly #harness: 'claude' | 'codex';
  readonly #context: HarnessInvocation;
  readonly #limit: number;
  readonly #structured: boolean;
  /** Tool calls counted from every parsed line (progress is throttled, so it cannot count). */
  #toolUses = 0;
  /** A skipped oversized line may have carried tool calls that were not counted. */
  #toolUsesUnknown = false;
  readonly #claudeToolIds = new Set<string>();
  readonly #codexInFlight = new Set<string>();
  readonly #diagnostics: Record<string, JsonValue> = { model: null, cliVersion: null };
  #reportedSession: string | null = null;
  #lastProgress = -Infinity;
  #reportedInit = false;
  #skippedLines = 0;
  #stdoutTail = '';
  #sawStdout = false;

  public constructor(
    harness: 'claude' | 'codex',
    structured: boolean,
    limit: number,
    context: HarnessInvocation,
    requested: string | null = null,
  ) {
    this.#harness = harness;
    this.#context = context;
    this.#limit = limit;
    this.#structured = structured;
    this.protocol =
      harness === 'claude'
        ? new ClaudeProtocol(structured, requested)
        : new CodexProtocol(requested);
    this.#lines = new ProtocolLines(
      limit,
      (line) => this.#consume(line),
      (prefix) => {
        if (!irrelevantLine(harness, prefix)) return false;
        this.#skippedLines++;
        this.#countSkipped(prefix);
        return true;
      },
    );
  }

  public get stdoutTail(): string {
    return this.#stdoutTail;
  }

  /** Whether stdout carried any non-whitespace text; the process result retains no stdout. */
  public get sawStdout(): boolean {
    return this.#sawStdout;
  }

  public async stdout(chunk: Uint8Array): Promise<void> {
    await this.#context.onOutput?.('stdout', chunk);
    const text = Buffer.from(chunk).toString('utf8');
    this.#sawStdout ||= /\S/u.test(text);
    this.#stdoutTail = (this.#stdoutTail + text).slice(-1024);
    await this.#lines.feed(chunk);
  }

  public async stderr(chunk: Uint8Array): Promise<void> {
    await this.#context.onOutput?.('stderr', chunk);
  }

  /** Flush buffered lines and classify; `stderr` lets the protocol read native failure tags. */
  public async finish(stderr = ''): Promise<ProtocolOutcome> {
    await this.#lines.finish();
    return this.protocol.finish(stderr);
  }

  public diagnostics(stderr: string, warnings: readonly string[] = []): AgentDiagnostics {
    const outcome = this.protocol.finish();
    const notices = outcome.kind === 'success' ? (outcome.response.warnings ?? []) : [];
    return {
      ...this.#diagnostics,
      // A positive count is a true lower bound; only a zero is made unknown by a skipped line.
      toolUses: this.#toolUsesUnknown && this.#toolUses === 0 ? null : this.#toolUses,
      skippedLines: this.#skippedLines,
      stderrTail: stderr,
      warnings: [
        ...notices,
        ...warnings,
        ...(this.#skippedLines
          ? [`Skipped ${String(this.#skippedLines)} oversized nonessential protocol lines.`]
          : []),
      ]
        .slice(-32)
        .map((value) => value.slice(0, 2048)),
    };
  }

  /**
   * An oversized line is discarded unparsed, so count what its bounded header proves. A Codex tool
   * item names its type and ID up front; a Claude assistant line may hold a tool_use block past
   * the prefix, so the count becomes unknown rather than a false zero.
   */
  #countSkipped(prefix: string): void {
    if (this.#harness === 'claude') {
      if (/^\s*\{\s*"type"\s*:\s*"assistant"/u.test(prefix)) this.#toolUsesUnknown = true;
      return;
    }
    const header = codexItemHeader(prefix);
    if (header === undefined) return;
    if (codexToolItems.has(header.type))
      this.#countCodexTool(header.event, header.id === undefined ? undefined : { id: header.id });
  }

  async #consume(line: string): Promise<void> {
    let data: Record<string, unknown> | undefined;
    try {
      data = object(JSON.parse(line) as unknown);
    } catch (cause) {
      throw Object.assign(
        new Error(`${this.#harness} returned malformed JSON. Check the installed CLI version.`, {
          cause,
        }),
        { code: 'QUIET_CHOIR_PROTOCOL' },
      );
    }
    if (!data)
      throw Object.assign(new Error(`${this.#harness} returned a non-object protocol message.`), {
        code: 'QUIET_CHOIR_PROTOCOL',
      });
    try {
      this.protocol.feed(data);
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        code: 'QUIET_CHOIR_PROTOCOL',
      });
    }
    const progress = this.#harness === 'claude' ? this.#claude(data) : this.#codex(data);
    if (
      this.protocol.retainedBytes + Buffer.byteLength(JSON.stringify(this.#diagnostics)) >
      this.#limit
    )
      throw retainedLimit(this.#limit);
    const session = this.protocol.sessionId;
    if (session && this.#reportedSession === null) {
      await this.#context.onSession?.(session);
      this.#reportedSession = session;
    }
    if (
      progress &&
      ((progress.kind === 'init' && !this.#reportedInit) ||
        performance.now() - this.#lastProgress >= 100)
    ) {
      this.#lastProgress = performance.now();
      if (progress.kind === 'init') this.#reportedInit = true;
      try {
        this.#context.onProgress?.(progress);
      } catch {
        // Observers are lossy diagnostics; they never invalidate native work.
      }
    }
  }

  #claude(data: Record<string, unknown>): AgentProgress | undefined {
    if (data['type'] === 'system' && data['subtype'] === 'init') {
      const model = short(data['model']);
      const cliVersion = short(data['claude_code_version']);
      Object.assign(this.#diagnostics, {
        model,
        cliVersion,
        init: {
          tools: names(data['tools']),
          mcpServers: names(data['mcp_servers']),
          plugins: names(data['plugins']),
          permissionMode: short(data['permissionMode']),
        },
      });
      return {
        kind: 'init',
        summary: 'Claude session initialized',
        ...(model === null ? {} : { model }),
        ...(cliVersion === null ? {} : { cliVersion }),
      };
    }
    if (data['type'] === 'result') {
      const denied = Array.isArray(data['permission_denials']) ? data['permission_denials'] : [];
      Object.assign(this.#diagnostics, {
        turns: count(data['num_turns']),
        durationMs: count(data['duration_ms']),
        terminalReason: short(data['terminal_reason']),
        stopReason: short(data['stop_reason']),
        permissionDenials: denied.length,
        deniedTools: [
          ...new Set(
            denied.slice(0, 128).flatMap((item: unknown) => {
              const name = short(object(item)?.['tool_name']);
              return name === null ? [] : [name];
            }),
          ),
        ],
        subagents: Object.fromEntries(
          Object.entries(object(data['subagent_stats']) ?? {})
            .slice(0, 32)
            .map(([key, value]) => [key.slice(0, 128), count(value)]),
        ),
      });
      return { kind: 'status', summary: 'Claude returned its terminal result' };
    }
    if (data['type'] === 'assistant') {
      const content = object(data['message'])?.['content'];
      const tool = Array.isArray(content)
        ? (content.find((item: unknown) => object(item)?.['type'] === 'tool_use') as unknown)
        : undefined;
      if (Array.isArray(content)) for (const item of content) this.#countClaudeTool(object(item));
      return tool
        ? { kind: 'tool', summary: `Claude tool: ${short(object(tool)?.['name']) ?? 'unknown'}` }
        : { kind: 'message', summary: 'Claude assistant message' };
    }
    if (data['type'] === 'rate_limit_event') {
      // The latest valid event wins; a malformed or empty one keeps any earlier report and, like
      // every other observation here, can never fail a call.
      const report = parseClaudeRateLimitEvent(data);
      if (report) this.#diagnostics['rateLimit'] = report;
      return { kind: 'status', summary: `Claude: rate limit ${report?.status ?? 'event'}` };
    }
    if (data['type'] === 'system' && typeof data['subtype'] === 'string') {
      if (data['subtype'] === 'hook_started')
        this.#diagnostics['hookCount'] = Number(this.#diagnostics['hookCount'] ?? 0) + 1;
      return { kind: 'status', summary: `Claude: ${data['subtype'].slice(0, 128)}` };
    }
    return undefined;
  }

  #codex(data: Record<string, unknown>): AgentProgress | undefined {
    if (data['type'] === 'thread.started')
      return { kind: 'init', summary: 'Codex thread initialized' };
    const item = object(data['item']);
    const type = short(item?.['type']);
    if (type !== null && codexToolItems.has(type)) this.#countCodexTool(data['type'], item);
    if (type !== null)
      return {
        kind: type === 'agent_message' ? 'message' : 'tool',
        summary: `Codex ${type}: ${short(data['type']) ?? 'activity'}`,
      };
    if (typeof data['type'] === 'string')
      return { kind: 'status', summary: `Codex: ${data['type'].slice(0, 128)}` };
    return undefined;
  }

  #countClaudeTool(block: Record<string, unknown> | undefined): void {
    if (block?.['type'] !== 'tool_use') return;
    // Claude Code delivers --json-schema output through this synthetic tool; it is not tool use.
    if (this.#structured && block['name'] === 'StructuredOutput') return;
    const id = typeof block['id'] === 'string' ? block['id'] : undefined;
    if (id !== undefined) {
      if (this.#claudeToolIds.has(id)) return;
      if (this.#claudeToolIds.size < maxTrackedIds) this.#claudeToolIds.add(id);
    }
    this.#toolUses++;
  }

  #countCodexTool(event: unknown, item: Record<string, unknown> | undefined): void {
    const id = typeof item?.['id'] === 'string' ? item['id'] : undefined;
    // An item is counted when first seen: item.started records it in flight, and its
    // item.completed then only clears that entry. An item without an ID counts on completion.
    if (event === 'item.started') {
      if (id === undefined || this.#codexInFlight.has(id)) return;
      if (this.#codexInFlight.size < maxTrackedIds) this.#codexInFlight.add(id);
      this.#toolUses++;
    } else if (event === 'item.completed') {
      if (id !== undefined && this.#codexInFlight.delete(id)) return;
      this.#toolUses++;
    }
  }
}
