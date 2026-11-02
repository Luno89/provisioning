import { beforeEach, describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type InProcessRoutes } from '../../platform/testing/routes.js';
import { autoModeRouter } from './auto-mode.js';
import type { AutoModeService } from '../services/AutoModeService.js';

let autoMode: ReturnType<typeof mock<Pick<AutoModeService, 'agents' | 'setAgent' | 'setTree' | 'setConversation'>>>;
let app: InProcessRoutes;

beforeEach(async () => {
  autoMode = mock<Pick<AutoModeService, 'agents' | 'setAgent' | 'setTree' | 'setConversation'>>();
  app = await routesInProcess({ prefix: '/api/auto-mode', router: () => autoModeRouter({ autoMode }) });
});

describe('/api/auto-mode', () => {
  it('lists the signed-in person\'s agents that are on', async () => {
    autoMode.agents.calledWith(TEST_USER.id).mockResolvedValue(['executor']);
    expect(await app.get('/api/auto-mode')).toMatchObject({ status: 200, data: { agents: ['executor'] } });
  });

  it('hands the service the agent, the person and the body, and answers with its value', async () => {
    autoMode.setAgent.calledWith(TEST_USER.id, 'executor', matches((body) => JSON.stringify(body) === '{"on":true}')).mockResolvedValue({ ok: true, value: { agents: ['executor'] } });
    expect(await app.put('/api/auto-mode/agents/executor', { on: true })).toMatchObject({ status: 200, data: { agents: ['executor'] } });
  });

  it('answers a refusal with the status and words the service gave', async () => {
    autoMode.setAgent.mockResolvedValue({ ok: false, status: 404, error: 'Agent not found' });
    autoMode.setTree.mockResolvedValue({ ok: false, status: 400, error: 'say on' });
    autoMode.setConversation.mockResolvedValue({ ok: false, status: 404, error: 'Conversation not found' });
    expect(await app.put('/api/auto-mode/agents/nobody', { on: true })).toMatchObject({ status: 404, data: { error: 'Agent not found' } });
    expect(await app.put('/api/auto-mode/trees/t1', {})).toMatchObject({ status: 400, data: { error: 'say on' } });
    expect(await app.put('/api/auto-mode/conversations/c1', { on: true })).toMatchObject({ status: 404, data: { error: 'Conversation not found' } });
  });

  it('switches a tree and a chat through the service', async () => {
    autoMode.setTree.calledWith(TEST_USER.id, 't1', matches(() => true)).mockResolvedValue({ ok: true, value: { autoMode: true } });
    autoMode.setConversation.calledWith(TEST_USER.id, 'c1', matches(() => true)).mockResolvedValue({ ok: true, value: { autoMode: false } });
    expect((await app.put('/api/auto-mode/trees/t1', { on: true })).data).toEqual({ autoMode: true });
    expect((await app.put('/api/auto-mode/conversations/c1', { on: false })).data).toEqual({ autoMode: false });
  });

  it('turns a signed-out request away before the service is asked', async () => {
    app.setUser(null);
    expect((await app.get('/api/auto-mode')).status).toBe(401);
    expect(autoMode.agents).not.toHaveBeenCalled();
  });
});
