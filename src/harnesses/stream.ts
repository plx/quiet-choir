import type { AgentDiagnostics, AgentProgress } from '../harness-kit.js';
import type { HarnessInvocation, InvocationStream, JsonValue } from '../harness-kit.js';
import { createInvocationStream } from '../harness-kit.js';
import { ClaudeProtocol, CodexProtocol, type ProtocolOutcome } from './protocol.js';
import { parseClaudeRateLimitEvent } from '../workflow/runtime/rate-limit.js';
import { codexItemHeader, irrelevantLine, JsonLines, retainedLimit } from './lines.js';

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

/** Longest tool target in a progress summary, in code points. */
const maxTargetLength = 80;
/** Characters of a native value examined for a target; the rest cannot reach the summary. */
const targetScanLength = 4096;
/** Minimum gap between thinking lines within one burst of consecutive thinking status lines. */
const thinkingProgressIntervalMs = 10_000;
/** Claude tool input keys a target may come from, in priority order; nothing else is read. */
const claudeTargetKeys = [
  'file_path',
  'notebook_path',
  'command',
  'pattern',
  'url',
  'query',
  'path',
  'description',
] as const;
/** Keys whose values are paths: bounding keeps their tail so the filename survives. */
const pathTargetKeys = new Set<string>(['file_path', 'notebook_path', 'path']);

/**
 * A short, bounded progress target, or null. Only the first line is kept, with control characters
 * and runs of whitespace collapsed to one space. An http(s) URL loses its userinfo, query and
 * fragment, so a token in it never reaches progress. Past {@link maxTargetLength} code points a
 * path keeps its tail and anything else its head, marked with `…` where text was cut.
 */
function target(value: unknown, path = false): string | null {
  if (typeof value !== 'string') return null;
  let text = (
    value
      .slice(0, targetScanLength)
      .trimStart()
      .split(/\r\n|\r|\n/u, 1)[0] ?? ''
  )
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (/^https?:\/\//iu.test(text)) {
    const url = URL.parse(text);
    if (url === null) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    text = url.href;
  }
  const points = Array.from(text);
  if (points.length === 0) return null;
  if (points.length <= maxTargetLength) return text;
  return path
    ? `…${points.slice(1 - maxTargetLength).join('')}`
    : `${points.slice(0, maxTargetLength - 1).join('')}…`;
}

/** Strip one `sh`/`bash`/`zsh` `-c`/`-lc` wrapper and one level of matching quotes around it. */
function unwrapShell(command: string): string {
  const inner = /^\s*(?:\S*\/)?(?:bash|zsh|sh)\s+-l?c\s+([\s\S]+)$/u.exec(command)?.[1]?.trim();
  if (inner === undefined) return command;
  const quote = inner[0];
  return (quote === "'" || quote === '"') && inner.length >= 2 && inner.endsWith(quote)
    ? inner.slice(1, -1)
    : inner;
}

/** A Codex command: a string, or an argv array of strings joined by spaces. */
function codexCommand(value: unknown): string | null {
  const command =
    typeof value === 'string'
      ? value
      : Array.isArray(value) && value.every((part) => typeof part === 'string')
        ? value.slice(0, 64).join(' ')
        : null;
  return command === null ? null : target(unwrapShell(command.slice(0, targetScanLength)));
}

/** A Claude `thinking_tokens` status line, which arrives about once a second while thinking. */
function thinkingLine(data: Record<string, unknown>): boolean {
  return data['type'] === 'system' && data['subtype'] === 'thinking_tokens';
}

/** Append a target to a summary, and ` (+N more)` for further calls in the same line. */
function withTarget(summary: string, found: string | null, more = 0): string {
  return `${summary}${found === null ? '' : ` ${found}`}${more > 0 ? ` (+${String(more)} more)` : ''}`;
}

