import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExternalAgentSessions, koalaTools, launchesFrom, workingDirOf, workspaceLine } from './external-agents.js';
import { LocalMcpServer } from './local-mcp.js';
import type { AgentScript } from './acp-script-agent.js';

const AGENT = fileURLToPath(new URL('./acp-script-agent.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');

let dir: string;
let sessions: ExternalAgentSessions;

beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'external-agents-')); });
afterEach(async () => {
  await sessions?.closeAll();
  await rm(dir, { recursive: true, force: true });
});

const machine = async (script: AgentScript, segmentMs = 2000) => {
  const scriptPath = path.join(dir, 'script.json');
  await writeFile(scriptPath, JSON.stringify(script));
  sessions = new ExternalAgentSessions({ rootDir: path.join(dir, 'root'), launches: { scripted: { command: process.execPath, args: ['--import', TSX, AGENT, scriptPath] } }, segmentMs });
  return sessions;
};

describe('external agents on a machine', () => {
  it('reads which agents a machine has from its setting, and refuses one without a command', () => {
    expect(launchesFrom('{"antigravity":{"command":"/opt/agy/agy_acp_server.par","args":["--uid="]}}')).toEqual({ antigravity: { command: '/opt/agy/agy_acp_server.par', args: ['--uid='] } });
    expect(launchesFrom(undefined)).toEqual({});
    expect(() => launchesFrom('{"claude":{}}')).toThrow('external agent claude needs a command');
  });

  it('runs a turn in the folder it is given, telling the agent the context once, until the turn ends', async () => {
    const machineSessions = await machine({ name: 'scripted', version: '2', turns: [{ steps: [{ write: { path: 'notes.md', content: 'hello' } }, { say: 'Wrote it.' }] }] });
    const result = await machineSessions.step({ key: 'run-1:node:1', agent: 'scripted', op: { kind: 'open', brief: 'Write notes', context: 'You work on the shop.', path: 'shop' } });
    expect(result).toMatchObject({ state: 'ended', stopReason: 'end_turn', identity: { name: 'scripted', version: '2' }, sessionId: 'scripted-1', events: [{ type: 'text', delta: 'Wrote it.' }] });
    expect(await readFile(path.join(dir, 'root', 'shop', 'notes.md'), 'utf8')).toBe('hello');
    expect(await machineSessions.step({ key: 'run-1:node:1', agent: 'scripted', op: { kind: 'close' } })).toMatchObject({ state: 'closed' });
    expect(await machineSessions.step({ key: 'run-1:node:1', agent: 'scripted', op: { kind: 'continue' } })).toMatchObject({ state: 'failed', error: 'that session is no longer open on this machine' });
  });

  it('pauses on a permission request with what is asked, and carries on with the answer', async () => {
    const machineSessions = await machine({ name: 'scripted', version: '1', turns: [{ steps: [{ tool: { id: 'push', title: 'git push', kind: 'execute', input: { command: 'git push' } }, ask: true, output: 'pushed' }, { say: 'Pushed.' }] }] });
    const asks = await machineSessions.step({ key: 'k', agent: 'scripted', op: { kind: 'open', brief: 'push it' } });
    expect(asks).toMatchObject({ state: 'asks', ask: { tool: { callId: 'push', title: 'git push', kind: 'execute', input: { command: 'git push' } }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'reject', kind: 'reject_once' }] } });
    const after = await machineSessions.step({ key: 'k', agent: 'scripted', op: { kind: 'answer', optionId: 'allow' } });
    expect(after).toMatchObject({ state: 'ended', stopReason: 'end_turn' });
    expect(after.events).toContainEqual({ type: 'tool', tool: expect.objectContaining({ callId: 'push', status: 'completed', output: 'pushed' }) });
    expect(after.events).toContainEqual({ type: 'text', delta: 'Pushed.' });
  });

  it('hands back what happened so far every segment while a long turn runs, and stops it when cancelled', async () => {
    const machineSessions = await machine({ name: 'scripted', version: '1', turns: [{ steps: [{ say: 'starting' }, { wait: 60_000 }, { say: 'never' }] }] }, 300);
    let beats = 0;
    const first = await machineSessions.step({ key: 'k', agent: 'scripted', op: { kind: 'open', brief: 'go' } }, () => { beats += 1; });
    expect(first).toMatchObject({ state: 'running', events: [{ type: 'text', delta: 'starting' }] });
    expect(await machineSessions.step({ key: 'k', agent: 'scripted', op: { kind: 'continue' } })).toMatchObject({ state: 'running', events: [] });
    expect(await machineSessions.step({ key: 'k', agent: 'scripted', op: { kind: 'cancel' } })).toMatchObject({ state: 'ended', stopReason: 'cancelled' });
    expect(beats).toBeGreaterThanOrEqual(1);
  });

  it('switches the agent into the mode asked for, and refuses one it does not have', async () => {
    const modes = { current: 'default', available: [{ id: 'default', name: 'Default' }, { id: 'auto_edit', name: 'Auto Edit' }] };
    const machineSessions = await machine({ name: 'scripted', version: '1', modes, turns: [{ steps: [{ say: 'ok' }] }, { steps: [{ say: 'ok' }] }] });
    const moded = await machineSessions.step({ key: 'a', agent: 'scripted', op: { kind: 'open', brief: 'go', mode: 'auto_edit' } });
    expect(moded.events).toContainEqual({ type: 'mode', modeId: 'auto_edit' });
    expect(await machineSessions.step({ key: 'b', agent: 'scripted', op: { kind: 'open', brief: 'go', mode: 'yolo' } })).toEqual({ state: 'failed', error: 'scripted has no yolo mode (it has default, auto_edit)', events: [] });
  });

  it('fails plainly for an agent the machine does not have, a folder outside it, or an agent that dies', async () => {
    const machineSessions = await machine({ name: 'scripted', version: '1', turns: [{ steps: [{ exit: 2 }] }] });
    expect(await machineSessions.step({ key: 'a', agent: 'claude', op: { kind: 'open', brief: 'go' } })).toEqual({ state: 'failed', error: 'this machine has no agent called claude (it has scripted)', events: [] });
    expect(await machineSessions.step({ key: 'b', agent: 'scripted', op: { kind: 'open', brief: 'go', path: '../elsewhere' } })).toEqual({ state: 'failed', error: '../elsewhere is outside this machine\'s folder', events: [] });
    expect(await machineSessions.step({ key: 'c', agent: 'scripted', op: { kind: 'open', brief: 'go' } })).toMatchObject({ state: 'failed', error: expect.stringMatching(/exited \(2\) during the turn/) });
  });

  it('tells the agent its folder and what it was given once, at the start, and only the task after that', async () => {
    const machineSessions = await machine({ name: 'scripted', version: '1', turns: [{ steps: [{ echo: true }] }] });
    const result = await machineSessions.step({ key: 'k', agent: 'scripted', op: { kind: 'open', brief: 'Build the labels.', context: 'You build Odoo modules.', path: 'shop' } });
    const said = result.events.map((event) => (event.type === 'text' ? event.delta : '')).join('');
    expect(said).toBe(`${workspaceLine(path.join(dir, 'root', 'shop'))}\n\nYou build Odoo modules.\n\nBuild the labels.`);
  });

  it('flags a command the agent ran outside its folder, once per command', async () => {
    const machineSessions = await machine({ name: 'scripted', version: '1', turns: [{ steps: [
      { tool: { id: 'pwd', title: 'pwd', kind: 'execute', input: { workingDir: '/home/someone/.gemini/antigravity-cli/skills' } }, output: '/home/someone/.gemini/antigravity-cli/skills' },
      { tool: { id: 'ls', title: 'ls', kind: 'execute', input: { cwd: path.join(dir, 'root', 'shop', 'addons') } } },
    ] }] });
    const result = await machineSessions.step({ key: 'k', agent: 'scripted', op: { kind: 'open', brief: 'look around', path: 'shop' } });
    expect(result.events.filter((event) => event.type === 'stray')).toEqual([
      { type: 'stray', callId: 'pwd', title: 'pwd', workingDir: '/home/someone/.gemini/antigravity-cli/skills', folder: path.join(dir, 'root', 'shop') },
    ]);
  });
});

