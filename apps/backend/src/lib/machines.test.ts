import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { joinEnv, machineAgentsFrom, manualAgentsOf, manualAgentsProblem } from './machines.js';

describe('the settings a machine is handed', () => {
  it('reads back exactly in a shell, whatever the values hold', () => {
    const values = { KOALA_ROOT_DIR: "/home/o'brien/my koala", KOALA_DEVICE_TOKEN: 'abc$HOME`x`', EMPTY: '' };
    const read = execFileSync('sh', ['-c', `${joinEnv(values)}printf '%s|%s|%s' "$KOALA_ROOT_DIR" "$KOALA_DEVICE_TOKEN" "$EMPTY"`]).toString();
    expect(read).toBe("/home/o'brien/my koala|abc$HOME`x`|");
  });
});

describe('what a machine reports about its agents', () => {
  it('keeps well-formed agents, trims what is long, and drops the rest', () => {
    const agents = machineAgentsFrom([
      { id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found', version: '0.61.0', args: ['--acp', 7], signIn: [], reason: 'x'.repeat(5000) },
      { id: 'gemini', title: 'No state', source: 'found' },
      { id: 'BAD', title: 'x', state: 'ready', source: 'found' },
      { id: 'ok', title: 'Elsewhere', state: 'ready', source: 'somewhere' },
      null,
    ]);
    expect(agents).toEqual([{ id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found', version: '0.61.0', args: ['--acp'], reason: 'x'.repeat(1000) }]);
    expect(machineAgentsFrom('nonsense')).toEqual([]);
  });
});

describe('agents a person adds by hand', () => {
  it('says what is wrong with an entry', () => {
    expect(manualAgentsProblem('x')).toBe('send the agents as a list');
    expect(manualAgentsProblem([{ id: 'Agy', command: 'x' }])).toMatch(/lowercase letters/);
    expect(manualAgentsProblem([{ id: 'agy', command: 'x', args: [1] }])).toBe("agy's arguments must be words");
    expect(manualAgentsProblem([{ id: 'agy', command: 'x', args: ['--uid='] }])).toBeNull();
  });

  it('keeps them tidy', () => {
    expect(manualAgentsOf([{ id: 'agy', title: '  ', command: ' /opt/agy ' }])).toEqual([{ id: 'agy', command: '/opt/agy', args: [] }]);
    expect(manualAgentsOf([{ id: 'agy' }])).toEqual([]);
  });
});
