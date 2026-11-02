import { describe, expect, it } from 'vitest';
import { any, mock } from 'vitest-mock-extended';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import { dispatch, SIGNED_IN } from '../testing/dispatch.js';
import { equalTo } from '../testing/equal-to.js';
import { customizationsRouter, type CustomizationsRouterDeps } from './customizations.js';

const project = { id: 'p1', name: 'Shop', ownerId: SIGNED_IN.id } as ProjectMetadata;

function setUp() {
  const customizations = mock<CustomizationsRouterDeps['customizations']>();
  const deps = mock<CustomizationsRouterDeps>({ customizations });
  deps.getOwnedProject.calledWith('p1', any()).mockResolvedValue(project);
  deps.getOwnedProject.calledWith('p2', any()).mockResolvedValue(undefined);
  return { deps, customizations, router: customizationsRouter(deps) };
}

describe('what was made in a project\'s live app', () => {
  it('lists it for a project the person owns, and says so for one they do not', async () => {
    const { customizations, router } = setUp();
    const drift = { projectId: 'p1', project: 'Shop', module: 'shop_customizations', items: [] };
    customizations.drift.calledWith(SIGNED_IN.id, 'p1').mockResolvedValue({ ok: true, value: drift });
    expect((await dispatch(router, { method: 'GET', url: '/p1/customizations' })).json).toEqual(drift);
    const other = await dispatch(router, { method: 'GET', url: '/p2/customizations' });
    expect([other.status, other.json]).toEqual([404, { error: 'You have no project with that id' }]);
  });

  it('says why the service could not read it', async () => {
    const { customizations, router } = setUp();
    customizations.drift.mockResolvedValue({ ok: false, status: 409, error: 'nothing is live yet' });
    const refused = await dispatch(router, { method: 'GET', url: '/p1/customizations' });
    expect([refused.status, refused.json]).toEqual([409, { error: 'nothing is live yet' }]);
  });

  it('proposes bringing it into git on the project\'s channel and answers with the proposal', async () => {
    const { deps, customizations, router } = setUp();
    deps.channelOf.calledWith(project).mockResolvedValue('channel-p1');
    customizations.propose.calledWith(SIGNED_IN.id, 'p1', equalTo({ refs: ['view:7'] }), equalTo({ conversationId: 'channel-p1' })).mockResolvedValue({ ok: true, value: { id: 'plan-1' } as never });
    const proposed = await dispatch(router, { method: 'POST', url: '/p1/customizations/adopt', json: { refs: ['view:7'] } });
    expect([proposed.status, proposed.json]).toEqual([201, { id: 'plan-1' }]);
  });

  it('proposes without a conversation when the project has no channel, and passes the service\'s refusal on', async () => {
    const { deps, customizations, router } = setUp();
    deps.channelOf.mockResolvedValue(undefined);
    customizations.propose.calledWith(SIGNED_IN.id, 'p1', equalTo({ refs: [] }), equalTo({})).mockResolvedValue({ ok: false, status: 400, error: 'name what to bring in' });
    const refused = await dispatch(router, { method: 'POST', url: '/p1/customizations/adopt', json: { refs: [] } });
    expect([refused.status, refused.json]).toEqual([400, { error: 'name what to bring in' }]);
    expect((await dispatch(router, { method: 'POST', url: '/p2/customizations/adopt', json: {} })).status).toBe(404);
  });
});
