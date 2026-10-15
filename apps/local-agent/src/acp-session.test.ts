import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { insideRoot, openAcpSession, AcpSessionError, type AcpSession, type PermissionAnswer, type PermissionAsk } from './acp-session.js';
import type { AgentEvent } from './acp-events.js';
import type { AgentScript } from './acp-script-agent.js';

const AGENT = fileURLToPath(new URL('./acp-script-agent.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');

let dir: string;
let session: AcpSession | undefined;

beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'acp-session-')); });
afterEach(async () => {
  await session?.close();
  session = undefined;
  await rm(dir, { recursive: true, force: true });
});

const open = async (script: AgentScript, answer: (ask: PermissionAsk) => Promise<PermissionAnswer> = async () => ({ optionId: 'allow' }), extra: { resume?: string } = {}) => {
  const scriptPath = path.join(dir, 'script.json');
  await writeFile(scriptPath, JSON.stringify(script));
  const events: AgentEvent[] = [];
  const asks: PermissionAsk[] = [];
  session = await openAcpSession({
    launch: { command: process.execPath, args: ['--import', TSX, AGENT, scriptPath] },
    cwd: path.join(dir, 'work'),
    onEvent: (event) => events.push(event),
    onPermission: (ask) => { asks.push(ask); return answer(ask); },
    ...extra,
  });
  return { session, events, asks };
};

const script = (steps: AgentScript['turns'][number]['steps'], more: Partial<AgentScript> = {}): AgentScript => ({ name: 'scripted', version: '1.2.3', turns: [{ steps }], ...more });

