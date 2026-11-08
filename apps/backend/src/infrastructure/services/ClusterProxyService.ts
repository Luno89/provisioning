import { connect } from 'net';
import { ignore } from '@koala/engine-core/failures';
import type { Followed } from '../../platform/index.js';
import type { ClusterAccess, Target } from './ClusterAccess.js';

interface PortForwardEntry {
  followed: Promise<Followed>;
  ready: Promise<number>;
}

export interface ServiceTarget {
  service: string;
  namespace: string;
  remotePort: number;
  resource?: string;
  dashboardPath?: string;
}

const SERVICE_TARGETS: Record<string, ServiceTarget> = {
  prometheus: {
    service: 'kube-prometheus-stack-prometheus',
    namespace: 'monitoring',
    remotePort: 9090,
  },
  grafana: {
    service: 'kube-prometheus-stack-grafana',
    namespace: 'monitoring',
    remotePort: 80,
  },
  traefik: {
    service: 'traefik',
    namespace: 'traefik',
    remotePort: 8080,
    resource: 'deployment/traefik',
    dashboardPath: '/dashboard/',
  },
  gitea: {
    service: 'gitea-http',
    namespace: 'gitea',
    remotePort: 3000,
  },
  infisical: {
    service: 'infisical-infisical-standalone-infisical',
    namespace: 'infisical',
    remotePort: 8080,
  },
  alertmanager: {
    service: 'kube-prometheus-stack-alertmanager',
    namespace: 'monitoring',
    remotePort: 9093,
  },
  'otel-collector': {
    service: 'otel-collector',
    namespace: 'monitoring',
    remotePort: 4318,
  },
  tempo: {
    service: 'tempo',
    namespace: 'monitoring',
    remotePort: 3200,
  },
};

export const DIRECT_PROBE_MS = 1000;
export const DIRECT_RETRY_MS = 60_000;

export type ProxyAccess = Pick<ClusterAccess, 'kubectl' | 'follow'>;

export type Reachable = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

const following = new Set<Followed>();
let stopping = false;
const stopOnExit = () => {
  if (stopping) return;
  stopping = true;
  process.once('exit', () => { for (const followed of following) followed.stop(); });
};

