import { BaseService, type Database, type ClusterMetadata, type DeploymentMetadata } from '../../platform/index.js';
import { InfrastructureService } from './InfrastructureService.js';
import { ClusterService } from './ClusterService.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { isMockCloudProvider, isSelfManagedCluster } from '../lib/cluster-topology.js';
import { assertUpstreamTarget } from '../lib/upstream-target.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Server as SocketServer } from 'socket.io';
import { ODOO_PROJECT_APP } from '../../releases/lib/odoo-release.js';
import { addressScope, appLabel, edgeSite, flatHost, freeLabel, inScope, labelOfFlat, nestedHost, offersNested, type AddressScope } from '../../instances/lib/edge-addresses.js';

export interface InstanceEdge {
  name: string;
  nestedReady(): boolean;
  reload(): Promise<void>;
}

export interface AppAddressing {
  edge?: InstanceEdge | undefined;
  groupOf?: ((dep: DeploymentMetadata) => Promise<string | undefined>) | undefined;
}

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AppExposureService extends BaseService {
  private infra: InfrastructureService;
  private clusters: ClusterService;
  private nginxConfDir: string;
  private io: SocketServer | undefined;
  private edge: InstanceEdge | undefined;
  private groupOf: (dep: DeploymentMetadata) => Promise<string | undefined>;

  constructor(db: Database, infra: InfrastructureService, clusters: ClusterService, io?: SocketServer, addressing: AppAddressing = {}) {
    super(db);
    this.infra = infra;
    this.clusters = clusters;
    this.nginxConfDir = path.join(__dirname, '../../../data/nginx');
    this.io = io;
    this.edge = addressing.edge;
    this.groupOf = addressing.groupOf ?? (async () => undefined);
  }

  private sanitize(name: string) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  private isMockCloud(cluster: ClusterMetadata): boolean {
    return isMockCloudProvider(cluster.provider, hasCloudCredentials);
  }

  private async buildUpstreamTarget(dep: DeploymentMetadata, cluster: ClusterMetadata): Promise<{namespace: string, backendTarget: string, appHostname: string}> {
    const namespace = dep.namespace || this.sanitize(dep.name);
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

    if (this.edge && cluster.isSystem) {
      for (const traefikNamespace of ['traefik', 'kube-system']) {
        const found = await this.infra.runKubectl(['get', 'svc', 'traefik', '-n', traefikNamespace, '-o', 'json'], kubeconfigPath).catch(() => undefined);
        if (!found) continue;
        const svc = JSON.parse(found);
        const port = (svc.spec?.ports?.find((p: any) => p.name === 'web') || svc.spec?.ports?.[0])?.port || 80;
        return { namespace, backendTarget: assertUpstreamTarget(`traefik.${traefikNamespace}.svc.cluster.local:${port}`, namespace), appHostname };
      }
      throw new Error('This instance\'s cluster has no Traefik (looked in the traefik and kube-system namespaces), so its apps cannot be reached.');
    }

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

    return { namespace, backendTarget: assertUpstreamTarget(backendTarget, namespace), appHostname };
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

  private previewOf(dep: DeploymentMetadata): { key: string; appHostname: string } | undefined {
    if (dep.appType !== ODOO_PROJECT_APP) return undefined;
    const key = `${dep.namespace || this.sanitize(dep.name)}-preview`;
    return { key, appHostname: `${key}.apps.local` };
  }

  private previewPublicHostname(dep: DeploymentMetadata, domain: string, publicHostname: string, scope: AddressScope): string {
    const label = scope.kind === 'combined' ? undefined : labelOfFlat(publicHostname, scope.name, domain);
    if (label) return flatHost(`${label}-preview`, scope.name, domain);
    return `${this.sanitize(dep.name)}-preview-${dep.id.replace(/-/g, '').slice(0, 6)}.${domain}`;
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

  private async scopeOf(dep: DeploymentMetadata): Promise<AddressScope> {
    return addressScope({ group: await this.groupOf(dep), instance: this.edge?.name, deploymentId: dep.id });
  }

  private async hostnameFor(dep: DeploymentMetadata, domain: string, scope?: AddressScope): Promise<string> {
    const within = scope ?? await this.scopeOf(dep);
    if (dep.publicHostname && inScope(dep.publicHostname, within, domain)) return dep.publicHostname;
    if (within.kind === 'combined') return flatHost(this.sanitize(dep.name), within.name, domain);
    const taken = new Set((await this.db.infrastructure.getDeployments())
      .filter((other) => other.id !== dep.id && other.publicHostname)
      .map((other) => labelOfFlat(other.publicHostname!, within.name, domain))
      .filter((label): label is string => Boolean(label)));
    return flatHost(freeLabel(appLabel(dep.name), within.name, taken), within.name, domain);
  }

  private publicHosts(flat: string, domain: string, scope: AddressScope): { hosts: string[]; shown: string } {
    const label = labelOfFlat(flat, scope.name, domain);
    if (!this.edge || !label || !offersNested(scope) || !this.edge.nestedReady()) return { hosts: [flat], shown: flat };
    const nested = nestedHost(label, scope.name, domain);
    return { hosts: [flat, nested], shown: nested };
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
    if (this.edge) return this.edge.reload();
    await execAsync('docker exec nowrinkles-caddy caddy reload --config /etc/caddy/Caddyfile --force');
  }

  private async writeCaddyConf(namespace: string, publicHostname: string, backendTarget: string, appHostname: string, domain: string, scope: AddressScope): Promise<string> {
    const confPath = this.caddyConfPathFor(namespace);
    const { hosts, shown } = this.publicHosts(publicHostname, domain, scope);
    await fs.mkdir(path.dirname(confPath), { recursive: true });
    await fs.writeFile(confPath, this.edge ? edgeSite(hosts, backendTarget, appHostname) : this.buildCaddyContent(publicHostname, backendTarget, appHostname));
    try {
      await this.reloadCaddy();
    } catch (err: any) {
      throw new Error(`Failed to reload Caddy: ${err.message}`);
    }
    return shown;
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
    const deployments = await this.db.infrastructure.getDeployments();
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
    const preview = this.previewOf(dep);
    if (preview) {
      await this.writeNginxConf(preview.key, backendTarget, preview.appHostname);
      dep.previewLocalUrl = `http://${preview.key}.localhost:8000`;
    }

    await this.db.infrastructure.saveDeployment(dep);
    if (this.io) this.io.emit('deployment-updated');
    return dep;
  }

  async exposePublic(id: string) {
    const deployments = await this.db.infrastructure.getDeployments();
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

    const scope = await this.scopeOf(dep);
    const publicHostname = await this.hostnameFor(dep, domain, scope);
    dep.publicHostname = publicHostname;
    dep.isExposedPublicly = true;
    dep.publicExposureUrl = `https://${await this.writeCaddyConf(namespace, publicHostname, backendTarget, appHostname, domain, scope)}`;
    this.syncDerivedFields(dep);

    const preview = this.previewOf(dep);
    if (preview) {
      const previewHostname = this.previewPublicHostname(dep, domain, publicHostname, scope);
      dep.previewPublicUrl = `https://${await this.writeCaddyConf(preview.key, previewHostname, backendTarget, preview.appHostname, domain, scope)}`;
    }

    await this.db.infrastructure.saveDeployment(dep);
    if (this.io) this.io.emit('deployment-updated');
    return dep;
  }

  async syncExposedApps() {
    const deployments = await this.db.infrastructure.getDeployments();
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
        const preview = this.previewOf(dep);
        if (dep.isExposedPublicly && domain) {
          const scope = await this.scopeOf(dep);
          const publicHostname = await this.hostnameFor(dep, domain, scope);
          dep.publicHostname = publicHostname;
          dep.publicExposureUrl = `https://${await this.writeCaddyConf(namespace, publicHostname, backendTarget, appHostname, domain, scope)}`;
          if (preview) {
            const previewHostname = this.previewPublicHostname(dep, domain, publicHostname, scope);
            dep.previewPublicUrl = `https://${await this.writeCaddyConf(preview.key, previewHostname, backendTarget, preview.appHostname, domain, scope)}`;
          }
        }
        if (dep.isExposedLocally) {
          dep.localExposureUrl = `http://${namespace}.localhost:8000`;
          await this.writeNginxConf(namespace, backendTarget, appHostname);
          if (preview) {
            await this.writeNginxConf(preview.key, backendTarget, preview.appHostname);
            dep.previewLocalUrl = `http://${preview.key}.localhost:8000`;
          }
        }
        this.syncDerivedFields(dep);
        await this.db.infrastructure.saveDeployment(dep);

        changed = true;
        const modes = [dep.isExposedPublicly ? `public: ${dep.publicHostname}` : null, dep.isExposedLocally ? 'local' : null].filter(Boolean).join(', ');
        this.logger.info(`Synced exposure for "${dep.name}" -> ${backendTarget} (${modes})`);

      } catch (err: any) {
        this.logger.error(`Failed to sync nginx config for "${dep.name}": ${err.message}`);
      }
    }

    const keys = (d: DeploymentMetadata) => [d.namespace || this.sanitize(d.name), ...(this.previewOf(d) ? [this.previewOf(d)!.key] : [])];
    const exposedNamespaces = new Set(exposed.filter(d => d.isExposedLocally).flatMap(keys));
    const publicNamespaces = new Set(exposed.filter(d => d.isExposedPublicly).flatMap(keys));
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

    const caddyDir = path.dirname(this.caddyConfPathFor('x'));
    try {
      let removed = false;
      for (const file of await fs.readdir(caddyDir).catch(() => [] as string[])) {
        if (!file.endsWith('.caddy') || publicNamespaces.has(file.replace(/\.caddy$/, ''))) continue;
        await fs.unlink(path.join(caddyDir, file));
        this.logger.info(`Removed stale Caddy config: ${file}`);
        removed = true;
      }
      if (removed) await this.reloadCaddy();
    } catch (err: any) {
      this.logger.error(`Failed to clean stale Caddy configs: ${err.message}`);
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
    const deployments = await this.db.infrastructure.getDeployments();
    const dep = deployments.find(d => d.id === id);
    if (!dep) throw new Error('Deployment not found');

    const namespace = dep.namespace || this.sanitize(dep.name);
    dep.isExposedLocally = false;
    delete dep.localExposureUrl;
    this.syncDerivedFields(dep);
    const preview = this.previewOf(dep);
    if (preview) {
      await this.removeNginxConf(preview.key);
      delete dep.previewLocalUrl;
    }

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

    await this.db.infrastructure.saveDeployment(dep);
    if (this.io) this.io.emit('deployment-updated');
    return dep;
  }

  async unexposePublic(id: string) {
    const deployments = await this.db.infrastructure.getDeployments();
    const dep = deployments.find(d => d.id === id);
    if (!dep) throw new Error('Deployment not found');

    const namespace = dep.namespace || this.sanitize(dep.name);

    dep.isExposedPublicly = false;
    delete dep.publicExposureUrl;
    this.syncDerivedFields(dep);

    await this.removeCaddyConf(namespace);
    const preview = this.previewOf(dep);
    if (preview) {
      await this.removeCaddyConf(preview.key);
      delete dep.previewPublicUrl;
    }

    await this.db.infrastructure.saveDeployment(dep);
    if (this.io) this.io.emit('deployment-updated');
    return dep;
  }

  async updateExposurePath(id: string, exposurePath: string) {
    const deployments = await this.db.infrastructure.getDeployments();
    const dep = deployments.find(d => d.id === id);
    if (!dep) throw new Error('Deployment not found');

    let formattedPath = exposurePath.trim();
    if (formattedPath && !formattedPath.startsWith('/')) {
      formattedPath = '/' + formattedPath;
    }

    dep.exposurePath = formattedPath;
    await this.db.infrastructure.saveDeployment(dep);
    if (this.io) this.io.emit('deployment-updated');

    return dep;
  }
}
