import { describe, it, expect, vi } from 'vitest';
import { McpClient, parseRpcBody, sessionIdFrom, PROTOCOL_VERSION, type Fetcher } from './mcp-client.js';

const json = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

const rpcOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as { method: string; id: number };

const answering = (answer: (init: RequestInit | undefined) => Response) => vi.fn<Fetcher>(async (_url, init) => answer(init));

const initReply = (over: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0', id: 1,
  result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'weather-mcp', version: '0.1.0' }, ...over },
});

describe('reading a reply', () => {
  it('reads plain JSON', () => {
    expect(parseRpcBody('application/json', '{"a":1}')).toEqual({ a: 1 });
  });

  it('reads an SSE stream, taking the last data frame', () => {
    const body = 'event: message\ndata: {"first":true}\n\ndata: {"jsonrpc":"2.0","result":{"ok":1}}\n\n';
    expect(parseRpcBody('text/event-stream', body)).toEqual({ jsonrpc: '2.0', result: { ok: 1 } });
  });

  it('ignores the [DONE] sentinel', () => {
    const body = 'data: {"result":{"ok":1}}\n\ndata: [DONE]\n\n';
    expect(parseRpcBody('text/event-stream', body)).toEqual({ result: { ok: 1 } });
  });

  it('says so when a stream carried nothing', () => {
    expect(() => parseRpcBody('text/event-stream', 'event: ping\n\n')).toThrow(/no data frames/i);
  });

  it('finds the session header whatever its casing', () => {
    expect(sessionIdFrom(new Headers({ 'Mcp-Session-Id': 'abc' }))).toBe('abc');
    expect(sessionIdFrom(new Headers({ 'mcp-session-id': 'abc' }))).toBe('abc');
    expect(sessionIdFrom(new Headers({}))).toBeUndefined();
  });
});

describe('the session', () => {
  it('carries the id from initialize into every later call', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = answering((init) => {
      calls.push(init ?? {});
      const body = rpcOf(init);
      if (body.method === 'initialize') return json(initReply(), { 'mcp-session-id': 'sess-42' });
      return json({ jsonrpc: '2.0', id: body.id, result: { tools: [] } });
    });

    const client = new McpClient('http://server/mcp', fetchImpl);
    await client.initialize();
    await client.listTools();

    expect(calls).toHaveLength(2);
    expect((calls[0]!.headers as Record<string, string>)['mcp-session-id']).toBeUndefined();
    expect((calls[1]!.headers as Record<string, string>)['mcp-session-id']).toBe('sess-42');
  });

  it('reports the version the server AGREED to, not the one asked for', async () => {
    const fetchImpl = answering(() => json(initReply({ protocolVersion: '2024-11-05' })));
    const client = new McpClient('http://server/mcp', fetchImpl);
    const session = await client.initialize();
    expect(session.protocolVersion).toBe('2024-11-05');
    expect(session.serverName).toBe('weather-mcp');
  });

  it('works with a stateless server that sends no session id', async () => {
    const fetchImpl = answering((init) => {
      if (rpcOf(init).method === 'initialize') return json(initReply());
      return json({ result: { tools: [{ name: 'x' }] } });
    });
    const client = new McpClient('http://server/mcp', fetchImpl);
    expect((await client.initialize()).sessionId).toBeUndefined();
    expect(await client.listTools()).toHaveLength(1);
  });

  it('keeps what the server says about itself to whoever uses it', async () => {
    const client = new McpClient('http://x/mcp', answering(() => json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'Playwright', version: '1.64' }, instructions: '  Use browser_snapshot before clicking.  ' } })));
    expect(await client.initialize()).toMatchObject({ serverName: 'Playwright', serverVersion: '1.64', instructions: 'Use browser_snapshot before clicking.' });
  });

  it('initializes on its own if you go straight to listing tools', async () => {
    const methods: string[] = [];
    const fetchImpl = answering((init) => {
      const body = rpcOf(init);
      methods.push(body.method);
      if (body.method === 'initialize') return json(initReply(), { 'mcp-session-id': 's' });
      return json({ result: { tools: [] } });
    });
    await new McpClient('http://server/mcp', fetchImpl).listTools();
    expect(methods).toEqual(['initialize', 'tools/list']);
  });
});

describe('calling a tool', () => {
  const withTool = (reply: unknown) => answering((init) => {
    if (rpcOf(init).method === 'initialize') return json(initReply(), { 'mcp-session-id': 's' });
    return json(reply);
  });

  it('flattens text content into something an agent can read', async () => {
    const fetchImpl = withTool({ result: { content: [{ type: 'text', text: '{"tempC":18}' }] } });
    const out = await new McpClient('http://server/mcp', fetchImpl).callTool('get-forecast', { city: 'London' });
    expect(out.text).toBe('{"tempC":18}');
    expect(out.isError).toBe(false);
  });

  it('returns a protocol error as a result rather than throwing', async () => {
    const fetchImpl = withTool({ error: { code: -32602, message: 'Unknown tool' } });
    const out = await new McpClient('http://server/mcp', fetchImpl).callTool('nope', {});
    expect(out.isError).toBe(true);
    expect(out.text).toContain('Unknown tool');
  });

  it('honours the server saying its own tool failed', async () => {
    const fetchImpl = withTool({ result: { isError: true, content: [{ type: 'text', text: 'city not found' }] } });
    const out = await new McpClient('http://server/mcp', fetchImpl).callTool('get-forecast', { city: 'zzz' });
    expect(out.isError).toBe(true);
    expect(out.text).toBe('city not found');
  });

  it('surfaces an HTTP failure with its body', async () => {
    const fetchImpl = answering(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(new McpClient('http://server/mcp', fetchImpl).initialize())
      .rejects.toThrow(/HTTP 502/);
  });
});
