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

interface ServiceTarget {
  service: string;
  namespace: string;
  remotePort: number;
  /** Override the kubectl port-forward target resource (e.g. "deployment/traefik"). Defaults to "svc/{service}". */
  resource?: string;
  /** Path appended to the port-forward URL (e.g. "/dashboard/" for Traefik). Defaults to "/". */
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
    namespace: 'kube-system',
    remotePort: 9000,
    resource: 'deployment/traefik',
    dashboardPath: '/dashboard/',
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
  ): Promise<string> {
    const target = SERVICE_TARGETS[serviceKey];
    if (!target) throw new Error(`Unknown service: ${serviceKey}`);

    const clusterForwards = this.forwards.get(clusterId) ?? new Map();
    this.forwards.set(clusterId, clusterForwards);

    const existing = clusterForwards.get(serviceKey);
    if (existing) {
      const port = await existing.ready;
      return `http://127.0.0.1:${port}${target.dashboardPath ?? '/'}`;
    }

    const localPort = 0; // let the OS pick a free port

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
      // kubectl prints: "Forwarding from 127.0.0.1:54321 -> 3000"
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
    return `http://127.0.0.1:${port}${target.dashboardPath ?? '/'}`;
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
