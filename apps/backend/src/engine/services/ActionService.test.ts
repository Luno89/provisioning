import { beforeEach, describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { WorkspaceDependencyService } from './WorkspaceDependencyService.js';
import type { ReleaseSettings } from '../../releases/index.js';
import type { TreeModelsService } from '../../models/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { asPerson } from '../../platform/lib/permissions.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { ActionProposal } from '../lib/action-proposals.js';
import { runsFingerprint, type McpServerRecord, type ServerRuns } from '../lib/mcp-servers.js';
import type { McpServerInput } from './McpServerService.js';
import { ActionService, type ActionAgents, type ActionAlerts, type ActionDeployer, type ActionServers } from './ActionService.js';

const OWNER = 'u1';
const WORKSPACE: ServerRuns = { where: 'workspace', needs: ['playwright-mcp'], start: 'playwright-mcp', port: 8931 };

const proposal = (over: Partial<ActionProposal> = {}): ActionProposal => ({
  id: 'a1', ownerId: OWNER, kind: 'deploy_app', summary: 's', detail: [], params: {}, status: 'proposed',
  conversationId: 'c1', createdAt: 'x', updatedAt: 'x', ...over,
});

const server = (over: Partial<McpServerRecord> = {}): McpServerRecord => ({
  id: 'pw-id', ownerId: OWNER, name: 'playwright', runs: WORKSPACE, capturing: { runId: 'c1', at: 't' }, createdAt: 't', updatedAt: 't', ...over,
});

let db: Database;
let deployer: ReturnType<typeof mock<ActionDeployer>>;
let settled: [string, string | undefined][];

const service = (extra: Partial<ConstructorParameters<typeof ActionService>[0]> = {}) => new ActionService({
  store: db,
  deployer,
  now: () => 'now',
  onSettled: (ownerId, conversationId) => { settled.push([ownerId, conversationId]); },
  ...extra,
});

beforeEach(async () => {
  db = memoryDatabase();
  deployer = mock<ActionDeployer>();
  settled = [];
  await db.projects.saveProject({ id: 'p1', name: 'billing', ownerId: OWNER, appType: 'gitapp', deployEnv: 'A=1', createdAt: 'x' });
});

describe('cards the person decides on', () => {
  it('lists a conversation\'s proposals and a tree\'s, and no one else\'s', async () => {
    await db.engine.saveActionProposal(proposal());
    await db.engine.saveActionProposal(proposal({ id: 'a2', conversationId: 'c2', treeId: 't1' }));
    await db.engine.saveActionProposal(proposal({ id: 'a3', ownerId: 'someone-else' }));
    expect((await service().list(OWNER, { conversationId: 'c1' })).map((card) => card.id)).toEqual(['a1']);
    expect((await service().list(OWNER, { treeId: 't1' })).map((card) => card.id)).toEqual(['a2']);
    expect(await service().list(OWNER)).toHaveLength(2);
  });

  it('deploys a catalogue app only when applied, and only once', async () => {
    deployer.deployApp.mockResolvedValue({ id: 'wf-1', resourceId: 'vectors' });
    await db.engine.saveActionProposal(proposal({ params: { appType: 'qdrant', name: 'vectors', clusterId: 'k', strategy: 'native' } }));
    expect(deployer.deployApp).not.toHaveBeenCalled();

    const applied = await service().apply(OWNER, 'a1');
    expect(applied).toMatchObject({ ok: true, proposal: { status: 'applied', result: 'deploying vectors (workflow wf-1)' } });
    expect(deployer.deployApp).toHaveBeenCalledWith({ appType: 'qdrant', name: 'vectors', clusterId: 'k', strategy: 'native' }, OWNER);
    expect(await service().apply(OWNER, 'a1')).toEqual({ ok: false, status: 409, error: 'This proposal is already applied.' });
    expect(settled).toEqual([[OWNER, 'c1']]);
  });

  it('deploys natively when the card names no strategy', async () => {
    deployer.deployApp.mockResolvedValue({ id: 'wf-1' });
    await db.engine.saveActionProposal(proposal({ params: { appType: 'qdrant', name: 'vectors', clusterId: 'k' } }));
    await service().apply(OWNER, 'a1');
    expect(deployer.deployApp).toHaveBeenCalledWith({ appType: 'qdrant', name: 'vectors', clusterId: 'k', strategy: 'native' }, OWNER);
  });

  it('records a failure with its reason, tells nobody it settled, and lets it be tried again', async () => {
    deployer.deployApp.mockRejectedValueOnce(new Error('not enough memory on k'));
    await db.engine.saveActionProposal(proposal({ params: { appType: 'qdrant', name: 'v', clusterId: 'k' } }));
    expect(await service().apply(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'not enough memory on k' } });
    expect(settled).toEqual([]);

    deployer.deployApp.mockResolvedValueOnce({ id: 'wf-3' });
    const again = await service().apply(OWNER, 'a1');
    expect(again).toMatchObject({ ok: true, proposal: { status: 'applied' } });
    expect(again.ok && again.proposal).not.toHaveProperty('reason');
  });

  it('rejects without doing anything, and hides someone else\'s', async () => {
    await db.engine.saveActionProposal(proposal());
    expect(await service().reject(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { status: 'rejected' } });
    expect(deployer.deployApp).not.toHaveBeenCalled();
    expect(await service().reject(OWNER, 'a1')).toMatchObject({ ok: false, status: 409 });
    await db.engine.saveActionProposal(proposal({ id: 'a2', ownerId: 'someone-else' }));
    expect(await service().apply(OWNER, 'a2')).toEqual({ ok: false, status: 404, error: 'Proposal not found' });
    expect(await service().reject(OWNER, 'a2')).toEqual({ ok: false, status: 404, error: 'Proposal not found' });
  });

  it('writes the proposed environment when applied, and fails for a project that is gone', async () => {
    await db.engine.saveActionProposal(proposal({ kind: 'set_project_env', params: { projectId: 'p1', env: 'A=1\nB=2' } }));
    expect(await service().apply(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { status: 'applied', result: 'billing\'s environment is set; it takes effect on the next deploy' } });
    expect((await db.projects.getProjects()).find((p) => p.id === 'p1')?.deployEnv).toBe('A=1\nB=2');

    await db.engine.saveActionProposal(proposal({ id: 'a2', kind: 'set_project_env', params: { projectId: 'gone', env: 'A=1' } }));
    expect(await service().apply(OWNER, 'a2')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'the project no longer exists' } });
  });

  it('deploys a project\'s build, and fails for a build that is gone', async () => {
    deployer.promoteProjectBuild.mockResolvedValue({ id: 'wf-2' });
    await db.releases.savePipelineRun({ id: 'run1', projectId: 'p1', status: 'succeeded' } as never);
    await db.engine.saveActionProposal(proposal({ kind: 'deploy_project', params: { projectId: 'p1', runId: 'run1' } }));
    expect(await service().apply(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { status: 'applied', result: 'deploying billing from build run1 (workflow wf-2)' } });

    await db.engine.saveActionProposal(proposal({ id: 'a2', kind: 'deploy_project', params: { projectId: 'p1', runId: 'nope' } }));
    expect(await service().apply(OWNER, 'a2')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'that build no longer exists' } });
  });

  it('adds an app spec to the person\'s catalogue when applied, and refuses one that does not hold together', async () => {
    const spec = { id: 'mongo', image: 'mongo:7', ports: [{ name: 'mongo', port: 27017 }], resources: { limits: { memory: '1Gi', cpu: '1000m' } } };
    await db.engine.saveActionProposal(proposal({ kind: 'add_app_spec', params: { spec: JSON.stringify(spec) } }));
    expect(await service().apply(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { status: 'applied', result: '"mongo" is in your catalogue and can be deployed' } });
    expect((await db.infrastructure.getAppSpecs()).find((entry) => entry.id === 'mongo')).toMatchObject({ builtIn: false, ownerId: OWNER, spec: { image: 'mongo:7' } });

    await db.engine.saveActionProposal(proposal({ id: 'a2', kind: 'add_app_spec', params: { spec: JSON.stringify({ id: 'broken' }) } }));
    expect(await service().apply(OWNER, 'a2')).toMatchObject({ ok: true, proposal: { status: 'failed' } });
  });

  it('declares a project\'s dependency when applied', async () => {
    await db.engine.saveActionProposal(proposal({ kind: 'add_project_dependency', params: { projectId: 'nope', service: 'redis', as: 'cache' } }));
    expect(await service().apply(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { status: 'failed' } });
  });

  it('fails an MCP card that reaches the plain path, since a server is added only by its own', async () => {
    await db.engine.saveActionProposal(proposal({ kind: 'add_mcp_server', params: { spec: '{"name":"x","agents":[]}' } }));
    expect(await service().apply(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'MCP servers cannot be added from here' } });
  });
});

