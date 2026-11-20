import { publicJwkShaped } from '../lib/oidc.js';
import crypto from 'crypto';
import type { Database } from '../../platform/index.js';
import { INSTANCE_STATUSES, inService, type InstanceAddresses, type InstanceGroup, type InstanceRecord, type InstanceStatus } from '../lib/instances.js';
import { nameProblem, suggestedName } from '../lib/instance-names.js';
import { routeProblem } from '../lib/instance-routes.js';
import { DEFAULT_UPDATES, findRelease, pickProblem, pinned, updateTarget, updatesView, type InstanceRelease, type UpdatesView } from '../lib/instance-updates.js';
import type { Reach } from '../lib/instance-watch.js';
import { InstanceReach } from './InstanceReach.js';
import { provisionReportOf, type KoalaInstallView, type PlacedKoala, type ProvisionReport } from '@koala/engine-core/koala-install';
import { askedInstall, installUnfinished, installView } from '../lib/koala-installs.js';
import { pastRevision, setupHeard, setupSaid, statusSettled, type InstanceSetup } from '../lib/instance-setup.js';

type Store = Pick<Database, 'instances' | 'accounts'>;

export interface SetupInstalls {
  setupHeard(installId: string, report: ProvisionReport): Promise<Outcome<{ recorded: true }>>;
}

export interface StatusReport {
  status?: unknown;
  detail?: unknown;
  url?: unknown;
  meshIp?: unknown;
  imageTag?: unknown;
  presence?: unknown;
  dataVersion?: unknown;
  revision?: unknown;
  provision?: unknown;
}

export interface WatchView {
  notifyWhenUnreachable: boolean;
  reach?: Reach | undefined;
}

export interface InstanceSettings {
  rootUrl: string;
  rootPublicKeys: () => string[];
  meshLoginServer?: string | undefined;
  registry: string;
  imageTag: string;
  domain?: string | undefined;
  siteNames?: readonly string[] | undefined;
  releases?: ReleaseSource | undefined;
  notices?: { tell(): Promise<number> } | undefined;
  serviceCaller?: ((token: string) => Promise<{ clientId: string; kind: 'instance' | 'hub' } | undefined>) | undefined;
  connected?: ((instanceId: string) => boolean) | undefined;
  serviceChanged?: ((instance: InstanceRecord) => void) | undefined;
  reach?: InstanceReach | undefined;
  installs?: SetupInstalls | undefined;
}

export interface ReleaseSource {
  releases(): Promise<InstanceRelease[]>;
  hasChart(imageTag: string): boolean;
}

export interface PlacingMachine {
  id: string;
  name: string;
  meshIp?: string | undefined;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 401 | 404 | 409 | 503; error: string };

export const hashCredential = (secret: string): string => crypto.createHash('sha256').update(secret).digest('hex');
const sameHash = (a: string, b: string): boolean => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const instanceIdFor = (ownerId: string): string => `inst-${hashCredential(ownerId).slice(0, 12)}`;

export class InstanceService {
  constructor(
    private readonly store: Store,
    private readonly settings: InstanceSettings,
    private readonly mesh: { createPreAuthKey(ownerId: string, opts?: { reusable?: boolean; expirySeconds?: number }): Promise<{ key: string }>; listUserDevices?(ownerId: string): Promise<{ ipAddresses: string[] }[]>; removeNode?(ownerId: string, meshIp: string): Promise<void> } | undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly routesChanged: () => void = () => {},
  ) {}

  private get reach(): InstanceReach {
    return this.settings.reach ?? new InstanceReach({ open: false, domain: this.settings.domain });
  }

