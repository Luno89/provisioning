import { describe, it, expect } from 'vitest';
import { OrchestratorChat } from './orchestrator-chat.js';

describe('OrchestratorChat', () => {
  it('generates a conversational greeting for generic input', async () => {
    const res = await OrchestratorChat.processMessage('hello there');
    expect(res.message.role).toBe('assistant');
    expect(res.message.content).toContain('ready to help');
    expect(res.proposals).toHaveLength(0);
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

  it('proposes a research task for investigation requests', async () => {
    const res = await OrchestratorChat.processMessage('Research FlashAttention support for Qwen 2.5');
    expect(res.proposals).toHaveLength(1);

    const proposal = res.proposals[0];
    expect(proposal?.personaId).toBe('researcher');
    expect(proposal?.rubrics?.some((r) => r.name === 'evidence_and_citations')).toBe(true);
  });
});
