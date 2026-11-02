import { describe, expect, it, vi } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { Server as SocketServer } from 'socket.io';
import { encryptValue, type ClusterMetadata, type Principal } from '../../platform/index.js';
import type { GiteaService } from '../../projects/index.js';
import { ProvisionRefused } from '../lib/cluster-topology.js';
import type { AppService } from '../services/AppService.js';
import type { ClusterProxyService } from '../services/ClusterProxyService.js';
import type { ClusterService } from '../services/ClusterService.js';
import type { InfisicalService } from '../services/InfisicalService.js';
import type { InfrastructureService } from '../services/InfrastructureService.js';
import type { TemporalBridge, WorkflowDeal } from '../services/TemporalBridge.js';
import type { InfrastructureStore } from '../store.js';
import { clustersRouter } from './clusters.js';
import { callRouter, OPERATOR, PERSON, type CallingUser } from '../testing/call-router.js';

const KEY = 'clusters-route-test-key';
const cluster = (over: Partial<ClusterMetadata> = {}): ClusterMetadata => ({ id: 'c1', name: 'lab', provider: 'k3d', status: 'healthy', ownerId: PERSON.id, ...over }) as ClusterMetadata;
const systemCluster = (): ClusterMetadata => ({ id: 'provisioning-lunorica', name: 'system', provider: 'k3d', status: 'healthy', isSystem: true }) as ClusterMetadata;
const deal = (id: string, resourceId?: string): WorkflowDeal => ({ id, event: 'x', ...(resourceId ? { resourceId } : {}) });
const by = (user: CallingUser) => matches<Principal>((who) => who.id === user.id);

function setup() {
  const clusterService = mock<ClusterService>();
  const appService = mock<Pick<AppService, 'discoverDeployments'>>();
  const clusterProxyService = mock<Pick<ClusterProxyService, 'ensurePortForward' | 'stopForCluster' | 'getAutoLoginCookies'>>();
  const giteaService = mock<GiteaService>();
  const infisicalService = mock<InfisicalService>();
  const infraService = mock<Pick<InfrastructureService, 'runKubectl'>>();
  const temporalBridge = mock<TemporalBridge>();
  const db = mock<Pick<InfrastructureStore, 'getClusters' | 'deleteCluster'>>();
  const generateKeypair = vi.fn(async () => ({ privateKey: 'PRIVATE', publicKey: 'ssh-ed25519 AAAA koala\n' }));
  const router = clustersRouter({
    clusterService, appService, clusterProxyService, giteaService, infisicalService, infraService, temporalBridge, db,
    io: mock<SocketServer>(), dataKey: KEY, generateKeypair,
  });
  const call = (path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown, user?: CallingUser) =>
    callRouter(router, '/api/clusters', { path, method, ...(body !== undefined ? { body } : {}), ...(user ? { user } : {}) });
  return { clusterService, appService, clusterProxyService, giteaService, infisicalService, infraService, temporalBridge, db, generateKeypair, call };
}

describe('listing clusters', () => {
  it('lists the clusters the person may see', async () => {
    const { clusterService, call } = setup();
    clusterService.getAll.calledWith(by(PERSON), matches<SocketServer | undefined>(() => true)).mockResolvedValue([cluster()]);
    expect((await call('')).body).toEqual([cluster()]);
  });
});