  private async nameFor(ownerId: string, name: unknown): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
    const existing = (await this.store.instances.getInstances(ownerId))[0];
    if (existing?.name) {
      return name === undefined || name === existing.name
        ? { ok: true, name: existing.name }
        : { ok: false, error: `your instance is already named "${existing.name}", and a name stays as it is, since links use it` };
    }
    if (typeof name !== 'string') return { ok: false, error: 'pick a name for your instance' };
    const problem = nameProblem(name, this.settings.siteNames ?? []);
    if (problem) return { ok: false, error: problem };
    const taken = (await this.store.instances.getInstances()).some((entry) => (entry.name === name && entry.ownerId !== ownerId) || (entry.groups ?? []).some((group) => group.name === name));
    return taken ? { ok: false, error: `"${name}" is taken` } : { ok: true, name };
  }

  async nameCheck(ownerId: string, name: unknown): Promise<{ ok: boolean; problem?: string; suggestion?: string; address?: string }> {
    const user = await this.store.accounts.getUserById(ownerId);
    const suggestion = user?.email ? suggestedName(user.email) : undefined;
    if (name === undefined || name === '') return { ok: false, ...(suggestion ? { suggestion } : {}) };
    const found = await this.nameFor(ownerId, name);
    if (!found.ok) return { ok: false, problem: found.error };
    return this.settings.domain ? { ok: true, address: `https://${found.name}.${this.settings.domain}` } : { ok: true };
  }

  private async save(instance: InstanceRecord, patch: Partial<InstanceRecord>): Promise<InstanceRecord> {
    const next = { ...instance, ...patch, updatedAt: this.now().toISOString() };
    await this.store.instances.saveInstance(next);
    return next;
  }

  async placeOn(ownerId: string, machine: PlacingMachine, requestedName: unknown, installId: string): Promise<Outcome<{ instanceId: string; replaces?: string | undefined }>> {
    if (!this.settings.meshLoginServer) return { ok: false, status: 503, error: 'this root has no mesh configured (MESH_LOGIN_SERVER), so no machine can hold a Koala' };
    if (!this.settings.registry) return { ok: false, status: 503, error: 'this root has no registry for machines to pull from (INSTANCE_REGISTRY)' };
    if (!machine.meshIp) return { ok: false, status: 409, error: `${machine.name} is not on your private network yet; Koala is put on it once it is` };
    const existing = (await this.store.instances.getInstances(ownerId))[0];
    if (existing && existing.status !== 'failed' && existing.status !== 'waiting' && existing.machineId && existing.machineId !== machine.id) {
      return { ok: false, status: 409, error: `your Koala is on ${existing.machine ?? 'another machine'}; moving it is a step of its own` };
    }
    const named = await this.nameFor(ownerId, requestedName);
    if (!named.ok) return { ok: false, status: 400, error: named.error };
    const instanceId = existing?.id ?? instanceIdFor(ownerId);
    const now = this.now().toISOString();
    await this.save(existing ?? { id: instanceId, ownerId, url: '', createdAt: now, updatedAt: now }, {
      status: 'joined',
      detail: `Asking ${machine.name} to put Koala on itself`,
      machine: machine.name,
      machineId: machine.id,
      meshIp: machine.meshIp,
      name: named.name,
      install: askedInstall(installId, machine.id, now),
      setup: undefined,
    });
    const replaces = existing?.install && installUnfinished(existing.install) ? existing.install.id : undefined;
    return { ok: true, value: { instanceId, ...(replaces ? { replaces } : {}) } };
  }

  async placedKoala(installId: string, machine: PlacingMachine): Promise<Outcome<PlacedKoala>> {
    if (!this.settings.meshLoginServer || !this.settings.registry) return { ok: false, status: 503, error: 'this root has no mesh or no registry, so no machine can hold a Koala' };
    if (!machine.meshIp) return { ok: false, status: 409, error: `${machine.name} is not on your private network yet; Koala is put on it once it is` };
    const instance = (await this.store.instances.getInstances()).find((entry) => entry.install?.id === installId);
    if (!instance?.install || instance.install.machineId !== machine.id || !installUnfinished(instance.install)) return { ok: false, status: 404, error: 'no such install is under way on this machine' };
    const credential = crypto.randomBytes(32).toString('base64url');
    const recorded = await this.store.instances.updateInstall(instance.id, installId, { credentialHash: hashCredential(credential), 'install.imageTag': this.settings.imageTag, updatedAt: this.now().toISOString() });
    if (!recorded) return { ok: false, status: 404, error: 'no such install is under way on this machine' };
    return {
      ok: true,
      value: {
        installId,
        instanceId: instance.id,
        ownerId: instance.ownerId,
        machineId: machine.id,
        rootUrl: this.settings.rootUrl,
        rootPublicKeys: this.settings.rootPublicKeys().join('\n'),
        meshLoginServer: this.settings.meshLoginServer,
        meshAddress: machine.meshIp,
        image: `${this.settings.registry}/nowrinkles/app`,
        imageTag: this.settings.imageTag,
        chartUrl: `${this.settings.rootUrl}/api/instances/chart.tgz`,
        ...pinned(findRelease(await this.knownReleases(), this.settings.imageTag)),
        credential,
        name: instance.name ?? '',
        domain: this.settings.domain ?? '',
      },
    };
  }

  async installOf(installId: string): Promise<InstanceRecord | undefined> {
    return (await this.store.instances.getInstances()).find((entry) => entry.install?.id === installId);
  }

  async installNotStarted(instanceId: string, installId: string, why: string): Promise<void> {
    const at = this.now().toISOString();
    await this.store.instances.updateInstall(instanceId, installId, { 'install.state': 'failed', 'install.why': why, 'install.at': at, status: 'failed', detail: why, updatedAt: at });
  }

  async installsOn(machineId: string): Promise<InstanceRecord[]> {
    return (await this.store.instances.getInstances()).filter((entry) => entry.install?.machineId === machineId);
  }

  async installedUrl(instance: InstanceRecord, raw: unknown): Promise<Outcome<string>> {
    const checked = await this.reach.reportedUrl(raw, { name: instance.name, meshIp: instance.meshIp });
    return checked.ok ? { ok: true, value: checked.url } : { ok: false, status: 400, error: checked.error };
  }


  private async authenticated(instanceId: unknown, credential: unknown): Promise<InstanceRecord | undefined> {
    if (typeof instanceId !== 'string' || typeof credential !== 'string' || !credential) return undefined;
    const instance = (await this.store.instances.getInstances()).find((entry) => entry.id === instanceId);
    if (!instance) return undefined;
    if (instance.credentialHash && sameHash(instance.credentialHash, hashCredential(credential))) return instance;
    const caller = await this.settings.serviceCaller?.(credential);
    return caller?.kind === 'instance' && caller.clientId === instance.id ? instance : undefined;
  }

  async koalaOf(ownerId: string): Promise<{ url: string; audience: string } | undefined> {
    const instance = (await this.store.instances.getInstances(ownerId)).find((candidate) => inService(candidate));
    return instance ? { url: instance.url, audience: instance.id } : undefined;
  }

  caller(instanceId: string, token: string): Promise<InstanceRecord | undefined> {
    return this.authenticated(instanceId, token);
  }

  async announceSignIn(instanceId: unknown, credential: unknown, jwk: unknown): Promise<Outcome<{ since: string }>> {
    if (typeof instanceId !== 'string' || typeof credential !== 'string' || !credential) return { ok: false, status: 401, error: 'this instance is not known here' };
    const instance = (await this.store.instances.getInstances()).find((entry) => entry.id === instanceId);
    if (!instance?.credentialHash || !sameHash(instance.credentialHash, hashCredential(credential))) return { ok: false, status: 401, error: 'this instance is not known here' };
    if (!publicJwkShaped(jwk)) return { ok: false, status: 400, error: 'send the instance\'s sign-in key as an Ed25519 public JWK with its kid' };
    const since = instance.signIn?.jwk.kid === jwk.kid ? instance.signIn.since : this.now().toISOString();
    await this.store.instances.saveSignInKey(instance.id, { jwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: jwk.kid }, since });
    return { ok: true, value: { since } };
  }

  private async meshIpOwned(ownerId: string, meshIp: string): Promise<'yes' | 'no' | 'unknown'> {
    if (!this.mesh?.listUserDevices) return 'yes';
    const theirs = await this.mesh.listUserDevices(ownerId).catch((err: Error) => {
      console.warn(`[instances] the mesh could not say which machines are ${ownerId}'s, so ${meshIp} is not taken as their instance's address yet: ${err.message}`);
      return undefined;
    });
    if (!theirs) return 'unknown';
    return theirs.some((device) => device.ipAddresses.includes(meshIp)) ? 'yes' : 'no';
  }

  private chartUrlFor(imageTag: string): string {
    return imageTag !== this.settings.imageTag && this.settings.releases?.hasChart(imageTag)
      ? `${this.settings.rootUrl}/api/instances/chart/${encodeURIComponent(imageTag)}.tgz`
      : `${this.settings.rootUrl}/api/instances/chart.tgz`;
  }

  private async knownReleases(): Promise<InstanceRelease[]> {
    return (await this.settings.releases?.releases()) ?? [];
  }

  async release(instanceId: unknown, credential: unknown): Promise<Outcome<{ imageTag: string; chartUrl: string; digest?: string; chartSha256?: string; dataVersion?: number }>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    const releases = await this.knownReleases();
    const imageTag = updateTarget(instance.updates ?? DEFAULT_UPDATES, instance.running, this.settings.imageTag, releases, instance.dataVersion ?? 0);
    const release = findRelease(releases, imageTag);
    const { imageDigest, chartSha256 } = pinned(release);
    return { ok: true, value: { imageTag, chartUrl: this.chartUrlFor(imageTag), ...(imageDigest ? { digest: imageDigest } : {}), ...(chartSha256 ? { chartSha256 } : {}), ...(release?.dataVersion ? { dataVersion: release.dataVersion } : {}) } };
  }

  private async viewOf(instance: InstanceRecord): Promise<UpdatesView> {
    return updatesView(instance.updates ?? DEFAULT_UPDATES, instance.running, instance.previous, this.settings.imageTag, await this.knownReleases(), instance.dataVersion ?? 0);
  }

  async updates(instanceId: unknown, credential: unknown): Promise<Outcome<UpdatesView>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    return { ok: true, value: await this.viewOf(instance) };
  }

  async runningOf(instanceId: unknown, credential: unknown): Promise<Outcome<{ running?: string | undefined }>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    return { ok: true, value: { running: instance.running } };
  }

  async setUpdates(instanceId: unknown, credential: unknown, change: { auto?: unknown; version?: unknown }): Promise<Outcome<UpdatesView>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    if (change.auto !== undefined && typeof change.auto !== 'boolean') return { ok: false, status: 400, error: 'send "auto" as true or false' };
    if (change.version !== undefined && (typeof change.version !== 'string' || change.version === '')) return { ok: false, status: 400, error: 'send "version" as the release to move to' };
    if (change.auto === true && change.version !== undefined) return { ok: false, status: 400, error: 'a picked version turns automatic updates off; send one or the other' };
    if (typeof change.version === 'string') {
      const releases = await this.knownReleases();
      const problem = pickProblem(releases, instance.running, instance.previous, change.version, instance.dataVersion ?? 0);
      if (problem) return { ok: false, status: 409, error: problem };
      const saved = await this.save(instance, { updates: { auto: false, picked: findRelease(releases, change.version)!.imageTag } });
      return { ok: true, value: await this.viewOf(saved) };
    }
    if (change.auto === undefined) return { ok: false, status: 400, error: 'send "auto", or "version" to move to' };
    const saved = await this.save(instance, { updates: change.auto ? { auto: true } : { auto: false, ...(instance.running ? { picked: instance.running } : {}) } });
    return { ok: true, value: await this.viewOf(saved) };
  }


  private setupOf(followed: InstanceSetup | undefined, raw: unknown): { ok: true; report: ProvisionReport; setup: InstanceSetup } | { ok: false; status: 400 | 409; error: string } {
    const read = provisionReportOf(raw);
    if (!read.ok) return { ok: false, status: 400, error: read.problem };
    const setup = setupHeard(followed, read.value, this.now().toISOString());
    if (!setup) return { ok: false, status: 409, error: pastRevision(followed!, read.value) };
    return { ok: true, report: read.value, setup };
  }

  private async reportSetup(instance: InstanceRecord, raw: unknown): Promise<Outcome<InstanceRecord>> {
    const read = provisionReportOf(raw);
    if (!read.ok) return { ok: false, status: 400, error: read.problem };
    const report = read.value;
    if (instance.install && installUnfinished(instance.install)) {
      if (!this.settings.installs) return { ok: false, status: 503, error: 'this root follows no installs of Koala' };
      const handed = await this.settings.installs.setupHeard(instance.install.id, report);
      return handed.ok ? { ok: true, value: instance } : handed;
    }
    const heard = this.setupOf(instance.setup, raw);
    if (!heard.ok) return heard;
    const { setup } = heard;
    const saved = await this.save(instance, { setup, ...setupSaid(setup, instance.machine) });
    if (saved.status !== instance.status) {
      this.routesChanged();
      this.settings.serviceChanged?.(saved);
    }
    return { ok: true, value: saved };
  }

  async report(instanceId: unknown, credential: unknown, report: StatusReport): Promise<Outcome<InstanceRecord>> {
    if (report.provision !== undefined && Object.keys(report).some((key) => key !== 'provision')) return { ok: false, status: 400, error: 'a report of Koala\'s setup sends only "provision"' };
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    if (report.provision !== undefined) return this.reportSetup(instance, report.provision);
    if (!INSTANCE_STATUSES.includes(report.status as InstanceStatus)) return { ok: false, status: 400, error: `status is one of ${INSTANCE_STATUSES.join(', ')}` };
    if (report.revision !== undefined) {
      if (typeof report.revision !== 'number' || !Number.isInteger(report.revision) || report.revision < 1) return { ok: false, status: 400, error: 'revision is the chart revision the instance runs, a whole number from 1' };
      if (report.status !== 'installing') return { ok: false, status: 400, error: 'a report naming its revision says installing: ready comes from that revision\'s setup' };
    }
    let meshIp = instance.meshIp;
    if (report.meshIp !== undefined) {
      if (typeof report.meshIp !== 'string' || routeProblem({ name: 'x', meshIp: report.meshIp, nested: false })) return { ok: false, status: 400, error: 'meshIp is the instance\'s address on the mesh' };
      const owned = report.meshIp === instance.meshIp ? 'yes' : await this.meshIpOwned(instance.ownerId, report.meshIp);
      if (owned === 'no') return { ok: false, status: 400, error: `${report.meshIp} is not one of this instance's owner's machines on the mesh` };
      if (owned === 'yes') meshIp = report.meshIp;
    }
    let url = instance.url;
    if (report.url !== undefined) {
      const checked = await this.reach.reportedUrl(report.url, { name: instance.name, meshIp });
      if (!checked.ok) return { ok: false, status: 400, error: checked.error };
      url = checked.url;
    }
    if (report.imageTag !== undefined && (typeof report.imageTag !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(report.imageTag))) return { ok: false, status: 400, error: 'imageTag is the image tag the instance runs' };
    if (report.dataVersion !== undefined && (typeof report.dataVersion !== 'number' || !Number.isInteger(report.dataVersion) || report.dataVersion < 0)) return { ok: false, status: 400, error: 'dataVersion is the data version the instance\'s release brought, a whole number' };
    const dataVersion = Math.max(instance.dataVersion ?? 0, typeof report.dataVersion === 'number' ? report.dataVersion : 0);
    const running = report.status !== 'failed' && typeof report.imageTag === 'string' ? report.imageTag : instance.running;
    const moved = running !== instance.running && instance.running ? { previous: instance.running } : {};
    const detail = typeof report.detail === 'string' ? report.detail.slice(0, 500) : undefined;
    const said = statusSettled({ status: report.status as InstanceStatus, detail: detail ?? '' }, report.revision as number | undefined, instance.setup, instance.machine);
    const saved = await this.save(instance, { status: said.status, detail: said.detail || detail, url, meshIp, running, ...moved, ...(dataVersion ? { dataVersion } : {}) });
    if (report.presence !== true && !this.settings.connected?.(instance.id)) await this.store.instances.savePresence(instance, false);
    if (saved.status !== instance.status || saved.meshIp !== instance.meshIp) this.routesChanged();
    if (saved.status !== instance.status) this.settings.serviceChanged?.(saved);
    if (dataVersion > (instance.dataVersion ?? 0)) await this.settings.notices?.tell().catch((err: Error) => console.error(`[releases] could not tell the owner of ${instance.id} where its data holds it: ${err.message}`));
    return { ok: true, value: saved };
  }

  async mine(ownerId: string): Promise<{ id: string; status: InstanceStatus; detail?: string | undefined; url: string; name?: string | undefined; install?: KoalaInstallView | undefined; watch: WatchView } | null> {
    const instance = (await this.store.instances.getInstances(ownerId))[0];
    if (!instance) return null;
    return {
      id: instance.id, status: instance.status ?? (instance.url ? 'ready' : 'waiting'), detail: instance.detail, url: instance.url, name: instance.name,
      ...(instance.install ? { install: installView(instance.install) } : {}),
      watch: await this.watchViewOf(instance),
    };
  }

  async ownerOf(instanceId: unknown, credential: unknown): Promise<Outcome<{ ownerId: string }>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    return { ok: true, value: { ownerId: instance.ownerId } };
  }

  private async watchViewOf(instance: InstanceRecord): Promise<WatchView> {
    const watch = await this.store.instances.getWatch(instance.id);
    return {
      notifyWhenUnreachable: watch?.notifyWhenUnreachable !== false,
      ...(watch?.reach ? { reach: watch.reach } : {}),
    };
  }

  private async setNotify(instance: InstanceRecord, raw: unknown): Promise<Outcome<WatchView>> {
    if (typeof raw !== 'boolean') return { ok: false, status: 400, error: 'send notifyWhenUnreachable as true or false' };
    await this.store.instances.saveNotifyWhenUnreachable(instance, raw);
    return { ok: true, value: await this.watchViewOf(instance) };
  }

  async watchAs(instanceId: unknown, credential: unknown): Promise<Outcome<WatchView>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    return { ok: true, value: await this.watchViewOf(instance) };
  }

  async setWatchAs(instanceId: unknown, credential: unknown, raw: unknown): Promise<Outcome<WatchView>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    return this.setNotify(instance, raw);
  }

  async setWatchOf(ownerId: string, raw: unknown): Promise<Outcome<WatchView>> {
    const instance = (await this.store.instances.getInstances(ownerId))[0];
    if (!instance) return { ok: false, status: 404, error: 'you have no instance' };
    return this.setNotify(instance, raw);
  }

  async addresses(instanceId: unknown, credential: unknown): Promise<Outcome<InstanceAddresses & { name: string; domain: string }>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    if (!instance.name || !this.settings.domain) return { ok: false, status: 503, error: 'this root gives instances no addresses of their own (no INGRESS_DOMAIN), so apps are not published from here' };
    return { ok: true, value: { nested: false, ...instance.addresses, name: instance.name, domain: this.settings.domain } };
  }

  async setAddresses(instanceId: unknown, credential: unknown, nested: unknown): Promise<Outcome<InstanceAddresses & { name: string; domain: string }>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    if (typeof nested !== 'boolean') return { ok: false, status: 400, error: 'send "nested" as true or false' };
    if (!instance.name || !this.settings.domain) return { ok: false, status: 503, error: 'this root gives instances no addresses of their own (no INGRESS_DOMAIN), so apps are not published from here' };
    if ((instance.addresses?.nested ?? false) !== nested) {
      await this.save(instance, { addresses: nested ? { nested: true, state: 'issuing' } : { nested: false } });
      this.routesChanged();
    }
    return this.addresses(instanceId, credential);
  }

  private async groupProblem(instance: InstanceRecord, projectId: string | undefined, name: unknown): Promise<string | null> {
    if (typeof name !== 'string' || !name) return 'name the group its apps are addressed under';
    const problem = nameProblem(name, this.settings.siteNames ?? []);
    if (problem) return problem;
    const instances = await this.store.instances.getInstances();
    if (instances.some((entry) => entry.name === name)) return `"${name}" is taken`;
    const holder = instances.flatMap((entry) => (entry.groups ?? []).map((group) => ({ instanceId: entry.id, ...group }))).find((group) => group.name === name);
    if (holder && !(holder.instanceId === instance.id && holder.projectId === projectId)) return `"${name}" is taken`;
    return null;
  }

  async checkGroup(instanceId: unknown, credential: unknown, name: unknown): Promise<Outcome<{ ok: boolean; problem?: string | undefined }>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    const problem = await this.groupProblem(instance, undefined, name);
    return { ok: true, value: problem ? { ok: false, problem } : { ok: true } };
  }

  async claimGroup(instanceId: unknown, credential: unknown, projectId: unknown, name: unknown): Promise<Outcome<InstanceGroup>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 200) return { ok: false, status: 400, error: 'name the project the group is for' };
    const held = (instance.groups ?? []).find((group) => group.projectId === projectId);
    if (held && held.name !== name) return { ok: false, status: 409, error: `this project's apps are already addressed under "${held.name}", and a group stays as it is while the project is shared` };
    const problem = await this.groupProblem(instance, projectId, name);
    if (problem) return { ok: false, status: problem.endsWith('is taken') ? 409 : 400, error: problem };
    const group = { projectId, name: name as string };
    if (!held) {
      await this.save(instance, { groups: [...(instance.groups ?? []), group] });
      this.routesChanged();
    }
    return { ok: true, value: group };
  }

  async releaseGroup(instanceId: unknown, credential: unknown, projectId: unknown): Promise<Outcome<{ released: boolean }>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    if (typeof projectId !== 'string' || !projectId) return { ok: false, status: 400, error: 'name the project the group is for' };
    const kept = (instance.groups ?? []).filter((group) => group.projectId !== projectId);
    if (kept.length === (instance.groups ?? []).length) return { ok: true, value: { released: false } };
    await this.save(instance, { groups: kept });
    this.routesChanged();
    return { ok: true, value: { released: true } };
  }
}
