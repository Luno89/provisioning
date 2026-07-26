import { BaseService } from './BaseService.js';
import { InfrastructureService } from './InfrastructureService.js';
import { ClusterService } from './ClusterService.js';
import type { Database } from '../lib/db-interface.js';
import type { ClusterMetadata, DeploymentMetadata } from '../lib/types.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { isMockCloudProvider } from '../lib/cluster-topology.js';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Server as SocketServer } from 'socket.io';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AppExposureService extends BaseService {
  private infra: InfrastructureService;
  private clusters: ClusterService;
  private nginxConfDir: string;
  // `| undefined` rather than `?:` — the constructor unconditionally assigns the optional `io`
  // param, and exactOptionalPropertyTypes rejects assigning `undefined` to an optional property.
  private io: SocketServer | undefined;
  private activeTunnels: Map<string, any> = new Map();

  private static registeredListeners = false;
  private static activeServices: AppExposureService[] = [];

  constructor(db: Database, infra: InfrastructureService, clusters: ClusterService, io?: SocketServer) {
    super(db);
    this.infra = infra;
    this.clusters = clusters;
    this.nginxConfDir = path.join(__dirname, '../../data/nginx');
    this.io = io;

    AppExposureService.activeServices.push(this);

    if (!AppExposureService.registeredListeners) {
      const globalCleanup = () => {
        for (const service of AppExposureService.activeServices) {
          for (const child of service.activeTunnels.values()) {
            try {
              child.kill('SIGKILL');
            } catch {}
          }
        }
      };

      process.on('exit', globalCleanup);
      process.on('SIGINT', () => { globalCleanup(); process.exit(0); });
      process.on('SIGTERM', () => { globalCleanup(); process.exit(0); });
      process.on('SIGUSR2', () => { globalCleanup(); process.exit(0); });
      AppExposureService.registeredListeners = true;
    }
  }

  private sanitize(name: string) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  private isMockCloud(cluster: ClusterMetadata): boolean {
    return isMockCloudProvider(cluster.provider, hasCloudCredentials);
  }

  private async buildUpstreamTarget(dep: DeploymentMetadata, cluster: ClusterMetadata): Promise<{namespace: string, backendTarget: string, appHostname: string}> {
    const namespace = this.sanitize(dep.name);
    const kubeconfigPath = await this.clusters.getKubeconfigPath(cluster);

    const output = await this.infra.runKubectl(['get', 'svc', '-n', namespace, '-o', 'json'], kubeconfigPath);
    const res = JSON.parse(output);
    const services: any[] = res.items || [];

    const dbKeywords = ['db', 'postgres', 'mysql', 'redis', 'mongo', 'memcached', 'mariadb', 'influx', 'cassandra', 'elasticsearch'];
    const dbPorts = [5432, 3306, 6379, 27017, 11211, 8086, 9042, 9200];

    const candidateServices = services.filter((svc: any) => {
      const name = svc.metadata?.name?.toLowerCase() || '';
      if (dbKeywords.some(kw => name.includes(kw))) return false;
      const ports = svc.spec?.ports || [];
      if (ports.length === 0) return false;
      return ports.some((p: any) => !dbPorts.includes(p.port));
    });

    // Still needed even though the app's own Service is no longer what we resolve a target
    // from below — this confirms a real, non-DB app Service actually exists in the namespace
    // before proxying anything at all (and throws the same clear error as before if not).
    if (candidateServices.length === 0) {
      throw new Error(`No proxyable web services found in namespace "${namespace}".`);
    }

    // Every app construct now creates an Ingress routing this exact hostname to itself
    // (see lib/app-ingress.ts) — Traefik dispatches by Host header, so this is the one thing
    // that actually determines which app the request reaches.
    const appHostname = `${namespace}.apps.local`;

    // Resolve Traefik's own Service instead of the app's — Traefik is what actually proxies
    // to the app now (see lib/app-ingress.ts's Ingress + this method's appHostname above), so
    // every app in a given cluster shares this same, single upstream target. Identical
    // resolution branches to what used to run per-app here, just pointed at a fixed service.
    const traefikOutput = await this.infra.runKubectl(['get', 'svc', 'traefik', '-n', 'traefik', '-o', 'json'], kubeconfigPath);
    const traefikSvc = JSON.parse(traefikOutput);
    const traefikPortObj = traefikSvc.spec?.ports?.find((p: any) => p.name === 'web') || traefikSvc.spec?.ports?.[0];
    const targetPort = traefikPortObj?.port || 80;

    const isMock = this.isMockCloud(cluster);
    let backendTarget = '';
    if (cluster.gpuEnabled) {
      // Native k3s (the system/management cluster) — no k3d node container exists for this
      // one, so there's nothing to resolve a container IP for. See getHostGatewayIp().
      const nodePort = traefikPortObj?.nodePort;
      if (!nodePort) {
        throw new Error(`Traefik's Service does not have a nodePort assigned. Cannot expose locally.`);
      }
      const hostIp = await this.infra.getHostGatewayIp();
      backendTarget = `${hostIp}:${nodePort}`;
    } else if (cluster.provider === 'k3d' || isMock) {
      const nodePort = traefikPortObj?.nodePort;
      if (!nodePort) {
        throw new Error(`Traefik's Service does not have a nodePort assigned. Cannot expose locally.`);
      }
      const serverIp = await this.infra.getK3dServerIp(cluster.name);
      backendTarget = `${serverIp}:${nodePort}`;
    } else {
      const ingress = traefikSvc.status?.loadBalancer?.ingress?.[0];
      const targetIpOrHost = ingress?.ip || ingress?.hostname;
      if (!targetIpOrHost) {
        throw new Error(`Cloud LoadBalancer for Traefik's Service is still provisioning.`);
      }
      backendTarget = `${targetIpOrHost}:${targetPort}`;
    }

    return { namespace, backendTarget, appHostname };
  }

  private buildConfContent(namespace: string, backendTarget: string, appHostname: string, tunnelHost?: string): string {
    const extraHost = tunnelHost ? ` ${tunnelHost}` : '';
    return `server {
    listen 80;
    server_name ${namespace} ~^${namespace}\\..*$${extraHost};

    location / {
        resolver 127.0.0.11 valid=10s;
        set \$upstream "${backendTarget}";
        proxy_pass http://\$upstream;
        # Fixed, not $host — the backend is now always Traefik (see buildUpstreamTarget), which
        # dispatches to the right app purely by Host header. Forwarding the client's original
        # Host (the tunnel domain, or namespace.localhost) would never match any app's Ingress.
        proxy_set_header Host ${appHostname};
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSockets / longpolling settings
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`;
  }

  private async startTunnel(deploymentId: string, namespace: string): Promise<string> {
    const existing = this.activeTunnels.get(deploymentId);
    if (existing) {
      try {
        existing.kill('SIGKILL');
      } catch {}
      this.activeTunnels.delete(deploymentId);
    }

    const localUrl = `http://${namespace}.localhost:8000`;
    console.log(`[AppExposureService] Spawning localtunnel for ${namespace} on port 8000...`);

    return new Promise<string>((resolve) => {
      const child = spawn('npx', ['-y', 'localtunnel', '--port', '8000', '--subdomain', namespace, '--local-host', `${namespace}.localhost`]);
      this.activeTunnels.set(deploymentId, child);

      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.warn(`[AppExposureService] Localtunnel for ${namespace} timed out. Falling back to local URL.`);
          resolve(localUrl);
        }
      }, 15000);

      child.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`[Localtunnel stdout] ${output.trim()}`);
        const match = output.match(/your url is:\s+(https:\/\/[^\s]+)/i);
        if (match && match[1]) {
          clearTimeout(timeout);
          if (!resolved) {
            resolved = true;
            const publicUrl = match[1];
            console.log(`[AppExposureService] Localtunnel established successfully: ${publicUrl}`);
            resolve(publicUrl);
          }
        }
      });

      child.stderr.on('data', (data) => {
        console.error(`[Localtunnel stderr] ${data.toString().trim()}`);
      });

      child.on('close', (code) => {
        console.log(`[AppExposureService] Localtunnel process for ${namespace} exited with code ${code}`);
        clearTimeout(timeout);
        this.activeTunnels.delete(deploymentId);
      });

      child.on('error', (err) => {
        console.error(`[AppExposureService] Localtunnel process error: ${err.message}`);
        clearTimeout(timeout);
        this.activeTunnels.delete(deploymentId);
        if (!resolved) {
          resolved = true;
          resolve(localUrl);
        }
      });
    });
  }

  // Derives the back-compat single-value fields (isExposed/exposureUrl) from the two
  // independent mode flags, and removes them entirely once neither mode is active — every
  // write path funnels through here so those fields can never drift out of sync.
  private syncDerivedFields(dep: DeploymentMetadata) {
    dep.isExposed = !!(dep.isExposedLocally || dep.isExposedPublicly);
    if (dep.publicExposureUrl) dep.exposureUrl = dep.publicExposureUrl;
    else if (dep.localExposureUrl) dep.exposureUrl = dep.localExposureUrl;
    else delete dep.exposureUrl;
  }

  private confPathFor(namespace: string): string {
    return path.join(this.nginxConfDir, 'conf.d', `${namespace}.conf`);
  }

  // Both modes share one Nginx conf per namespace — buildConfContent's server_name already
  // matches the bare local hostname via regex regardless of tunnelHost, so writing it with or
  // without a tunnel host never breaks the other mode; only the *content* changes.
  private async writeNginxConf(namespace: string, backendTarget: string, appHostname: string, tunnelHost?: string) {
    const confPath = this.confPathFor(namespace);
    const confContent = this.buildConfContent(namespace, backendTarget, appHostname, tunnelHost);
    await fs.mkdir(path.dirname(confPath), { recursive: true });
    await fs.writeFile(confPath, confContent);
    try {
      await execAsync('docker exec provisioner-nginx nginx -s reload');
    } catch (err: any) {
      throw new Error(`Failed to reload Nginx container: ${err.message}`);
    }
  }

  private async removeNginxConf(namespace: string) {
    try {
      await fs.unlink(this.confPathFor(namespace));
    } catch {
      // Already gone
    }
    try {
      await execAsync('docker exec provisioner-nginx nginx -s reload');
    } catch (err: any) {
      this.logger.error(`Failed to reload Nginx container: ${err.message}`);
    }
  }

  async exposeLocal(id: string) {
    const deployments = await this.db.getDeployments();
    const dep = deployments.find(d => d.id === id);
    if (!dep) throw new Error('Deployment not found');

    const cluster = await this.clusters.getByIdUnscoped(dep.clusterId);
    if (!cluster) throw new Error('Cluster not found');

    const { namespace, backendTarget, appHostname } = await this.buildUpstreamTarget(dep, cluster);

    dep.isExposedLocally = true;
    dep.localExposureUrl = `http://${namespace}.localhost:8000`;
    this.syncDerivedFields(dep);

    // Preserve the tunnel host in the conf if public exposure is already active independently.
    const tunnelHost = dep.isExposedPublicly && dep.publicExposureUrl ? dep.publicExposureUrl.replace(/^https?:\/\//, '') : undefined;
    await this.writeNginxConf(namespace, backendTarget, appHostname, tunnelHost);

    await this.db.saveDeployment(dep);
    if (this.io) this.io.emit('deployment-updated');
    return dep;
  }

  async exposePublic(id: string) {
    const deployments = await this.db.getDeployments();
    const dep = deployments.find(d => d.id === id);
    if (!dep) throw new Error('Deployment not found');

    const cluster = await this.clusters.getByIdUnscoped(dep.clusterId);
    if (!cluster) throw new Error('Cluster not found');

    const { namespace, backendTarget, appHostname } = await this.buildUpstreamTarget(dep, cluster);

    const publicUrl = await this.startTunnel(dep.id, namespace);
    dep.isExposedPublicly = true;
    dep.publicExposureUrl = publicUrl;
    this.syncDerivedFields(dep);

    const tunnelHost = publicUrl.replace(/^https?:\/\//, '');
    await this.writeNginxConf(namespace, backendTarget, appHostname, tunnelHost);

    await this.db.saveDeployment(dep);
    if (this.io) this.io.emit('deployment-updated');
    return dep;
  }

  async syncExposedApps() {
    const deployments = await this.db.getDeployments();
    const exposed = deployments.filter(d => d.isExposedLocally || d.isExposedPublicly);
    let changed = false;

    for (const dep of exposed) {
      try {
        const cluster = await this.clusters.getByIdUnscoped(dep.clusterId);
        if (!cluster) {
          this.logger.warn(`Cluster not found for deployment "${dep.name}", skipping sync`);
          continue;
        }

        const { namespace, backendTarget, appHostname } = await this.buildUpstreamTarget(dep, cluster);

        let tunnelHost: string | undefined;
        if (dep.isExposedPublicly) {
          const url = await this.startTunnel(dep.id, namespace).catch((err) => {
            this.logger.error(`Failed to establish sync tunnel for "${dep.name}": ${err.message}`);
            return dep.publicExposureUrl; // keep the last-known URL rather than clobbering it with a guess
          });
          if (url) {
            dep.publicExposureUrl = url;
            tunnelHost = url.replace(/^https?:\/\//, '');
          }
        }
        if (dep.isExposedLocally) {
          dep.localExposureUrl = `http://${namespace}.localhost:8000`;
        }
        this.syncDerivedFields(dep);
        await this.db.saveDeployment(dep);

        await this.writeNginxConf(namespace, backendTarget, appHostname, tunnelHost);
        changed = true;
        const modes = [dep.isExposedPublicly ? `tunnel: ${tunnelHost}` : null, dep.isExposedLocally ? 'local' : null].filter(Boolean).join(', ');
        this.logger.info(`Synced nginx config for "${dep.name}" -> ${backendTarget} (${modes})`);

      } catch (err: any) {
        this.logger.error(`Failed to sync nginx config for "${dep.name}": ${err.message}`);
      }
    }

    // Remove conf.d files for deployments that are no longer exposed (either way) or no longer exist
    const exposedNamespaces = new Set(exposed.map(d => this.sanitize(d.name)));
    const confDir = path.join(this.nginxConfDir, 'conf.d');
    try {
      const files = await fs.readdir(confDir);
      for (const file of files) {
        if (file === 'default.conf') continue;
        const ns = file.replace(/\.conf$/, '');
        if (!exposedNamespaces.has(ns)) {
          await fs.unlink(path.join(confDir, file));
          this.logger.info(`Removed stale nginx config: ${file}`);
          changed = true;
        }
      }
    } catch (err: any) {
      this.logger.error(`Failed to clean stale nginx configs: ${err.message}`);
    }

    if (changed) {
      try {
        await execAsync('docker exec provisioner-nginx nginx -s reload');
        this.logger.info('Nginx reloaded after sync');
      } catch (err: any) {
        this.logger.error(`Failed to reload Nginx after sync: ${err.message}`);
      }
    }

    if (this.io && exposed.length > 0) {
      this.io.emit('deployment-updated');
    }
  }

  async unexposeLocal(id: string) {
    const deployments = await this.db.getDeployments();
    const dep = deployments.find(d => d.id === id);
    if (!dep) throw new Error('Deployment not found');

    const namespace = this.sanitize(dep.name);
    dep.isExposedLocally = false;
    delete dep.localExposureUrl;
    this.syncDerivedFields(dep);

    if (dep.isExposedPublicly && dep.publicExposureUrl) {
      // Public exposure is still active — rewrite (don't remove) the conf, keeping the tunnel
      // host. The bare/regex server_name match for the local hostname is harmless to leave in
      // since local exposure is off; nothing routes to it once the app isn't advertised as
      // locally-exposed in the UI, and it costs nothing to leave the pattern in the conf.
      const cluster = await this.clusters.getByIdUnscoped(dep.clusterId);
      if (cluster) {
        const { backendTarget, appHostname } = await this.buildUpstreamTarget(dep, cluster);
        const tunnelHost = dep.publicExposureUrl.replace(/^https?:\/\//, '');
        await this.writeNginxConf(namespace, backendTarget, appHostname, tunnelHost);
      }
    } else {
      await this.removeNginxConf(namespace);
    }

    await this.db.saveDeployment(dep);
    if (this.io) this.io.emit('deployment-updated');
    return dep;
  }

  async unexposePublic(id: string) {
    const deployments = await this.db.getDeployments();
    const dep = deployments.find(d => d.id === id);
    if (!dep) throw new Error('Deployment not found');

    const namespace = this.sanitize(dep.name);

    const tunnel = this.activeTunnels.get(id);
    if (tunnel) {
      try {
        tunnel.kill('SIGKILL');
      } catch {}
      this.activeTunnels.delete(id);
    }

    dep.isExposedPublicly = false;
    delete dep.publicExposureUrl;
    this.syncDerivedFields(dep);

    if (dep.isExposedLocally) {
      // Local exposure is still active — rewrite the conf without the tunnel host rather than
      // removing it, so the app stays reachable at namespace.localhost:8000.
      const cluster = await this.clusters.getByIdUnscoped(dep.clusterId);
      if (cluster) {
        const { backendTarget, appHostname } = await this.buildUpstreamTarget(dep, cluster);
        await this.writeNginxConf(namespace, backendTarget, appHostname);
      }
    } else {
      await this.removeNginxConf(namespace);
    }

    await this.db.saveDeployment(dep);
    if (this.io) this.io.emit('deployment-updated');
    return dep;
  }

  async updateExposurePath(id: string, exposurePath: string) {
    const deployments = await this.db.getDeployments();
    const dep = deployments.find(d => d.id === id);
    if (!dep) throw new Error('Deployment not found');

    let formattedPath = exposurePath.trim();
    if (formattedPath && !formattedPath.startsWith('/')) {
      formattedPath = '/' + formattedPath;
    }

    dep.exposurePath = formattedPath;
    await this.db.saveDeployment(dep);
    if (this.io) this.io.emit('deployment-updated');

    return dep;
  }
}
