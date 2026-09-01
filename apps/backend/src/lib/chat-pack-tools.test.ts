import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makePackToolExecutor } from './chat-pack-tools.js';

vi.mock('./tool-registry.js', () => ({ runTool: vi.fn() }));
import { runTool } from './tool-registry.js';

const github = { name: 'github-mcp', description: 'GitHub MCP' };

const context: any = {
  userId: 'u1',
  conversationId: 'c1',
  sessionId: 's1',
  enabledNames: ['github-mcp'],
  servers: [github],
  webSearch: async () => ({ results: [] }),
  fetchWebPage: async () => '',
  toolRefused: (r: string) => r.startsWith('REFUSED'),
  registry: { call: vi.fn() },
  kubectl: async (a: string[]) => `kubectl ${a.join(' ')}`,
};

beforeEach(() => vi.clearAllMocks());

describe('the persona-pack tool dispatcher', () => {
  it('routes an enabled server tool to its MCP registry', async () => {
    context.registry.call.mockResolvedValueOnce({ text: 'remote answer' });
    const exec = makePackToolExecutor(context);
    const out = await exec({ id: 'c', name: 'github-mcp__get-repo', arguments: '{}' });

    expect(context.registry.call).toHaveBeenCalledWith(github, 'get-repo', {});
    expect(out.content).toBe('remote answer');
    expect(out.ok).toBe(true);
  });

  it('marks a refused remote result so the loop treats it as terminal', async () => {
    context.registry.call.mockResolvedValueOnce({ text: 'REFUSED do not enable' });
    const exec = makePackToolExecutor(context);
    const out = await exec({ id: 'c', name: 'github-mcp__get-repo', arguments: '{}' });
    expect(out.ok).toBe(false);
  });

  it('sends an unqualified name to the tool registry, whatever kind of tool it is', async () => {
    vi.mocked(runTool).mockResolvedValueOnce({ content: 'registry out' });
    const exec = makePackToolExecutor(context);
    const out = await exec({ id: 'c', name: 'list_mcp_servers', arguments: '{}' });
    expect(out.content).toBe('registry out');
    expect(out.ok).toBe(true);
  });

  /**
   * The bug this file's whole shape came from: a chat pack granting a planning tool had it offered
   * to the model and then refused at dispatch, because the chat had its own map of 25 names.
   */
  it('sends a planning tool there too, rather than refusing it as unknown', async () => {
    vi.mocked(runTool).mockResolvedValueOnce({ content: '{"leaves":[]}' });
    const exec = makePackToolExecutor(context);
    const out = await exec({ id: 'c', name: 'list_leaves', arguments: '{}' });
    expect(vi.mocked(runTool).mock.calls[0]![1]).toEqual({ name: 'list_leaves', arguments: '{}' });
    expect(out.content).toBe('{"leaves":[]}');
  });
});