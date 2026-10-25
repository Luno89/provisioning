import crypto from 'crypto';
import type { Database } from '../../platform/index.js';
import { INSTANCE_STATUSES, type InstanceAddresses, type InstanceGroup, type InstanceRecord, type InstanceStatus } from '../lib/instances.js';
import { nameProblem, suggestedName } from '../lib/instance-names.js';
import { routeProblem } from '../lib/instance-routes.js';
import { freePorts, poolNamespace, trialDaysProblem, type PoolPolicy } from '../lib/pool.js';
import { extendedTrial } from '../lib/pool-trial.js';
import { moveProblem, type MoveStateName } from '../lib/instance-move.js';
import { DEFAULT_UPDATES, findRelease, pickProblem, pinned, updateTarget, updatesView, type InstanceRelease, type UpdatesView } from '../lib/instance-updates.js';

export const JOIN_TOKEN_TTL_SECONDS = 3600;

type Store = Pick<Database, 'instances' | 'accounts'>;

export interface PoolWorkflows {
  start(instanceId: string, ownerId: string): Promise<void>;
  trialChanged(instanceId: string): Promise<void>;
  remove(instanceId: string, ownerId: string): Promise<void>;
  move?(instanceId: string, ownerId: string): Promise<void>;
  moveFinished?(instanceId: string): Promise<void>;
  moveStopped?(instanceId: string, reason: string): Promise<void>;
}

export interface MoveView {
  state: MoveStateName;
  detail?: string | undefined;
  machine?: string | undefined;
  startedAt: string;
}

export interface PoolInstanceRow {
  id: string;
  name: string;
  owner: string;
  status: InstanceStatus;
  detail?: string | undefined;
  startedAt: string;
  trialEndsAt: string;
  pausedAt?: string | undefined;
}

export interface InstanceSettings {
  rootUrl: string;
  rootPublicKeys: () => string[];
  meshLoginServer?: string | undefined;
  registry: string;
  imageTag: string;
  domain?: string | undefined;
  siteNames?: readonly string[] | undefined;
  pool?: { slots: number; trialDays: number } | { off: string } | undefined;
  releases?: ReleaseSource | undefined;
}

export interface ReleaseSource {
  releases(): Promise<InstanceRelease[]>;
  hasChart(imageTag: string): boolean;
}

export interface PoolOffer {
  available: boolean;
  reason?: string | undefined;
  trialDays?: number | undefined;
}

export interface JoinBundle {
  instanceId: string;
  ownerId: string;
  rootUrl: string;
  rootPublicKeys: string;
  meshLoginServer: string;
  preAuthKey: string;
  registry: string;
  image: string;
  imageTag: string;
  imageDigest?: string | undefined;
  chartUrl: string;
  chartSha256?: string | undefined;
  credential: string;
  name: string;
  domain: string;
  move?: boolean | undefined;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 401 | 404 | 409 | 503; error: string };

export const hashCredential = (secret: string): string => crypto.createHash('sha256').update(secret).digest('hex');
const sameHash = (a: string, b: string): boolean => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const instanceIdFor = (ownerId: string): string => `inst-${hashCredential(ownerId).slice(0, 12)}`;

export class InstanceService {
  constructor(
    private readonly store: Store,
    private readonly settings: InstanceSettings,
    private readonly mesh: { createPreAuthKey(ownerId: string, opts?: { reusable?: boolean; expirySeconds?: number }): Promise<{ key: string }> } | undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly routesChanged: () => void = () => {},
    private readonly poolWorkflows: PoolWorkflows | undefined = undefined,
  ) {}

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

  async createJoinToken(ownerId: string, requestedName?: unknown): Promise<Outcome<{ token: string; command: string; expiresAt: string; name: string }>> {
    const current = (await this.store.instances.getInstances(ownerId))[0];
    if (current?.pool && current.status !== 'failed') return { ok: false, status: 400, error: 'your instance runs on Koala\'s servers; moving it to your own machine keeps your work, and starting afresh there would not' };
    const named = await this.nameFor(ownerId, requestedName);
    if (!named.ok) return { ok: false, status: 400, error: named.error };
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + JOIN_TOKEN_TTL_SECONDS * 1000).toISOString();
    const instanceId = instanceIdFor(ownerId);
    await this.store.instances.saveJoinToken({ hash: hashCredential(token), ownerId, instanceId, expiresAt });

