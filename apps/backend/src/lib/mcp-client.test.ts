import { describe, it, expect, vi } from 'vitest';
import { McpClient, parseRpcBody, sessionIdFrom, PROTOCOL_VERSION } from './mcp-client.js';

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'application/json', ...headers }),
  text: async () => JSON.stringify(body),
});

const sse = (body: unknown, headers: Record<string, string> = {}) => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'text/event-stream', ...headers }),
  text: async () => `event: message\ndata: ${JSON.stringify(body)}\n\n`,
});

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
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      const body = JSON.parse(String(init.body));
      if (body.method === 'initialize') return initReplyResponse();
      return json({ jsonrpc: '2.0', id: body.id, result: { tools: [] } }) as any;
    });
    const initReplyResponse = () => json(initReply(), { 'mcp-session-id': 'sess-42' }) as any;

    const client = new McpClient('http://server/mcp', fetchImpl as never);
    await client.initialize();
    await client.listTools();

    expect(calls).toHaveLength(2);
    expect((calls[0]!.headers as Record<string, string>)['mcp-session-id']).toBeUndefined();
    expect((calls[1]!.headers as Record<string, string>)['mcp-session-id']).toBe('sess-42');
  });

  it('reports the version the server AGREED to, not the one asked for', async () => {
    const fetchImpl = vi.fn(async () => json(initReply({ protocolVersion: '2024-11-05' })) as any);
    const client = new McpClient('http://server/mcp', fetchImpl as never);
    const session = await client.initialize();
    expect(session.protocolVersion).toBe('2024-11-05');
    expect(session.serverName).toBe('weather-mcp');
  });

  it('works with a stateless server that sends no session id', async () => {
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === 'initialize') return json(initReply()) as any;
      return json({ result: { tools: [{ name: 'x' }] } }) as any;
    });
    const client = new McpClient('http://server/mcp', fetchImpl as never);
    expect((await client.initialize()).sessionId).toBeUndefined();
    expect(await client.listTools()).toHaveLength(1);
  });

  it('initializes on its own if you go straight to listing tools', async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      methods.push(body.method);
      if (body.method === 'initialize') return json(initReply(), { 'mcp-session-id': 's' }) as any;
      return json({ result: { tools: [] } }) as any;
    });
    await new McpClient('http://server/mcp', fetchImpl as never).listTools();
    expect(methods).toEqual(['initialize', 'tools/list']);
  });
});

describe('calling a tool', () => {
  const withTool = (reply: unknown) => vi.fn(async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.method === 'initialize') return json(initReply(), { 'mcp-session-id': 's' }) as any;
    return json(reply) as any;
  });

  it('flattens text content into something an agent can read', async () => {
    const fetchImpl = withTool({ result: { content: [{ type: 'text', text: '{"tempC":18}' }] } });
    const out = await new McpClient('http://server/mcp', fetchImpl as never).callTool('get-forecast', { city: 'London' });
    expect(out.text).toBe('{"tempC":18}');
    expect(out.isError).toBe(false);
  });

  it('returns a protocol error as a result rather than throwing', async () => {
    const fetchImpl = withTool({ error: { code: -32602, message: 'Unknown tool' } });
    const out = await new McpClient('http://server/mcp', fetchImpl as never).callTool('nope', {});
    expect(out.isError).toBe(true);
    expect(out.text).toContain('Unknown tool');
  });

  it('honours the server saying its own tool failed', async () => {
    const fetchImpl = withTool({ result: { isError: true, content: [{ type: 'text', text: 'city not found' }] } });
    const out = await new McpClient('http://server/mcp', fetchImpl as never).callTool('get-forecast', { city: 'zzz' });
    expect(out.isError).toBe(true);
    expect(out.text).toBe('city not found');
  });

  it('surfaces an HTTP failure with its body', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 502, headers: new Headers(), text: async () => '<html>bad gateway</html>',
    }) as any);
    await expect(new McpClient('http://server/mcp', fetchImpl as never).initialize())
      .rejects.toThrow(/HTTP 502/);
  });
});
