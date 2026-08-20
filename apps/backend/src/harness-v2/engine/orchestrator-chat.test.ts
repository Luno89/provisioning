import { describe, it, expect } from 'vitest';
import { OrchestratorChat } from './orchestrator-chat.js';

describe('OrchestratorChat', () => {
  it('generates a rich conversational greeting for generic input', async () => {
    const res = await OrchestratorChat.processMessage('hello there');
    expect(res.message.role).toBe('assistant');
    expect(res.message.content).toContain('Harness V2 Orchestrator');
    expect(res.proposals).toHaveLength(0);
  });

  it('executes web search tool when asked to search online', async () => {
    const res = await OrchestratorChat.processMessage('search web for Temporal workflows TypeScript');
    expect(res.toolCallsExecuted).toHaveLength(1);
    expect(res.toolCallsExecuted[0]?.name).toBe('web_search');
    expect(res.message.content).toContain('latest web findings');
  });

  it('inspects infrastructure when asked about cluster services', async () => {
    const res = await OrchestratorChat.processMessage('what is deployed in the cluster infrastructure?');
    expect(res.toolCallsExecuted).toHaveLength(1);
    expect(res.toolCallsExecuted[0]?.name).toBe('list_infrastructure');
    expect(res.message.content).toContain('platform services');
  });

  it('proposes a structured HarnessTask for coding requests', async () => {
    const res = await OrchestratorChat.processMessage('Implement Redis rate limiting for authentication API');
    expect(res.proposals).toHaveLength(1);

    const proposal = res.proposals[0];
    expect(proposal?.title).toContain('Redis rate limiting');
    expect(proposal?.personaId).toBe('coder');
    expect(proposal?.budget.maxTurns).toBeGreaterThanOrEqual(10);
    expect(proposal?.rubrics).toBeDefined();
    expect(proposal?.status).toBe('proposed');
  });
});