/** Native JSONL state, bounded diagnostics and lossy progress; no filesystem ownership. @internal */
export class HarnessStream {
  public readonly protocol: ClaudeProtocol | CodexProtocol;
  readonly #lines: JsonLines;
  readonly #harness: 'claude' | 'codex';
  /** The shared onOutput tee, session-once and progress throttle of the public harness kit. */
  readonly #plumbing: InvocationStream;
  readonly #limit: number;
  readonly #structured: boolean;
  /** Tool calls counted from every parsed line (progress is throttled, so it cannot count). */
  #toolUses = 0;
  /** A skipped oversized line may have carried tool calls that were not counted. */
  #toolUsesUnknown = false;
  readonly #claudeToolIds = new Set<string>();
  readonly #codexInFlight = new Set<string>();
  readonly #diagnostics: Record<string, JsonValue> = { model: null, cliVersion: null };
  #skippedLines = 0;
  /** When the last thinking line was offered to progress (`performance.now()` clock). */
  #thinkingReportedAt = -Infinity;
  /** Whether the last progress-producing line was a thinking line. */
  #inThinkingRun = false;
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
    this.#limit = limit;
    this.#structured = structured;
    this.protocol =
      harness === 'claude'
        ? new ClaudeProtocol(structured, requested)
        : new CodexProtocol(requested);
    this.#lines = new JsonLines(
      limit,
      (line) => this.#consume(line),
      (prefix) => {
        if (!irrelevantLine(harness, prefix)) return false;
        this.#skippedLines++;
        this.#countSkipped(prefix);
        return true;
      },
    );
    this.#plumbing = createInvocationStream({
      invocation: context,
      stdout: (chunk) => {
        const text = Buffer.from(chunk).toString('utf8');
        this.#sawStdout ||= /\S/u.test(text);
        this.#stdoutTail = (this.#stdoutTail + text).slice(-1024);
        return this.#lines.feed(chunk);
      },
    });
  }

  public get stdoutTail(): string {
    return this.#stdoutTail;
  }

  /** Whether stdout carried any non-whitespace text; the process result retains no stdout. */
  public get sawStdout(): boolean {
    return this.#sawStdout;
  }

  public stdout(chunk: Uint8Array): Promise<void> {
    return this.#plumbing.stdout(chunk);
  }

  public stderr(chunk: Uint8Array): Promise<void> {
    return this.#plumbing.stderr(chunk);
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
    // Thinking lines track their own run; every other progress-producing line ends it.
    if (progress && !(this.#harness === 'claude' && thinkingLine(data)))
      this.#inThinkingRun = false;
    if (
      this.protocol.retainedBytes + Buffer.byteLength(JSON.stringify(this.#diagnostics)) >
      this.#limit
    )
      throw retainedLimit(this.#limit);
    // The session is awaited before this line's progress and before any further output.
    const session = this.protocol.sessionId;
    if (session) await this.#plumbing.session(session);
    if (progress) this.#plumbing.progress(progress);
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
      if (!tool) return { kind: 'message', summary: 'Claude assistant message' };
      const name = short(object(tool)?.['name']);
      const more =
        (content as unknown[]).filter((item) => object(item)?.['type'] === 'tool_use').length - 1;
      return {
        kind: 'tool',
        summary: withTarget(
          `Claude tool: ${name ?? 'unknown'}`,
          this.#claudeTarget(tool, name),
          more,
        ),
      };
    }
    if (data['type'] === 'rate_limit_event') {
      // The latest valid event wins; a malformed or empty one keeps any earlier report and, like
      // every other observation here, can never fail a call.
      const report = parseClaudeRateLimitEvent(data);
      if (report) this.#diagnostics['rateLimit'] = report;
      return { kind: 'status', summary: `Claude: rate limit ${report?.status ?? 'event'}` };
    }
    if (thinkingLine(data)) {
      // Collapse a burst: its first line, then at most one line per interval as a heartbeat.
      const now = performance.now();
      const report =
        !this.#inThinkingRun || now - this.#thinkingReportedAt >= thinkingProgressIntervalMs;
      this.#inThinkingRun = true;
      if (!report) return undefined;
      this.#thinkingReportedAt = now;
      const tokens = count(data['estimated_tokens']);
      return {
        kind: 'status',
        summary:
          tokens === null ? 'Claude: thinking' : `Claude: thinking (~${String(tokens)} tokens)`,
      };
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
        summary: this.#codexTarget(
          type,
          item,
          `Codex ${type}: ${short(data['type']) ?? 'activity'}`,
        ),
      };
    if (typeof data['type'] === 'string')
      return { kind: 'status', summary: `Codex: ${data['type'].slice(0, 128)}` };
    return undefined;
  }

  /**
   * The target of a Claude tool_use block, read only through {@link claudeTargetKeys}: never file
   * contents, edit strings, prompts or MCP arguments. StructuredOutput in a structured call has
   * none, because its input is the result payload.
   */
  #claudeTarget(block: unknown, name: string | null): string | null {
    if (this.#structured && name === 'StructuredOutput') return null;
    const input = object(object(block)?.['input']);
    if (!input) return null;
    for (const key of claudeTargetKeys) {
      const found = target(input[key], pathTargetKeys.has(key));
      if (found !== null) return found;
    }
    return null;
  }

  /** A Codex tool item's target: a command, the first changed path, `server/tool` or a query. */
  #codexTarget(type: string, item: Record<string, unknown> | undefined, summary: string): string {
    if (type === 'command_execution') return withTarget(summary, codexCommand(item?.['command']));
    if (type === 'file_change') {
      const changes = item?.['changes'];
      const path = Array.isArray(changes) ? target(object(changes[0])?.['path'], true) : null;
      // The count of further files only means something next to the first one.
      return path === null ? summary : withTarget(summary, path, (changes as unknown[]).length - 1);
    }
    if (type === 'mcp_tool_call') {
      const server = target(item?.['server']);
      const tool = target(item?.['tool']);
      return withTarget(
        summary,
        server === null || tool === null ? (server ?? tool) : target(`${server}/${tool}`),
      );
    }
    if (type === 'web_search') return withTarget(summary, target(item?.['query']));
    return summary;
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
