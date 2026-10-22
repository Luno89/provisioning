import { execFile, spawn, type ChildProcess } from 'child_process';
import { connect } from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../../../../');
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');
const KUBECTL = path.join(BIN_DIR, 'kubectl');

interface PortForwardEntry {
  process: ChildProcess;
  localPort: number;
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
};

export const DIRECT_PROBE_MS = 1000;
export const DIRECT_RETRY_MS = 60_000;

const running = new Set<ChildProcess>();
let reaping = false;
const reapOnExit = () => {
  if (reaping) return;
  reaping = true;
  process.once('exit', () => { for (const child of running) child.kill(); });
};

export interface DirectAccess {
  clusterIp(kubeconfigPath: string, namespace: string, service: string): Promise<string | undefined>;
  reachable(host: string, port: number, timeoutMs: number): Promise<boolean>;
}

const kubectlClusterIp: DirectAccess['clusterIp'] = (kubeconfigPath, namespace, service) => new Promise((resolve) => {
  execFile(KUBECTL, ['--kubeconfig', kubeconfigPath, '-n', namespace, 'get', 'svc', service, '-o', 'jsonpath={.spec.clusterIP}'], { timeout: 10_000 }, (err, stdout) => {
    const ip = String(stdout ?? '').trim();
    resolve(err || !ip || ip === 'None' ? undefined : ip);
  });
});

const tcpReachable: DirectAccess['reachable'] = (host, port, timeoutMs) => new Promise((resolve) => {
  const socket = connect({ host, port });
  const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
  socket.setTimeout(timeoutMs, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});

export class ClusterProxyService {
  private forwards: Map<string, Map<string, PortForwardEntry>> = new Map();
  private readonly direct = new Map<string, Promise<string | undefined>>();

  constructor(private readonly access: DirectAccess = { clusterIp: kubectlClusterIp, reachable: tcpReachable }) {}

  async directServiceUrl(clusterId: string, serviceKey: string, kubeconfigPath: string, target: ServiceTarget): Promise<string | undefined> {
    const key = this.key(clusterId, serviceKey);
    const known = this.direct.get(key);
    if (known) return known;
    const found = (async () => {
      const ip = await this.access.clusterIp(kubeconfigPath, target.namespace, target.service);
      if (!ip || !(await this.access.reachable(ip, target.remotePort, DIRECT_PROBE_MS))) return undefined;
      return `http://${ip}:${target.remotePort}${target.dashboardPath ?? '/'}`;
    })();
    this.direct.set(key, found);
    if (!(await found)) setTimeout(() => { if (this.direct.get(key) === found) this.direct.delete(key); }, DIRECT_RETRY_MS).unref();
    return found;
  }

  async serviceUrl(clusterId: string, serviceKey: string, kubeconfigPath: string, explicitTarget?: ServiceTarget): Promise<string> {
    const target = explicitTarget ?? SERVICE_TARGETS[serviceKey];
    if (!target) throw new Error(`Unknown service: ${serviceKey}`);
    return (await this.directServiceUrl(clusterId, serviceKey, kubeconfigPath, target))
      ?? this.ensurePortForward(clusterId, serviceKey, kubeconfigPath, target);
  }

  private key(clusterId: string, serviceKey: string) {
    return `${clusterId}::${serviceKey}`;
  }

  async ensurePortForward(
    clusterId: string,
    serviceKey: string,
    kubeconfigPath: string,
    explicitTarget?: ServiceTarget,
  ): Promise<string> {
    const target = explicitTarget ?? SERVICE_TARGETS[serviceKey];
    if (!target) throw new Error(`Unknown service: ${serviceKey}`);

    const clusterForwards = this.forwards.get(clusterId) ?? new Map();
    this.forwards.set(clusterId, clusterForwards);

    const existing = clusterForwards.get(serviceKey);
    if (existing) {
      const port = await existing.ready;
      return `http://localhost:${port}${target.dashboardPath ?? '/'}`;
    }

    const localPort = 0;

    const child = spawn(
      KUBECTL,
      [
        'port-forward',
        '--address', '127.0.0.1',
        '--kubeconfig', kubeconfigPath,
        '-n', target.namespace,
        target.resource ?? ('svc/' + target.service),
        `${localPort}:${target.remotePort}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    running.add(child);
    reapOnExit();

    let resolvePort: (port: number) => void;
    let rejectPort: (err: Error) => void;
    const ready = new Promise<number>((resolve, reject) => {
      resolvePort = resolve;
      rejectPort = reject;
    });

    let stderrBuf = '';
    let resolved = false;

    child.stderr?.on('data', (data: Buffer) => {
      stderrBuf += data.toString();
    });

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      const match = text.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
      if (match && !resolved) {
        resolved = true;
        resolvePort(parseInt(match[1] ?? '0', 10));
      }
    });

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        rejectPort(err);
      }
    });

    child.on('close', (code) => {
      running.delete(child);
      clusterForwards.delete(serviceKey);
      if (!resolved) {
        resolved = true;
        const detail = stderrBuf.trim() || 'no stderr';
        rejectPort(new Error(`port-forward exited with code ${code}: ${detail}`));
      }
    });

    const entry: PortForwardEntry = { process: child, localPort: 0, ready };
    clusterForwards.set(serviceKey, entry);

    const port = await ready;
    entry.localPort = port;
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
      entry.process.kill();
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

let shared: ClusterProxyService | undefined;

export const sharedClusterProxy = (): ClusterProxyService => {
  shared ??= new ClusterProxyService();
  return shared;
};
