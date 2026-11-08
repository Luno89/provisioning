import fs from 'fs/promises';
import path from 'path';
import type { Server as SocketServer } from 'socket.io';
import { BaseService, listAt, numberAt, textAt, type ClusterMetadata, type Database, type DeploymentMetadata } from '../../platform/index.js';
import { ODOO_PROJECT_APP } from '../../releases/index.js';
import {
  addressScope, appLabel, edgeSite, flatHost, freeLabel, inScope, labelOfFlat, labelOfLocal, localHost, nestedHost, offersNested,
  type AddressScope,
} from '../../instances/index.js';
import { namespaceOf } from '../lib/app-namespace.js';
import type { Reach } from '../lib/cluster-places.js';
import { assertUpstreamTarget } from '../lib/upstream-target.js';
import type { ClusterAccess } from './ClusterAccess.js';

export interface InstanceEdge {
  name: string | undefined;
  localPort: number | undefined;
  sites: string;
  nestedReady(): boolean;
  reload(): Promise<void>;
}

export interface AppAddressing {
  edge?: InstanceEdge | undefined;
  groupOf?: ((dep: DeploymentMetadata) => Promise<string | undefined>) | undefined;
}

export interface AppExposureDb {
  infrastructure: Pick<Database['infrastructure'], 'getDeployments' | 'saveDeployment'>;
}

export interface ExposureClusters {
  access: Pick<ClusterAccess, 'reach' | 'kubectl'>;
  getByIdUnscoped(id: string): Promise<ClusterMetadata | undefined>;
}

interface Upstream { namespace: string; backendTarget: string; appHostname: string }

type SiteKind = 'local' | 'public';

const NO_EDGE = 'Apps are exposed through an instance\'s edge, the Caddy beside its backend, and this Koala has none.';
const NO_LOCAL_PORT = 'This instance runs on Koala\'s servers, so there is no computer of yours for an app to answer on; expose it publicly instead.';
const NO_DOMAIN = 'This instance has no domain of its own, so an app cannot have a public address here. It can still be exposed on this computer.';
const isMissingFile = (err: unknown): boolean => textAt(err, 'code') === 'ENOENT';
const DATABASE_NAMES = ['db', 'postgres', 'mysql', 'redis', 'mongo', 'memcached', 'mariadb', 'influx', 'cassandra', 'elasticsearch'];
const DATABASE_PORTS = [5432, 3306, 6379, 27017, 11211, 8086, 9042, 9200];

export class AppExposureService extends BaseService<AppExposureDb> {
  private readonly edge: InstanceEdge | undefined;
  private readonly groupOf: (dep: DeploymentMetadata) => Promise<string | undefined>;

  constructor(db: AppExposureDb, private readonly clusters: ExposureClusters, private readonly io?: SocketServer, addressing: AppAddressing = {}) {
    super(db);
    this.edge = addressing.edge;
    this.groupOf = addressing.groupOf ?? (async () => undefined);
  }

  private theEdge(): InstanceEdge {
    if (!this.edge) throw new Error(NO_EDGE);
    return this.edge;
  }

  private async deployment(id: string): Promise<DeploymentMetadata> {
    const dep = (await this.db.infrastructure.getDeployments()).find((d) => d.id === id);
    if (!dep) throw new Error('Deployment not found');
    return dep;
  }

  private async traefikOn(reach: Reach): Promise<{ namespace: string; spec: unknown }> {
    for (const namespace of ['traefik', 'kube-system']) {
      const found = await this.clusters.access.kubectl(reach, ['get', 'svc', 'traefik', '-n', namespace, '--ignore-not-found', '-o', 'json']);
      if (found.trim()) return { namespace, spec: JSON.parse(found) as unknown };
    }
    throw new Error(`${reach.clusterId} has no Traefik (looked in the traefik and kube-system namespaces), so its apps cannot be reached.`);
  }

  private async upstream(dep: DeploymentMetadata): Promise<Upstream> {
    const namespace = namespaceOf(dep);
    const reach = await this.clusters.access.reach(dep.clusterId);
    if (reach.kind === 'root') throw new Error(`${dep.clusterId} is root's own cluster, which runs no one's apps.`);
    const services = listAt(JSON.parse(await this.clusters.access.kubectl(reach, ['get', 'svc', '-n', namespace, '-o', 'json'])) as unknown, 'items');
    const web = services.some((svc) => {
      const full = textAt(svc, 'metadata', 'name')?.toLowerCase() || '';
      const owned = [namespace, dep.name.toLowerCase()].find((prefix) => full.startsWith(prefix));
      const name = owned ? full.slice(owned.length) : full;
      if (DATABASE_NAMES.some((word) => name.includes(word))) return false;
      return listAt(svc, 'spec', 'ports').some((p) => !DATABASE_PORTS.includes(numberAt(p, 'port') ?? 0));
    });
    if (!web) throw new Error(`No proxyable web services found in namespace "${namespace}".`);

    const traefik = await this.traefikOn(reach);
    const ports = listAt(traefik.spec, 'spec', 'ports');
    const webPort = ports.find((p) => textAt(p, 'name') === 'web') ?? ports[0];
    const appHostname = `${namespace}.apps.local`;
    if (reach.kind === 'koala') {
      const port = numberAt(webPort, 'port') || 80;
      return { namespace, appHostname, backendTarget: assertUpstreamTarget(`traefik.${traefik.namespace}.svc.cluster.local:${port}`, namespace) };
    }
    const cluster = await this.clusters.getByIdUnscoped(dep.clusterId);
    if (!cluster?.meshIp) throw new Error(`${dep.clusterId} has no mesh address, so this instance's edge cannot reach its apps.`);
    const nodePort = numberAt(webPort, 'nodePort');
    if (!nodePort) throw new Error(`Traefik on ${dep.clusterId} has no node port, so this instance's edge cannot reach its apps.`);
    return { namespace, appHostname, backendTarget: assertUpstreamTarget(`${cluster.meshIp}:${nodePort}`, namespace) };
  }

