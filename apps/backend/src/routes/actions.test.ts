import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { actionsRouter } from './actions.js';
import { ActionService, type ActionDeployer } from '../services/ActionService.js';
import type { ActionProposal } from '../lib/action-proposals.js';
import { runsFingerprint, type McpServerRecord, type ServerRuns } from '../lib/mcp-servers.js';
import type { ImageNow } from '../lib/proposal-progress.js';

const WORKSPACE: ServerRuns = { where: 'workspace', install: [{ via: 'npm', packages: ['@playwright/mcp'] }], start: 'playwright-mcp', port: 8931 };

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
  let granted: [string, string, unknown][];
  let held: Record<string, string[]>;
  let images: Record<string, ImageNow>;
  const captured = { tools: [{ name: 'browser_click' }, { name: 'browser_snapshot' }], at: 't', fingerprint: '' };
  let servers: McpServerRecord[];

  beforeEach(async () => {
    added = [];
    granted = [];
    held = { executor: ['docs'], planner: [] };
    images = {};
    servers = [{ id: 'docs-id', ownerId: TEST_USER.id, name: 'docs', runs: { where: 'hosted', url: 'http://docs.test/mcp' }, createdAt: 't', updatedAt: 't' }];
    harness = await mountRouter({ prefix: '/api/actions', router: (db) => actionsRouter({ actions: new ActionService({
      store: db,
      deployer: { deployApp: vi.fn(), promoteProjectBuild: vi.fn() },
      servers: {
        add: async (_ownerId, input) => {
          added.push(input as Record<string, unknown>);
          if (input.template === 'nothing') return { ok: false, status: 404, error: 'there is no known server called "nothing"' };
          const server: McpServerRecord = { id: 'pw-id', ownerId: TEST_USER.id, name: (input.name as string) ?? 'playwright', runs: WORKSPACE, capturing: { runId: 'c1', at: 't' }, createdAt: 't', updatedAt: 't' };
          servers.push(server);
          return { ok: true, server: { ...server, status: { state: 'capturing', runId: 'c1' } } };
        },
        list: async () => servers,
      },
      agents: {
        agents: async () => Object.entries(held).map(([slug, names]) => ({ slug, servers: names })),
        holdServer: async (_ownerId, slug, server, meta) => {
          granted.push([slug, server, meta]);
          held[slug] = [...(held[slug] ?? []), server];
          if (server === 'docs') return undefined;
          images[slug] = { state: 'building' };
          return images[slug];
        },
        image: async (_ownerId, slug) => images[slug],
      },
    }) }) });
  });

  afterEach(() => harness.close());

  const spec = (over: Record<string, unknown>) => JSON.stringify({ name: 'playwright', agents: ['executor', 'planner'], why: 'check pages', ...over });

  it('adds a known server with what the card said, gives it to each agent named, and starts their images building', async () => {
    await harness.db.saveActionProposal(proposal({ kind: 'add_mcp_server', params: { spec: spec({ template: 'playwright', notes: 'Odoo on 8069' }) } }));
    const res = await post(harness.url('/api/actions/a1/apply'));
    expect(res.data).toMatchObject({
      status: 'applied',
      result: 'added playwright; its tools are being captured; given to executor, planner; building executor, planner\'s images',
      started: { server: { id: 'pw-id', name: 'playwright', added: true }, images: ['executor', 'planner'] },
    });
    expect(added).toEqual([expect.objectContaining({ template: 'playwright', name: 'playwright', notes: 'Odoo on 8069' })]);
    expect(granted).toEqual([
      ['executor', 'playwright', { why: 'check pages', proposalId: 'a1' }],
      ['planner', 'playwright', { why: 'check pages', proposalId: 'a1' }],
    ]);
  });

  it('follows what it started until the tools are captured and every image is built', async () => {
    await harness.db.saveActionProposal(proposal({ kind: 'add_mcp_server', params: { spec: spec({ template: 'playwright', agents: ['executor'] }) } }));
    await post(harness.url('/api/actions/a1/apply'));

    const first = (await axios.get(harness.url('/api/actions/a1/progress'))).data;
    expect(first).toEqual({
      steps: [
        { label: 'Added playwright', state: 'done' },
        { label: 'Capturing its tools', state: 'running' },
        { label: 'Building executor\'s image', state: 'running' },
      ],
      done: false,
      server: { id: 'pw-id', name: 'playwright' },
    });

    const server = servers.find((entry) => entry.id === 'pw-id')!;
    delete server.capturing;
    server.captured = { ...captured, fingerprint: runsFingerprint(WORKSPACE) };
    images.executor = { state: 'ready' };
    const last = (await axios.get(harness.url('/api/actions/a1/progress'))).data;
    expect(last).toMatchObject({ done: true, ready: 'playwright is ready for executor', steps: [{ state: 'done' }, { label: 'Captured its tools', state: 'done', detail: '2, 2 offered' }, { label: 'executor\'s image is built', state: 'done' }] });
  });

  it('gives a server the person has without adding anything, and fails with the reason when it cannot add one', async () => {
    await harness.db.saveActionProposal(proposal({ kind: 'add_mcp_server', params: { spec: spec({ server: 'docs', name: 'docs', agents: ['planner'] }) } }));
    expect((await post(harness.url('/api/actions/a1/apply'))).data).toMatchObject({ status: 'applied', result: 'given to planner', started: { server: { id: 'docs-id', added: false } } });
    expect(added).toEqual([]);

    await harness.db.saveActionProposal(proposal({ id: 'a2', kind: 'add_mcp_server', params: { spec: spec({ template: 'nothing' }) } }));
    expect((await post(harness.url('/api/actions/a2/apply'))).data).toMatchObject({ status: 'failed', reason: 'there is no known server called "nothing"' });
    expect(granted.map(([slug]) => slug)).toEqual(['planner']);
    expect((await axios.get(harness.url('/api/actions/a2/progress'), { validateStatus: () => true })).status).toBe(404);
  });
});

