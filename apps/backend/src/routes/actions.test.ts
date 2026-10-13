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
  let settled: [string, string | undefined][];

  beforeEach(async () => {
    deployer = {
      deployApp: vi.fn(async () => ({ id: 'wf-1', resourceId: 'vectors' })),
      promoteProjectBuild: vi.fn(async () => ({ id: 'wf-2' })),
    };
    settled = [];
    harness = await mountRouter({ prefix: '/api/actions', router: (db) => actionsRouter({ actions: new ActionService({ store: db, deployer, onSettled: (ownerId, conversationId) => { settled.push([ownerId, conversationId]); } }) }) });
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
    expect(settled, 'an accepted card is something settled in its conversation').toEqual([[TEST_USER.id, 'c1']]);
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

describe('/api/actions adding an MCP server', () => {
  let harness: Harness;
  let added: Record<string, unknown>[];
  let granted: [string, string[], unknown][];
  let held: Record<string, string[]>;
  const servers: { name: string; runs: { where: string } }[] = [{ name: 'docs', runs: { where: 'hosted' } }];

  beforeEach(async () => {
    added = [];
    granted = [];
    held = { executor: ['docs'], planner: [] };
    harness = await mountRouter({ prefix: '/api/actions', router: (db) => actionsRouter({ actions: new ActionService({
      store: db,
      deployer: { deployApp: vi.fn(), promoteProjectBuild: vi.fn() },
      servers: {
        add: async (_ownerId, input) => {
          added.push(input as Record<string, unknown>);
          if (input.template === 'nothing') return { ok: false, status: 404, error: 'there is no known server called "nothing"' };
          return { ok: true, server: { name: (input.name as string) ?? 'playwright', runs: { where: 'workspace' } } as never };
        },
        list: async () => servers as never,
      },
      agents: {
        agents: async () => Object.entries(held).map(([slug, names]) => ({ slug, servers: names })),
        setServers: async (_ownerId, slug, wanted, meta) => { granted.push([slug, [...wanted], meta]); return true; },
      },
    }) }) });
  });

  afterEach(() => harness.close());

  const spec = (over: Record<string, unknown>) => JSON.stringify({ name: 'playwright', agents: ['executor', 'planner'], why: 'check pages', ...over });

  it('adds a known server with what the card said, then gives it to each agent named, keeping what they held', async () => {
    await harness.db.saveActionProposal(proposal({ kind: 'add_mcp_server', params: { spec: spec({ template: 'playwright', notes: 'Odoo on 8069' }) } }));
    const res = await post(harness.url('/api/actions/a1/apply'));
    expect(res.data).toMatchObject({ status: 'applied', result: 'added playwright; its tools are being captured; given to executor, planner, whose images rebuild with it' });
    expect(added).toEqual([expect.objectContaining({ template: 'playwright', name: 'playwright', notes: 'Odoo on 8069' })]);
    expect(granted).toEqual([
      ['executor', ['docs', 'playwright'], { why: 'check pages', proposalId: 'a1' }],
      ['planner', ['playwright'], { why: 'check pages', proposalId: 'a1' }],
    ]);
  });

  it('gives a server the person has without adding anything, and fails with the reason when it cannot add one', async () => {
    await harness.db.saveActionProposal(proposal({ kind: 'add_mcp_server', params: { spec: spec({ server: 'docs', name: 'docs', agents: ['planner'] }) } }));
    expect((await post(harness.url('/api/actions/a1/apply'))).data).toMatchObject({ status: 'applied', result: 'given to planner' });
    expect(added).toEqual([]);

    await harness.db.saveActionProposal(proposal({ id: 'a2', kind: 'add_mcp_server', params: { spec: spec({ template: 'nothing' }) } }));
    expect((await post(harness.url('/api/actions/a2/apply'))).data).toMatchObject({ status: 'failed', reason: 'there is no known server called "nothing"' });
    expect(granted.map(([slug]) => slug)).toEqual(['planner']);
  });
});
