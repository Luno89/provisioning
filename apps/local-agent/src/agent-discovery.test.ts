import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAgents, manualAgentsFrom, onPath, type DiscoveryDeps, type FoundAgent } from './agent-discovery.js';
import { probeAcp } from './acp-session.js';
import type { AgentScript } from './acp-script-agent.js';

const AGENT = fileURLToPath(new URL('./acp-script-agent.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');

let dir: string;
let bin: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'agent-discovery-'));
  bin = path.join(dir, 'bin');
  await rm(bin, { recursive: true, force: true });
  await import('node:fs/promises').then((fs) => fs.mkdir(bin));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const executable = async (name: string, body: string) => {
  const file = path.join(bin, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
};

const acpAgent = async (name: string, script: AgentScript) => {
  const scriptPath = path.join(dir, `${name}.json`);
  await writeFile(scriptPath, JSON.stringify(script));
  return executable(name, `exec "${process.execPath}" --import "${TSX}" "${AGENT}" "${scriptPath}"`);
};

const inHome = (place: string) => (place.startsWith('~/') ? path.join(dir, 'home', place.slice(2)) : place);

const deps = (): DiscoveryDeps => ({
  which: (command) => onPath(inHome(command), bin),
  exists: (place) => access(inHome(place)).then(() => true, () => false),
  probe: (launch) => probeAcp(launch, dir),
});

describe('finding the agents on a machine', () => {
  it('confirms an agent by asking it over ACP, and names it as it names itself', async () => {
    await acpAgent('gemini', { name: 'gemini-cli', version: '0.9.1', turns: [] });
    const reports: FoundAgent[][] = [];
    const found = await discoverAgents(deps(), [], (agents) => reports.push(agents));
    expect(found.agents).toEqual([{ id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found', command: path.join(bin, 'gemini'), args: ['--acp'], name: 'gemini-cli', version: '0.9.1', reason: undefined }]);
    expect(found.launches).toEqual({ gemini: { command: path.join(bin, 'gemini'), args: ['--acp'] } });
    expect(reports[0]).toMatchObject([{ id: 'gemini', state: 'checking' }]);
  });

  it('hands over how to launch an agent with every report that calls it ready, so a run sent at once finds it', async () => {
    await acpAgent('gemini', { name: 'gemini-cli', version: '0.9.1', turns: [] });
    const reports: { agents: FoundAgent[]; launches: Record<string, unknown> }[] = [];
    await discoverAgents(deps(), [], (agents, launches) => reports.push({ agents, launches }));
    for (const report of reports) {
      for (const agent of report.agents.filter((entry) => entry.state === 'ready')) expect(report.launches[agent.id], `${agent.id} is ready without a launch`).toBeDefined();
    }
    expect(reports.at(-1)!.agents.some((agent) => agent.state === 'ready')).toBe(true);
  });

  it('reads the models an agent offers by opening a session without prompting it, and reports the one it starts on', async () => {
    await acpAgent('gemini', { name: 'gemini-cli', version: '0.9.1', models: { current: 'flash', available: [{ id: 'flash', name: 'Gemini 3.8 Flash' }, { id: 'pro', name: 'Gemini 3.8 Pro' }] }, turns: [] });
    const found = await discoverAgents(deps(), []);
    expect(found.agents[0]).toMatchObject({ id: 'gemini', state: 'ready', model: 'flash', models: [{ id: 'flash', name: 'Gemini 3.8 Flash' }, { id: 'pro', name: 'Gemini 3.8 Pro' }] });
  });

  it('says a CLI needs its ACP adapter when only the CLI is installed, and offers nothing to run', async () => {
    await executable('claude', 'exit 0');
    const found = await discoverAgents(deps(), []);
    expect(found.agents).toEqual([{ id: 'claude', title: 'Claude Code', state: 'needs-adapter', source: 'found', adapter: '@agentclientprotocol/claude-agent-acp', reason: 'Claude Code is installed, but it speaks ACP through @agentclientprotocol/claude-agent-acp, which is not installed' }]);
    expect(found.launches).toEqual({});
  });

  it('still runs Claude Code through the adapter under its old name, and prefers the current one', async () => {
    await executable('claude', 'exit 0');
    await acpAgent('claude-code-acp', { name: 'claude-code-acp', version: '0.16.2', turns: [] });
    expect((await discoverAgents(deps(), [])).agents).toMatchObject([{ id: 'claude', state: 'ready', version: '0.16.2' }]);
    await acpAgent('claude-agent-acp', { name: 'claude-agent-acp', version: '0.91.0', turns: [] });
    expect((await discoverAgents(deps(), [])).agents).toMatchObject([{ id: 'claude', state: 'ready', version: '0.91.0', command: path.join(bin, 'claude-agent-acp') }]);
  });

  it('says Antigravity needs Google\'s ACP server when it is set up here but the server is not installed', async () => {
    await mkdir(path.join(dir, 'home', '.gemini', 'antigravity-acp'), { recursive: true });
    const found = await discoverAgents(deps(), []);
    expect(found.agents).toEqual([{ id: 'antigravity', title: 'Antigravity', state: 'needs-adapter', source: 'found', adapter: "Google's Antigravity ACP server", reason: "Antigravity is set up here, but Koala reaches it through Google's Antigravity ACP server, which is not installed" }]);
    expect(found.launches).toEqual({});
  });

  it('runs Antigravity from where Install adapter put Google\'s server', async () => {
    const home = path.join(dir, 'home', '.local', 'share', 'koala', 'agents', 'antigravity-acp');
    await mkdir(home, { recursive: true });
    const scriptPath = path.join(dir, 'agy.json');
    await writeFile(scriptPath, JSON.stringify({ name: 'antigravity', version: '1.4.0', turns: [] }));
    await writeFile(path.join(home, 'agy_acp_server.par'), `#!/bin/sh\nexec "${process.execPath}" --import "${TSX}" "${AGENT}" "${scriptPath}"\n`);
    await chmod(path.join(home, 'agy_acp_server.par'), 0o755);
    const found = await discoverAgents(deps(), []);
    expect(found.agents).toMatchObject([{ id: 'antigravity', state: 'ready', command: path.join(home, 'agy_acp_server.par') }]);
  });

  it('keeps a program that does not answer as an ACP agent out of what runs, saying why', async () => {
    await executable('goose', 'echo "goose: unknown command acp" >&2; exit 3');
    const found = await discoverAgents(deps(), []);
    expect(found.agents[0]).toMatchObject({ id: 'goose', state: 'not-answering', reason: expect.stringContaining('without answering as an ACP agent') });
    expect(found.launches).toEqual({});
  });

  it('runs an agent added by hand in place of a known one, and reports one that is not there', async () => {
    const custom = await acpAgent('my-gemini', { name: 'gemini-cli', version: '1.0.0', turns: [] });
    await acpAgent('gemini', { name: 'gemini-cli', version: '0.9.1', turns: [] });
    const found = await discoverAgents(deps(), [{ id: 'gemini', title: 'My Gemini', command: custom, args: ['--fast'] }, { id: 'agy', command: '/nowhere/agy_acp_server.par', args: [] }]);
    expect(found.agents).toEqual([
      expect.objectContaining({ id: 'gemini', title: 'My Gemini', state: 'ready', source: 'by-hand', args: ['--fast'], version: '1.0.0' }),
      expect.objectContaining({ id: 'agy', state: 'not-answering', source: 'by-hand', reason: '/nowhere/agy_acp_server.par is not on this machine' }),
    ]);
    expect(Object.keys(found.launches)).toEqual(['gemini']);
  });

  it('finds nothing on a machine with none of them', async () => {
    expect(await discoverAgents(deps(), [])).toEqual({ agents: [], launches: {} });
  });
});

describe('agents added by hand', () => {
  it('keeps well-formed entries and drops the rest', () => {
    expect(manualAgentsFrom([
      { id: 'antigravity', title: ' Antigravity ', command: ' /opt/agy/agy_acp_server.par ', args: ['--uid=', 3] },
      { id: 'Bad Id', command: 'x' },
      { id: 'nocommand' },
      'nonsense',
    ])).toEqual([{ id: 'antigravity', title: 'Antigravity', command: '/opt/agy/agy_acp_server.par', args: ['--uid='] }]);
    expect(manualAgentsFrom(undefined)).toEqual([]);
  });
});