describe('/api/actions: how builds are released', () => {
  let harness: Harness;

  beforeEach(async () => {
    const { ReleaseSettings } = await import('../services/ReleaseSettings.js');
    const { REPLACE, SLOTS } = await import('../extensions/releases/procedures.js');
    const procedures: Record<string, typeof SLOTS> = { release: SLOTS, 'release-replace': REPLACE };
    harness = await mountRouter({
      prefix: '/api/actions',
      router: (db) => actionsRouter({ actions: new ActionService({
        store: db,
        deployer: { deployApp: vi.fn(), promoteProjectBuild: vi.fn() },
        releases: new ReleaseSettings({
          agents: async () => [{ slug: 'release', name: 'Release' }, { slug: 'release-replace', name: 'Release by replacing' }],
          procedureOf: async (_owner, slug) => procedures[slug],
          treeTypes: (ownerId) => db.getTreeTypes(ownerId),
          saveTreeType: (type) => db.saveTreeType(type),
          projects: () => db.getProjects(),
          saveProject: (project) => db.saveProject(project),
          typeOfProject: async () => undefined,
          hasChart: async () => false,
        }),
      }) }),
    });
    await harness.db.saveProject({ id: 'p1', name: 'billing', ownerId: TEST_USER.id, appType: 'gitapp', createdAt: 'x' });
  });

  afterEach(() => harness.close());

  it('changes how a project\'s builds are released only when the card is applied, and clears it the same way', async () => {
    await harness.db.saveActionProposal(proposal({ kind: 'set_release', params: { target: 'project', id: 'p1', agent: 'release', app: 'odoo' } }));
    expect((await harness.db.getProjects()).find((p) => p.id === 'p1')?.release).toBeUndefined();
    const applied = await post(harness.url('/api/actions/a1/apply'));
    expect(applied.data).toMatchObject({ status: 'applied', result: 'builds are released by the release agent with the odoo adapter from the next build' });
    expect((await harness.db.getProjects()).find((p) => p.id === 'p1')?.release).toEqual({ agent: 'release', app: 'odoo' });

    await harness.db.saveActionProposal(proposal({ id: 'a2', kind: 'set_release', params: { target: 'project', id: 'p1', clear: 'true' } }));
    await post(harness.url('/api/actions/a2/apply'));
    expect((await harness.db.getProjects()).find((p) => p.id === 'p1')?.release).toBeUndefined();
  });

  it('fails a card whose release no longer fits, saying why', async () => {
    await harness.db.saveActionProposal(proposal({ kind: 'set_release', params: { target: 'project', id: 'p1', agent: 'release' } }));
    expect((await post(harness.url('/api/actions/a1/apply'))).data).toMatchObject({ status: 'failed', reason: 'release releases beside the live app, so it needs the app\'s adapter (odoo)' });
  });
});