    const existing = (await this.store.instances.getInstances(ownerId))[0];
    const now = this.now().toISOString();
    await this.store.instances.saveInstance({
      id: instanceId,
      ownerId,
      url: existing?.url ?? '',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      status: 'waiting',
      detail: 'Waiting for the machine to run the install command',
      name: named.name,
      ...(existing?.credentialHash ? { credentialHash: existing.credentialHash } : {}),
      ...(existing?.addresses ? { addresses: existing.addresses } : {}),
      ...(existing?.groups?.length ? { groups: existing.groups } : {}),
    });

    return { ok: true, value: { token, expiresAt, name: named.name, command: `curl -fsSL ${this.settings.rootUrl}/install.sh | sudo sh -s -- ${token}` } };
  }

  private async poolRoom(): Promise<{ ok: true; slots: number; trialDays: number; taken: InstanceRecord[] } | { ok: false; reason: string }> {
    const pool = this.settings.pool;
    if (!pool || 'off' in pool || !this.poolWorkflows) return { ok: false, reason: pool && 'off' in pool ? pool.off : 'this root has no pool' };
    const taken = (await this.store.instances.getInstances()).filter((entry) => entry.pool && entry.status !== 'failed');
    return { ok: true, slots: pool.slots, trialDays: (await this.store.instances.getPoolPolicy())?.trialDays ?? pool.trialDays, taken };
  }

  async poolOffer(ownerId: string): Promise<PoolOffer> {
    const room = await this.poolRoom();
    if (!room.ok) return { available: false, reason: room.reason };
    const own = room.taken.some((entry) => entry.ownerId === ownerId);
    if (!own && room.taken.length >= room.slots) return { available: false, reason: 'Koala\'s servers are full right now; use your own machine, or try again later', trialDays: room.trialDays };
    return { available: true, trialDays: room.trialDays };
  }

  async createPoolInstance(ownerId: string, requestedName?: unknown): Promise<Outcome<{ id: string; name: string; trialEndsAt: string }>> {
    const room = await this.poolRoom();
    if (!room.ok) return { ok: false, status: 503, error: room.reason };
    const existing = (await this.store.instances.getInstances(ownerId))[0];
    if (existing && existing.status && existing.status !== 'waiting' && existing.status !== 'failed') {
      return { ok: false, status: 400, error: existing.pool ? 'your instance on Koala\'s servers is already there' : 'you already have Koala on your own machine' };
    }
    if (room.taken.length >= room.slots) return { ok: false, status: 503, error: 'Koala\'s servers are full right now; use your own machine, or try again later' };
    const named = await this.nameFor(ownerId, requestedName);
    if (!named.ok) return { ok: false, status: 400, error: named.error };
    const ports = existing?.pool?.ports ?? freePorts((await this.store.instances.getInstances()).flatMap((entry) => (entry.pool ? [entry.pool.ports] : [])));
    if (!ports) return { ok: false, status: 503, error: 'Koala\'s servers have no ports left for another instance' };
    const now = this.now();
    const trialEndsAt = new Date(now.getTime() + room.trialDays * 86_400_000).toISOString();
    const instanceId = instanceIdFor(ownerId);
    await this.store.instances.saveInstance({
      id: instanceId,
      ownerId,
      url: '',
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      status: 'installing',
      detail: 'Making your space on Koala\'s servers',
      name: named.name,
      ...(existing?.addresses ? { addresses: existing.addresses } : {}),
      ...(existing?.groups?.length ? { groups: existing.groups } : {}),
      pool: { ports, startedAt: now.toISOString(), trialEndsAt },
    });
    try {
      await this.poolWorkflows!.start(instanceId, ownerId);
    } catch (error) {
      const record = (await this.store.instances.getInstances(ownerId)).find((entry) => entry.id === instanceId)!;
      await this.save(record, { status: 'failed', detail: `Setting it up could not start: ${(error as Error).message}` });
      return { ok: false, status: 503, error: `setting up your instance could not start: ${(error as Error).message}` };
    }
    return { ok: true, value: { id: instanceId, name: named.name, trialEndsAt } };
  }

  async poolAdmin(): Promise<Outcome<{ slots: number; trialDays: number; defaultTrialDays: number; policy?: PoolPolicy | undefined; instances: PoolInstanceRow[] }>> {
    const room = await this.poolRoom();
    if (!room.ok) return { ok: false, status: 503, error: room.reason };
    const pool = this.settings.pool as { slots: number; trialDays: number };
    const instances: PoolInstanceRow[] = [];
    for (const entry of (await this.store.instances.getInstances()).filter((record) => record.pool && record.name)) {
      const owner = await this.store.accounts.getUserById(entry.ownerId);
      instances.push({
        id: entry.id, name: entry.name!, owner: owner?.email ?? entry.ownerId, status: entry.status ?? 'installing', detail: entry.detail,
        startedAt: entry.pool!.startedAt, trialEndsAt: entry.pool!.trialEndsAt, pausedAt: entry.pool!.pausedAt,
      });
    }
    instances.sort((a, b) => a.trialEndsAt.localeCompare(b.trialEndsAt));
    const policy = await this.store.instances.getPoolPolicy();
    return { ok: true, value: { slots: room.slots, trialDays: room.trialDays, defaultTrialDays: pool.trialDays, ...(policy ? { policy } : {}), instances } };
  }

  async setTrialDays(adminId: string, days: unknown): Promise<Outcome<PoolPolicy>> {
    const room = await this.poolRoom();
    if (!room.ok) return { ok: false, status: 503, error: room.reason };
    const problem = trialDaysProblem(days);
    if (problem) return { ok: false, status: 400, error: problem };
    const policy = { trialDays: days as number, updatedAt: this.now().toISOString(), updatedBy: adminId };
    await this.store.instances.savePoolPolicy(policy);
    return { ok: true, value: policy };
  }

  async setTrialEnd(instanceId: string, trialEndsAt: unknown): Promise<Outcome<PoolInstanceRow>> {
    if (!this.poolWorkflows) return { ok: false, status: 503, error: 'this root has no pool' };
    const instance = (await this.store.instances.getInstances()).find((entry) => entry.id === instanceId);
    if (!instance?.pool || !instance.name) return { ok: false, status: 404, error: 'no pool instance by that id' };
    const at = typeof trialEndsAt === 'string' ? Date.parse(trialEndsAt) : NaN;
    if (!Number.isFinite(at)) return { ok: false, status: 400, error: 'send the new end of the trial as "trialEndsAt", a date and time' };
    if (at <= this.now().getTime()) return { ok: false, status: 400, error: 'the new end of the trial has to be in the future' };
    const trial = extendedTrial(instance.pool, new Date(at).toISOString(), this.now().getTime());
    const saved = await this.save(instance, { pool: { ...instance.pool, trialEndsAt: trial.trialEndsAt, told: [...(trial.told ?? [])], pausedAt: trial.pausedAt } });
    await this.poolWorkflows.trialChanged(instanceId);
    const owner = await this.store.accounts.getUserById(saved.ownerId);
    return { ok: true, value: { id: saved.id, name: saved.name!, owner: owner?.email ?? saved.ownerId, status: saved.status ?? 'installing', detail: saved.detail, startedAt: saved.pool!.startedAt, trialEndsAt: saved.pool!.trialEndsAt, pausedAt: saved.pool!.pausedAt } };
  }

  async removePoolInstance(instanceId: string, confirm: unknown): Promise<Outcome<{ removing: string }>> {
    if (!this.poolWorkflows) return { ok: false, status: 503, error: 'this root has no pool' };
    const instance = (await this.store.instances.getInstances()).find((entry) => entry.id === instanceId);
    if (!instance?.pool || !instance.name) return { ok: false, status: 404, error: 'no pool instance by that id' };
    if (confirm !== instance.name) return { ok: false, status: 400, error: `type the instance's name, "${instance.name}", to delete it and everything in it` };
    await this.save(instance, { status: 'paused', detail: 'Being deleted' });
    await this.poolWorkflows.remove(instance.id, instance.ownerId);
    return { ok: true, value: { removing: instance.name } };
  }

  async join(token: unknown, machine: unknown): Promise<Outcome<JoinBundle>> {
    if (typeof token !== 'string' || !token) return { ok: false, status: 400, error: 'send the join token as "token"' };
    const found = await this.store.instances.takeJoinToken(hashCredential(token));
    if (!found || found.expiresAt <= this.now().toISOString()) return { ok: false, status: 401, error: 'that join command has expired or was already used — make a new one from the app' };
    if (!this.mesh || !this.settings.meshLoginServer) return { ok: false, status: 503, error: 'this root has no mesh configured (MESH_LOGIN_SERVER), so no machine can join it' };
    if (!this.settings.registry) return { ok: false, status: 503, error: 'this root has no registry for machines to pull from (INSTANCE_REGISTRY)' };

    const credential = crypto.randomBytes(32).toString('base64url');
    const instance = (await this.store.instances.getInstances(found.ownerId)).find((entry) => entry.id === found.instanceId);
    const machineName = typeof machine === 'string' ? machine.slice(0, 120) : undefined;
    if (found.move) {
      if (!instance?.move || instance.move.state === 'switching' || instance.move.state === 'failed') return { ok: false, status: 401, error: 'that move command is no longer wanted — start the move again from Koala' };
    } else if (instance?.pool) {
      return { ok: false, status: 409, error: 'this instance runs on Koala\'s servers; only its move command brings it to a machine' };
    }
    const { key } = await this.mesh.createPreAuthKey(found.ownerId, { reusable: false, expirySeconds: JOIN_TOKEN_TTL_SECONDS });
    const now = this.now().toISOString();
    if (found.move && instance?.move) {
      await this.save(instance, {
        move: { ...instance.move, state: 'joined', detail: 'Your machine has the move command and is setting itself up', credentialHash: hashCredential(credential), target: { machine: machineName } },
      });
    } else {
      await this.save(instance ?? { id: found.instanceId, ownerId: found.ownerId, url: '', createdAt: now, updatedAt: now }, {
        status: 'joined',
        detail: 'The machine has the install command and is setting itself up',
        credentialHash: hashCredential(credential),
        machine: machineName,
      });
    }

    return {
      ok: true,
      value: {
        instanceId: found.instanceId,
        ownerId: found.ownerId,
        rootUrl: this.settings.rootUrl,
        rootPublicKeys: this.settings.rootPublicKeys().join('\n'),
        meshLoginServer: this.settings.meshLoginServer,
        preAuthKey: key,
        registry: this.settings.registry,
        image: `${this.settings.registry}/nowrinkles/app`,
        imageTag: this.settings.imageTag,
        chartUrl: `${this.settings.rootUrl}/api/instances/chart.tgz`,
        ...pinned(findRelease(await this.knownReleases(), this.settings.imageTag)),
        credential,
        name: instance?.name ?? '',
        domain: this.settings.domain ?? '',
        ...(found.move ? { move: true } : {}),
      },
    };
  }

  private async authenticated(instanceId: unknown, credential: unknown): Promise<InstanceRecord | undefined> {
    if (typeof instanceId !== 'string' || typeof credential !== 'string' || !credential) return undefined;
    const instance = (await this.store.instances.getInstances()).find((entry) => entry.id === instanceId);
    return instance?.credentialHash && sameHash(instance.credentialHash, hashCredential(credential)) ? instance : undefined;
  }

  private async mover(instanceId: unknown, credential: unknown): Promise<InstanceRecord | undefined> {
    if (typeof instanceId !== 'string' || typeof credential !== 'string' || !credential) return undefined;
    const instance = (await this.store.instances.getInstances()).find((entry) => entry.id === instanceId);
    const hash = instance?.move?.credentialHash;
    return hash && instance.move!.state !== 'failed' && sameHash(hash, hashCredential(credential)) ? instance : undefined;
  }

  async startMove(ownerId: string): Promise<Outcome<{ token: string; command: string; expiresAt: string }>> {
    const instance = (await this.store.instances.getInstances(ownerId))[0];
    if (!instance) return { ok: false, status: 404, error: 'you have no instance to move' };
    const problem = moveProblem(instance);
    if (problem) return { ok: false, status: 409, error: problem };
    if (!this.poolWorkflows?.move) return { ok: false, status: 503, error: 'this root cannot move instances' };
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + JOIN_TOKEN_TTL_SECONDS * 1000).toISOString();
    await this.store.instances.saveJoinToken({ hash: hashCredential(token), ownerId, instanceId: instance.id, expiresAt, move: true });
    const live = instance.move && instance.move.state !== 'failed';
    const paused = instance.status === 'paused';
    await this.save(instance, {
      move: live ? instance.move! : {
        state: 'waiting', startedAt: this.now().toISOString(), wasPaused: paused,
        detail: paused ? 'Starting your stopped instance so it can move' : 'Waiting for your machine to run the move command',
      },
    });
    if (!live) await this.poolWorkflows.move(instance.id, ownerId);
    return { ok: true, value: { token, expiresAt, command: `curl -fsSL ${this.settings.rootUrl}/install.sh | sudo sh -s -- ${token}` } };
  }

  async startMoveAs(instanceId: unknown, credential: unknown): Promise<Outcome<{ token: string; command: string; expiresAt: string }>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    return this.startMove(instance.ownerId);
  }

  async moveOf(ownerId: string): Promise<MoveView | null> {
    const move = (await this.store.instances.getInstances(ownerId))[0]?.move;
    return move ? { state: move.state, startedAt: move.startedAt, ...(move.detail ? { detail: move.detail } : {}), ...(move.target?.machine ? { machine: move.target.machine } : {}) } : null;
  }

  async moveOfAs(instanceId: unknown, credential: unknown): Promise<Outcome<MoveView | null>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    return { ok: true, value: await this.moveOf(instance.ownerId) };
  }

  async stopMove(ownerId: string): Promise<Outcome<{ stopping: true }>> {
    const instance = (await this.store.instances.getInstances(ownerId))[0];
    if (!instance?.move || instance.move.state === 'failed') return { ok: false, status: 404, error: 'nothing is moving' };
    if (instance.move.state === 'switching') return { ok: false, status: 409, error: 'the instance is switching to its new machine already' };
    await this.poolWorkflows?.moveStopped?.(instance.id, 'you stopped the move');
    return { ok: true, value: { stopping: true } };
  }

  async stopMoveAs(instanceId: unknown, credential: unknown): Promise<Outcome<{ stopping: true }>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    return this.stopMove(instance.ownerId);
  }

  async moveSource(instanceId: unknown, credential: unknown): Promise<Outcome<{ name: string; instanceId: string }>> {
    const instance = await this.mover(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or move credential' };
    if (!instance.pool || !instance.name) return { ok: false, status: 409, error: 'the instance is no longer on Koala\'s servers' };
    return { ok: true, value: { name: instance.name, instanceId: instance.id } };
  }

  private async reportMove(instance: InstanceRecord, report: { status?: unknown; detail?: unknown; url?: unknown; meshIp?: unknown; moved?: unknown }): Promise<Outcome<InstanceRecord>> {
    const move = instance.move!;
    if (move.state === 'switching') return { ok: true, value: instance };
    const detail = typeof report.detail === 'string' ? report.detail.slice(0, 500) : move.detail;
    const target = { ...move.target };
    if (typeof report.meshIp === 'string' && !routeProblem({ name: 'x', meshIp: report.meshIp, nested: false })) target.meshIp = report.meshIp;
    if (typeof report.url === 'string') {
      try {
        target.url = new URL(report.url).origin;
      } catch {
        return { ok: false, status: 400, error: 'url is the origin the instance answers on' };
      }
    }
    if (report.status === 'failed') {
      const saved = await this.save(instance, { move: { ...move, state: 'failed', detail: detail ?? 'The move stopped on your machine', target } });
      await this.poolWorkflows?.moveStopped?.(instance.id, saved.move!.detail!);
      return { ok: true, value: saved };
    }
    if (report.status === 'ready' && report.moved === true) {
      if (!target.meshIp || !target.url) return { ok: false, status: 400, error: 'a moved instance reports its mesh address and its url' };
      const saved = await this.save(instance, { move: { ...move, state: 'switching', detail: 'Switching your address to your machine', target } });
      await this.poolWorkflows?.moveFinished?.(instance.id);
      return { ok: true, value: saved };
    }
    return { ok: true, value: await this.save(instance, { move: { ...move, state: 'copying', detail, target } }) };
  }

  private chartUrlFor(imageTag: string): string {
    return imageTag !== this.settings.imageTag && this.settings.releases?.hasChart(imageTag)
      ? `${this.settings.rootUrl}/api/instances/chart/${encodeURIComponent(imageTag)}.tgz`
      : `${this.settings.rootUrl}/api/instances/chart.tgz`;
  }

  private async knownReleases(): Promise<InstanceRelease[]> {
    return (await this.settings.releases?.releases()) ?? [];
  }

  async release(instanceId: unknown, credential: unknown): Promise<Outcome<{ imageTag: string; chartUrl: string; digest?: string; chartSha256?: string }>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    const releases = await this.knownReleases();
    const imageTag = updateTarget(instance.updates ?? DEFAULT_UPDATES, instance.running, this.settings.imageTag, releases);
    const { imageDigest, chartSha256 } = pinned(findRelease(releases, imageTag));
    return { ok: true, value: { imageTag, chartUrl: this.chartUrlFor(imageTag), ...(imageDigest ? { digest: imageDigest } : {}), ...(chartSha256 ? { chartSha256 } : {}) } };
  }

  private async viewOf(instance: InstanceRecord): Promise<UpdatesView> {
    return updatesView(instance.updates ?? DEFAULT_UPDATES, instance.running, instance.previous, this.settings.imageTag, await this.knownReleases());
  }

  async updates(instanceId: unknown, credential: unknown): Promise<Outcome<UpdatesView>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    return { ok: true, value: await this.viewOf(instance) };
  }

  async setUpdates(instanceId: unknown, credential: unknown, change: { auto?: unknown; version?: unknown }): Promise<Outcome<UpdatesView>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    if (change.auto !== undefined && typeof change.auto !== 'boolean') return { ok: false, status: 400, error: 'send "auto" as true or false' };
    if (change.version !== undefined && (typeof change.version !== 'string' || change.version === '')) return { ok: false, status: 400, error: 'send "version" as the release to move to' };
    if (change.auto === true && change.version !== undefined) return { ok: false, status: 400, error: 'a picked version turns automatic updates off; send one or the other' };
    if (typeof change.version === 'string') {
      const releases = await this.knownReleases();
      const problem = pickProblem(releases, instance.running, instance.previous, change.version);
      if (problem) return { ok: false, status: 409, error: problem };
      const saved = await this.save(instance, { updates: { auto: false, picked: findRelease(releases, change.version)!.imageTag } });
      return { ok: true, value: await this.viewOf(saved) };
    }
    if (change.auto === undefined) return { ok: false, status: 400, error: 'send "auto", or "version" to move to' };
    const saved = await this.save(instance, { updates: change.auto ? { auto: true } : { auto: false, ...(instance.running ? { picked: instance.running } : {}) } });
    return { ok: true, value: await this.viewOf(saved) };
  }

  async machineKey(instanceId: unknown, credential: unknown): Promise<Outcome<{ preAuthKey: string; meshLoginServer: string }>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    if (!this.mesh || !this.settings.meshLoginServer) return { ok: false, status: 503, error: 'this root has no mesh configured (MESH_LOGIN_SERVER), so no machine can join it' };
    const { key } = await this.mesh.createPreAuthKey(instance.ownerId, { reusable: false, expirySeconds: JOIN_TOKEN_TTL_SECONDS });
    return { ok: true, value: { preAuthKey: key, meshLoginServer: this.settings.meshLoginServer } };
  }

  async report(instanceId: unknown, credential: unknown, report: { status?: unknown; detail?: unknown; url?: unknown; meshIp?: unknown; moved?: unknown; imageTag?: unknown }): Promise<Outcome<InstanceRecord>> {
    const moving = await this.mover(instanceId, credential);
    if (moving) return this.reportMove(moving, report);
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    if (!INSTANCE_STATUSES.includes(report.status as InstanceStatus)) return { ok: false, status: 400, error: `status is one of ${INSTANCE_STATUSES.join(', ')}` };
    if (instance.pool && (instance.status !== 'ready' || instance.move)) return { ok: true, value: instance };
    let url = instance.url;
    if (report.url !== undefined) {
      try {
        const parsed = new URL(String(report.url));
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
        url = parsed.origin;
      } catch {
        return { ok: false, status: 400, error: 'url is the origin the instance answers on' };
      }
    }
    let meshIp = instance.meshIp;
    if (report.meshIp !== undefined) {
      if (typeof report.meshIp !== 'string' || routeProblem({ name: 'x', meshIp: report.meshIp, nested: false })) return { ok: false, status: 400, error: 'meshIp is the instance\'s address on the mesh' };
      meshIp = report.meshIp;
    }
    if (report.imageTag !== undefined && (typeof report.imageTag !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(report.imageTag))) return { ok: false, status: 400, error: 'imageTag is the image tag the instance runs' };
    const running = report.status === 'ready' && typeof report.imageTag === 'string' ? report.imageTag : instance.running;
    const moved = running !== instance.running && instance.running ? { previous: instance.running } : {};
    const saved = await this.save(instance, { status: report.status as InstanceStatus, detail: typeof report.detail === 'string' ? report.detail.slice(0, 500) : undefined, url, meshIp, running, ...moved });
    if (saved.status !== instance.status || saved.meshIp !== instance.meshIp) this.routesChanged();
    return { ok: true, value: saved };
  }

  async mine(ownerId: string): Promise<{ id: string; status: InstanceStatus; detail?: string | undefined; url: string; name?: string | undefined; trialEndsAt?: string | undefined; move?: MoveView | undefined } | null> {
    const instance = (await this.store.instances.getInstances(ownerId))[0];
    if (!instance) return null;
    const move = await this.moveOf(ownerId);
    return {
      id: instance.id, status: instance.status ?? (instance.url ? 'ready' : 'waiting'), detail: instance.detail, url: instance.url, name: instance.name,
      ...(instance.pool ? { trialEndsAt: instance.pool.trialEndsAt } : {}),
      ...(move ? { move } : {}),
    };
  }

  async ownerOf(instanceId: unknown, credential: unknown): Promise<Outcome<{ ownerId: string }>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    return { ok: true, value: { ownerId: instance.ownerId } };
  }

  async poolPlaceOf(instanceId: unknown, credential: unknown): Promise<Outcome<{ name: string; hostNamespace: string }>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    if (!instance.pool || !instance.name) return { ok: false, status: 404, error: 'this instance does not run on Koala\'s servers' };
    if (instance.status === 'paused') return { ok: false, status: 409, error: 'this instance is stopped' };
    return { ok: true, value: { name: instance.name, hostNamespace: poolNamespace(instance.name) } };
  }

  async trialOf(instanceId: unknown, credential: unknown): Promise<Outcome<{ trialEndsAt?: string | undefined }>> {
    const instance = await this.authenticated(instanceId, credential);
    if (!instance) return { ok: false, status: 401, error: 'unknown instance or credential' };
    return { ok: true, value: instance.pool ? { trialEndsAt: instance.pool.trialEndsAt } : {} };
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
