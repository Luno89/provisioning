import { describe, it, expect } from 'vitest';
import { accountDefaultOf, accountMachineFor, machineRunFor } from './machine-runs.js';

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

describe('an account default on a machine', () => {
  const branches = { nodes: [{ id: 'where', kind: 'where-it-runs' }] } as never;
  const doesNot = { nodes: [{ id: 'm', kind: 'call-model' }] } as never;
  const onMachine = { modelId: 'machine:d1:claude-code' };

  it('takes a chat, and work whose procedure can be handed to a machine', () => {
    expect(accountMachineFor({ chat: true }, undefined, onMachine, doesNot)).toBe('machine:d1:claude-code');
    expect(accountMachineFor({}, undefined, onMachine, branches)).toBe('machine:d1:claude-code');
    expect(accountMachineFor({}, undefined, onMachine, doesNot)).toBeUndefined();
  });

  it('gives way to a model asked for and to the agent\'s own unless the default overrides it', () => {
    expect(accountMachineFor({ modelId: 'tabby-qwen', chat: true }, undefined, onMachine, branches)).toBeUndefined();
    expect(accountMachineFor({ chat: true }, 'tabby-qwen', onMachine, branches)).toBeUndefined();
    expect(accountMachineFor({ chat: true }, 'tabby-qwen', { ...onMachine, overrides: true }, branches)).toBe('machine:d1:claude-code');
  });

  it('does nothing for a model default, a run asked about without running, or a check\'s space', () => {
    expect(accountMachineFor({ chat: true }, undefined, { modelId: 'tabby-qwen' }, branches)).toBeUndefined();
    expect(accountMachineFor(undefined, undefined, onMachine, branches)).toBeUndefined();
    expect(accountDefaultOf({ space: { person: 'p' }, defaultModelId: 'machine:d1:claude-code' })).toBeUndefined();
    expect(accountDefaultOf({ defaultModelId: 'machine:d1:claude-code', globalModelOverride: true })).toEqual({ modelId: 'machine:d1:claude-code', overrides: true });
  });
});
