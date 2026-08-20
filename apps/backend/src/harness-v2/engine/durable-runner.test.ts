import { describe, it, expect, vi } from 'vitest';
import { DurableRunner } from './durable-runner.js';

describe('DurableRunner', () => {
  const mockSandbox = {
    exec: vi.fn().mockResolvedValue({ stdout: 'success', stderr: '', exitCode: 0 }),
    readFile: vi.fn().mockResolvedValue('file content'),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };

  it('processes approved tool calls and returns step record', async () => {
    const result = await DurableRunner.processTurn({
      taskId: 't-1',
      turnIndex: 1,
      phase: 'implement',
      personaId: 'p-1',
      personaRole: 'coder',
      workspacePath: '/work/repo',
      sandbox: mockSandbox,
      modelResponse: {
        promptTokens: 100,
        completionTokens: 50,
        content: 'Running tests now',
        toolCalls: [
          { id: 'c1', name: 'run_command', args: { command: 'npm test' } },
        ],
      },
    });

    expect(result.step.actionGate.passed).toBe(true);
    expect(result.step.toolResults).toHaveLength(1);
    expect(result.step.toolResults[0]?.stdout).toBe('success');
    expect(result.finished).toBe(false);
  });

  it('intercepts dangerous tool calls without invoking sandbox', async () => {
    mockSandbox.exec.mockClear();

    const result = await DurableRunner.processTurn({
      taskId: 't-1',
      turnIndex: 2,
      phase: 'implement',
      personaId: 'p-1',
      personaRole: 'coder',
      workspacePath: '/work/repo',
      sandbox: mockSandbox,
      modelResponse: {
        promptTokens: 100,
        completionTokens: 50,
        content: 'Cleaning up root',
        toolCalls: [
          { id: 'c2', name: 'run_command', args: { command: 'rm -rf /' } },
        ],
      },
    });

    expect(result.step.actionGate.passed).toBe(false);
    expect(result.step.actionGate.riskLevel).toBe('critical');
    expect(mockSandbox.exec).not.toHaveBeenCalled();
    expect(result.step.toolResults[0]?.isError).toBe(true);
    expect(result.step.toolResults[0]?.stderr).toContain('[ACTION GATE REFUSAL]');
  });

  it('detects finish tool and sets finished flag', async () => {
    const result = await DurableRunner.processTurn({
      taskId: 't-1',
      turnIndex: 5,
      phase: 'verify',
      personaId: 'p-1',
      personaRole: 'coder',
      workspacePath: '/work/repo',
      sandbox: mockSandbox,
      modelResponse: {
        promptTokens: 100,
        completionTokens: 50,
        content: 'All done.',
        toolCalls: [
          { id: 'c3', name: 'finish', args: { summary: 'Implementation complete' } },
        ],
      },
    });

    expect(result.finished).toBe(true);
    expect(result.finishSummary).toBe('Implementation complete');
  });
});
