import { describe, it, expect, vi } from 'vitest';
import { OrchestratorChat } from './orchestrator-chat.js';

describe('OrchestratorChat', () => {
  it('executes get_openapi_spec tool directly', async () => {
    const res = await OrchestratorChat.executeTool({
      id: 'call-1',
      name: 'get_openapi_spec',
      args: {},
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('openapi');
    expect(res.stdout).toContain('/clusters');
  });

  it('executes propose_task tool directly with dynamic rubrics', async () => {
    const res = await OrchestratorChat.executeTool({
      id: 'call-2',
      name: 'propose_task',
      args: {
        title: 'Build Redis rate limiter',
        description: 'Create rate limiting middleware in Express with token bucket algorithm',
        personaId: 'coder',
      },
    });
    expect(res.exitCode).toBe(0);
    const proposal = JSON.parse(res.stdout!);
    expect(proposal.title).toBe('Build Redis rate limiter');
    expect(proposal.personaId).toBe('coder');
    expect(proposal.budget.maxTurns).toBeGreaterThanOrEqual(10);
    expect(proposal.rubrics.length).toBeGreaterThan(0);
  });

  it('executes web_search tool directly', async () => {
    const res = await OrchestratorChat.executeTool({
      id: 'call-3',
      name: 'web_search',
      args: { query: 'Temporal TypeScript SDK' },
    });
    expect(res.exitCode).toBe(0);
  });

  it('processes message and invokes model completions with tools', async () => {
    const mockModelService: any = {
      list: vi.fn().mockResolvedValue([
        { id: 'mock-model', name: 'Mock LLM', source: 'endpoint', baseUrl: 'http://localhost:11434/v1', model: 'mock' },
      ]),
      resolveBaseUrl: vi.fn().mockResolvedValue({
        provider: { id: 'mock-model', name: 'Mock LLM', source: 'endpoint', model: 'mock' },
        baseUrl: 'http://localhost:11434/v1',
      }),
    };

    // When model server is unavailable, returns clear diagnostic notice
    const res = await OrchestratorChat.processMessage('hello', [], {
      userId: 'test-user',
      modelService: mockModelService,
    });
    expect(res.message.role).toBe('assistant');
  });
});
