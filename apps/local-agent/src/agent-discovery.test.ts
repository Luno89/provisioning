import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const deps = (): DiscoveryDeps => ({ which: (command) => onPath(command, bin), probe: (launch) => probeAcp(launch, dir) });

describe('finding the agents on a machine', () => {
  it('confirms an agent by asking it over ACP, and names it as it names itself', async () => {
    await acpAgent('gemini', { name: 'gemini-cli', version: '0.9.1', turns: [] });
    const reports: FoundAgent[][] = [];
    const found = await discoverAgents(deps(), [], (agents) => reports.push(agents));
    expect(found.agents).toEqual([{ id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found', command: path.join(bin, 'gemini'), args: ['--acp'], name: 'gemini-cli', version: '0.9.1', reason: undefined }]);
    expect(found.launches).toEqual({ gemini: { command: path.join(bin, 'gemini'), args: ['--acp'] } });
    expect(reports[0]).toMatchObject([{ id: 'gemini', state: 'checking' }]);
  });

  it('says a CLI needs its ACP adapter when only the CLI is installed, and offers nothing to run', async () => {
    await executable('claude', 'exit 0');
    const found = await discoverAgents(deps(), []);
    expect(found.agents).toEqual([{ id: 'claude', title: 'Claude Code', state: 'needs-adapter', source: 'found', adapter: '@zed-industries/claude-code-acp', reason: 'Claude Code is installed, but it speaks ACP through @zed-industries/claude-code-acp, which is not installed' }]);
    expect(found.launches).toEqual({});
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
