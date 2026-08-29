import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../../../');
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
  alertmanager: {
    service: 'kube-prometheus-stack-alertmanager',
    namespace: 'monitoring',
    remotePort: 9093,
  },
};

export class ClusterProxyService {
  private forwards: Map<string, Map<string, PortForwardEntry>> = new Map();

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
