import { describe, expect, it } from 'vitest';
import { turnFor, type AgentScript } from './acp-script-agent.js';

const script: AgentScript = { name: 's', version: '1', turns: [
  { steps: [{ say: 'first' }] },
  { when: 'Question:', steps: [{ say: 'yes' }] },
  { steps: [{ say: 'second' }] },
] };

describe('which turn a scripted agent plays', () => {
  it('plays the turn whose prompt it was written for, and the rest in order', () => {
    expect(turnFor(script, 0, 'Question: does it pass?')?.steps).toEqual([{ say: 'yes' }]);
    expect(turnFor(script, 0, 'Do the task')?.steps).toEqual([{ say: 'first' }]);
    expect(turnFor(script, 1, 'Do the next')?.steps).toEqual([{ say: 'second' }]);
    expect(turnFor(script, 2, 'Anything more')).toBeUndefined();
  });
});
