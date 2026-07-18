import { BaseService } from './BaseService.js';
import { InfrastructureService } from './InfrastructureService.js';
import { ClusterService } from './ClusterService.js';
import type { Database } from '../lib/db-interface.js';
import type { ClusterMetadata, DeploymentMetadata } from '../lib/types.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
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
  private io?: SocketServer;
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
    if (cluster.provider === 'k3d') return false;
    return !hasCloudCredentials(cluster.provider);
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

    const isMock = this.isMockCloud(cluster);
    let backendTarget = '';
    if (cluster.provider === 'k3d' || isMock) {
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

  private buildConfContent(namespace: string, backendTarget: string, tunnelHost?: string): string {
    const extraHost = tunnelHost ? ` ${tunnelHost}` : '';
    return `server {
    listen 80;
    server_name ${namespace} ~^${namespace}\\..*$${extraHost};

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

  async expose(id: string) {
    const deployments = await this.db.getDeployments();
    const dep = deployments.find(d => d.id === id);
    if (!dep) throw new Error('Deployment not found');

    const cluster = await this.clusters.getById(dep.clusterId);
    if (!cluster) throw new Error('Cluster not found');

    const { namespace, backendTarget } = await this.buildUpstreamTarget(dep, cluster);

    // Start tunnel first to get the actual assigned URL
    const exposureUrl = await this.startTunnel(dep.id, namespace);
    const tunnelHost = exposureUrl.replace(/^https?:\/\//, '');

    const confPath = path.join(this.nginxConfDir, 'conf.d', `${namespace}.conf`);
    const confContent = this.buildConfContent(namespace, backendTarget, tunnelHost);
    await fs.mkdir(path.dirname(confPath), { recursive: true });
    await fs.writeFile(confPath, confContent);

    try {
      await execAsync('docker exec provisioner-nginx nginx -s reload');
    } catch (err: any) {
      throw new Error(`Failed to reload Nginx container: ${err.message}`);
    }

    dep.isExposed = true;
    dep.exposureUrl = exposureUrl;
    await this.db.saveDeployment(dep);
    if (this.io) this.io.emit('deployment-updated');

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

        // Start public tunnel and wait for it
        const url = await this.startTunnel(dep.id, namespace).catch((err) => {
          this.logger.error(`Failed to establish sync tunnel for "${dep.name}": ${err.message}`);
          return `http://${namespace}.localhost:8000`;
        });

        dep.exposureUrl = url;
        await this.db.saveDeployment(dep);

        // Write configuration dynamically with assigned tunnel hostname
        const tunnelHost = url.replace(/^https?:\/\//, '');
        const confPath = path.join(this.nginxConfDir, 'conf.d', `${namespace}.conf`);
        const confContent = this.buildConfContent(namespace, backendTarget, tunnelHost);
        await fs.mkdir(path.dirname(confPath), { recursive: true });
        await fs.writeFile(confPath, confContent);
        changed = true;
        this.logger.info(`Synced nginx config for "${dep.name}" -> ${backendTarget} (tunnel: ${tunnelHost})`);

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

    if (this.io && exposed.length > 0) {
      this.io.emit('deployment-updated');
    }
  }

  async unexpose(id: string) {
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

    const confPath = path.join(this.nginxConfDir, 'conf.d', `${namespace}.conf`);
    try {
      await fs.unlink(confPath);
    } catch (err: any) {
      // Ignore if file doesn't exist
    }

    try {
      await execAsync('docker exec provisioner-nginx nginx -s reload');
    } catch (err: any) {
      this.logger.error(`Failed to reload Nginx container: ${err.message}`);
    }

    dep.isExposed = false;
    delete dep.exposureUrl;
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
