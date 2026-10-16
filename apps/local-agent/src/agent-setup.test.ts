import { describe, it, expect } from 'vitest';
import type { AgentInstall, DiscoveryDeps } from './agent-discovery.js';
import type { AcpLaunch } from './acp-session.js';
import { setUpAgents, type AdapterChoice, type SetupIo } from './agent-setup.js';
import { yesAnswer } from './terminal-ask.js';

const machine = (onPath: string[]) => {
  const present = new Set(onPath);
  const discovery: DiscoveryDeps = {
    which: async (command) => (present.has(command) ? `/bin/${command}` : undefined),
    exists: async () => false,
    probe: async (launch: AcpLaunch) => ({ identity: { name: launch.command.replace('/bin/', ''), version: '1.0.0' }, signIn: [] }),
  };
  const installs: AgentInstall[] = [];
  const install = async (wanted: AgentInstall) => {
    installs.push(wanted);
    if (wanted.registry === 'claude-acp') present.add('claude-agent-acp');
    if (wanted.registry === 'codex-acp') return { ok: false, output: "Codex needs a newer Node.js than this machine's v20.11.0" };
    return { ok: true, output: 'Installed' };
  };
  return { deps: { discovery, install }, installs };
};

const recorder = (answers: (boolean | undefined)[] = []) => {
  const lines: string[] = [];
  const asked: string[] = [];
  const io: SetupIo = {
    ok: (line) => lines.push(`ok ${line}`),
    note: (line) => lines.push(`- ${line}`),
    fail: (line) => lines.push(`x ${line}`),
    ask: async (question) => { asked.push(question); return answers.shift(); },
  };
  return { io, lines, asked };
};

const run = async (choice: AdapterChoice, onPath: string[], answers?: (boolean | undefined)[]) => {
  const { deps, installs } = machine(onPath);
  const { io, lines, asked } = recorder(answers);
  const agents = await setUpAgents(choice, deps, io);
  return { agents, installs, lines, asked };
};

describe('setting up the agents on a machine as it joins', () => {
  it('asks before installing each missing adapter, installs the ones the person wants, and shows them ready', async () => {
    const { agents, installs, lines, asked } = await run('ask', ['gemini', 'claude', 'codex'], [true, false]);
    expect(asked).toEqual(['Install @agentclientprotocol/claude-agent-acp for Claude Code now?', 'Install @agentclientprotocol/codex-acp for Codex now?']);
    expect(installs).toEqual([{ registry: 'claude-acp' }]);
    expect(agents.map((agent) => [agent.id, agent.state])).toEqual([['gemini', 'ready'], ['claude', 'ready'], ['codex', 'needs-adapter']]);
    expect(lines).toEqual([
      'ok Gemini CLI (gemini) 1.0.0',
      '- Claude Code is installed, but it speaks ACP through @agentclientprotocol/claude-agent-acp, which is not installed',
      '- Codex is installed, but it speaks ACP through @agentclientprotocol/codex-acp, which is not installed',
      '- Install Codex later with Install adapter on My Machines.',
      'ok Claude Code (claude-agent-acp) 1.0.0, through @agentclientprotocol/claude-agent-acp',
    ]);
  });

  it('installs nothing and asks nothing when told none', async () => {
    const { installs, asked, lines } = await run('none', ['claude']);
    expect(installs).toEqual([]);
    expect(asked).toEqual([]);
    expect(lines.at(-1)).toBe('- Install Claude Code later with Install adapter on My Machines.');
  });

  it('installs every adapter when told all, and says which one failed and why', async () => {
    const { installs, asked, lines } = await run('all', ['claude', 'codex']);
    expect(asked).toEqual([]);
    expect(installs).toEqual([{ registry: 'claude-acp' }, { registry: 'codex-acp' }]);
    expect(lines).toContain("x @agentclientprotocol/codex-acp was not installed: Codex needs a newer Node.js than this machine's v20.11.0");
  });

  it('stops asking, and installs nothing, when there is no terminal to ask on', async () => {
    const { installs, asked, lines } = await run('ask', ['claude', 'codex'], [undefined]);
    expect(asked).toHaveLength(1);
    expect(installs).toEqual([]);
    expect(lines).toContain('- There is no terminal to ask on, so nothing more is installed.');
  });

  it('says how to add an agent when none is found', async () => {
    const { agents, lines } = await run('ask', []);
    expect(agents).toEqual([]);
    expect(lines[0]).toMatch(/^- No coding agents were found yet/);
  });

  it('takes Enter or yes as yes, anything else as no', () => {
    expect(['', 'y', 'Yes', ' YES '].map(yesAnswer)).toEqual([true, true, true, true]);
    expect(['n', 'no', 'later'].map(yesAnswer)).toEqual([false, false, false]);
  });
});