describe('a deploy card checks its cluster again', () => {
  it('deploys to a cluster the person may deploy to, as the signed-in principal, and fails the card for one they may not', async () => {
    deployer.deployApp.mockResolvedValue({ id: 'wf-1' });
    const getById = mock<{ getById(id: string, principal: unknown, action: 'deploy-to'): Promise<unknown> }>();
    const principal = asPerson(OWNER);
    getById.getById.calledWith('c1', matches((given) => given === principal), 'deploy-to').mockResolvedValue({ id: 'c1' });
    await db.engine.saveActionProposal(proposal({ params: { appType: 'odoo', name: 'shop', clusterId: 'c1' } }));
    expect(await service({ clusters: getById }).apply(OWNER, 'a1', principal)).toMatchObject({ ok: true, proposal: { status: 'applied' } });

    await db.engine.saveActionProposal(proposal({ id: 'a2', params: { appType: 'odoo', name: 'shop', clusterId: 'c9' } }));
    expect(await service({ clusters: getById }).apply(OWNER, 'a2', principal)).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'that cluster is not one you can deploy to' } });
    expect(deployer.deployApp).toHaveBeenCalledTimes(1);
  });

  it('asks as the card\'s owner when no principal is handed over', async () => {
    const clusters = mock<{ getById(id: string, principal: unknown, action: 'deploy-to'): Promise<unknown> }>();
    clusters.getById.mockResolvedValue(undefined);
    await db.engine.saveActionProposal(proposal({ params: { appType: 'odoo', name: 'shop', clusterId: 'c1' } }));
    await service({ clusters }).apply(OWNER, 'a1');
    expect(clusters.getById).toHaveBeenCalledWith('c1', matches((given) => (given as { id?: string }).id === OWNER), 'deploy-to');
  });
});