describe('provisioning a cluster', () => {
  it('starts provisioning and answers 202 with its workflow', async () => {
    const { temporalBridge, call } = setup();
    temporalBridge.provision.calledWith('lab', 'k3d', PERSON.id, undefined, undefined).mockResolvedValue(deal('w1', 'c1'));
    const answer = await call('', 'POST', { name: 'lab', provider: 'k3d' });
    expect(answer.status).toBe(202);
    expect(answer.body).toEqual({ message: 'Provisioning started', clusterName: 'lab', provider: 'k3d', id: 'c1', workflowId: 'w1', state: 'running' });
  });

  it('hands a VM provider the server type, location and image asked for', async () => {
    const { temporalBridge, call } = setup();
    temporalBridge.provision.calledWith('vm', 'hetzner', PERSON.id, undefined, matches<{ serverType?: string; location?: string; image?: string }>((vm) => vm.serverType === 'cx22' && vm.location === 'fsn1' && vm.image === 'ubuntu-24.04')).mockResolvedValue(deal('w2', 'c2'));
    const answer = await call('', 'POST', { name: 'vm', provider: 'hetzner', hetznerServerType: 'cx22', hetznerLocation: 'fsn1', hetznerImage: 'ubuntu-24.04' });
    expect(answer.status).toBe(202);
  });

  it('refuses a name that is not a cluster name, with a suggestion when there is one', async () => {
    const { call } = setup();
    const answer = await call('', 'POST', { name: 'My Lab', provider: 'k3d' });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ error: 'Cluster names cannot contain spaces.', suggestion: 'my-lab' });
  });

  it('refuses a provider Koala does not make clusters on', async () => {
    const { temporalBridge, call } = setup();
    const answer = await call('', 'POST', { name: 'lab', provider: 'nonsense' });
    expect(answer.status).toBe(400);
    expect(temporalBridge.provision).not.toHaveBeenCalled();
  });

  it('answers 400 with the reason when the provider is refused as not available yet', async () => {
    const { temporalBridge, call } = setup();
    temporalBridge.provision.mockRejectedValue(new ProvisionRefused('aws is not available yet'));
    const answer = await call('', 'POST', { name: 'lab', provider: 'aws' });
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: 'aws is not available yet' });
  });

  it('answers 503 when Temporal cannot provision', async () => {
    const { temporalBridge, call } = setup();
    temporalBridge.provision.mockRejectedValue(new Error('no worker'));
    const answer = await call('', 'POST', { name: 'lab', provider: 'k3d' });
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ error: 'Temporal cluster provisioning unavailable: no worker' });
  });

  it('asks for a host and a user when a machine is added', async () => {
    const { call } = setup();
    const answer = await call('', 'POST', { name: 'box', provider: 'remote', remoteHost: '10.0.0.5' });
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: 'remoteHost and remoteUsername are required for provider "remote"' });
  });

  it('makes a key for a machine added without one and waits for the person to authorise it', async () => {
    const { clusterService, generateKeypair, call } = setup();
    clusterService.createAwaitingKey.mockResolvedValue({ id: 'c7' } as ClusterMetadata);
    const answer = await call('', 'POST', { name: 'box', provider: 'remote', remoteHost: '10.0.0.5', remoteUsername: 'ubuntu', remoteSshPort: 2222 });
    expect(generateKeypair).toHaveBeenCalledWith('nowrinkles-box');
    expect(clusterService.createAwaitingKey).toHaveBeenCalledWith({ name: 'box', ownerId: PERSON.id, host: '10.0.0.5', username: 'ubuntu', privateKey: 'PRIVATE', port: 2222 });
    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ id: 'c7', status: 'awaiting-key', publicKey: 'ssh-ed25519 AAAA koala', message: 'Authorise this key on the machine, then start provisioning.' });
  });

  it('provisions a machine straight away when its key came with it', async () => {
    const { temporalBridge, clusterService, call } = setup();
    temporalBridge.provision.mockResolvedValue(deal('w3', 'c8'));
    const answer = await call('', 'POST', { name: 'box', provider: 'remote', remoteHost: '10.0.0.5', remoteUsername: 'ubuntu', remoteSshPrivateKey: 'KEY' });
    expect(answer.status).toBe(202);
    expect(clusterService.createAwaitingKey).not.toHaveBeenCalled();
    expect(temporalBridge.provision).toHaveBeenCalledWith('box', 'remote', PERSON.id, { host: '10.0.0.5', username: 'ubuntu', privateKey: 'KEY' }, undefined);
  });
});

describe('starting a machine that was waiting for its key', () => {
  const waiting = (over: Partial<ClusterMetadata> = {}) => cluster({ status: 'awaiting-key', provider: 'remote', remoteHost: '10.0.0.5', remoteUsername: 'ubuntu', remoteSshPrivateKeyEnc: encryptValue('SECRET-KEY', KEY), ...over });

  it('provisions it with the key it kept and removes the waiting record', async () => {
    const { clusterService, temporalBridge, db, call } = setup();
    clusterService.getById.calledWith('c1', by(PERSON), 'change').mockResolvedValue(waiting({ remoteSshPort: 2222 }));
    temporalBridge.provision.mockResolvedValue(deal('w4', 'c9'));
    const answer = await call('/c1/start', 'POST');
    expect(answer.status).toBe(202);
    expect(answer.body).toEqual({ message: 'Provisioning started', id: 'c9', workflowId: 'w4' });
    expect(temporalBridge.provision).toHaveBeenCalledWith('lab', 'remote', PERSON.id, { host: '10.0.0.5', username: 'ubuntu', privateKey: 'SECRET-KEY', port: 2222 });
    expect(db.deleteCluster).toHaveBeenCalledWith('c1');
  });

  it('says the cluster is not found, is not waiting, or lacks its details', async () => {
    const { clusterService, call } = setup();
    expect((await call('/c1/start', 'POST')).status).toBe(404);
    clusterService.getById.mockResolvedValue(cluster({ status: 'healthy' }));
    const notWaiting = await call('/c1/start', 'POST');
    expect(notWaiting.status).toBe(409);
    expect(notWaiting.body).toEqual({ error: 'Cluster "lab" is healthy, not awaiting a key.' });
    const { remoteHost: _host, ...withoutHost } = waiting();
    clusterService.getById.mockResolvedValue(withoutHost);
    expect((await call('/c1/start', 'POST')).status).toBe(400);
  });

  it('answers 500 with the reason when provisioning cannot start', async () => {
    const { clusterService, temporalBridge, call } = setup();
    clusterService.getById.mockResolvedValue(waiting());
    temporalBridge.provision.mockRejectedValue(new Error('no worker'));
    const answer = await call('/c1/start', 'POST');
    expect(answer.status).toBe(500);
    expect(answer.body).toEqual({ error: 'no worker' });
  });
});