describe('a session with an ACP agent', () => {
  beforeEach(async () => { await import('node:fs/promises').then((fs) => fs.mkdir(path.join(dir, 'work'))); });

  it('says which agent it is, and streams a turn\'s thinking, text and tool calls until the turn ends', async () => {
    const { session, events } = await open(script([
      { think: 'Reading the brief' },
      { tool: { id: 't1', title: 'Run odoo-check', kind: 'execute', input: { command: 'odoo-check delivery_labels addons' } }, output: 'PASSED' },
      { say: 'Done.' },
    ], { modes: { current: 'ask', available: [{ id: 'ask', name: 'Ask' }, { id: 'auto', name: 'Auto' }] } }));

    expect(session.identity).toEqual({ name: 'scripted', version: '1.2.3' });
    expect(session.modes).toEqual({ current: 'ask', available: [{ id: 'ask', name: 'Ask' }, { id: 'auto', name: 'Auto' }] });
    expect(await session.prompt('Build the labels')).toEqual({ stopReason: 'end_turn' });
    expect(events).toEqual([
      { type: 'thinking', delta: 'Reading the brief' },
      { type: 'tool', tool: { callId: 't1', title: 'Run odoo-check', kind: 'execute', status: 'pending', input: { command: 'odoo-check delivery_labels addons' } } },
      { type: 'tool', tool: { callId: 't1', title: 'Run odoo-check', kind: 'execute', status: 'completed', input: { command: 'odoo-check delivery_labels addons' }, output: 'PASSED' } },
      { type: 'text', delta: 'Done.' },
    ]);
  });

  it('asks before a call the agent wants permission for, and tells the agent what the person chose', async () => {
    const { session, events, asks } = await open({ name: 'scripted', version: '1', turns: [
      { steps: [{ tool: { id: 'rm', title: 'rm -rf build', kind: 'delete' }, ask: true }] },
      { steps: [{ tool: { id: 'push', title: 'git push', kind: 'execute' }, ask: true }] },
    ] }, async (ask) => ({ optionId: ask.tool.callId === 'rm' ? 'reject' : 'allow' }));

    await session.prompt('clean up');
    await session.prompt('push it');
    expect(asks.map((ask) => [ask.tool.title, ask.tool.kind, ask.options.map((option) => option.kind)])).toEqual([
      ['rm -rf build', 'delete', ['allow_once', 'allow_always', 'reject_once']],
      ['git push', 'execute', ['allow_once', 'allow_always', 'reject_once']],
    ]);
    const finals = events.filter((event) => event.type === 'tool').map((event) => event.type === 'tool' && [event.tool.callId, event.tool.status]);
    expect(finals).toContainEqual(['rm', 'failed']);
    expect(finals).toContainEqual(['push', 'completed']);
  });

  it('reads and writes files for the agent inside its folder only', async () => {
    await writeFile(path.join(dir, 'work', 'brief.md'), 'line one\nline two');
    await writeFile(path.join(dir, 'secret.txt'), 'nope');
    const { session, events } = await open({ name: 'scripted', version: '1', turns: [
      { steps: [{ write: { path: 'addons/x/__init__.py', content: 'from . import models\n' } }, { read: { path: 'brief.md' } }] },
      { steps: [{ write: { path: '../escaped.txt', content: 'out' } }] },
      { steps: [{ read: { path: '../secret.txt' } }] },
    ] });

    await session.prompt('write it');
    expect(await readFile(path.join(dir, 'work', 'addons/x/__init__.py'), 'utf8')).toBe('from . import models\n');
    expect(events).toContainEqual({ type: 'text', delta: 'read: line one\nline two' });
    await expect(session.prompt('escape')).rejects.toThrow(/outside the session's folder/);
    expect(existsSync(path.join(dir, 'escaped.txt'))).toBe(false);
    await expect(session.prompt('peek')).rejects.toThrow(/outside the session's folder/);
  });

  it('stops a turn when cancelled, and answers a permission still waiting as cancelled', async () => {
    const { session } = await open({ name: 'scripted', version: '1', turns: [
      { steps: [{ say: 'working' }, { wait: 60_000 }, { say: 'never' }] },
      { steps: [{ tool: { id: 'ask', title: 'deploy', kind: 'execute' }, ask: true }] },
    ] }, () => new Promise<PermissionAnswer>(() => {}));

    const turn = session.prompt('go');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await session.cancel();
    expect(await turn).toEqual({ stopReason: 'cancelled' });

    const asking = session.prompt('deploy');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await session.cancel();
    expect(await asking).toEqual({ stopReason: 'cancelled' });
  });

  it('fails the turn, with what the agent printed, when the agent dies mid-turn', async () => {
    const { session } = await open(script([{ say: 'about to crash' }, { exit: 3 }]));
    const failure = await session.prompt('go').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(AcpSessionError);
    expect((failure as Error).message).toMatch(/exited \(3\) during the turn/);
  });

  it('continues an earlier session without replaying its history as new events', async () => {
    const { session, events } = await open(script([{ say: 'continued' }]), undefined, { resume: 'scripted-7' });
    expect(session.resumed).toBe(true);
    expect(session.sessionId).toBe('scripted-7');
    await session.prompt('next');
    expect(events).toEqual([{ type: 'text', delta: 'continued' }]);
  });

  it('switches the agent\'s mode', async () => {
    const { session, events } = await open(script([], { modes: { current: 'ask', available: [{ id: 'ask', name: 'Ask' }, { id: 'auto', name: 'Auto' }] } }));
    await session.setMode('auto');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toContainEqual({ type: 'mode', modeId: 'auto' });
  });

  it('says why when the agent cannot be started', async () => {
    const failure = await openAcpSession({
      launch: { command: path.join(dir, 'no-such-agent'), args: [] },
      cwd: path.join(dir, 'work'),
      onEvent: () => {},
      onPermission: async () => ({ cancelled: true }),
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(AcpSessionError);
    expect((failure as Error).message).toMatch(/could not start/);
  });
});

describe('the session\'s folder', () => {
  it('holds paths inside it and refuses ones that climb out', () => {
    expect(insideRoot('/w/tree', 'addons/a.py')).toBe('/w/tree/addons/a.py');
    expect(insideRoot('/w/tree', '/w/tree/x')).toBe('/w/tree/x');
    expect(insideRoot('/w/tree', '/w/tree')).toBe('/w/tree');
    expect(insideRoot('/w/tree', '../x')).toBeUndefined();
    expect(insideRoot('/w/tree', '/w/tree-other/x')).toBeUndefined();
  });
});
