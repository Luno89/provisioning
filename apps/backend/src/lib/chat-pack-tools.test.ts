import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makePackToolExecutor } from './chat-pack-tools.js';

vi.mock('./koala-tool-runner.js', () => ({ runKoalaTool: vi.fn() }));
import { runKoalaTool } from './koala-tool-runner.js';

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

  it('falls back to a koala tool for an unqualified name', async () => {
    vi.mocked(runKoalaTool).mockResolvedValueOnce({ content: 'koala out' });
    const exec = makePackToolExecutor(context);
    const out = await exec({ id: 'c', name: 'list_mcp_servers', arguments: '{}' });
    expect(out.content).toBe('koala out');
    expect(out.ok).toBe(true);
  });
});