describe('destroying a cluster', () => {
  it('starts the destroy workflow, stopping the dashboard proxies first', async () => {
    const { clusterService, clusterProxyService, temporalBridge, call } = setup();
    clusterService.getById.mockResolvedValue(cluster());
    temporalBridge.destroyCluster.calledWith('c1').mockResolvedValue(deal('w5'));
    const answer = await call('/c1', 'DELETE');
    expect(clusterProxyService.stopForCluster).toHaveBeenCalledWith('c1');
    expect(answer.status).toBe(202);
    expect(answer.body).toEqual({ message: 'Destroying cluster', clusterId: 'c1', workflowId: 'w5', state: 'running' });
  });

  it('aborts a cluster that is still provisioning', async () => {
    const { clusterService, temporalBridge, call } = setup();
    clusterService.getById.mockResolvedValue(cluster({ status: 'provisioning' }));
    expect((await call('/c1', 'DELETE')).body).toEqual({ success: true, message: 'Cluster provisioning aborted' });
    expect(clusterService.abort).toHaveBeenCalledWith('c1', matches<Principal>((who) => who.id === PERSON.id), expect.anything());
    expect(temporalBridge.destroyCluster).not.toHaveBeenCalled();
  });

  it('says the cluster is not found, and refuses the system cluster to everyone', async () => {
    const { clusterService, call } = setup();
    expect((await call('/c1', 'DELETE')).status).toBe(404);
    clusterService.getById.mockResolvedValue(systemCluster());
    const refused = await call('/provisioning-lunorica', 'DELETE', undefined, OPERATOR);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
  });

  it('deletes the record when Temporal cannot be asked, and says both reasons when that fails too', async () => {
    const { clusterService, temporalBridge, call } = setup();
    clusterService.getById.mockResolvedValue(cluster());
    temporalBridge.destroyCluster.mockRejectedValue(new Error('no worker'));
    expect((await call('/c1', 'DELETE')).body).toEqual({ success: true, message: 'Cluster deleted' });
    clusterService.abort.mockRejectedValue(new Error('database down'));
    const both = await call('/c1', 'DELETE');
    expect(both.status).toBe(503);
    expect(both.body).toEqual({ error: 'Cluster destruction unavailable: no worker; deleting its record failed too: database down' });
  });
});

describe('discovering', () => {
  it('lets only the operator adopt the host\'s clusters', async () => {
    const { clusterService, call } = setup();
    clusterService.discoverClusters.calledWith(OPERATOR.id).mockResolvedValue([cluster({ status: 'discovered' })]);
    expect((await call('/discover', 'POST', {})).status).toBe(403);
    expect((await call('/discover', 'POST', {}, OPERATOR)).body).toEqual({ clusters: [cluster({ status: 'discovered' })] });
    clusterService.discoverClusters.mockRejectedValue(new Error('k3d not found'));
    expect((await call('/discover', 'POST', {}, OPERATOR)).body).toEqual({ error: 'k3d not found' });
  });

  it('discovers the deployments on a cluster the person may see', async () => {
    const { clusterService, appService, call } = setup();
    expect((await call('/c1/discover-deployments', 'POST')).status).toBe(404);
    clusterService.getById.calledWith('c1', by(PERSON), 'see-everything').mockResolvedValue(cluster());
    appService.discoverDeployments.calledWith('c1', by(PERSON)).mockResolvedValue([]);
    expect((await call('/c1/discover-deployments', 'POST')).body).toEqual({ deployments: [] });
    appService.discoverDeployments.mockRejectedValue(new Error('no kubectl'));
    expect((await call('/c1/discover-deployments', 'POST')).status).toBe(500);
  });

  it('reports the GPUs of a cluster the person may see', async () => {
    const { clusterService, call } = setup();
    expect((await call('/c1/gpu-status')).status).toBe(404);
    clusterService.getById.calledWith('c1', by(PERSON), 'see-everything').mockResolvedValue(cluster());
    clusterService.getGpuStatus.calledWith('c1', by(PERSON)).mockResolvedValue({ gpus: 1 } as never);
    expect((await call('/c1/gpu-status')).body).toEqual({ gpus: 1 });
  });
});