describe('a card adding an MCP server', () => {
  let servers: ReturnType<typeof mock<ActionServers>>;
  let agents: ReturnType<typeof mock<ActionAgents>>;
  let dependencies: ReturnType<typeof mock<Pick<WorkspaceDependencyService, 'save'>>>;
  let records: McpServerRecord[];
  let held: Record<string, string[]>;
  let images: Record<string, { state: 'ready' | 'building' }>;
  let added: McpServerInput[];
  const captured = { tools: [{ name: 'browser_click' }, { name: 'browser_snapshot' }], at: 't', fingerprint: '' };

  const spec = (over: Record<string, unknown>) => JSON.stringify({ name: 'playwright', agents: ['executor', 'planner'], why: 'check pages', ...over });
  const withServers = () => service({ servers, agents, dependencies });

  beforeEach(() => {
    records = [server({ id: 'docs-id', name: 'docs', runs: { where: 'hosted', url: 'http://docs.test/mcp' }, capturing: undefined })];
    held = { executor: ['docs'], planner: [] };
    images = {};
    added = [];
    servers = mock<ActionServers>();
    agents = mock<ActionAgents>();
    dependencies = mock<Pick<WorkspaceDependencyService, 'save'>>();
    servers.list.mockImplementation(async () => records);
    servers.add.mockImplementation(async (_ownerId, input) => {
      added.push(input);
      if (input.template === 'nothing') return { ok: false, status: 404, error: 'there is no known server called "nothing"' };
      const record = server({ name: typeof input.name === 'string' ? input.name : 'playwright' });
      records.push(record);
      return { ok: true, server: { ...record, status: { state: 'capturing', runId: 'c1' } } };
    });
    agents.agents.mockImplementation(async () => Object.entries(held).map(([slug, names]) => ({ slug, servers: names })));
    agents.holdServer.mockImplementation(async (_ownerId, slug, name) => {
      held[slug] = [...(held[slug] ?? []), name];
      if (name === 'docs') return undefined;
      images[slug] = { state: 'building' };
      return images[slug];
    });
    agents.image.mockImplementation(async (_ownerId, slug) => images[slug]);
  });

  it('adds a known server with what the card said, gives it to each agent named, and starts their images building', async () => {
    await db.engine.saveActionProposal(proposal({ kind: 'add_mcp_server', params: { spec: spec({ template: 'playwright', notes: 'Odoo on 8069' }) } }));
    expect(await withServers().apply(OWNER, 'a1')).toMatchObject({
      ok: true,
      proposal: {
        status: 'applied',
        result: 'added playwright; its tools are being captured; given to executor, planner; building executor, planner\'s images',
        started: { server: { id: 'pw-id', name: 'playwright', added: true }, images: ['executor', 'planner'] },
      },
    });
    expect(added).toEqual([matches((input) => (input as { template?: string; notes?: string }).template === 'playwright' && (input as { notes?: string }).notes === 'Odoo on 8069')]);
    expect(agents.holdServer).toHaveBeenCalledWith(OWNER, 'executor', 'playwright', { why: 'check pages', proposalId: 'a1' });
    expect(agents.holdServer).toHaveBeenCalledWith(OWNER, 'planner', 'playwright', { why: 'check pages', proposalId: 'a1' });
  });

  it('adds a server described by what it runs when the card names no template', async () => {
    await db.engine.saveActionProposal(proposal({ kind: 'add_mcp_server', params: { spec: spec({ runs: WORKSPACE, agents: ['planner'] }) } }));
    await withServers().apply(OWNER, 'a1');
    expect(added).toEqual([matches((input) => JSON.stringify((input as { runs?: unknown }).runs) === JSON.stringify(WORKSPACE))]);
  });

  it('adds the dependencies a new server needs first, and fails the card when one cannot be added', async () => {
    const dependency = { name: 'browser', summary: 'a browser', install: { on: 'any', script: 'true' } };
    dependencies.save.mockResolvedValueOnce({ saved: false, problems: ['no script'] });
    await db.engine.saveActionProposal(proposal({ kind: 'add_mcp_server', params: { spec: spec({ template: 'playwright', dependencies: [dependency] }) } }));
    expect(await withServers().apply(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'the dependency browser could not be added: no script' } });
    expect(added).toEqual([]);

    await db.engine.saveActionProposal(proposal({ id: 'a2', kind: 'add_mcp_server', params: { spec: spec({ template: 'playwright', dependencies: [dependency] }) } }));
    expect(await service({ servers, agents }).apply(OWNER, 'a2')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'dependencies cannot be added from here' } });
  });

  it('fails the card naming an agent that is gone, or a server that is', async () => {
    await db.engine.saveActionProposal(proposal({ kind: 'add_mcp_server', params: { spec: spec({ template: 'playwright', agents: ['ghost'] }) } }));
    expect(await withServers().apply(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'there is no agent called ghost any more' } });
    await db.engine.saveActionProposal(proposal({ id: 'a2', kind: 'add_mcp_server', params: { spec: spec({ server: 'vanished', agents: ['planner'] }) } }));
    expect(await withServers().apply(OWNER, 'a2')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'there is no MCP server called vanished any more' } });
  });

  it('follows what it started until the tools are captured and every image is built', async () => {
    await db.engine.saveActionProposal(proposal({ kind: 'add_mcp_server', params: { spec: spec({ template: 'playwright', agents: ['executor'] }) } }));
    const cards = withServers();
    await cards.apply(OWNER, 'a1');

    expect(await cards.progress(OWNER, 'a1')).toEqual({
      steps: [
        { label: 'Added playwright', state: 'done' },
        { label: 'Capturing its tools', state: 'running' },
        { label: 'Building executor\'s image', state: 'running' },
      ],
      done: false,
      server: { id: 'pw-id', name: 'playwright' },
    });

    const record = records.find((entry) => entry.id === 'pw-id')!;
    delete record.capturing;
    record.captured = { ...captured, fingerprint: runsFingerprint(WORKSPACE) };
    images.executor = { state: 'ready' };
    expect(await cards.progress(OWNER, 'a1')).toMatchObject({ done: true, ready: 'playwright is ready for executor', steps: [{ state: 'done' }, { label: 'Captured its tools', state: 'done', detail: '2, 2 offered' }, { label: 'executor\'s image is built', state: 'done' }] });
  });

  it('gives a server the person has without adding anything, and fails with the reason when it cannot add one', async () => {
    await db.engine.saveActionProposal(proposal({ kind: 'add_mcp_server', params: { spec: spec({ server: 'docs', name: 'docs', agents: ['planner', 'executor'] }) } }));
    expect(await withServers().apply(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { status: 'applied', result: 'given to planner', started: { server: { id: 'docs-id', added: false } } } });
    expect(added).toEqual([]);

    await db.engine.saveActionProposal(proposal({ id: 'a2', kind: 'add_mcp_server', params: { spec: spec({ server: 'docs', name: 'docs', agents: ['planner'] }) } }));
    expect(await withServers().apply(OWNER, 'a2')).toMatchObject({ ok: true, proposal: { status: 'applied', result: 'docs was already held by everyone named' } });

    await db.engine.saveActionProposal(proposal({ id: 'a3', kind: 'add_mcp_server', params: { spec: spec({ template: 'nothing' }) } }));
    expect(await withServers().apply(OWNER, 'a3')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'there is no known server called "nothing"' } });
    expect(await withServers().progress(OWNER, 'a3')).toBeUndefined();
  });

  it('follows nothing for a card that started nothing, or where servers are not kept', async () => {
    await db.engine.saveActionProposal(proposal());
    expect(await withServers().progress(OWNER, 'a1')).toBeUndefined();
    await db.engine.saveActionProposal(proposal({ id: 'a2', started: { server: { id: 'pw-id', name: 'playwright', added: true } } }));
    expect(await service().progress(OWNER, 'a2')).toBeUndefined();
    expect(await withServers().progress(OWNER, 'missing')).toBeUndefined();
  });
});

