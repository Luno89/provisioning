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
      appTypes: async () => [{ id: 'qdrant', label: 'Qdrant Vector Database', strategies: ['native'], builtIn: true }, { id: 'nextcloud', strategies: ['helm', 'native'], builtIn: true }],
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
    expect(proposals[0]!.sections).toEqual([
      { parts: [{ kind: 'fields', fields: [{ label: 'Project', value: 'billing' }] }] },
      { title: 'What changes', parts: [{ kind: 'code', code: 'LOG_LEVEL: info → debug\nFEATURE_X=on (new)' }, { kind: 'text', text: 'Takes effect on the next deploy.' }] },
    ]);
    expect(proposals[0]!.detail).toEqual(['Project: billing', 'What changes — LOG_LEVEL: info → debug\nFEATURE_X=on (new)', 'What changes — Takes effect on the next deploy.']);
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

describe('proposing an app spec', () => {
  const spec = { id: 'mongo', image: 'mongo:7', ports: [{ name: 'mongo', port: 27017 }], resources: { limits: { memory: '1Gi', cpu: '1000m' } } };

  it('proposes a valid spec as a card showing what it runs', async () => {
    const { call, proposals } = tools();
    await call('propose_app_spec', { spec });
    expect(proposals[0]).toMatchObject({ kind: 'add_app_spec', summary: 'add the app "mongo" in the catalogue' });
    expect(proposals[0]!.detail).toEqual(expect.arrayContaining(['Image: mongo:7', 'Ports: 27017 (mongo)']));
    expect(JSON.parse(proposals[0]!.params.spec!)).toEqual(spec);
  });

  it('refuses an unsafe spec with every problem, and a built-in id', async () => {
    const { call, proposals } = tools();
    expect((await call('propose_app_spec', { spec: { ...spec, hostNetwork: true } })).digest).toContain('may not reach the node');
    expect((await call('propose_app_spec', { spec: { ...spec, id: 'qdrant' } })).digest).toContain('ships with the platform');
    expect(proposals).toEqual([]);
  });
});

describe('what happened to a project\'s work after it landed', () => {
  const releasing = (deployments: DeploymentMetadata[], releases: { commit: string; slot?: 'a' | 'b'; state: string; startedAt: string; reason?: string; e2e?: { state: string; summary?: string } }[]) => {
    const handlers = createProjectTools({
      stores: {
        projects: { list: async () => [PROJECT] },
        trees: { list: async () => [] },
        runs: async () => RUNS,
        deployments: async () => deployments,
        clusters: async () => CLUSTERS,
        appTypes: async () => [],
        readPath: async () => null,
        bindingCheck: async () => ({ problem: 'none' }),
        proposals: { list: async () => [], save: async () => undefined },
        releases: async () => releases.map((release, i) => ({ id: `r${i}`, ownerId: 'u1', projectId: 'p1', pipelineRunId: 'x', image: 'i:t', host: 'h', updatedAt: 't', ...release }) as never),
      },
    });
    return (name: string) => handlers[name]!({ name, parsed: { projectId: 'p1' }, driver: undefined, caller: { ownerId: 'u1' } });
  };

  it('says what is live, that a preview waits for the person on the card, and how each release\'s browser tests went', async () => {
    const call = releasing([], [
      { commit: 'aaaaaaaa1', slot: 'a', state: 'live', startedAt: '2026-10-09T01:00:00Z', e2e: { state: 'passed', summary: '2 passed, 0 failed' } },
      { commit: 'bbbbbbbb2', slot: 'b', state: 'preview', startedAt: '2026-10-09T02:00:00Z', e2e: { state: 'failed', summary: '1 passed, 1 failed' } },
    ]);
    const out = await call('project_releases');
    expect(out.digest).toBe('billing: live aaaaaaaa, a preview waits');
    expect(out.content).toContain('Live: aaaaaaaa in slot a.');
    expect(out.content).toContain('Waiting for the person: bbbbbbbb is ready to preview in slot b. Cutting over or discarding it is theirs');
    expect(out.content).toContain('- bbbbbbbb in slot b: preview; browser tests failed (1 passed, 1 failed)');
  });

  it('says so when a project has no releases', async () => {
    expect((await releasing([], [])('project_releases')).content).toContain('billing has no releases');
  });

  it('gives an app\'s real addresses, on this machine, publicly and in preview, or says how the person opens it', async () => {
    const app = { id: 'd1', name: 'billing', clusterId: 'c', strategy: 'helm', status: 'running', ownerId: 'u1', gitappProjectId: 'p1' } as DeploymentMetadata;
    expect((await releasing([{ ...app, localExposureUrl: 'http://billing.localhost:8000', previewLocalUrl: 'http://billing-preview.localhost:8000' }], [])('get_project_url')).content)
      .toContain('It is reached on this machine at http://billing.localhost:8000; its preview on this machine at http://billing-preview.localhost:8000.');
    expect((await releasing([app], [])('get_project_url')).content).toContain('It is not exposed yet: the person opens it with "Open app" on the project\'s card');
  });
});
