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
  // `| undefined` rather than `?:` — the constructor unconditionally assigns the optional `io`
  // param, and exactOptionalPropertyTypes rejects assigning `undefined` to an optional property.
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
    } else if (cluster.meshIp) {
      // Mesh clusters (hetzner, remote) — reached over WireGuard at the node's own address.
      //
      // This branch has to come before the LoadBalancer one below, because these clusters would
      // otherwise fall into it and wait forever: constructs/traefik.ts gives a self-managed
      // cluster a NodePort Service, and `status.loadBalancer.ingress` is only ever populated by a
      // cloud controller, which single-node k3s does not have. Exposing an app on a Hetzner
      // cluster failed with "Cloud LoadBalancer ... is still provisioning" on a cluster that has
      // no load balancer and never will.
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
        // Genuine for aws/gcp/azure/do, where a controller really is still working. A
        // self-managed cluster reaching here means it never joined the mesh — say so, rather than
        // blaming a load balancer that was never coming.
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

  /**
   * The public suffix apps are served under, e.g. `nowrinkles.dev`. Unset on a local dev box,
   * where there is no public address and no certificate authority will issue for one.
   */
  private ingressDomain(): string | undefined {
    return process.env.INGRESS_DOMAIN || undefined;
  }

  /**
   * Stable, globally unique public hostname for a deployment.
   *
   * The id suffix is what makes it safe across tenants: two people can both deploy something
   * called "blog", and without it the second would silently take over the first's hostname. Taken
   * from the deployment id rather than the owner id so nothing about who owns it leaks into DNS.
   */
  private hostnameFor(dep: DeploymentMetadata, domain: string): string {
    if (dep.publicHostname) return dep.publicHostname;
    return `${this.sanitize(dep.name)}-${dep.id.replace(/-/g, '').slice(0, 6)}.${domain}`;
  }

  private caddyConfPathFor(namespace: string): string {
    return path.join(this.nginxConfDir, '..', 'caddy', 'apps', `${namespace}.caddy`);
  }

  /**
   * One Caddy site block per publicly exposed app.
   *
   * Sites are listed EXPLICITLY rather than served by a catch-all with on-demand TLS. With a
   * wildcard `*.<domain>` A record every name under the domain resolves to the root node, so a
   * catch-all would let anyone trigger certificate issuance for names we do not own — burning
   * Let's Encrypt's 50-per-week-per-registered-domain limit at will. An unlisted name simply gets
   * no certificate here.
   *
   * The Host rewrite is the load-bearing part, exactly as in the nginx path: Traefik in the tenant
   * cluster dispatches purely on Host, so it must see the app's own Ingress hostname and not the
   * public one the browser asked for.
   */
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
    // --force because the config often parses identically after an app is removed and re-added,
    // and Caddy skips a reload it considers a no-op.
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
    } catch {
      // Already gone
    }
    try {
      await this.reloadCaddy();
    } catch (err: any) {
      // Best-effort on teardown: the file is gone, so the route dies on the next reload anyway.
      this.logger.error(`Failed to reload Caddy: ${err.message}`);
    }
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

    const domain = this.ingressDomain();
    if (!domain) {
      // Public exposure used to mean spawning `npx localtunnel`, which handed back a *.loca.lt
      // address that was rate-limited, showed an interstitial, and did not reliably grant the
      // subdomain requested. It is gone. Public URLs now come from the hosted root node, so
      // there is genuinely nothing to serve from a laptop.
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
          // Rewritten every sync because backendTarget can move under us — a cluster that was
          // re-provisioned comes back with a different nodePort, and the old route would proxy
          // into nothing. The hostname itself is stable (hostnameFor reuses publicHostname), so
          // the user's URL never changes.
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

    dep.isExposedPublicly = false;
    delete dep.publicExposureUrl;
    // publicHostname is deliberately kept: re-exposing later should hand back the same URL rather
    // than silently minting a new one and breaking every link anyone saved.
    this.syncDerivedFields(dep);

    // The two modes no longer share a config file. Local exposure is the host nginx serving
    // namespace.localhost:8000; public exposure is a Caddy site on the root node. Removing one
    // cannot disturb the other, which is why this no longer has to rewrite the nginx conf to
    // strip a tunnel host out of it.
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
