import { describe, it, expect } from 'vitest';
import { effectiveMachineChoice, machineChoice, machineChoiceId, machineSessionKey } from './machine-choice.js';

describe('a machine choice', () => {
  it('reads back what it was written from, and refuses anything else', () => {
    const id = machineChoiceId({ deviceId: 'dev-1', agent: 'antigravity' });
    expect(id).toBe('machine:dev-1:antigravity');
    expect(machineChoice(id)).toEqual({ deviceId: 'dev-1', agent: 'antigravity' });
    expect(machineSessionKey(machineChoice(id)!)).toBe('dev-1:antigravity');
    for (const other of [undefined, null, '', 'tabby-qwen', 'machine:', 'machine:dev-1', 'machine:dev-1:', 'machine::antigravity']) {
      expect(machineChoice(other)).toBeUndefined();
    }
  });

  it('takes the run\'s own machine first, then the agent\'s, and an agent on a machine stays there under a model the run inherited', () => {
    expect(effectiveMachineChoice('machine:a:gemini', 'machine:b:antigravity')).toEqual({ deviceId: 'a', agent: 'gemini' });
    expect(effectiveMachineChoice(undefined, 'machine:b:antigravity')).toEqual({ deviceId: 'b', agent: 'antigravity' });
    expect(effectiveMachineChoice('tabby-qwen', 'machine:b:antigravity')).toEqual({ deviceId: 'b', agent: 'antigravity' });
    expect(effectiveMachineChoice('tabby-qwen', 'openrouter-x')).toBeUndefined();
    expect(effectiveMachineChoice(undefined, undefined)).toBeUndefined();
  });
});
