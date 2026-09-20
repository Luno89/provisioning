import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { ALL_SEEDED_AGENTS, type Persona } from '@koala/agent-engine';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { agentsRouter } from './agents.js';
import { AgentService } from '../services/AgentService.js';
import { ENGINE_TOOL_SEEDS } from '../engine-host/tools/engine-tool-seeds.js';
import { BUILT_IN_PROCEDURES } from '@koala/agent-engine/procedure';

const quiet = { validateStatus: () => true };

const PROCEDURES = BUILT_IN_PROCEDURES;

const digger = (over: Partial<Persona> = {}): Persona => ({
  slug: 'digger',
  name: 'Digger',
  description: 'Digs things up',
  version: '1',
  prompt: 'You dig.',
  guidance: '',
  returns: '',
  failures: [],
  procedure: 'tool-rounds',
  tools: ['read_file', 'list_dir'],
  environment: { terminal: true, filesystem: true },
  ...over,
});

const harness = (): Promise<Harness> => mountRouter({
  prefix: '/api/agents',
  router: (db) => agentsRouter({
    agents: new AgentService({
      personas: {
        list: (ownerId?: string) => db.getEnginePersonas(ownerId),
        save: (persona) => db.saveEnginePersona(persona),
        remove: (ownerId, slug) => db.deleteEnginePersona(ownerId, slug),
      },
      tools: async () => [...ENGINE_TOOL_SEEDS],
      procedures: async () => PROCEDURES,
      images: {
        start: async () => ({ state: 'building', reference: 'registry/koala:abc' }),
        standing: async () => ({ state: 'ready', reference: 'registry/koala:abc' }),
      },
    }),
  }),
});

describe('the agents API', () => {
  it('lists what ships, marked as not yours', async () => {
    const { url, close } = await harness();
    const { data } = await axios.get(url('/api/agents'));
    await close();

    expect(data.agents.length).toBe(ALL_SEEDED_AGENTS().length);
    expect(data.agents.every((agent: { mine: boolean }) => agent.mine === false)).toBe(true);
  });

  it('saves your own agent and hands back what its image is doing', async () => {
    const { url, close } = await harness();

    const saved = await axios.put(`${url('/api/agents/digger')}`, digger());
    const listed = await axios.get(url('/api/agents'));
    await close();

    expect(saved.status).toBe(200);
    expect(saved.data.agent).toMatchObject({ slug: 'digger', mine: true, ownerId: TEST_USER.id });
    expect(saved.data.agent.image).toMatchObject({ state: 'building' });
    expect(listed.data.agents.find((agent: { slug: string }) => agent.slug === 'digger')).toBeDefined();
  });

  it('refuses one that does not hold together, and says why', async () => {
    const { url, close } = await harness();

    const out = await axios.put(`${url('/api/agents/digger')}`, digger({ tools: ['ghost_tool'] }), quiet);
    await close();

    expect(out.status).toBe(400);
    expect(out.data.problems.join(' ')).toContain('"ghost_tool", which is not a tool');
  });

  it('refuses a body that is not the agent the url names', async () => {
    const { url, close } = await harness();

    const out = await axios.put(`${url('/api/agents/digger')}`, digger({ slug: 'other' }), quiet);
    await close();

    expect(out.status).toBe(400);
    expect(out.data.error).toContain('is not called "digger"');
  });

  it('reads one back by slug, and says nothing for one that is not there', async () => {
    const { url, close } = await harness();

    const found = await axios.get(`${url('/api/agents/executor')}`);
    const missing = await axios.get(`${url('/api/agents/nobody')}`, quiet);
    await close();

    expect(found.data.agent).toMatchObject({ slug: 'executor', mine: false });
    expect(missing.status).toBe(404);
  });

  it('deletes your copy, leaving the built-in, and refuses to delete one that was never yours', async () => {
    const { url, close } = await harness();
    await axios.put(`${url('/api/agents/research')}`, { ...ALL_SEEDED_AGENTS().find((one) => one.slug === 'research')!, prompt: 'Mine.' });

    const removed = await axios.delete(`${url('/api/agents/research')}`);
    const after = await axios.get(`${url('/api/agents/research')}`);
    const again = await axios.delete(`${url('/api/agents/research')}`, quiet);
    await close();

    expect(removed.status).toBe(200);
    expect(after.data.agent).toMatchObject({ mine: false });
    expect(again.status).toBe(404);
  });
});
