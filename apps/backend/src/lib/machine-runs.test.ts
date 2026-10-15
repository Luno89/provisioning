import { describe, it, expect } from 'vitest';
import { machineRunFor } from './machine-runs.js';

describe('a run on a machine', () => {
  it('hands a chat turn to the chat procedure and anything else to the task procedure', () => {
    expect(machineRunFor({ modelId: 'machine:d1:antigravity', chat: true }, undefined, undefined)).toEqual({ machine: { deviceId: 'd1', agent: 'antigravity' }, procedureId: 'external-agent-chat' });
    expect(machineRunFor({ modelId: 'machine:d1:antigravity' }, undefined, undefined)).toEqual({ machine: { deviceId: 'd1', agent: 'antigravity' }, procedureId: 'external-agent-task' });
  });

  it('runs an agent set to a machine there, keeps a procedure asked for by name, and leaves a model run alone', () => {
    expect(machineRunFor({ modelId: 'tabby-qwen' }, 'machine:d2:claude-code', undefined)).toEqual({ machine: { deviceId: 'd2', agent: 'claude-code' }, procedureId: 'external-agent-task' });
    expect(machineRunFor(undefined, 'machine:d2:claude-code', 'my-own')).toMatchObject({ procedureId: 'my-own' });
    expect(machineRunFor({ modelId: 'tabby-qwen', chat: true }, 'tabby-other', undefined)).toBeUndefined();
  });
});
