import { beforeEach, describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { LANGUAGE_IDS, type Persona } from '@koala/agent-engine';
import type { AgentService, EditableAgent } from '../services/AgentService.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type InProcessRoutes } from '../../platform/testing/routes.js';
import { agentsRouter } from './agents.js';

const persona = (over: Partial<Persona> = {}): Persona => ({
  slug: 'executor', name: 'Executor', description: 'Does one task', version: '1', prompt: 'You do one thing.', guidance: '', returns: '', failures: [],
  procedure: 'tool-rounds', tools: [], environment: { terminal: true, filesystem: true }, ...over,
});

const editable = (over: Partial<Persona> = {}): EditableAgent => ({ ...persona(over), mine: false, recallsMemories: false, usedBy: [], toolSources: [], serverSources: [] });

let agents: ReturnType<typeof mock<AgentService>>;
let app: InProcessRoutes;

beforeEach(async () => {
  agents = mock<AgentService>();
  app = await routesInProcess({ prefix: '/api/agents', router: () => agentsRouter({ agents }) });
});

describe('/api/agents', () => {
  it('lists the agents the signed-in person can see', async () => {
    agents.list.calledWith(TEST_USER.id).mockResolvedValue([]);
    expect(await app.get('/api/agents')).toMatchObject({ status: 200, data: { agents: [] } });
  });

  it('lists the tools an agent can be granted with the languages a workspace can be in', async () => {
    agents.grantable.calledWith(TEST_USER.id).mockResolvedValue([]);
    expect(await app.get('/api/agents/tools')).toMatchObject({ status: 200, data: { tools: [], languages: [...LANGUAGE_IDS] } });
  });

  it('reads one agent, and says when there is none', async () => {
    agents.get.calledWith(TEST_USER.id, 'executor').mockResolvedValue(editable());
    expect(await app.get('/api/agents/executor')).toMatchObject({ status: 200, data: { agent: { slug: 'executor' } } });
    expect(await app.get('/api/agents/ghost')).toMatchObject({ status: 404, data: { error: 'There is no agent with that slug' } });
  });

  it('saves the body as the person, with who they are, when it names the agent in the address', async () => {
    agents.save.calledWith(TEST_USER.id, matches((body) => (body as { slug?: string }).slug === 'executor'), matches((principal) => (principal as { id?: string }).id === TEST_USER.id)).mockResolvedValue({ saved: true, agent: editable({ name: 'Mine' }) });
    expect(await app.put('/api/agents/executor', persona())).toMatchObject({ status: 200, data: { agent: { name: 'Mine' } } });
  });

  it('refuses a body that names another agent, before the service is asked', async () => {
    expect(await app.put('/api/agents/executor', persona({ slug: 'other' }))).toMatchObject({ status: 400, data: { error: 'the agent in the body is not called "executor"' } });
    expect(await app.put('/api/agents/executor', [])).toMatchObject({ status: 400 });
    expect(agents.save).not.toHaveBeenCalled();
  });

  it('answers an agent that does not hold together with each problem', async () => {
    agents.save.mockResolvedValue({ saved: false, problems: ['it needs a prompt'] });
    expect(await app.put('/api/agents/executor', persona())).toMatchObject({ status: 400, data: { error: 'The agent does not hold together', problems: ['it needs a prompt'] } });
  });

  it('deletes the person\'s own copy, and says when they have none', async () => {
    agents.remove.calledWith(TEST_USER.id, 'executor').mockResolvedValue(true);
    agents.remove.calledWith(TEST_USER.id, 'ghost').mockResolvedValue(false);
    expect(await app.delete('/api/agents/executor')).toMatchObject({ status: 200, data: { ok: true } });
    expect(await app.delete('/api/agents/ghost')).toMatchObject({ status: 404, data: { error: 'You have no copy of that agent to delete' } });
  });
});