describe('a card choosing a tree\'s model', () => {
  let harness: Harness;

  beforeEach(async () => {
    const { TreeModelsService } = await import('../services/TreeModelsService.js');
    const { seedTreeTypes } = await import('../lib/tree-types.js');
    const executor = { slug: 'executor', name: 'Executor', procedure: { nodes: [{ id: 'm', kind: 'call-model', settings: {} }], groups: [] } } as never;
    const grove = { slug: 'grove', name: 'Grove', procedure: { nodes: [{ id: 'w', kind: 'fan-out', settings: { agent: 'executor' } }], groups: [] } } as never;
    harness = await mountRouter({
      prefix: '/api/actions',
      router: (db) => actionsRouter({ actions: new ActionService({
        store: db,
        deployer: { deployApp: vi.fn(), promoteProjectBuild: vi.fn() },
        treeModels: new TreeModelsService({
          store: db,
          models: { list: async () => [{ id: 'tabby' }, { id: 'vllm' }] as never, route: async () => ({ provider: { id: 'tabby' } as never }) },
          agentOf: async (_owner, slug) => (slug === 'executor' ? executor : slug === 'grove' ? grove : undefined),
        }),
      }) }),
    });
    await seedTreeTypes(harness.db);
    await harness.db.saveTree({ id: 't1', ownerId: TEST_USER.id, name: 'shop', type: 'api-service', createdAt: 'x', updatedAt: 'x' } as never);
  });

  afterEach(() => harness.close());

  it('sets the agent\'s model for the tree only when applied, clears it the same way, and fails one whose model is gone', async () => {
    await harness.db.saveActionProposal(proposal({ kind: 'set_tree_model', params: { treeId: 't1', agent: 'executor', modelId: 'vllm' } }));
    expect((await harness.db.getTrees()).find((tree) => tree.id === 't1')?.models).toBeUndefined();
    expect((await post(harness.url('/api/actions/a1/apply'))).data).toMatchObject({ status: 'applied', result: 'executor works on vllm in this tree from its next run' });
    expect((await harness.db.getTrees()).find((tree) => tree.id === 't1')?.models).toEqual({ executor: 'vllm' });

    await harness.db.saveActionProposal(proposal({ id: 'a2', kind: 'set_tree_model', params: { treeId: 't1', agent: 'executor', clear: 'true' } }));
    expect((await post(harness.url('/api/actions/a2/apply'))).data).toMatchObject({ status: 'applied', result: 'executor is back on its own model in this tree' });
    expect((await harness.db.getTrees()).find((tree) => tree.id === 't1')?.models).toBeUndefined();

    await harness.db.saveActionProposal(proposal({ id: 'a3', kind: 'set_tree_model', params: { treeId: 't1', agent: 'executor', modelId: 'gone' } }));
    expect((await post(harness.url('/api/actions/a3/apply'))).data).toMatchObject({ status: 'failed', reason: 'There is no model gone among yours' });
  });
});

describe('a card setting an alert', () => {
  let harness: Harness;
  let added: string[];
  let removed: string[];

  beforeEach(async () => {
    added = [];
    removed = [];
    harness = await mountRouter({
      prefix: '/api/actions',
      router: (db) => actionsRouter({ actions: new ActionService({
        store: db,
        deployer: { deployApp: vi.fn(), promoteProjectBuild: vi.fn() },
        alerts: {
          add: async (ownerId, deploymentId, spec, conversationId) => {
            added.push(`${ownerId} ${deploymentId} ${spec.kind} ${spec.threshold} ${spec.forMinutes} ${conversationId}`);
            return { summary: 'Books: Books takes over 1.5 s to answer for 10 minutes' };
          },
          remove: async (ownerId, ruleId) => { removed.push(`${ownerId} ${ruleId}`); },
        },
      }) }),
    });
  });

  afterEach(() => harness.close());

  it('sets the alert when applied, in the conversation it was proposed in', async () => {
    await harness.db.saveActionProposal(proposal({ kind: 'set_alert', conversationId: 'conv-1', params: { deploymentId: 'books', kind: 'slow', threshold: '1.5', forMinutes: '10' } }));
    expect((await post(harness.url('/api/actions/a1/apply'))).data).toMatchObject({ status: 'applied', result: 'set: Books: Books takes over 1.5 s to answer for 10 minutes' });
    expect(added).toEqual([`${TEST_USER.id} books slow 1.5 10 conv-1`]);
  });

  it('removes one, and fails a card whose threshold is out of range', async () => {
    await harness.db.saveActionProposal(proposal({ kind: 'set_alert', params: { remove: 'r1' } }));
    expect((await post(harness.url('/api/actions/a1/apply'))).data).toMatchObject({ status: 'applied', result: 'the alert is removed' });
    expect(removed).toEqual([`${TEST_USER.id} r1`]);
    await harness.db.saveActionProposal(proposal({ id: 'a2', kind: 'set_alert', params: { deploymentId: 'books', kind: 'memory', threshold: '500', forMinutes: '5' } }));
    expect((await post(harness.url('/api/actions/a2/apply'))).data).toMatchObject({ status: 'failed', reason: 'the threshold for "memory" is in % of its limit, between 10 and 100' });
  });
});
