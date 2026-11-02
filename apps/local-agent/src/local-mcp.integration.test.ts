import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalMcpServer, MCP_PROTOCOL_VERSION, type LocalTool } from './local-mcp.js';

const echo: LocalTool = {
  name: 'search_memories',
  description: 'search',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  run: async (args) => {
    if (args.query === 'boom') throw new Error('the memories could not be read');
    return `found ${String(args.query)}`;
  },
};

let server: LocalMcpServer;
beforeEach(async () => { server = new LocalMcpServer(); await server.start(); });
afterEach(async () => { await server.close(); });

const rpc = (url: string, body: unknown, method = 'POST') => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });

describe('Koala\'s tools served to an agent on the machine', () => {
  it('serves only on this machine, at a path of its own per session', () => {
    const one = server.mount([echo], 'read-only');
    const two = server.mount([echo], 'read-only');
    expect(one.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{36}$/);
    expect(one.url).not.toBe(two.url);
  });

  it('answers initialize, lists its tools and runs them, as an MCP client asks', async () => {
    const { url } = server.mount([echo], 'Koala\'s own tools, read-only.');
    expect(await (await rpc(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json()).toEqual({
      jsonrpc: '2.0', id: 1,
      result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'koala', version: '1' }, instructions: 'Koala\'s own tools, read-only.' },
    });
    expect((await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect(await (await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'search_memories', description: 'search', inputSchema: echo.inputSchema }] } });
    expect(await (await rpc(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_memories', arguments: { query: 'odoo 20' } } })).json()).toEqual({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'found odoo 20' }] } });
  });

  it('says plainly when a tool fails, a tool does not exist, or a method is not served', async () => {
    const { url } = server.mount([echo], '');
    expect(await (await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_memories', arguments: { query: 'boom' } } })).json())
      .toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'the memories could not be read' }], isError: true } });
    expect(await (await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'save_memory', arguments: {} } })).json())
      .toEqual({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'there is no tool called save_memory' } });
    expect((await (await rpc(url, { jsonrpc: '2.0', id: 3, method: 'resources/list' })).json() as { error: { code: number } }).error.code).toBe(-32601);
    expect((await rpc(url, {}, 'GET')).status).toBe(405);
  });

  it('stops answering a session\'s path once it is unmounted, and never answers a path it did not hand out', async () => {
    const mounted = server.mount([echo], '');
    mounted.unmount();
    expect((await rpc(mounted.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(404);
    expect((await rpc(mounted.url.replace(/[0-9a-f]{36}$/, 'guess'), { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(404);
  });
});