describe('a card changing how builds are released', () => {
  let releases: ReturnType<typeof mock<Pick<ReleaseSettings, 'setForType' | 'setForProject'>>>;

  beforeEach(() => {
    releases = mock<Pick<ReleaseSettings, 'setForType' | 'setForProject'>>();
  });

  it('changes how a project\'s builds are released only when applied, and clears it the same way', async () => {
    releases.setForProject.mockResolvedValue({ ok: true, value: { how: { agent: 'release', app: 'odoo' }, from: 'project' } });
    await db.engine.saveActionProposal(proposal({ kind: 'set_release', params: { target: 'project', id: 'p1', agent: 'release', app: 'odoo' } }));
    expect(releases.setForProject).not.toHaveBeenCalled();
    expect(await service({ releases }).apply(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { status: 'applied', result: 'builds are released by the release agent with the odoo adapter from the next build' } });
    expect(releases.setForProject).toHaveBeenCalledWith(OWNER, 'p1', { agent: 'release', app: 'odoo' });

    await db.engine.saveActionProposal(proposal({ id: 'a2', kind: 'set_release', params: { target: 'project', id: 'p1', clear: 'true' } }));
    expect(await service({ releases }).apply(OWNER, 'a2')).toMatchObject({ ok: true, proposal: { result: 'the setting is cleared; the next build is released the default way' } });
    expect(releases.setForProject).toHaveBeenLastCalledWith(OWNER, 'p1', undefined);
  });

  it('sets a tree type\'s release, not a project\'s, when the card is about the type', async () => {
    releases.setForType.mockResolvedValue({ ok: false, status: 404, error: 'there is no tree type odoo' });
    await db.engine.saveActionProposal(proposal({ kind: 'set_release', params: { target: 'treeType', id: 'odoo', agent: 'release-replace' } }));
    expect(await service({ releases }).apply(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'there is no tree type odoo' } });
    expect(releases.setForType).toHaveBeenCalledWith(OWNER, 'odoo', { agent: 'release-replace' });
    expect(releases.setForProject).not.toHaveBeenCalled();
  });

  it('fails a card whose release no longer fits, saying why, and one where releases cannot be changed', async () => {
    releases.setForProject.mockResolvedValue({ ok: false, status: 400, error: 'release releases beside the live app, so it needs the app\'s adapter (odoo)' });
    await db.engine.saveActionProposal(proposal({ kind: 'set_release', params: { target: 'project', id: 'p1', agent: 'release' } }));
    expect(await service({ releases }).apply(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'release releases beside the live app, so it needs the app\'s adapter (odoo)' } });
    await db.engine.saveActionProposal(proposal({ id: 'a2', kind: 'set_release', params: { target: 'project', id: 'p1', agent: 'release' } }));
    expect(await service().apply(OWNER, 'a2')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'release settings cannot be changed here' } });
  });
});