  private previewOf(dep: DeploymentMetadata): { key: string; appHostname: string } | undefined {
    if (dep.appType !== ODOO_PROJECT_APP) return undefined;
    const key = `${namespaceOf(dep)}-preview`;
    return { key, appHostname: `${key}.apps.local` };
  }

  private keysOf(dep: DeploymentMetadata): string[] {
    const preview = this.previewOf(dep);
    return [namespaceOf(dep), ...(preview ? [preview.key] : [])];
  }

  private previewPublicHostname(dep: DeploymentMetadata, domain: string, publicHostname: string, scope: AddressScope): string {
    const label = labelOfFlat(publicHostname, scope.name, domain);
    if (!label) throw new Error(`${dep.name}'s address ${publicHostname} is not under ${scope.name}.${domain}`);
    return flatHost(`${label}-preview`, scope.name, domain);
  }

  private syncDerivedFields(dep: DeploymentMetadata): void {
    dep.isExposed = !!(dep.isExposedLocally || dep.isExposedPublicly);
    if (dep.publicExposureUrl) dep.exposureUrl = dep.publicExposureUrl;
    else if (dep.localExposureUrl) dep.exposureUrl = dep.localExposureUrl;
    else delete dep.exposureUrl;
  }

  private sitePath(key: string, kind: SiteKind): string {
    return path.join(this.theEdge().sites, `${key}.${kind}.caddy`);
  }

  private async writeSite(key: string, kind: SiteKind, content: string): Promise<void> {
    const file = this.sitePath(key, kind);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }

  private async removeSite(key: string, kind: SiteKind): Promise<void> {
    try {
      await fs.unlink(this.sitePath(key, kind));
    } catch (err) {
      if (!isMissingFile(err)) throw err;
    }
  }

  private async reload(): Promise<void> {
    try {
      await this.theEdge().reload();
    } catch (err) {
      throw new Error(`The edge did not take its new sites: ${(err as Error).message}`);
    }
  }

  private domain(): string {
    const domain = process.env.INGRESS_DOMAIN || undefined;
    if (!domain || !this.theEdge().name) throw new Error(NO_DOMAIN);
    return domain;
  }

  private localPort(): number {
    const port = this.theEdge().localPort;
    if (!port) throw new Error(NO_LOCAL_PORT);
    return port;
  }

  private async scopeOf(dep: DeploymentMetadata): Promise<AddressScope> {
    const instance = this.theEdge().name;
    if (!instance) throw new Error(NO_DOMAIN);
    return addressScope({ group: await this.groupOf(dep), instance });
  }

  private async hostnameFor(dep: DeploymentMetadata, domain: string, scope: AddressScope): Promise<string> {
    if (dep.publicHostname && inScope(dep.publicHostname, scope, domain)) return dep.publicHostname;
    const taken = new Set((await this.db.infrastructure.getDeployments())
      .filter((other) => other.id !== dep.id && other.publicHostname)
      .map((other) => labelOfFlat(other.publicHostname!, scope.name, domain))
      .filter((label): label is string => Boolean(label)));
    return flatHost(freeLabel(appLabel(dep.name), scope.name, taken), scope.name, domain);
  }

  private async localLabelFor(dep: DeploymentMetadata, port: number): Promise<string> {
    const kept = labelOfLocal(dep.localExposureUrl, port);
    if (kept) return kept;
    const taken = new Set((await this.db.infrastructure.getDeployments())
      .filter((other) => other.id !== dep.id && other.isExposedLocally)
      .flatMap((other) => {
        const label = labelOfLocal(other.localExposureUrl, port);
        return label ? [label, `${label}-preview`] : [];
      }));
    return freeLabel(appLabel(dep.name), '', taken);
  }

  private publicHosts(flat: string, domain: string, scope: AddressScope): { hosts: string[]; shown: string } {
    const label = labelOfFlat(flat, scope.name, domain);
    if (!label || !offersNested(scope) || !this.theEdge().nestedReady()) return { hosts: [flat], shown: flat };
    const nested = nestedHost(label, scope.name, domain);
    return { hosts: [flat, nested], shown: nested };
  }

