import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { joinEnv, machineAgentsFrom, machineChoiceProblem, manualAgentsOf, manualAgentsProblem } from './machines.js';

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

describe('picking an agent on a machine', () => {
  const machine = { name: 'desk', online: true, agents: [
    { id: 'antigravity', title: 'Antigravity', state: 'ready' as const, source: 'found' as const },
    { id: 'claude-code', title: 'Claude Code', state: 'needs-adapter' as const, source: 'found' as const, reason: 'its ACP adapter is not installed' },
  ] };

  it('takes a ready agent on a connected machine', () => {
    expect(machineChoiceProblem(machine, 'antigravity')).toBeUndefined();
  });

  it('says why anything else cannot answer', () => {
    expect(machineChoiceProblem(undefined, 'antigravity')).toMatch(/not one of yours/);
    expect(machineChoiceProblem(machine, 'goose')).toBe('desk has no agent called goose');
    expect(machineChoiceProblem(machine, 'claude-code')).toBe('Claude Code on desk is not ready: its ACP adapter is not installed');
    expect(machineChoiceProblem({ ...machine, online: false }, 'antigravity')).toBe('desk is not connected, so Antigravity cannot answer');
    expect(machineChoiceProblem({ ...machine, online: false }, 'antigravity', { waitsToConnect: true })).toBeUndefined();
  });
});