describe('a card choosing a tree\'s model', () => {
  let treeModels: ReturnType<typeof mock<Pick<TreeModelsService, 'set'>>>;

  beforeEach(() => {
    treeModels = mock<Pick<TreeModelsService, 'set'>>();
  });

  it('sets the agent\'s model for the tree, clears it, and fails one the tree\'s models refuse', async () => {
    treeModels.set.calledWith(OWNER, 't1', matches((body) => JSON.stringify(body) === JSON.stringify({ agent: 'executor', modelId: 'vllm' }))).mockResolvedValue({ ok: true, value: { rows: [] } });
    treeModels.set.calledWith(OWNER, 't1', matches((body) => JSON.stringify(body) === JSON.stringify({ agent: 'executor', modelId: null }))).mockResolvedValue({ ok: true, value: { rows: [] } });
    treeModels.set.calledWith(OWNER, 't1', matches((body) => JSON.stringify(body) === JSON.stringify({ agent: 'executor', modelId: 'gone' }))).mockResolvedValue({ ok: false, status: 400, error: 'There is no model gone among yours' });

    await db.engine.saveActionProposal(proposal({ kind: 'set_tree_model', params: { treeId: 't1', agent: 'executor', modelId: 'vllm' } }));
    expect(treeModels.set).not.toHaveBeenCalled();
    expect(await service({ treeModels }).apply(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { status: 'applied', result: 'executor works on vllm in this tree from its next run' } });

    await db.engine.saveActionProposal(proposal({ id: 'a2', kind: 'set_tree_model', params: { treeId: 't1', agent: 'executor', clear: 'true' } }));
    expect(await service({ treeModels }).apply(OWNER, 'a2')).toMatchObject({ ok: true, proposal: { status: 'applied', result: 'executor is back on its own model in this tree' } });

    await db.engine.saveActionProposal(proposal({ id: 'a3', kind: 'set_tree_model', params: { treeId: 't1', agent: 'executor', modelId: 'gone' } }));
    expect(await service({ treeModels }).apply(OWNER, 'a3')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'There is no model gone among yours' } });
    await db.engine.saveActionProposal(proposal({ id: 'a4', kind: 'set_tree_model', params: { treeId: 't1', agent: 'executor', modelId: 'vllm' } }));
    expect(await service().apply(OWNER, 'a4')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'a tree\'s models cannot be changed here' } });
  });
});

