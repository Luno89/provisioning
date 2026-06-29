import { BaseService } from './BaseService.js';
import { InfrastructureService } from './InfrastructureService.js';
import { ClusterService } from './ClusterService.js';
import type { LocalDB } from '../lib/db.js';
import type { ClusterMetadata, DeploymentMetadata } from '../lib/types.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AppExposureService extends BaseService {
  private infra: InfrastructureService;
  private clusters: ClusterService;
  private nginxConfDir: string;

  constructor(db: LocalDB, infra: InfrastructureService, clusters: ClusterService) {
    super(db);
    this.infra = infra;
    this.clusters = clusters;
    this.nginxConfDir = path.join(__dirname, '../../data/nginx');
  }

  private sanitize(name: string) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  private async buildUpstreamTarget(dep: DeploymentMetadata, cluster: ClusterMetadata): Promise<{namespace: string, backendTarget: string}> {
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

    const primarySvc = candidateServices.find((svc: any) =>
      svc.spec?.type === 'LoadBalancer' || svc.spec?.type === 'NodePort'
    ) || candidateServices[0];

    const svcName = primarySvc.metadata.name;
    const portObj = primarySvc.spec?.ports?.find((p: any) => !dbPorts.includes(p.port)) || primarySvc.spec?.ports?.[0];
    const targetPort = portObj?.port || 80;

    let backendTarget = '';
    if (cluster.provider === 'k3d') {
      const nodePort = portObj?.nodePort;
      if (!nodePort) {
        throw new Error(`Service "${svcName}" does not have a nodePort assigned. Cannot expose locally.`);
      }
      backendTarget = `172.17.0.1:${nodePort}`;
    } else {
      const ingress = primarySvc.status?.loadBalancer?.ingress?.[0];
      const targetIpOrHost = ingress?.ip || ingress?.hostname;
      if (!targetIpOrHost) {
        throw new Error(`Cloud LoadBalancer for service "${svcName}" is still provisioning.`);
      }
      backendTarget = `${targetIpOrHost}:${targetPort}`;
    }

    return { namespace, backendTarget };
  }

  private buildConfContent(namespace: string, backendTarget: string): string {
    return `server {
    listen 80;
    server_name ${namespace} ~^${namespace}\\..*$;

    location / {
        resolver 127.0.0.11 valid=10s;
        set \$upstream "${backendTarget}";
        proxy_pass http://\$upstream;
        proxy_set_header Host $host;
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

  async expose(id: string) {
    const deployments = await this.db.getDeployments();
    const dep = deployments.find(d => d.id === id);
    if (!dep) throw new Error('Deployment not found');

    const cluster = await this.clusters.getById(dep.clusterId);
    if (!cluster) throw new Error('Cluster not found');

    const { namespace, backendTarget } = await this.buildUpstreamTarget(dep, cluster);

    const confPath = path.join(this.nginxConfDir, 'conf.d', `${namespace}.conf`);
    const confContent = this.buildConfContent(namespace, backendTarget);
    await fs.mkdir(path.dirname(confPath), { recursive: true });
    await fs.writeFile(confPath, confContent);

    try {
      await execAsync('docker exec provisioner-nginx nginx -s reload');
    } catch (err: any) {
      throw new Error(`Failed to reload Nginx container: ${err.message}`);
    }

    const exposureUrl = `http://${namespace}.localhost:8000`;
    dep.isExposed = true;
    dep.exposureUrl = exposureUrl;
    await this.db.saveDeployment(dep);

    return dep;
  }

  async syncExposedApps() {
    const deployments = await this.db.getDeployments();
    const exposed = deployments.filter(d => d.isExposed);
    let changed = false;

    for (const dep of exposed) {
      try {
        const cluster = await this.clusters.getById(dep.clusterId);
        if (!cluster) {
          this.logger.warn(`Cluster not found for deployment "${dep.name}", skipping sync`);
          continue;
        }

        const { namespace, backendTarget } = await this.buildUpstreamTarget(dep, cluster);
        const confPath = path.join(this.nginxConfDir, 'conf.d', `${namespace}.conf`);
        const confContent = this.buildConfContent(namespace, backendTarget);
        await fs.mkdir(path.dirname(confPath), { recursive: true });
        await fs.writeFile(confPath, confContent);
        changed = true;
        this.logger.info(`Synced nginx config for "${dep.name}" -> ${backendTarget}`);
      } catch (err: any) {
        this.logger.error(`Failed to sync nginx config for "${dep.name}": ${err.message}`);
      }
    }

    // Remove conf.d files for deployments that are no longer exposed or no longer exist
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
  }

  async unexpose(id: string) {
    const deployments = await this.db.getDeployments();
    const dep = deployments.find(d => d.id === id);
    if (!dep) throw new Error('Deployment not found');

    const namespace = this.sanitize(dep.name);

    // 1. Remove Nginx configuration file
    const confPath = path.join(this.nginxConfDir, 'conf.d', `${namespace}.conf`);
    try {
      await fs.unlink(confPath);
    } catch (err: any) {
      // Ignore if file doesn't exist
    }

    // 2. Reload Nginx
    try {
      await execAsync('docker exec provisioner-nginx nginx -s reload');
    } catch (err: any) {
      this.logger.error(`Failed to reload Nginx container: ${err.message}`);
    }



    // 4. Update metadata
    dep.isExposed = false;
    delete dep.exposureUrl;
    await this.db.saveDeployment(dep);

    return dep;
  }
}
