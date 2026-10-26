import { t, type Lang, type MessageKey } from './messages.ts';
import type { LocalTool } from './query-tools.ts';

type JsonRpcId = string | number;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: Record<string, unknown> & { name?: unknown; clientInfo?: unknown; _meta?: Record<string, unknown> };
  result?: Record<string, unknown> & { tools?: unknown; isError?: unknown; content?: unknown };
  error?: unknown;
}

export interface ClientInfo {
  name?: string;
  version?: string;
}

export interface ToolCallEvent {
  tool: string;
  ms: number;
  isError: boolean;
  httpStatus?: number;
}

export interface RelayOptions {
  profileId: string;
  lang: Lang;
  disabledTools: ReadonlySet<string>;
  /** When set, the upstream runs without SAP settings and every tool error explains this instead. */
  blockedReason?: string;
  onClientInfo?: (info: ClientInfo) => void;
  onToolCall?: (event: ToolCallEvent) => void;
  /** Tools the launcher answers itself; a same-named upstream tool is replaced. */
  localTools?: LocalTool[];
  /** Receives the (later) answers to local tool calls. */
  onLocalReply?: (line: string) => void;
}

export interface ClientLineResult {
  /** Lines to forward to the upstream server. */
  toServer: string[];
  /** Lines to answer directly to Claude. */
  toClient: string[];
}

const UPSTREAM_HTTP = /SAP request failed \(HTTP (\d{3})\)/;
// The CSRF variant is what the upstream says when SAP cannot be reached before a POST (e.g. VPN off).
const UPSTREAM_CONNECTION = /SAP connection failed|CSRF token is required for POST\/PUT requests but could not be fetched/;
const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo';
const UPSTREAM_MISSING_ENV = /Missing required environment variables/;

/**
 * Sits between Claude and the unmodified upstream on the JSON-RPC level (one
 * JSON message per line). It hides disabled tools from tools/list, refuses
 * calls to them, and appends plain-language guidance to upstream errors.
 */
export class McpRelay {
  private readonly pendingLists = new Set<JsonRpcId>();
  private readonly pendingCalls = new Map<JsonRpcId, { tool: string; started: number }>();
  private clientInfoSeen = false;
  private serverInfoMeta: unknown;
  private readonly options: RelayOptions;

  constructor(options: RelayOptions) {
    this.options = options;
  }

  handleClientLine(line: string): ClientLineResult {
    const parsed = tryParse(line);
    if (parsed === undefined) return { toServer: [line], toClient: [] };
    if (Array.isArray(parsed)) {
      const forward: JsonRpcMessage[] = [];
      const replies: string[] = [];
      for (const msg of parsed as JsonRpcMessage[]) {
        const reply = this.inspectClientMessage(msg);
        if (typeof reply === 'string') replies.push(reply);
        else if (reply === undefined) forward.push(msg);
      }
      return { toServer: forward.length ? [JSON.stringify(forward)] : [], toClient: replies };
    }
    const reply = this.inspectClientMessage(parsed as JsonRpcMessage);
    if (reply === undefined) return { toServer: [line], toClient: [] };
    return { toServer: [], toClient: reply === null ? [] : [reply] };
  }

  handleServerLine(line: string): string {
    const parsed = tryParse(line);
    if (parsed === undefined) return line;
    if (Array.isArray(parsed)) {
      const changed = (parsed as JsonRpcMessage[]).map((m) => this.rewriteServerMessage(m));
      return changed.some(Boolean) ? JSON.stringify(parsed) : line;
    }
    return this.rewriteServerMessage(parsed as JsonRpcMessage) ? JSON.stringify(parsed) : line;
  }