describe('a card setting an alert', () => {
  let alerts: ReturnType<typeof mock<ActionAlerts>>;

  beforeEach(() => {
    alerts = mock<ActionAlerts>();
    alerts.add.mockResolvedValue({ summary: 'Books: Books takes over 1.5 s to answer for 10 minutes' });
  });

  it('sets the alert when applied, in the conversation it was proposed in', async () => {
    await db.engine.saveActionProposal(proposal({ kind: 'set_alert', conversationId: 'conv-1', params: { deploymentId: 'books', kind: 'slow', threshold: '1.5', forMinutes: '10' } }));
    expect(await service({ alerts }).apply(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { status: 'applied', result: 'set: Books: Books takes over 1.5 s to answer for 10 minutes' } });
    expect(alerts.add).toHaveBeenCalledWith(OWNER, 'books', matches((alert) => (alert as { kind?: string; threshold?: number; forMinutes?: number }).kind === 'slow' && (alert as { threshold?: number }).threshold === 1.5 && (alert as { forMinutes?: number }).forMinutes === 10), 'conv-1');
  });

  it('removes one, and fails a card whose threshold is out of range, whose kind is unknown or where alerts cannot be set', async () => {
    await db.engine.saveActionProposal(proposal({ kind: 'set_alert', params: { remove: 'r1' } }));
    expect(await service({ alerts }).apply(OWNER, 'a1')).toMatchObject({ ok: true, proposal: { result: 'the alert is removed' } });
    expect(alerts.remove).toHaveBeenCalledWith(OWNER, 'r1');

    await db.engine.saveActionProposal(proposal({ id: 'a2', kind: 'set_alert', params: { deploymentId: 'books', kind: 'memory', threshold: '500', forMinutes: '5' } }));
    expect(await service({ alerts }).apply(OWNER, 'a2')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'the threshold for "memory" is in % of its limit, between 10 and 100' } });

    await db.engine.saveActionProposal(proposal({ id: 'a3', kind: 'set_alert', params: { deploymentId: 'books', kind: 'sparkles' } }));
    expect(await service({ alerts }).apply(OWNER, 'a3')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'there is no alert of kind sparkles' } });

    await db.engine.saveActionProposal(proposal({ id: 'a4', kind: 'set_alert', params: { remove: 'r1' } }));
    expect(await service().apply(OWNER, 'a4')).toMatchObject({ ok: true, proposal: { status: 'failed', reason: 'alerts cannot be set here' } });
  });
});
