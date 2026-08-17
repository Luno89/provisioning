/**
 * Talking to an MCP server over Streamable HTTP.
 *
 * ── WHY THIS EXISTS ──
 * Koala builds MCP servers and then cannot use them. It deploys one, the pod runs, and nothing in
 * the harness has any idea what tools it exposes — so the next thing Koala builds cannot call the
 * thing it built last week. Closing that loop starts here: a client that can ask a running server
 * what it can do.
 *
 * ── THE SESSION HEADER, WHICH IS THE WHOLE TRICK ──
 * Streamable HTTP is not stateless. `initialize` returns an `Mcp-Session-Id` header, and EVERY
 * later request must carry it or the server answers `-32601 Session not found`. Probing a deployed
 * server by hand without it, I read that error as a defect in the generated server and nearly filed
 * it as a bug — the server was correct and the client was wrong. Getting this into code, once, is
 * the point.
 *
 * ── AND THE TWO RESPONSE SHAPES ──
 * The same endpoint answers with `application/json` or with an SSE stream, at the server's
 * discretion, and a client that handles only one works against half the servers it meets. Both are
 * parsed here.
 */

/** The protocol version this client speaks. Servers may negotiate down; that is reported, not fixed. */
export const PROTOCOL_VERSION = '2025-06-18';

export interface McpTool {
  name: string;
  description?: string;
  /** JSON Schema for the arguments, as the server declares it. */
  inputSchema?: Record<string, unknown>;
}

export interface McpSession {
  /** Returned by `initialize`; absent for a stateless server, which is legal. */
  sessionId?: string | undefined;
  /** What the server actually agreed to, which may not be what was asked for. */
  protocolVersion: string;
  serverName?: string | undefined;
  serverVersion?: string | undefined;
}

export type Fetcher = typeof fetch;

/**
 * Reads a JSON-RPC reply out of either response shape.
 *
 * An SSE body carries the payload in `data:` lines; the last complete one is the reply. Exported so
 * the parsing can be tested without a server, which is where the sharp edges are.
 */
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

/** Pulls the session id out, case-insensitively — servers differ on how they spell the header. */
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
    /** Generous by MCP standards: a tool call may do real work. */
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
          // Both, because the server chooses which to send and refusing one is how a client ends up
          // working against only half the servers it meets.
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

  /** Opens a session. Must be called before anything else, and its header is remembered. */
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
      // What the server AGREED to. Reporting the requested version instead would hide a server
      // speaking something older, which is exactly the kind of mismatch that shows up as a
      // baffling failure three calls later.
      protocolVersion: String(out.result?.protocolVersion ?? PROTOCOL_VERSION),
      serverName: info.name,
      serverVersion: info.version,
    };
    return this.session;
  }

  /** What the server can do. */
  async listTools(): Promise<McpTool[]> {
    if (!this.session) await this.initialize();
    const out = await this.rpc('tools/list');
    if (out.error) throw new Error(`tools/list failed: ${out.error.message}`);
    const tools = out.result?.tools;
    return Array.isArray(tools) ? (tools as McpTool[]) : [];
  }

  /**
   * Runs one of its tools.
   *
   * A tool that fails returns `isError` with content rather than throwing — that is the protocol's
   * design and it is the right one here too: a failed tool call is information the agent can act
   * on, not a reason to abandon the run.
   */
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