export const tcpReachable: Reachable = (host, port, timeoutMs) => new Promise((resolve) => {
  const socket = connect({ host, port });
  const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
  socket.setTimeout(timeoutMs, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});

const clusterIdOf = (target: Target): string => (typeof target === 'string' ? target : target.clusterId);

export class ClusterProxyService {
  private forwards: Map<string, Map<string, PortForwardEntry>> = new Map();
  private readonly direct = new Map<string, Promise<string | undefined>>();

  constructor(private readonly access: ProxyAccess, private readonly reachable: Reachable = tcpReachable) {}

  private async clusterIp(cluster: Target, namespace: string, service: string): Promise<string | undefined> {
    const ip = (await this.access.kubectl(cluster, ['-n', namespace, 'get', 'svc', service, '-o', 'jsonpath={.spec.clusterIP}'])).trim();
    return !ip || ip === 'None' ? undefined : ip;
  }

  async directServiceUrl(cluster: Target, serviceKey: string, target: ServiceTarget): Promise<string | undefined> {
    const key = this.key(clusterIdOf(cluster), serviceKey);
    const known = this.direct.get(key);
    if (known) return known;
    const found = (async () => {
      const ip = await this.clusterIp(cluster, target.namespace, target.service);
      if (!ip || !(await this.reachable(ip, target.remotePort, DIRECT_PROBE_MS))) return undefined;
      return `http://${ip}:${target.remotePort}${target.dashboardPath ?? '/'}`;
    })();
    this.direct.set(key, found);
    const settled = await found.catch((err: unknown) => { this.direct.delete(key); throw err; });
    if (!settled) setTimeout(() => { if (this.direct.get(key) === found) this.direct.delete(key); }, DIRECT_RETRY_MS).unref();
    return settled;
  }

  async serviceUrl(cluster: Target, serviceKey: string, explicitTarget?: ServiceTarget): Promise<string> {
    const target = explicitTarget ?? SERVICE_TARGETS[serviceKey];
    if (!target) throw new Error(`Unknown service: ${serviceKey}`);
    return (await this.directServiceUrl(cluster, serviceKey, target))
      ?? this.ensurePortForward(cluster, serviceKey, target);
  }

  private key(clusterId: string, serviceKey: string) {
    return `${clusterId}::${serviceKey}`;
  }

  async ensurePortForward(cluster: Target, serviceKey: string, explicitTarget?: ServiceTarget): Promise<string> {
    const target = explicitTarget ?? SERVICE_TARGETS[serviceKey];
    if (!target) throw new Error(`Unknown service: ${serviceKey}`);
    const clusterId = clusterIdOf(cluster);

    const clusterForwards = this.forwards.get(clusterId) ?? new Map<string, PortForwardEntry>();
    this.forwards.set(clusterId, clusterForwards);

    const existing = clusterForwards.get(serviceKey);
    if (existing) {
      const port = await existing.ready;
      return `http://localhost:${port}${target.dashboardPath ?? '/'}`;
    }

    let resolvePort: (port: number) => void = () => undefined;
    let rejectPort: (err: Error) => void = () => undefined;
    const ready = new Promise<number>((resolve, reject) => {
      resolvePort = resolve;
      rejectPort = reject;
    });
    let resolved = false;
    let printed = '';

    const followed = this.access.follow(cluster, [
      'port-forward',
      '--address', '127.0.0.1',
      '-n', target.namespace,
      target.resource ?? ('svc/' + target.service),
      `0:${target.remotePort}`,
    ], (chunk) => {
      if (resolved) return;
      printed += chunk;
      const match = printed.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
      if (match) {
        resolved = true;
        resolvePort(parseInt(match[1] ?? '0', 10));
      }
    });

    const entry: PortForwardEntry = { followed, ready };
    clusterForwards.set(serviceKey, entry);

    followed.then((running) => {
      following.add(running);
      stopOnExit();
      running.ended.then((result) => {
        following.delete(running);
        if (clusterForwards.get(serviceKey) === entry) clusterForwards.delete(serviceKey);
        if (!resolved) {
          resolved = true;
          rejectPort(new Error(`port-forward exited with code ${result.code}: ${result.stderr.trim() || 'no stderr'}`));
        }
      }, (err: unknown) => {
        following.delete(running);
        if (clusterForwards.get(serviceKey) === entry) clusterForwards.delete(serviceKey);
        if (!resolved) {
          resolved = true;
          rejectPort(err instanceof Error ? err : new Error(String(err)));
        }
      });
    }, (err: unknown) => {
      if (clusterForwards.get(serviceKey) === entry) clusterForwards.delete(serviceKey);
      resolved = true;
      rejectPort(err instanceof Error ? err : new Error(String(err)));
    });

    const port = await ready;
    return `http://localhost:${port}${target.dashboardPath ?? '/'}`;
  }

  async getAutoLoginCookies(
    serviceKey: string,
    targetUrl: string,
    credentials: { username: string; password: string },
  ): Promise<string[]> {
    if (serviceKey === 'grafana') {
      const res = await fetch(`${targetUrl}login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: credentials.username, password: credentials.password }),
      });
      if (!res.ok) throw new Error(`Grafana login failed: HTTP ${res.status}`);
      return res.headers.getSetCookie();
    }

    if (serviceKey === 'gitea') {
      const initial = await fetch(`${targetUrl}user/login`);
      const preAuthCookie = initial.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      const res = await fetch(`${targetUrl}user/login`, {
        method: 'POST',
        redirect: 'manual', // a successful login 303-redirects — don't follow it, just read its Set-Cookie
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: preAuthCookie,
        },
        body: new URLSearchParams({ user_name: credentials.username, password: credentials.password }).toString(),
      });
      if (res.status !== 303) throw new Error(`Gitea login failed: HTTP ${res.status}`);
      return res.headers.getSetCookie();
    }

    if (serviceKey === 'infisical') {
      // Infisical's /api/v1/auth/login returns a JWT in JSON, not a cookie — we set it as a
      // cookie so the browser sends it on the subsequent page load. The cookie name and path
      // match what the Infisical frontend expects.
      const res = await fetch(`${targetUrl}api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: credentials.username, password: credentials.password }),
      });
      if (!res.ok) throw new Error(`Infisical login failed: HTTP ${res.status}`);
      const body = await res.json() as { token?: string };
      if (!body.token) throw new Error('Infisical login returned no token');
      return [`infisical-token=${body.token}; Path=/; HttpOnly; SameSite=Lax`];
    }

    return [];
  }

  stopForCluster(clusterId: string) {
    const clusterForwards = this.forwards.get(clusterId);
    if (!clusterForwards) return;
    for (const [serviceKey, entry] of clusterForwards) {
      void entry.followed.then((running) => running.stop(), ignore('a port-forward that never started has no process to stop'));
      clusterForwards.delete(serviceKey);
    }
    this.forwards.delete(clusterId);
  }

  stopAll() {
    for (const [clusterId] of this.forwards) {
      this.stopForCluster(clusterId);
    }
  }
}

const shared = new WeakMap<ProxyAccess, ClusterProxyService>();

export const sharedClusterProxy = (access: ProxyAccess): ClusterProxyService => {
  const known = shared.get(access);
  if (known) return known;
  const made = new ClusterProxyService(access);
  shared.set(access, made);
  return made;
};