describe('Koala\'s tools for an external agent', () => {
  it('lets the agent search what was learned before, through the machine, and takes the tools away when the session closes', async () => {
    const scriptPath = path.join(dir, 'script.json');
    await writeFile(scriptPath, JSON.stringify({ name: 'scripted', version: '1', turns: [{ steps: [{ mcp: { server: 'koala', tool: 'search_memories', args: { query: 'odoo 20 access rules' } } }] }] } satisfies AgentScript));
    const mcp = new LocalMcpServer();
    await mcp.start();
    const asked: string[] = [];
    sessions = new ExternalAgentSessions({
      rootDir: path.join(dir, 'root'),
      launches: { scripted: { command: process.execPath, args: ['--import', TSX, AGENT, scriptPath] } },
      mcp,
      tools: koalaTools(async (query) => { asked.push(query); return '- Odoo 20 access rules are ir.access rows'; }),
    });
    try {
      const result = await sessions.step({ key: 'k', agent: 'scripted', op: { kind: 'open', brief: 'look it up' } });
      expect(result.events).toContainEqual({ type: 'text', delta: 'search_memories: - Odoo 20 access rules are ir.access rows' });
      expect(asked).toEqual(['odoo 20 access rules']);
    } finally {
      await sessions.closeAll();
      await mcp.close();
    }
  });
});

describe('where a command ran', () => {
  it('reads it from the call\'s input or from output the agent reports as JSON', () => {
    expect(workingDirOf({ input: { cwd: '/w' } })).toBe('/w');
    expect(workingDirOf({ output: '{"commandLine":"pwd","workingDir":"/home/x/skills","exitCode":0}' })).toBe('/home/x/skills');
    expect(workingDirOf({ output: 'plain text' })).toBeUndefined();
    expect(workingDirOf({ output: '{not json' })).toBeUndefined();
  });
});
