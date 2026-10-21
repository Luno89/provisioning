import { describe, expect, it, vi } from 'vitest';
import type { PersonaRecord } from '@koala/agent-engine';
import { MemoryDB } from '../../lib/memory-db.js';
import type { HiddenVocabulary } from '../../lib/extension-settings.js';
import { createAgentDirectory, grantStoreFrom } from './agent-directory.js';

const record = (slug: string, ownerId?: string): PersonaRecord => ({ slug, ...(ownerId ? { ownerId } : {}), name: slug } as PersonaRecord);
const nothingHidden: HiddenVocabulary = { extensions: new Set(), operations: new Set(), groups: new Set(), tools: new Set(), agents: new Set() };

function directory(over: { hidden?: HiddenVocabulary; onChanged?: (ownerId: string) => void } = {}) {
  const db = new MemoryDB();
  const agents = createAgentDirectory({
    records: { list: (ownerId) => db.getEnginePersonas(ownerId) },
    grants: grantStoreFrom(db),
    builtIn: () => [record('executor'), record('judge')],
    shipped: () => [{ agent: 'executor', tool: 'run_command' }, { agent: 'executor', tool: 'settle_leaf' }, { agent: 'judge', tool: 'read_file' }],
    hidden: async (ownerId) => (ownerId === 'user-1' && over.hidden ? over.hidden : nothingHidden),
    now: () => '2026-10-12T00:00:00Z',
    ...(over.onChanged ? { onChanged: over.onChanged } : {}),
  });
  return { db, agents };
}

const toolsOf = async (agents: ReturnType<typeof directory>['agents'], ownerId: string, slug: string) =>
  (await agents.agents(ownerId)).find((agent) => agent.slug === slug)?.tools;

