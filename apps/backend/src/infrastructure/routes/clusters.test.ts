import { describe, expect, it, vi } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { Server as SocketServer } from 'socket.io';
import type { ClusterMetadata, Principal } from '../../platform/index.js';
import type { GiteaService } from '../../projects/index.js';
import { ProvisionRefused } from '../lib/cluster-topology.js';
import type { ClusterProxyService } from '../services/ClusterProxyService.js';
import type { ClusterService } from '../services/ClusterService.js';
import type { InfisicalService } from '../services/InfisicalService.js';
import type { ClusterAccess } from '../services/ClusterAccess.js';
import type { ResourceDeal, TemporalBridge, WorkflowDeal } from '../services/TemporalBridge.js';
import { clustersRouter } from './clusters.js';
import type { HarnessUser } from '../../platform/routes/test-harness.js';
import { OPERATOR, PERSON, routesInProcess } from '../../platform/testing/routes.js';

const cluster = (over: Partial<ClusterMetadata> = {}): ClusterMetadata => ({ id: 'c1', name: 'lab', provider: 'k3d', status: 'healthy', ownerId: PERSON.id, ...over }) as ClusterMetadata;
const systemCluster = (): ClusterMetadata => ({ id: 'provisioning-lunorica', name: 'system', provider: 'k3d', status: 'healthy', isSystem: true }) as ClusterMetadata;
const deal = (id: string): WorkflowDeal => ({ id, event: 'x' });
const started = (id: string, resourceId: string): ResourceDeal => ({ id, event: 'x', resourceId });
const by = (user: HarnessUser) => matches<Principal>((who) => who.id === user.id);

function setup() {
  const clusterService = mock<ClusterService>();
  const clusterProxyService = mock<Pick<ClusterProxyService, 'ensurePortForward' | 'stopForCluster' | 'getAutoLoginCookies'>>();
  const giteaService = mock<GiteaService>();
  const infisicalService = mock<InfisicalService>();
  const access = mock<Pick<ClusterAccess, 'kubectl' | 'kubeconfigOf'>>();
  const temporalBridge = mock<TemporalBridge>();
  const router = clustersRouter({
    clusterService, clusterProxyService, giteaService, infisicalService, access, temporalBridge,
    io: mock<SocketServer>(),
  });
  const call = (path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown, user?: HarnessUser) =>
    routesInProcess({ prefix: '/api/clusters', router: () => router, user: PERSON }).then((routes) => routes.request(method, `/api/clusters${path}`, { ...(body !== undefined ? { body } : {}), ...(user ? { user } : {}) }));
  return { clusterService, clusterProxyService, giteaService, infisicalService, access, temporalBridge, call };
}

describe('listing clusters', () => {
  it('lists the clusters the person may see', async () => {
    const { clusterService, call } = setup();
    clusterService.getAll.calledWith(by(PERSON), matches<SocketServer | undefined>(() => true)).mockResolvedValue([cluster()]);
    expect((await call('')).data).toEqual([cluster()]);
  });
});

