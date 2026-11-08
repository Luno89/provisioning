import { describe, expect, it, vi } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { ClusterMetadata, Principal } from '../../platform/index.js';
import type { GiteaService } from '../../projects/index.js';
import type { ClusterProxyService } from '../services/ClusterProxyService.js';
import type { ClusterService } from '../services/ClusterService.js';
import type { InfisicalService } from '../services/InfisicalService.js';
import type { ClusterAccess } from '../services/ClusterAccess.js';
import { clustersRouter } from './clusters.js';
import type { HarnessUser } from '../../platform/routes/test-harness.js';
import { OPERATOR, PERSON, routesInProcess } from '../../platform/testing/routes.js';

const cluster = (over: Partial<ClusterMetadata> = {}): ClusterMetadata => ({ id: 'c1', name: 'lab', provider: 'machine', machineId: 'lab', status: 'healthy', ownerId: PERSON.id, ...over });
const koalasCluster = (): ClusterMetadata => ({ id: 'machine-koala', name: 'koala', provider: 'machine', machineId: 'koala', status: 'healthy', ownerId: OPERATOR.id }) as ClusterMetadata;
const by = (user: HarnessUser) => matches<Principal>((who) => who.id === user.id);

function setup() {
  const clusterService = mock<ClusterService>();
  const clusterProxyService = mock<Pick<ClusterProxyService, 'ensurePortForward' | 'getAutoLoginCookies'>>();
  const giteaService = mock<GiteaService>();
  const infisicalService = mock<InfisicalService>();
  const access = mock<Pick<ClusterAccess, 'kubectl'>>();
  const router = clustersRouter({ clusterService, clusterProxyService, giteaService, infisicalService, access });
  const call = (path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown, user?: HarnessUser) =>
    routesInProcess({ prefix: '/api/clusters', router: () => router, user: PERSON }).then((routes) => routes.request(method, `/api/clusters${path}`, { ...(body !== undefined ? { body } : {}), ...(user ? { user } : {}) }));
  return { clusterService, clusterProxyService, giteaService, infisicalService, access, call };
}

describe('listing clusters', () => {
  it('lists the clusters the person may see, in the order the service gives them, Koala\'s own first', async () => {
    const { clusterService, call } = setup();
    clusterService.getAll.calledWith(by(PERSON)).mockResolvedValue([koalasCluster(), cluster()]);
    expect((await call('')).data).toEqual([koalasCluster(), cluster()]);
  });
});

describe('what Koala no longer does', () => {
  it('makes no cluster and destroys none: POST and DELETE are not routes, and nothing is asked of the clusters', async () => {
    const { clusterService, call } = setup();
    expect((await call('', 'POST', { name: 'lab', provider: 'k3d' })).status).toBe(404);
    expect((await call('/c1', 'DELETE')).status).toBe(404);
    expect(clusterService.getById).not.toHaveBeenCalled();
  });
});

