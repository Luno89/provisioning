import { BaseService } from './BaseService.js';
import { InfrastructureService } from './InfrastructureService.js';
import { ClusterService } from './ClusterService.js';
import type { Database } from '../lib/db-interface.js';
import type { ClusterMetadata, DeploymentMetadata } from '../lib/types.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { isMockCloudProvider, isSelfManagedCluster } from '../lib/cluster-topology.js';
import { exec } from 'child_process';
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
  private io: SocketServer | undefined;

  constructor(db: Database, infra: InfrastructureService, clusters: ClusterService, io?: SocketServer) {
    super(db);
    this.infra = infra;
    this.clusters = clusters;
    this.nginxConfDir = path.join(__dirname, '../../data/nginx');
    this.io = io;

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

    if (candidateServices.length === 0) {
      throw new Error(`No proxyable web services found in namespace "${namespace}".`);
    }

    const appHostname = `${namespace}.apps.local`;

    const traefikOutput = await this.infra.runKubectl(['get', 'svc', 'traefik', '-n', 'traefik', '-o', 'json'], kubeconfigPath);
    const traefikSvc = JSON.parse(traefikOutput);
    const traefikPortObj = traefikSvc.spec?.ports?.find((p: any) => p.name === 'web') || traefikSvc.spec?.ports?.[0];
    const targetPort = traefikPortObj?.port || 80;

    const isMock = this.isMockCloud(cluster);
    let backendTarget = '';
    if (cluster.gpuEnabled) {
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
    } else if (cluster.meshIp) {
      const nodePort = traefikPortObj?.nodePort;
      if (!nodePort) {
        throw new Error(
          `Traefik on "${cluster.name}" has no nodePort — the cluster stack predates the NodePort change and needs re-applying.`,
        );
      }
      backendTarget = `${cluster.meshIp}:${nodePort}`;
    } else {
      const ingress = traefikSvc.status?.loadBalancer?.ingress?.[0];
      const targetIpOrHost = ingress?.ip || ingress?.hostname;
      if (!targetIpOrHost) {
        throw new Error(
          isSelfManagedCluster(cluster.provider, isMock)
            ? `Cluster "${cluster.name}" has no mesh address, so its apps cannot be reached. Was MESH_LOGIN_SERVER set when it was provisioned?`
            : `Cloud LoadBalancer for Traefik's Service is still provisioning.`,
        );
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

  private syncDerivedFields(dep: DeploymentMetadata) {
    dep.isExposed = !!(dep.isExposedLocally || dep.isExposedPublicly);
    if (dep.publicExposureUrl) dep.exposureUrl = dep.publicExposureUrl;
    else if (dep.localExposureUrl) dep.exposureUrl = dep.localExposureUrl;
    else delete dep.exposureUrl;
  }

  private confPathFor(namespace: string): string {
    return path.join(this.nginxConfDir, 'conf.d', `${namespace}.conf`);
  }

  private ingressDomain(): string | undefined {
    return process.env.INGRESS_DOMAIN || undefined;
  }

  private hostnameFor(dep: DeploymentMetadata, domain: string): string {
    if (dep.publicHostname) return dep.publicHostname;
    return `${this.sanitize(dep.name)}-${dep.id.replace(/-/g, '').slice(0, 6)}.${domain}`;
  }

  private caddyConfPathFor(namespace: string): string {
    return path.join(this.nginxConfDir, '..', 'caddy', 'apps', `${namespace}.caddy`);
  }

  private buildCaddyContent(publicHostname: string, backendTarget: string, appHostname: string): string {
    return `${publicHostname} {
	reverse_proxy ${backendTarget} {
		header_up Host ${appHostname}
		header_up X-Forwarded-Proto https

		# Apps stream (logs, terminals, live dashboards); the 30s default would sever those.
		transport http {
			read_timeout 0
			write_timeout 0
		}
	}
}
`;
  }

  private async reloadCaddy(): Promise<void> {
    await execAsync('docker exec nowrinkles-caddy caddy reload --config /etc/caddy/Caddyfile --force');
  }

  private async writeCaddyConf(namespace: string, publicHostname: string, backendTarget: string, appHostname: string) {
    const confPath = this.caddyConfPathFor(namespace);
    await fs.mkdir(path.dirname(confPath), { recursive: true });
    await fs.writeFile(confPath, this.buildCaddyContent(publicHostname, backendTarget, appHostname));
    try {
      await this.reloadCaddy();
    } catch (err: any) {
      throw new Error(`Failed to reload Caddy: ${err.message}`);
    }
  }

  private async removeCaddyConf(namespace: string) {
    try {
      await fs.unlink(this.caddyConfPathFor(namespace));
    } catch { /* ignored */ }
    try {
      await this.reloadCaddy();
    } catch (err: any) {
      this.logger.error(`Failed to reload Caddy: ${err.message}`);
    }
  }

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
    } catch { /* ignored */ }
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

    const domain = this.ingressDomain();
    if (!domain) {
      throw new Error(
        'Public exposure needs INGRESS_DOMAIN set — it is served by the hosted root node, not from here. Local exposure still works.',
      );
    }

    const { namespace, backendTarget, appHostname } = await this.buildUpstreamTarget(dep, cluster);

    const publicHostname = this.hostnameFor(dep, domain);
    dep.publicHostname = publicHostname;
    dep.isExposedPublicly = true;
    dep.publicExposureUrl = `https://${publicHostname}`;
    this.syncDerivedFields(dep);

    await this.writeCaddyConf(namespace, publicHostname, backendTarget, appHostname);

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

        const domain = this.ingressDomain();
        if (dep.isExposedPublicly && domain) {
          const publicHostname = this.hostnameFor(dep, domain);
          dep.publicHostname = publicHostname;
          dep.publicExposureUrl = `https://${publicHostname}`;
          await this.writeCaddyConf(namespace, publicHostname, backendTarget, appHostname);
        }
        if (dep.isExposedLocally) {
          dep.localExposureUrl = `http://${namespace}.localhost:8000`;
          await this.writeNginxConf(namespace, backendTarget, appHostname);
        }
        this.syncDerivedFields(dep);
        await this.db.saveDeployment(dep);

        changed = true;
        const modes = [dep.isExposedPublicly ? `public: ${dep.publicHostname}` : null, dep.isExposedLocally ? 'local' : null].filter(Boolean).join(', ');
        this.logger.info(`Synced exposure for "${dep.name}" -> ${backendTarget} (${modes})`);

      } catch (err: any) {
        this.logger.error(`Failed to sync nginx config for "${dep.name}": ${err.message}`);
      }
    }

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

    dep.isExposedPublicly = false;
    delete dep.publicExposureUrl;
    this.syncDerivedFields(dep);

    await this.removeCaddyConf(namespace);

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
