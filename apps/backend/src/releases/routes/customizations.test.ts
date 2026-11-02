import { describe, expect, it } from 'vitest';
import { any, mock } from 'vitest-mock-extended';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess } from '../../platform/testing/routes.js';
import { equalTo } from '../../platform/testing/matchers.js';
import { customizationsRouter, type CustomizationsRouterDeps } from './customizations.js';

const project = { id: 'p1', name: 'Shop', ownerId: TEST_USER.id } as ProjectMetadata;

async function setUp() {
  const customizations = mock<CustomizationsRouterDeps['customizations']>();
  const deps = mock<CustomizationsRouterDeps>({ customizations });
  deps.getOwnedProject.calledWith('p1', any()).mockResolvedValue(project);
  deps.getOwnedProject.calledWith('p2', any()).mockResolvedValue(undefined);
  const routes = await routesInProcess({ prefix: '/', router: () => customizationsRouter(deps) });
  return { deps, customizations, routes };
}

describe('what was made in a project\'s live app', () => {
  it('lists it for a project the person owns, and says so for one they do not', async () => {
    const { customizations, routes } = await setUp();
    const drift = { projectId: 'p1', project: 'Shop', module: 'shop_customizations', items: [] };
    customizations.drift.calledWith(TEST_USER.id, 'p1').mockResolvedValue({ ok: true, value: drift });
    expect((await routes.get('/p1/customizations')).data).toEqual(drift);
    const other = await routes.get('/p2/customizations');
    expect([other.status, other.data]).toEqual([404, { error: 'You have no project with that id' }]);
  });

  it('says why the service could not read it', async () => {
    const { customizations, routes } = await setUp();
    customizations.drift.mockResolvedValue({ ok: false, status: 409, error: 'nothing is live yet' });
    const refused = await routes.get('/p1/customizations');
    expect([refused.status, refused.data]).toEqual([409, { error: 'nothing is live yet' }]);
  });

  it('proposes bringing it into git on the project\'s channel and answers with the proposal', async () => {
    const { deps, customizations, routes } = await setUp();
    deps.channelOf.calledWith(project).mockResolvedValue('channel-p1');
    customizations.propose.calledWith(TEST_USER.id, 'p1', equalTo({ refs: ['view:7'] }), equalTo({ conversationId: 'channel-p1' })).mockResolvedValue({ ok: true, value: { id: 'plan-1' } as never });
    const proposed = await routes.post('/p1/customizations/adopt', { refs: ['view:7'] });
    expect([proposed.status, proposed.data]).toEqual([201, { id: 'plan-1' }]);
  });

  it('proposes without a conversation when the project has no channel, and passes the service\'s refusal on', async () => {
    const { deps, customizations, routes } = await setUp();
    deps.channelOf.mockResolvedValue(undefined);
    customizations.propose.calledWith(TEST_USER.id, 'p1', equalTo({ refs: [] }), equalTo({})).mockResolvedValue({ ok: false, status: 400, error: 'name what to bring in' });
    const refused = await routes.post('/p1/customizations/adopt', { refs: [] });
    expect([refused.status, refused.data]).toEqual([400, { error: 'name what to bring in' }]);
    expect((await routes.post('/p2/customizations/adopt', {})).status).toBe(404);
  });
});