describe('opening a cluster\'s dashboards', () => {
  const seen = () => {
    const parts = setup();
    parts.clusterService.getById.calledWith('provisioning-lunorica', by(OPERATOR), 'see-everything').mockResolvedValue(systemCluster());
    parts.clusterService.getKubeconfigPath.mockResolvedValue('/tmp/kubeconfig-system');
    parts.clusterProxyService.ensurePortForward.mockResolvedValue('http://127.0.0.1:4000');
    return parts;
  };

  it('says the cluster is not found to someone who may not see it', async () => {
    const { call } = seen();
    expect((await call('/provisioning-lunorica/proxy/prometheus')).status).toBe(404);
  });

  it('wraps a dashboard that has no sign-in in a frame', async () => {
    const { call } = seen();
    const answer = await call('/provisioning-lunorica/proxy/prometheus', 'GET', undefined, OPERATOR);
    expect(answer.headers['content-type']).toMatch(/text\/html/);
    expect(answer.text).toContain('<iframe src="http://127.0.0.1:4000"');
  });

  it('signs in as the platform\'s Gitea admin on the system cluster and redirects to it', async () => {
    const { giteaService, clusterProxyService, call } = seen();
    giteaService.getAdminCredentials.mockResolvedValue({ username: 'root', password: 'pw' });
    clusterProxyService.getAutoLoginCookies.calledWith('gitea', 'http://127.0.0.1:4000', matches<{ username: string; password: string }>((credentials) => credentials.password === 'pw')).mockResolvedValue(['session=abc; Path=/']);
    const answer = await call('/provisioning-lunorica/proxy/gitea', 'GET', undefined, OPERATOR);
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe('http://127.0.0.1:4000');
    expect(answer.headers['set-cookie']).toBe('session=abc; Path=/');
  });

  it('reads Grafana\'s admin password from the cluster and Infisical\'s from its service', async () => {
    const { infraService, infisicalService, clusterProxyService, call } = seen();
    infraService.runKubectl.mockResolvedValue(`${Buffer.from('grafana-pw').toString('base64')}\n`);
    infisicalService.getAdminCredentials.mockResolvedValue({ username: 'a@b.c', password: 'infisical-pw' } as never);
    clusterProxyService.getAutoLoginCookies.mockResolvedValue([]);
    await call('/provisioning-lunorica/proxy/grafana', 'GET', undefined, OPERATOR);
    expect(clusterProxyService.getAutoLoginCookies).toHaveBeenLastCalledWith('grafana', 'http://127.0.0.1:4000', { username: 'admin', password: 'grafana-pw' });
    await call('/provisioning-lunorica/proxy/infisical', 'GET', undefined, OPERATOR);
    expect(clusterProxyService.getAutoLoginCookies).toHaveBeenLastCalledWith('infisical', 'http://127.0.0.1:4000', { username: 'a@b.c', password: 'infisical-pw' });
  });

  it('falls back to the manual login when the automatic one fails', async () => {
    const { giteaService, call } = seen();
    giteaService.getAdminCredentials.mockRejectedValue(new Error('no admin'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const answer = await call('/provisioning-lunorica/proxy/gitea', 'GET', undefined, OPERATOR);
    warn.mockRestore();
    expect(answer.status).toBe(302);
    expect(answer.headers['set-cookie']).toBeUndefined();
  });

  it('answers 502 with the reason when the dashboard cannot be reached', async () => {
    const { clusterProxyService, call } = seen();
    clusterProxyService.ensurePortForward.mockRejectedValue(new Error('port-forward died'));
    const answer = await call('/provisioning-lunorica/proxy/prometheus', 'GET', undefined, OPERATOR);
    expect(answer.status).toBe(502);
    expect(answer.body).toEqual({ error: 'Service unavailable: port-forward died' });
  });
});