describe('provisioning a cluster', () => {
  it('starts provisioning and answers 202 with its workflow', async () => {
    const { temporalBridge, call } = setup();
    temporalBridge.provision.calledWith('lab', 'k3d', PERSON.id, undefined).mockResolvedValue(started('w1', 'c1'));
    const answer = await call('', 'POST', { name: 'lab', provider: 'k3d' });
    expect(answer.status).toBe(202);
    expect(answer.data).toEqual({ message: 'Provisioning started', clusterName: 'lab', provider: 'k3d', id: 'c1', workflowId: 'w1', state: 'running' });
  });

  it('hands a VM provider the server type, location and image asked for', async () => {
    const { temporalBridge, call } = setup();
    temporalBridge.provision.calledWith('vm', 'hetzner', PERSON.id, matches<{ serverType?: string; location?: string; image?: string }>((vm) => vm.serverType === 'cx22' && vm.location === 'fsn1' && vm.image === 'ubuntu-24.04')).mockResolvedValue(started('w2', 'c2'));
    const answer = await call('', 'POST', { name: 'vm', provider: 'hetzner', hetznerServerType: 'cx22', hetznerLocation: 'fsn1', hetznerImage: 'ubuntu-24.04' });
    expect(answer.status).toBe(202);
  });

  it('refuses a name that is not a cluster name, with a suggestion when there is one', async () => {
    const { call } = setup();
    const answer = await call('', 'POST', { name: 'My Lab', provider: 'k3d' });
    expect(answer.status).toBe(400);
    expect(answer.data).toMatchObject({ error: 'Cluster names cannot contain spaces.', suggestion: 'my-lab' });
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
    expect(answer.data).toEqual({ error: 'aws is not available yet' });
  });

  it('answers 503 when Temporal cannot provision', async () => {
    const { temporalBridge, call } = setup();
    temporalBridge.provision.mockRejectedValue(new Error('no worker'));
    const answer = await call('', 'POST', { name: 'lab', provider: 'k3d' });
    expect(answer.status).toBe(503);
    expect(answer.data).toEqual({ error: 'Temporal cluster provisioning unavailable: no worker' });
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
    expect(answer.data).toEqual({ message: 'Destroying cluster', clusterId: 'c1', workflowId: 'w5', state: 'running' });
  });

  it('aborts a cluster that is still provisioning', async () => {
    const { clusterService, temporalBridge, call } = setup();
    clusterService.getById.mockResolvedValue(cluster({ status: 'provisioning' }));
    expect((await call('/c1', 'DELETE')).data).toEqual({ success: true, message: 'Cluster provisioning aborted' });
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
    expect((await call('/c1', 'DELETE')).data).toEqual({ success: true, message: 'Cluster deleted' });
    clusterService.abort.mockRejectedValue(new Error('database down'));
    const both = await call('/c1', 'DELETE');
    expect(both.status).toBe(503);
    expect(both.data).toEqual({ error: 'Cluster destruction unavailable: no worker; deleting its record failed too: database down' });
  });
});

describe('opening a cluster\'s dashboards', () => {
  const seen = () => {
    const parts = setup();
    parts.clusterService.getById.calledWith('provisioning-lunorica', by(OPERATOR), 'see-everything').mockResolvedValue(systemCluster());
    parts.access.kubeconfigOf.calledWith('provisioning-lunorica').mockResolvedValue('/tmp/kubeconfig-system');
    parts.clusterProxyService.ensurePortForward.calledWith('provisioning-lunorica', matches(() => true), '/tmp/kubeconfig-system').mockResolvedValue('http://127.0.0.1:4000');
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
    const { access, infisicalService, clusterProxyService, call } = seen();
    access.kubectl.calledWith('provisioning-lunorica', matches((args: readonly string[]) => args.join(' ') === 'get secret kube-prometheus-stack-grafana -n monitoring -o jsonpath={.data.admin-password}')).mockResolvedValue(`${Buffer.from('grafana-pw').toString('base64')}\n`);
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

  it('answers 502 with why when the cluster cannot be reached, opening nothing', async () => {
    const { access, clusterProxyService, call } = seen();
    access.kubeconfigOf.calledWith('provisioning-lunorica').mockRejectedValue(new Error('this process is not running inside Koala\'s cluster, so it has no account there to reach it with'));
    const answer = await call('/provisioning-lunorica/proxy/prometheus', 'GET', undefined, OPERATOR);
    expect(answer.status).toBe(502);
    expect(answer.data).toEqual({ error: 'Service unavailable: this process is not running inside Koala\'s cluster, so it has no account there to reach it with' });
    expect(clusterProxyService.ensurePortForward).not.toHaveBeenCalled();
  });

  it('answers 502 with the reason when the dashboard cannot be reached', async () => {
    const { clusterProxyService, call } = seen();
    clusterProxyService.ensurePortForward.mockRejectedValue(new Error('port-forward died'));
    const answer = await call('/provisioning-lunorica/proxy/prometheus', 'GET', undefined, OPERATOR);
    expect(answer.status).toBe(502);
    expect(answer.data).toEqual({ error: 'Service unavailable: port-forward died' });
  });
});
