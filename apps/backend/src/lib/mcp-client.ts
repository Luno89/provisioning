
export const PROTOCOL_VERSION = '2025-06-18';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpSession {
  sessionId?: string | undefined;
  protocolVersion: string;
  serverName?: string | undefined;
  serverVersion?: string | undefined;
}

export type Fetcher = typeof fetch;

export function parseRpcBody(contentType: string, body: string): unknown {
  if (!contentType.includes('text/event-stream')) {
    return JSON.parse(body);
  }
  const frames = body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((d) => d && d !== '[DONE]');
  const last = frames[frames.length - 1];
  if (!last) throw new Error('The stream carried no data frames.');
  return JSON.parse(last);
}

export function sessionIdFrom(headers: Headers): string | undefined {
  return headers.get('mcp-session-id') ?? headers.get('Mcp-Session-Id') ?? undefined;
}

interface RpcResult {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export class McpClient {
  private session: McpSession | undefined;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: Fetcher = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  private async rpc(method: string, params: Record<string, unknown> = {}): Promise<RpcResult & { headers: Headers }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.session?.sessionId ? { 'mcp-session-id': this.session.sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${method}: ${text.slice(0, 200)}`);
      }
      const parsed = parseRpcBody(res.headers.get('content-type') ?? '', text) as RpcResult;
      return { ...parsed, headers: res.headers };
    } finally {
      clearTimeout(timer);
    }
  }

  async initialize(): Promise<McpSession> {
    const out = await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'koala', version: '1' },
    });
    if (out.error) throw new Error(`initialize failed: ${out.error.message}`);

    const info = (out.result?.serverInfo ?? {}) as { name?: string; version?: string };
    this.session = {
      sessionId: sessionIdFrom(out.headers),
      protocolVersion: String(out.result?.protocolVersion ?? PROTOCOL_VERSION),
      serverName: info.name,
      serverVersion: info.version,
    };
    return this.session;
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.session) await this.initialize();
    const out = await this.rpc('tools/list');
    if (out.error) throw new Error(`tools/list failed: ${out.error.message}`);
    const tools = out.result?.tools;
    return Array.isArray(tools) ? (tools as McpTool[]) : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    if (!this.session) await this.initialize();
    const out = await this.rpc('tools/call', { name, arguments: args });
    if (out.error) return { text: `${out.error.message} (code ${out.error.code})`, isError: true };

    const content = out.result?.content;
    const text = Array.isArray(content)
      ? content.map((c: { type?: string; text?: string }) => (c?.type === 'text' ? c.text ?? '' : `[${c?.type}]`)).join('\n')
      : JSON.stringify(out.result ?? {});
    return { text, isError: Boolean(out.result?.isError) };
  }

  get current(): McpSession | undefined {
    return this.session;
  }
}