  /**
   * undefined: forward to the upstream. A string: answer now instead. null:
   * consumed here, the answer comes later through onLocalReply.
   */
  private inspectClientMessage(msg: JsonRpcMessage): string | null | undefined {
    if (!msg || typeof msg !== 'object') return undefined;
    this.captureClientInfo(msg);
    const id = msg.id;
    if (id === undefined || id === null) return undefined;
    if (msg.method === 'tools/list') {
      this.pendingLists.add(id);
      return undefined;
    }
    if (msg.method === 'tools/call') {
      const tool = typeof msg.params?.name === 'string' ? msg.params.name : '';
      if (this.options.disabledTools.has(tool)) {
        return JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: this.text('relay.disabled', { tool }) },
        });
      }
      const local = this.localTool(tool);
      if (local) return this.callLocal(id, local, msg.params?.arguments);
      this.pendingCalls.set(id, { tool, started: Date.now() });
    }
    return undefined;
  }

  private localTool(name: string): LocalTool | undefined {
    return this.options.localTools?.find((l) => l.definition.name === name);
  }

  private callLocal(id: JsonRpcId, local: LocalTool, rawArgs: unknown): string | null {
    const tool = local.definition.name;
    if (this.options.blockedReason) return this.toolResult(id, `Error: ${this.options.blockedReason}`, true);
    const started = Date.now();
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
    void local
      .call(args)
      .catch((e: unknown) => ({ text: `Error: ${(e as Error)?.message ?? String(e)}`, isError: true, httpStatus: undefined }))
      .then((r) => {
        this.options.onToolCall?.({ tool, ms: Date.now() - started, isError: r.isError, httpStatus: r.httpStatus });
        this.options.onLocalReply?.(this.toolResult(id, r.text, r.isError));
      });
    return null;
  }

  /** A tools/call result valid in both protocol eras (2026-07-28 requires resultType; earlier ones ignore it). */
  private toolResult(id: JsonRpcId, text: string, isError: boolean): string {
    const result: Record<string, unknown> = { content: [{ type: 'text', text }], isError, resultType: 'complete' };
    if (this.serverInfoMeta) result._meta = { [SERVER_INFO_META]: this.serverInfoMeta };
    return JSON.stringify({ jsonrpc: '2.0', id, result });
  }

  private captureClientInfo(msg: JsonRpcMessage): void {
    if (this.clientInfoSeen || !this.options.onClientInfo) return;
    const fromInitialize = msg.method === 'initialize' ? msg.params?.clientInfo : undefined;
    const fromMeta = msg.params?._meta?.['io.modelcontextprotocol/clientInfo'];
    const info = (fromInitialize ?? fromMeta) as ClientInfo | undefined;
    if (info && typeof info === 'object') {
      this.clientInfoSeen = true;
      this.options.onClientInfo({ name: str(info.name), version: str(info.version) });
    }
  }

  /** Mutates the message in place; returns true when something changed. */
  private rewriteServerMessage(msg: JsonRpcMessage): boolean {
    if (!msg || typeof msg !== 'object' || msg.id === undefined || msg.id === null) return false;
    const id = msg.id;
    const meta = msg.result?._meta as Record<string, unknown> | undefined;
    if (meta && typeof meta === 'object' && meta[SERVER_INFO_META]) this.serverInfoMeta ??= meta[SERVER_INFO_META];

    if (this.pendingLists.delete(id)) {
      const tools = msg.result?.tools;
      if (Array.isArray(tools)) {
        const merged = this.withLocalTools(tools as { name?: string }[]);
        const visible = merged.filter((tool) => !this.options.disabledTools.has(tool.name ?? ''));
        if (merged !== tools || visible.length !== tools.length) {
          msg.result!.tools = visible;
          return true;
        }
      }
      return false;
    }

    const call = this.pendingCalls.get(id);
    if (!call) return false;
    this.pendingCalls.delete(id);
    const result = msg.result;
    const isError = Boolean(msg.error) || result?.isError === true;
    const first = Array.isArray(result?.content) ? (result.content[0] as { type?: string; text?: unknown }) : undefined;
    const text = typeof first?.text === 'string' ? first.text : '';
    const status = UPSTREAM_HTTP.exec(text)?.[1];
    this.options.onToolCall?.({
      tool: call.tool,
      ms: Date.now() - call.started,
      isError,
      httpStatus: status ? Number(status) : undefined,
    });
    if (result?.isError !== true || !first || typeof first.text !== 'string') return false;

    const guidance = this.guidanceFor(text, status);
    if (!guidance) return false;
    first.text = this.options.blockedReason ? `Error: ${guidance}` : `${text}\n\n${guidance}`;
    return true;
  }

  /** Local definitions replace same-named upstream tools; new ones follow the tool they extend. */
  private withLocalTools(tools: { name?: string }[]): { name?: string }[] {
    const local = this.options.localTools ?? [];
    if (!local.length) return tools;
    const merged = tools.map((tool) => this.localTool(tool.name ?? '')?.definition ?? tool);
    for (const l of local) {
      if (merged.some((tool) => tool.name === l.definition.name)) continue;
      const after = merged.findIndex((tool) => tool.name === 'GetTableContents');
      merged.splice(after >= 0 ? after + 1 : merged.length, 0, l.definition);
    }
    return merged;
  }

  private guidanceFor(text: string, status: string | undefined): string | undefined {
    if (this.options.blockedReason) return this.options.blockedReason;
    if (status) {
      const code = Number(status);
      if (code === 401) return this.text('relay.http401');
      if (code === 403) return this.text('relay.http403');
      if (code === 404) return this.text('relay.http404');
      if (code >= 300 && code < 400) return this.text('relay.http3xx', { status });
      if (code >= 500) return this.text('relay.http5xx', { status });
      return undefined;
    }
    if (UPSTREAM_CONNECTION.test(text)) return this.text('relay.connection');
    if (UPSTREAM_MISSING_ENV.test(text)) return this.text('relay.noPassword');
    return undefined;
  }

  private text(key: MessageKey, vars: Record<string, string> = {}): string {
    return t(this.options.lang, key, { profile: this.options.profileId, ...vars });
  }
}

function tryParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Splits a UTF-8 text stream into lines (MCP stdio frames are newline-delimited JSON). */
export class LineSplitter {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter((l) => l.length > 0);
  }

  flush(): string[] {
    const rest = this.buffer;
    this.buffer = '';
    return rest ? [rest] : [];
  }
}
