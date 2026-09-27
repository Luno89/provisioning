import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { actionsRouter } from './actions.js';
import { ActionService, type ActionDeployer } from '../services/ActionService.js';
import type { ActionProposal } from '../lib/action-proposals.js';

const post = (url: string) => axios.post(url, {}, { validateStatus: () => true });

const proposal = (over: Partial<ActionProposal>): ActionProposal => ({
  id: 'a1', ownerId: TEST_USER.id, kind: 'deploy_app', summary: 's', detail: [], params: {}, status: 'proposed',
  conversationId: 'c1', createdAt: 'x', updatedAt: 'x', ...over,
});

describe('/api/actions', () => {
  let harness: Harness;
  let deployer: ActionDeployer;

  beforeEach(async () => {
    deployer = {
      deployApp: vi.fn(async () => ({ id: 'wf-1', resourceId: 'vectors' })),
      promoteProjectBuild: vi.fn(async () => ({ id: 'wf-2' })),
    };
    harness = await mountRouter({ prefix: '/api/actions', router: (db) => actionsRouter({ actions: new ActionService({ store: db, deployer }) }) });
    await harness.db.saveProject({ id: 'p1', name: 'billing', ownerId: TEST_USER.id, appType: 'gitapp', deployEnv: 'A=1', createdAt: 'x' });
  });

  afterEach(() => harness.close());

  it('lists a conversation\'s proposals', async () => {
    await harness.db.saveActionProposal(proposal({}));
    expect((await axios.get(harness.url('/api/actions?conversationId=c1'))).data).toHaveLength(1);
  });

  it('deploys a catalogue app only when applied, and only once', async () => {
    await harness.db.saveActionProposal(proposal({ params: { appType: 'qdrant', name: 'vectors', clusterId: 'k', strategy: 'native' } }));
    expect(deployer.deployApp).not.toHaveBeenCalled();
    const res = await post(harness.url('/api/actions/a1/apply'));
    expect(res.data).toMatchObject({ status: 'applied', result: 'deploying vectors (workflow wf-1)' });
    expect(deployer.deployApp).toHaveBeenCalledWith({ appType: 'qdrant', name: 'vectors', clusterId: 'k', strategy: 'native' }, TEST_USER.id);
    expect((await post(harness.url('/api/actions/a1/apply'))).status).toBe(409);
  });

  it('writes the proposed environment when applied', async () => {
    await harness.db.saveActionProposal(proposal({ kind: 'set_project_env', params: { projectId: 'p1', env: 'A=1\nB=2' } }));
    await post(harness.url('/api/actions/a1/apply'));
    expect((await harness.db.getProjects()).find((p) => p.id === 'p1')?.deployEnv).toBe('A=1\nB=2');
  });

  it('adds an app spec to the person\'s catalogue when applied', async () => {
    const spec = { id: 'mongo', image: 'mongo:7', ports: [{ name: 'mongo', port: 27017 }], resources: { limits: { memory: '1Gi', cpu: '1000m' } } };
    await harness.db.saveActionProposal(proposal({ kind: 'add_app_spec', params: { spec: JSON.stringify(spec) } }));
    expect((await post(harness.url('/api/actions/a1/apply'))).data.status).toBe('applied');
    expect((await harness.db.getAppSpecs()).find((entry) => entry.id === 'mongo')).toMatchObject({ builtIn: false, ownerId: TEST_USER.id, spec: { image: 'mongo:7' } });
  });

  it('records a failure with its reason and lets it be tried again', async () => {
    deployer.deployApp = vi.fn(async () => { throw new Error('not enough memory on k'); });
    await harness.db.saveActionProposal(proposal({ params: { appType: 'qdrant', name: 'v', clusterId: 'k' } }));
    expect((await post(harness.url('/api/actions/a1/apply'))).data).toMatchObject({ status: 'failed', reason: 'not enough memory on k' });
    deployer.deployApp = vi.fn(async () => ({ id: 'wf-3' }));
    expect((await post(harness.url('/api/actions/a1/apply'))).data.status).toBe('applied');
  });

  it('rejects without doing anything, and hides someone else\'s', async () => {
    await harness.db.saveActionProposal(proposal({}));
    expect((await post(harness.url('/api/actions/a1/reject'))).data.status).toBe('rejected');
    expect(deployer.deployApp).not.toHaveBeenCalled();
    await harness.db.saveActionProposal(proposal({ id: 'a2', ownerId: 'someone-else' }));
    expect((await post(harness.url('/api/actions/a2/apply'))).status).toBe(404);
  });
});