describe('the agent directory', () => {
  it('reads every agent with its tools: the built-in ones as shipped, the person\'s own from their grants', async () => {
    const { db, agents } = directory();
    await db.saveEnginePersona(record('helper', 'user-1'));
    await agents.setTools('user-1', 'helper', ['read_file']);

    expect((await agents.agents('user-1')).map((agent) => [agent.slug, agent.tools])).toEqual([
      ['executor', ['run_command', 'settle_leaf']],
      ['judge', ['read_file']],
      ['helper', ['read_file']],
    ]);
    expect((await agents.agents('user-2')).map((agent) => agent.slug)).toEqual(['executor', 'judge']);
  });

  it('leaves out what an extension the person switched off brings, agents and tools alike, unless asked for everything', async () => {
    const hidden = { ...nothingHidden, agents: new Set(['judge']), tools: new Set(['settle_leaf']) };
    const { agents } = directory({ hidden });

    expect((await agents.agents('user-1')).map((agent) => [agent.slug, agent.tools])).toEqual([['executor', ['run_command']]]);
    expect((await agents.agents('user-1', { withHidden: true })).map((agent) => agent.slug)).toEqual(['executor', 'judge']);
    expect(await toolsOf(agents, 'user-2', 'executor')).toEqual(['run_command', 'settle_leaf']);
  });

  it('says where each tool of each agent comes from', async () => {
    const { agents } = directory();
    await agents.setTools('user-1', 'executor', ['run_command', 'browser']);

    expect((await agents.sourced('user-1')).sources.executor).toEqual([
      { tool: 'run_command', source: 'shipped' },
      { tool: 'settle_leaf', source: 'revoked' },
      { tool: 'browser', source: 'granted' },
    ]);
  });

  it('records why a tool was granted and which proposal granted it, and says when anything changed', async () => {
    const changed = vi.fn();
    const { db, agents } = directory({ onChanged: changed });

    expect(await agents.setTools('user-1', 'executor', ['run_command', 'settle_leaf', 'browser'], { why: 'to see the page', proposalId: 'p1' })).toBe(true);
    expect(await agents.setTools('user-1', 'executor', ['run_command', 'settle_leaf', 'browser'])).toBe(false);

    expect(await db.getToolGrants('user-1')).toEqual([
      { ownerId: 'user-1', agent: 'executor', tool: 'browser', grantedAt: '2026-10-12T00:00:00Z', why: 'to see the page', proposalId: 'p1' },
    ]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith('user-1');
  });

  it('forgets an agent\'s grants, or a tool\'s, for one person only', async () => {
    const changed = vi.fn();
    const { agents } = directory({ onChanged: changed });
    await agents.setTools('user-1', 'executor', ['browser']);
    await agents.setTools('user-2', 'executor', ['browser']);
    changed.mockClear();

    expect(await agents.forgetTool('user-1', 'browser')).toBe(1);
    expect(await toolsOf(agents, 'user-1', 'executor')).toEqual([]);
    expect(await agents.forgetAgent('user-1', 'executor')).toBe(2);
    expect(await toolsOf(agents, 'user-1', 'executor')).toEqual(['run_command', 'settle_leaf']);
    expect(await toolsOf(agents, 'user-2', 'executor')).toEqual(['browser']);
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

describe('the MCP servers agents hold', () => {
  it('are granted and taken away apart from tools, with where each came from', async () => {
    const { agents } = directory();
    expect(await agents.setServers('user-1', 'executor', ['playwright'])).toBe(true);
    await agents.setTools('user-1', 'executor', ['run_command', 'settle_leaf', 'playwright']);
    const sourced = await agents.sourced('user-1');
    expect(sourced.agents.find((agent) => agent.slug === 'executor')).toMatchObject({ tools: ['run_command', 'settle_leaf', 'playwright'], servers: ['playwright'] });
    expect(sourced.serverSources.executor).toEqual([{ tool: 'playwright', source: 'granted' }]);
    await agents.setServers('user-1', 'executor', []);
    expect((await agents.agents('user-1')).find((agent) => agent.slug === 'executor')).toMatchObject({ tools: ['run_command', 'settle_leaf', 'playwright'], servers: [] });
  });

  it('follow a server that is renamed, and go with it when it is removed', async () => {
    const { agents } = directory();
    await agents.setServers('user-1', 'executor', ['playwright']);
    await agents.setServers('user-1', 'judge', ['playwright']);
    await agents.setTools('user-1', 'judge', ['read_file', 'playwright']);
    expect(await agents.renameServer('user-1', 'playwright', 'browser')).toBe(2);
    expect((await agents.agents('user-1')).map((agent) => [agent.slug, agent.servers])).toEqual([['executor', ['browser']], ['judge', ['browser']]]);
    expect(await agents.forgetServer('user-1', 'browser')).toBe(2);
    expect((await agents.agents('user-1')).find((agent) => agent.slug === 'judge')).toMatchObject({ tools: ['read_file', 'playwright'], servers: [] });
  });
});

describe('what an agent needs in its workspace', () => {
  it('is what the steps of its procedure declare, read once per procedure', async () => {
    const db = new MemoryDB();
    const asked: string[] = [];
    const agents = createAgentDirectory({
      records: { list: (ownerId) => db.getEnginePersonas(ownerId) },
      grants: grantStoreFrom(db),
      builtIn: () => [{ ...record('tester'), procedure: 'browser-check' }, { ...record('other'), procedure: 'browser-check' }, { ...record('plain'), procedure: 'tool-rounds' }],
      shipped: () => [],
      stepNeeds: async (_ownerId, procedure) => { asked.push(procedure); return procedure === 'browser-check' ? [{ name: 'koala-e2e', from: 'step:Run Browser Tests' }] : []; },
    });
    const listed = await agents.agents('user-1');
    expect(listed.map((agent) => [agent.slug, agent.needs])).toEqual([['tester', ['koala-e2e']], ['other', ['koala-e2e']], ['plain', undefined]]);
    expect(asked.sort()).toEqual(['browser-check', 'tool-rounds']);
  });
});