describe('opening a cluster\'s dashboards', () => {
  const seen = () => {
    const parts = setup();
    parts.clusterService.getById.calledWith('machine-koala', by(OPERATOR), 'see-everything').mockResolvedValue(koalasCluster());
    parts.clusterService.isKoalasCluster.calledWith('machine-koala').mockReturnValue(true);
    parts.clusterProxyService.ensurePortForward.calledWith('machine-koala', matches(() => true)).mockResolvedValue('http://127.0.0.1:4000');
    return parts;
  };

  it('says the cluster is not found to someone who may not see it', async () => {
    const { call } = seen();
    expect((await call('/machine-koala/proxy/prometheus')).status).toBe(404);
  });

  it('wraps a dashboard that has no sign-in in a frame', async () => {
    const { call } = seen();
    const answer = await call('/machine-koala/proxy/prometheus', 'GET', undefined, OPERATOR);
    expect(answer.headers['content-type']).toMatch(/text\/html/);
    expect(answer.text).toContain('<iframe src="http://127.0.0.1:4000"');
  });

  it('signs in as the platform\'s Gitea admin on the cluster Koala runs in and redirects to it', async () => {
    const { giteaService, clusterProxyService, call } = seen();
    giteaService.getAdminCredentials.mockResolvedValue({ username: 'root', password: 'pw' });
    clusterProxyService.getAutoLoginCookies.calledWith('gitea', 'http://127.0.0.1:4000', matches<{ username: string; password: string }>((credentials) => credentials.password === 'pw')).mockResolvedValue(['session=abc; Path=/']);
    const answer = await call('/machine-koala/proxy/gitea', 'GET', undefined, OPERATOR);
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe('http://127.0.0.1:4000');
    expect(answer.headers['set-cookie']).toBe('session=abc; Path=/');
  });

  it('signs in to Gitea on no cluster but the one Koala runs in, and still opens it', async () => {
    const { clusterService, giteaService, clusterProxyService, call } = setup();
    clusterService.getById.calledWith('c1', by(PERSON), 'see-everything').mockResolvedValue(cluster());
    clusterService.isKoalasCluster.calledWith('c1').mockReturnValue(false);
    clusterProxyService.ensurePortForward.calledWith('c1', matches(() => true)).mockResolvedValue('http://127.0.0.1:4100');
    const answer = await call('/c1/proxy/gitea');
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe('http://127.0.0.1:4100');
    expect(giteaService.getAdminCredentials).not.toHaveBeenCalled();
    expect(clusterProxyService.getAutoLoginCookies).not.toHaveBeenCalled();
  });

  it('reads Grafana\'s admin password from the cluster and Infisical\'s from its service', async () => {
    const { access, infisicalService, clusterProxyService, call } = seen();
    access.kubectl.calledWith('machine-koala', matches((args: readonly string[]) => args.join(' ') === 'get secret kube-prometheus-stack-grafana -n monitoring -o jsonpath={.data.admin-password}')).mockResolvedValue(`${Buffer.from('grafana-pw').toString('base64')}\n`);
    infisicalService.getAdminCredentials.mockResolvedValue({ username: 'a@b.c', password: 'infisical-pw' } as never);
    clusterProxyService.getAutoLoginCookies.mockResolvedValue([]);
    await call('/machine-koala/proxy/grafana', 'GET', undefined, OPERATOR);
    expect(clusterProxyService.getAutoLoginCookies).toHaveBeenLastCalledWith('grafana', 'http://127.0.0.1:4000', { username: 'admin', password: 'grafana-pw' });
    await call('/machine-koala/proxy/infisical', 'GET', undefined, OPERATOR);
    expect(clusterProxyService.getAutoLoginCookies).toHaveBeenLastCalledWith('infisical', 'http://127.0.0.1:4000', { username: 'a@b.c', password: 'infisical-pw' });
  });

  it('falls back to the manual login when the automatic one fails', async () => {
    const { giteaService, call } = seen();
    giteaService.getAdminCredentials.mockRejectedValue(new Error('no admin'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const answer = await call('/machine-koala/proxy/gitea', 'GET', undefined, OPERATOR);
    warn.mockRestore();
    expect(answer.status).toBe(302);
    expect(answer.headers['set-cookie']).toBeUndefined();
  });

  it('answers 502 with why when the cluster cannot be reached', async () => {
    const { clusterProxyService, call } = seen();
    clusterProxyService.ensurePortForward.mockRejectedValue(new Error('this process is not running inside Koala\'s cluster, so it has no account there to reach it with'));
    const answer = await call('/machine-koala/proxy/prometheus', 'GET', undefined, OPERATOR);
    expect(answer.status).toBe(502);
    expect(answer.data).toEqual({ error: 'Service unavailable: this process is not running inside Koala\'s cluster, so it has no account there to reach it with' });
  });

  it('answers 502 with the reason when the dashboard cannot be reached', async () => {
    const { clusterProxyService, call } = seen();
    clusterProxyService.ensurePortForward.mockRejectedValue(new Error('port-forward died'));
    const answer = await call('/machine-koala/proxy/prometheus', 'GET', undefined, OPERATOR);
    expect(answer.status).toBe(502);
    expect(answer.data).toEqual({ error: 'Service unavailable: port-forward died' });
  });
});