  private async placeLocal(dep: DeploymentMetadata, up: Upstream): Promise<void> {
    const port = this.localPort();
    const label = await this.localLabelFor(dep, port);
    await this.writeSite(up.namespace, 'local', edgeSite([localHost(label, port)], up.backendTarget, up.appHostname, 'http'));
    dep.localExposureUrl = `http://${localHost(label, port)}`;
    const preview = this.previewOf(dep);
    if (preview) {
      const previewHost = localHost(`${label}-preview`, port);
      await this.writeSite(preview.key, 'local', edgeSite([previewHost], up.backendTarget, preview.appHostname, 'http'));
      dep.previewLocalUrl = `http://${previewHost}`;
    }
  }

  private async placePublic(dep: DeploymentMetadata, up: Upstream): Promise<void> {
    const domain = this.domain();
    const scope = await this.scopeOf(dep);
    const publicHostname = await this.hostnameFor(dep, domain, scope);
    const site = this.publicHosts(publicHostname, domain, scope);
    await this.writeSite(up.namespace, 'public', edgeSite(site.hosts, up.backendTarget, up.appHostname));
    dep.publicHostname = publicHostname;
    dep.publicExposureUrl = `https://${site.shown}`;
    const preview = this.previewOf(dep);
    if (preview) {
      const previewSite = this.publicHosts(this.previewPublicHostname(dep, domain, publicHostname, scope), domain, scope);
      await this.writeSite(preview.key, 'public', edgeSite(previewSite.hosts, up.backendTarget, preview.appHostname));
      dep.previewPublicUrl = `https://${previewSite.shown}`;
    }
  }

  private async saved(dep: DeploymentMetadata): Promise<DeploymentMetadata> {
    this.syncDerivedFields(dep);
    await this.db.infrastructure.saveDeployment(dep);
    this.io?.emit('deployment-updated');
    return dep;
  }

  async exposeLocal(id: string): Promise<DeploymentMetadata> {
    const dep = await this.deployment(id);
    this.localPort();
    await this.placeLocal(dep, await this.upstream(dep));
    await this.reload();
    dep.isExposedLocally = true;
    return this.saved(dep);
  }

  async exposePublic(id: string): Promise<DeploymentMetadata> {
    const dep = await this.deployment(id);
    this.domain();
    await this.placePublic(dep, await this.upstream(dep));
    await this.reload();
    dep.isExposedPublicly = true;
    return this.saved(dep);
  }

  async unexposeLocal(id: string): Promise<DeploymentMetadata> {
    const dep = await this.deployment(id);
    for (const key of this.keysOf(dep)) await this.removeSite(key, 'local');
    await this.reload();
    dep.isExposedLocally = false;
    delete dep.localExposureUrl;
    delete dep.previewLocalUrl;
    return this.saved(dep);
  }

  async unexposePublic(id: string): Promise<DeploymentMetadata> {
    const dep = await this.deployment(id);
    for (const key of this.keysOf(dep)) await this.removeSite(key, 'public');
    await this.reload();
    dep.isExposedPublicly = false;
    delete dep.publicExposureUrl;
    delete dep.previewPublicUrl;
    return this.saved(dep);
  }

  async syncExposedApps(): Promise<void> {
    const exposed = (await this.db.infrastructure.getDeployments()).filter((d) => d.isExposedLocally || d.isExposedPublicly);
    if (!this.edge) {
      if (exposed.length) throw new Error(`${NO_EDGE} These apps are marked exposed and answer nowhere: ${exposed.map((d) => d.name).join(', ')}`);
      return;
    }
    const sites = this.edge.sites;
    const wanted = new Set<string>();
    const failed: string[] = [];
    for (const dep of exposed) {
      for (const key of this.keysOf(dep)) {
        if (dep.isExposedLocally) wanted.add(`${key}.local.caddy`);
        if (dep.isExposedPublicly) wanted.add(`${key}.public.caddy`);
      }
      try {
        const up = await this.upstream(dep);
        if (dep.isExposedLocally) await this.placeLocal(dep, up);
        if (dep.isExposedPublicly) await this.placePublic(dep, up);
        await this.saved(dep);
      } catch (err) {
        failed.push(`${dep.name}: ${(err as Error).message}`);
      }
    }
    const present = await fs.readdir(sites).catch((err: unknown) => {
      if (isMissingFile(err)) return [] as string[];
      throw err;
    });
    for (const file of present) {
      if (file.endsWith('.caddy') && !wanted.has(file)) await fs.unlink(path.join(sites, file));
    }
    await this.reload();
    if (failed.length) throw new Error(`The edge kept these apps' sites as they were, since they could not be placed again: ${failed.join('; ')}`);
  }

  async updateExposurePath(id: string, exposurePath: string): Promise<DeploymentMetadata> {
    const dep = await this.deployment(id);
    const trimmed = exposurePath.trim();
    dep.exposurePath = trimmed && !trimmed.startsWith('/') ? `/${trimmed}` : trimmed;
    await this.db.infrastructure.saveDeployment(dep);
    this.io?.emit('deployment-updated');
    return dep;
  }
}
