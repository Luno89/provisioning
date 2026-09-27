import { describe, it, expect } from 'vitest';
import type { ActionProposal } from '../../lib/action-proposals.js';
import type { ClusterMetadata, DeploymentMetadata, PipelineRunMetadata, ProjectMetadata } from '../../lib/types.js';
import { createProjectTools } from './project-tools.js';

const PROJECT: ProjectMetadata = { id: 'p1', name: 'billing', ownerId: 'u1', appType: 'gitapp', giteaOwner: 'koala-u1', giteaRepo: 'billing', targetClusterId: 'provisioning-lunorica', deployEnv: 'LOG_LEVEL=info', createdAt: 'x' };
const RUNS = [
  { id: 'b2', projectId: 'p1', status: 'failed', startedAt: '2026-09-27T02:00:00Z', errorMessage: 'npm ci failed' },
  { id: 'b1', projectId: 'p1', status: 'succeeded', imageTag: 'reg/billing:abc', commitSha: 'abcdef123', startedAt: '2026-09-27T01:00:00Z' },
] as unknown as PipelineRunMetadata[];
const CLUSTERS = [{ id: 'provisioning-lunorica', name: 'provisioning-lunorica', provider: 'k3d', status: 'healthy', isSystem: true }] as ClusterMetadata[];

function tools() {
  const proposals: ActionProposal[] = [];
  let n = 0;
  const handlers = createProjectTools({
    newId: () => `a${++n}`,
    now: () => 't',
    stores: {
      projects: { list: async () => [PROJECT, { ...PROJECT, id: 'p2', name: 'theirs', ownerId: 'u2' }] },
      trees: { list: async () => [] },
      runs: async () => RUNS,
      deployments: async () => [{ name: 'taken', clusterId: 'provisioning-lunorica' }] as DeploymentMetadata[],
      clusters: async () => CLUSTERS,
      appTypes: async () => [{ id: 'qdrant', label: 'Qdrant Vector Database', strategies: ['native'] }, { id: 'nextcloud', strategies: ['helm', 'native'] }],
      readPath: async (_project, path) => ({ path, type: 'file', content: 'hello' }),
      bindingCheck: async (_owner, service) => (service === 'qdrant-1' ? { name: 'qdrant', type: 'vector-db' } : { problem: `no service ${service}` }),
      proposals: { list: async () => proposals, save: async (proposal) => { proposals.push(proposal); } },
    },
  });
  const call = (name: string, parsed: Record<string, unknown>) => handlers[name]!({ name, parsed, driver: undefined, caller: { ownerId: 'u1', conversationId: 'c1' } });
  return { call, proposals };
}

describe('reading a project', () => {
  it('reports the latest build and why it failed', async () => {
    const out = await tools().call('get_project_pipeline', { projectId: 'billing' });
    expect(out.content).toContain('latest build b2: failed');
    expect(out.content).toContain('npm ci failed');
  });

  it('lists plain env, reads a repo path, and refuses someone else\'s project', async () => {
    const { call } = tools();
    expect((await call('get_project_env', { projectId: 'p1' })).content).toContain('LOG_LEVEL=info');
    expect((await call('read_project_path', { projectId: 'p1', path: 'README.md' })).content).toContain('hello');
    expect((await call('get_project_env', { projectId: 'theirs' })).digest).toContain('no such project: theirs — yours are: billing');
  });
});

describe('proposing, never acting', () => {
  it('proposes deploying the latest successful build, once', async () => {
    const { call, proposals } = tools();
    await call('propose_deploy_project', { projectId: 'p1' });
    const again = await call('propose_deploy_project', { projectId: 'p1' });
    expect(again.content).toContain('already waiting');
    expect(proposals).toMatchObject([{ kind: 'deploy_project', params: { projectId: 'p1', runId: 'b1' }, status: 'proposed', conversationId: 'c1' }]);
    expect(proposals[0]!.detail).toContain('Image: reg/billing:abc');
  });

  it('proposes a catalogue app with the strategy it can deploy by, and refuses what cannot be', async () => {
    const { call, proposals } = tools();
    await call('propose_deploy_app', { appType: 'qdrant', name: 'vectors' });
    expect(proposals[0]).toMatchObject({ kind: 'deploy_app', params: { appType: 'qdrant', name: 'vectors', clusterId: 'provisioning-lunorica', strategy: 'native' } });
    expect((await call('propose_deploy_app', { appType: 'mystery', name: 'x' })).digest).toContain('the catalogue has: qdrant, nextcloud');
    expect((await call('propose_deploy_app', { appType: 'qdrant', name: 'taken' })).digest).toContain('already exists');
    expect((await call('propose_deploy_app', { appType: 'qdrant', name: 'v', cluster: 'nope' })).digest).toContain('no cluster called');
  });

  it('proposes env changes as a diff and keeps secrets out', async () => {
    const { call, proposals } = tools();
    await call('propose_project_env', { projectId: 'p1', env: { LOG_LEVEL: 'debug', FEATURE_X: 'on' } });
    expect(proposals[0]!.detail).toEqual(['Project: billing', 'LOG_LEVEL: info → debug', 'FEATURE_X=on (new)', 'Takes effect on the next deploy.']);
    expect(proposals[0]!.params.env).toBe('LOG_LEVEL=debug\nFEATURE_X=on');
    expect((await call('propose_project_env', { projectId: 'p1', env: 'x' })).digest).toContain('never a secret');
    expect((await call('propose_project_env', { projectId: 'p1', env: { LOG_LEVEL: 'debug', FEATURE_X: 'on' } })).content).toContain('already waiting');
  });

  it('proposes a dependency only on a service that can be bound', async () => {
    const { call, proposals } = tools();
    expect((await call('propose_project_dependency', { projectId: 'p1', service: 'nope' })).digest).toContain('no service nope');
    await call('propose_project_dependency', { projectId: 'p1', service: 'qdrant-1' });
    expect(proposals[0]).toMatchObject({ kind: 'add_project_dependency', params: { projectId: 'p1', service: 'qdrant-1' } });
  });
});
