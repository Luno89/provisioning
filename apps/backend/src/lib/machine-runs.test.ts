import { describe, it, expect } from 'vitest';
import { machineRunFor } from './machine-runs.js';

describe('a run on a machine', () => {
  it('hands a chat turn to the chat procedure and anything else to the task procedure', () => {
    expect(machineRunFor({ modelId: 'machine:d1:antigravity', chat: true }, undefined, undefined)).toEqual({ machine: { deviceId: 'd1', agent: 'antigravity' }, procedureId: 'external-agent-chat', inPlace: false });
    expect(machineRunFor({ modelId: 'machine:d1:antigravity' }, undefined, undefined)).toEqual({ machine: { deviceId: 'd1', agent: 'antigravity' }, procedureId: 'external-agent-task', inPlace: false });
  });

  it('runs an agent set to a machine there, keeps a procedure asked for by name, and leaves a model run alone', () => {
    expect(machineRunFor({ modelId: 'tabby-qwen' }, 'machine:d2:claude-code', undefined)).toEqual({ machine: { deviceId: 'd2', agent: 'claude-code' }, procedureId: 'external-agent-task', inPlace: false });
    expect(machineRunFor(undefined, 'machine:d2:claude-code', 'my-own')).toMatchObject({ procedureId: 'my-own' });
    expect(machineRunFor({ modelId: 'tabby-qwen', chat: true }, 'tabby-other', undefined)).toBeUndefined();
  });


  it('keeps the agent\'s own procedure on a machine when it branches for one, outside a chat', () => {
    const branches = { id: 'do-one-task', nodes: [{ id: 'where', kind: 'where-it-runs' }] } as never;
    const doesNot = { id: 'single-shot', nodes: [{ id: 'm', kind: 'call-model' }] } as never;
    expect(machineRunFor({ modelId: 'machine:d1:antigravity' }, undefined, undefined, branches)).toEqual({ machine: { deviceId: 'd1', agent: 'antigravity' }, procedureId: 'do-one-task', inPlace: true });
    expect(machineRunFor({ modelId: 'machine:d1:antigravity' }, undefined, undefined, doesNot)).toMatchObject({ procedureId: 'external-agent-task', inPlace: false });
    expect(machineRunFor({ modelId: 'machine:d1:antigravity', chat: true }, undefined, undefined, branches)).toMatchObject({ procedureId: 'external-agent-chat', inPlace: false });
  });
});
