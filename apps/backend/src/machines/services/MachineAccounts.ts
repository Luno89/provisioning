import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { JOIN_PROGRESS, type MachineJoinView } from '@koala/engine-core/machine-join';
import { progressOf } from '@koala/engine-core/machine-progress';
import { allowed, asPerson, type LocalAgentDeviceMetadata } from '../../platform/index.js';
import type { IdentityKeyPair } from '../../instances/index.js';
import type { KoalaInstalls } from './KoalaInstalls.js';
import { matchDeviceToken } from '../lib/local-agent-registry.js';
import { deviceTokenHash, newDeviceToken, promotedNext, rotationDue, tokenLifetime, withNextToken, type TokenVia } from '../lib/device-tokens.js';
import { MACHINE_CODE_TTL_SECONDS, hashMachineCode, joinCodeLapsed, joinDismissable, joinEndsOnConnecting, joinShown, machineCommand, machineJoinView, meshAddress, newMachineCode } from '../lib/machines.js';
import { issueWorkToken } from '../lib/work-tokens.js';
import type { MachinesStore } from '../store.js';

type Store = Pick<MachinesStore, 'getLocalAgentDevices' | 'saveLocalAgentDevice' | 'updateLocalAgentDevice' | 'deleteLocalAgentDevice'
  | 'saveMachineJoinCode' | 'takeMachineJoinCode' | 'getMachineJoin' | 'getReportedMachineJoins' | 'getMachineJoinsOf' | 'updateMachineJoin' | 'deleteMachineJoin' | 'deleteMachineJoinsOf'>;

const JOIN_GONE = 'that command has expired, or its join has finished or was dismissed: make a new one on My Machines';
const NO_SUCH_JOIN = 'no such join on your account';


export type Outcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 401 | 404 | 409 | 503; error: string };

export interface AccountMachine {
  id: string;
  ownerId: string;
  name: string;
  rootDir: string;
  os?: string | undefined;
  meshIp?: string | undefined;
  createdAt: string;
  lastSeenAt?: string | undefined;
}

export interface KoalaPlace {
  url: string;
  audience: string;
}

export interface MachineMessages {
  removed(deviceId: string): boolean;
  koala(deviceId: string, koala: { url: string; workToken: string } | null): boolean;
  online?(deviceId: string): boolean;
}

export interface MachineFollowers {
  joined(machine: AccountMachine): Promise<void>;
  removed(machine: AccountMachine): Promise<void>;
  changed(ownerId: string): Promise<void>;
}

export interface OwnerBrowsers {
  machinesChanged(ownerId: string): void;
}

export interface MachineAccountsDeps {
  store: Store;
  signing: IdentityKeyPair;
  settings: { url: string; meshLoginServer?: string | undefined; registry?: string | undefined };
  koala: { of(ownerId: string): Promise<KoalaPlace | undefined> };
  followers: MachineFollowers;
  toMachines: MachineMessages;
  toOwner: OwnerBrowsers;
  installs?: Pick<KoalaInstalls, 'start' | 'machineRemoved'> | undefined;
  mesh?: {
    createPreAuthKey(ownerId: string, opts?: { reusable?: boolean; expirySeconds?: number }): Promise<{ key: string }>;
    removeNode?(ownerId: string, meshIp: string): Promise<void>;
  } | undefined;
  now?: (() => Date) | undefined;
}

export const meshUsable = (server: string | undefined): server is string => Boolean(server);

export const NO_MESH = 'Koala\'s root runs no private network (MESH_LOGIN_SERVER is not set), and a machine takes work only over it, so none can be added';

const text = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;

export const accountMachineOf = (device: LocalAgentDeviceMetadata): AccountMachine => ({
  id: device.id,
  ownerId: device.ownerId,
  name: device.name,
  rootDir: device.rootDir,
  ...(device.os ? { os: device.os } : {}),
  ...(device.meshIp ? { meshIp: device.meshIp } : {}),
  createdAt: device.createdAt,
  ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
});

const ADOPTED_TEXT = ['id', 'name', 'rootDir', 'createdAt', 'os', 'meshIp', 'tokenHash', 'issuedAt', 'expiresAt'] as const;

interface AdoptedMachine {
  id: string;
  name: string;
  rootDir: string;
  createdAt: string;
  os?: string | undefined;
  meshIp?: string | undefined;
  tokenHash?: string | undefined;
  issuedAt?: string | undefined;
  expiresAt?: string | undefined;
}

function adoptable(raw: unknown): AdoptedMachine | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const picked = Object.fromEntries(ADOPTED_TEXT.flatMap((field) => {
    const value = text(record[field], field === 'rootDir' ? 500 : 200);
    return value ? [[field, value]] : [];
  })) as Partial<Record<(typeof ADOPTED_TEXT)[number], string>>;
  if (!picked.id || !picked.name || !picked.rootDir || !path.isAbsolute(picked.rootDir) || !picked.createdAt) return undefined;
  return picked as AdoptedMachine;
}

export class MachineAccounts {
  private readonly retiredListeners: ((tokenHash: string) => void)[] = [];

  constructor(private readonly deps: MachineAccountsDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async byId(id: string): Promise<LocalAgentDeviceMetadata | undefined> {
    return (await this.deps.store.getLocalAgentDevices()).find((device) => device.id === id);
  }

  onTokenRetired(listener: (tokenHash: string) => void): void {
    this.retiredListeners.push(listener);
  }

  async list(ownerId: string): Promise<AccountMachine[]> {
    return (await this.deps.store.getLocalAgentDevices()).filter((device) => device.ownerId === ownerId).map(accountMachineOf);
  }

  async listOnline(ownerId: string): Promise<Array<AccountMachine & { online: boolean; koalaWanted: boolean; koalaRefused?: { reason: string; at: string }; tokenRenewal?: { reason: string; failedAt: string; stopsAt?: string } }>> {
    return (await this.deps.store.getLocalAgentDevices()).filter((device) => device.ownerId === ownerId)
      .map((device) => ({
        ...accountMachineOf(device),
        online: this.deps.toMachines.online?.(device.id) ?? false,
        koalaWanted: Boolean(device.koalaWanted),
        ...(device.koalaRefused ? { koalaRefused: device.koalaRefused } : {}),
        ...(device.tokenRenewal ? { tokenRenewal: { ...device.tokenRenewal, ...(device.expiresAt ? { stopsAt: device.expiresAt } : {}) } } : {}),
      }));
  }

  async mine(ownerId: string): Promise<{ machines: Array<AccountMachine & { online: boolean; koalaWanted: boolean }>; joins: MachineJoinView[] }> {
    const [machines, joins] = await Promise.all([this.listOnline(ownerId), this.joins(ownerId)]);
    return { machines, joins };
  }

  async joins(ownerId: string): Promise<MachineJoinView[]> {
    return (await this.deps.store.getReportedMachineJoins(ownerId))
      .filter((join) => allowed(asPerson(ownerId), 'see', { kind: 'record', noun: 'machine join', ownerId: join.ownerId }))
      .filter(joinShown)
      .map(machineJoinView);
  }

  async createJoinCode(ownerId: string, koalaName?: string): Promise<{ code: string; command: string; expiresAt: string }> {
    if (!meshUsable(this.deps.settings.meshLoginServer)) throw Object.assign(new Error(NO_MESH), { status: 409 });
    const code = newMachineCode();
    const expiresAt = new Date(this.now().getTime() + MACHINE_CODE_TTL_SECONDS * 1000).toISOString();
    await this.deps.store.saveMachineJoinCode({ hash: hashMachineCode(code), id: uuidv4(), ownerId, expiresAt, keptUntil: expiresAt, ...(koalaName ? { koalaName } : {}) });
    return { code, expiresAt, command: machineCommand(this.deps.settings.url, code) };
  }

  async reportJoinProgress(code: unknown, body: unknown): Promise<Outcome<{ recorded: true }>> {
    if (typeof code !== 'string' || !code) return { ok: false, status: 401, error: 'send the code from My Machines as the bearer credential' };
    const join = await this.deps.store.getMachineJoin(hashMachineCode(code));
    if (!join || joinCodeLapsed(join, this.now())) return { ok: false, status: 401, error: JOIN_GONE };
    const read = progressOf(body, JOIN_PROGRESS);
    if (!read.ok) return { ok: false, status: 400, error: read.problem };
    const progress = { ...read.value, at: this.now().toISOString() };
    const recorded = join.connectedAt !== undefined && joinEndsOnConnecting({ progress })
      ? await this.deps.store.deleteMachineJoin(join.hash)
      : await this.deps.store.updateMachineJoin(join.hash, { set: { progress }, unset: ['keptUntil'] });
    if (!recorded) return { ok: false, status: 401, error: JOIN_GONE };
    this.deps.toOwner.machinesChanged(join.ownerId);
    return { ok: true, value: { recorded: true } };
  }

  async dismissJoin(ownerId: string, id: string): Promise<Outcome<{ dismissed: true }>> {
    const join = (await this.deps.store.getReportedMachineJoins(ownerId)).filter(joinShown).find((candidate) => candidate.id === id);
    if (!join || !allowed(asPerson(ownerId), 'change', { kind: 'record', noun: 'machine join', ownerId: join.ownerId })) return { ok: false, status: 404, error: NO_SUCH_JOIN };
    if (!joinDismissable(join, this.now())) return { ok: false, status: 409, error: 'that command can still join a machine; it can be dismissed once it fails, its command expires or a machine joins with it' };
    await this.deps.store.deleteMachineJoin(join.hash);
    this.deps.toOwner.machinesChanged(join.ownerId);
    return { ok: true, value: { dismissed: true } };
  }

  async joinFinished(deviceId: string, tokenHash: string): Promise<void> {
    const device = await this.byId(deviceId);
    if (!device) return;
    const finishing = (await this.deps.store.getMachineJoinsOf(device.id)).filter((join) => join.deviceTokenHash === tokenHash && !join.connectedAt);
    const connectedAt = this.now().toISOString();
    for (const join of finishing) {
      if (joinEndsOnConnecting(join)) await this.deps.store.deleteMachineJoin(join.hash);
      else await this.deps.store.updateMachineJoin(join.hash, { set: { connectedAt } });
    }
    if (finishing.length) this.deps.toOwner.machinesChanged(device.ownerId);
  }

  async join(code: unknown, machine: { hostname?: unknown; rootDir?: unknown; os?: unknown; replaces?: unknown }): Promise<Outcome<{ deviceId: string; env: Record<string, string> }>> {
    if (typeof code !== 'string' || !code) return { ok: false, status: 400, error: 'send the code from My Machines as "code"' };
    const rootDir = text(machine.rootDir, 500);
    if (!rootDir || !path.isAbsolute(rootDir)) return { ok: false, status: 400, error: 'send the folder Koala may work in as "rootDir", a full path' };
    const meshLoginServer = this.deps.settings.meshLoginServer;
    if (!meshUsable(meshLoginServer)) return { ok: false, status: 409, error: NO_MESH };
    if (!this.deps.mesh) return { ok: false, status: 503, error: 'this Koala has a mesh address but cannot reach Headscale to let the machine join it' };
    const found = await this.deps.store.takeMachineJoinCode(hashMachineCode(code), this.now().toISOString());
    if (!found || found.expiresAt <= this.now().toISOString()) return { ok: false, status: 401, error: 'that command has expired or was already used: make a new one on My Machines' };

    const replaced = typeof machine.replaces === 'string' && machine.replaces
      ? matchDeviceToken((await this.deps.store.getLocalAgentDevices()).filter((device) => device.ownerId === found.ownerId), machine.replaces)?.device
      : undefined;
    const id = replaced?.id ?? uuidv4();
    const token = newDeviceToken();
    const name = text(machine.hostname, 80) ?? 'machine';
    const os = text(machine.os, 80);
    const { os: _formerOs, nextTokenHash: _next, nextIssuedAt: _nextIssued, nextExpiresAt: _nextExpires, ...kept } = replaced ?? { os: undefined, nextTokenHash: undefined, nextIssuedAt: undefined, nextExpiresAt: undefined };
    const device: LocalAgentDeviceMetadata = {
      ...kept,
      id,
      ownerId: found.ownerId,
      name,
      rootDir,
      tokenHash: deviceTokenHash(token),
      ...tokenLifetime(this.now()),
      createdAt: replaced?.createdAt ?? this.now().toISOString(),
      ...(os ? { os } : {}),
      ...(found.koalaName ? { koalaWanted: { name: found.koalaName } } : {}),
    };
    await this.deps.store.saveLocalAgentDevice(device);
    await this.deps.store.updateMachineJoin(found.hash, { set: { deviceId: id, deviceTokenHash: device.tokenHash }, unset: ['keptUntil'] });
    if (await this.deps.store.deleteMachineJoinsOf(id, found.hash)) this.deps.toOwner.machinesChanged(found.ownerId);
    if (!replaced) await this.deps.followers.joined(accountMachineOf(device)).catch((err: Error) => console.warn(`[machines] ${name} joined, but its Koala could not be told: ${err.message}`));
    const preAuthKey = (await this.deps.mesh.createPreAuthKey(found.ownerId, { reusable: false, expirySeconds: MACHINE_CODE_TTL_SECONDS })).key;
    return {
      ok: true,
      value: {
        deviceId: id,
        env: {
          KOALA_ROOT_URL: this.deps.settings.url,
          KOALA_DEVICE_ID: id,
          KOALA_DEVICE_TOKEN: token,
          KOALA_ROOT_DIR: rootDir,
          MESH_LOGIN_SERVER: meshLoginServer,
          MESH_AUTH_KEY: preAuthKey,
          KOALA_REGISTRY: this.deps.settings.registry ?? '',
        },
      },
    };
  }

  async adoptFrom(ownerId: string, raw: unknown): Promise<{ adopted: number }> {
    const records = Array.isArray(raw) ? raw : [];
    const known = new Set((await this.deps.store.getLocalAgentDevices()).map((device) => device.id));
    let adopted = 0;
    for (const record of records) {
      const machine = adoptable(record);
      if (!machine || known.has(machine.id)) continue;
      await this.deps.store.saveLocalAgentDevice({ ...machine, ownerId });
      known.add(machine.id);
      adopted += 1;
    }
    return { adopted };
  }

  async koalaFor(deviceId: string): Promise<{ url: string; workToken: string } | undefined> {
    const device = await this.byId(deviceId);
    if (!device) return undefined;
    const place = await this.deps.koala.of(device.ownerId);
    if (!place) return undefined;
    const workToken = issueWorkToken(this.deps.signing, { machineId: device.id, ownerId: device.ownerId, audience: place.audience }, Math.floor(this.now().getTime() / 1000));
    return { url: place.url, workToken };
  }

  async putKoalaOn(ownerId: string, deviceId: string, name?: string): Promise<Outcome<{ placing: boolean }>> {
    const device = await this.byId(deviceId);
    if (!device || device.ownerId !== ownerId) return { ok: false, status: 404, error: 'no such machine on your account' };
    if (!this.deps.installs) return { ok: false, status: 503, error: 'this Koala does not put Koala on machines' };
    await this.deps.store.updateLocalAgentDevice(device.id, { set: { koalaWanted: { name: name ?? device.koalaWanted?.name ?? '' } }, unset: ['koalaRefused'] });
    return this.deliverKoala(device.id);
  }

  async deliverKoala(deviceId: string): Promise<Outcome<{ placing: boolean }>> {
    const device = await this.byId(deviceId);
    if (!device?.koalaWanted) return { ok: true, value: { placing: false } };
    if (!this.deps.installs) return { ok: false, status: 503, error: 'this Koala does not put Koala on machines' };
    const placed = await this.deps.installs.start(device.ownerId, device, device.koalaWanted.name || undefined);
    if (!placed.ok) {
      if (placed.status !== 409 || device.meshIp) await this.deps.store.updateLocalAgentDevice(device.id, { set: { koalaRefused: { reason: placed.error, at: this.now().toISOString() } }, unset: ['koalaWanted'] });
      return placed;
    }
    await this.deps.store.updateLocalAgentDevice(device.id, { unset: ['koalaWanted', 'koalaRefused'] });
    return { ok: true, value: { placing: true } };
  }

  async tellKoala(ownerId: string): Promise<void> {
    for (const device of (await this.deps.store.getLocalAgentDevices()).filter((candidate) => candidate.ownerId === ownerId)) {
      const koala = await this.koalaFor(device.id);
      this.deps.toMachines.koala(device.id, koala ?? null);
    }
  }

  async remove(ownerId: string, deviceId: string): Promise<boolean> {
    const device = await this.byId(deviceId);
    if (!device || device.ownerId !== ownerId) return false;
    await this.deps.installs?.machineRemoved(device.id);
    this.deps.toMachines.removed(device.id);
    await this.deps.store.deleteLocalAgentDevice(device.id);
    if (await this.deps.store.deleteMachineJoinsOf(device.id)) this.deps.toOwner.machinesChanged(device.ownerId);
    if (device.meshIp && this.deps.mesh?.removeNode) {
      await this.deps.mesh.removeNode(ownerId, device.meshIp).catch((err: Error) => console.warn(`[machines] ${device.name} is removed, but its mesh node ${device.meshIp} could not be: ${err.message}`));
    }
    await this.deps.followers.removed(accountMachineOf(device)).catch((err: Error) => console.warn(`[machines] ${device.name} is removed, but its Koala could not be told: ${err.message}`));
    return true;
  }

  async rotationFor(deviceId: string, via: TokenVia): Promise<string | undefined> {
    const device = await this.byId(deviceId);
    if (!device) return undefined;
    if (via === 'next') {
      await this.promote(device);
      return undefined;
    }
    if (!rotationDue(device, this.now())) return undefined;
    const token = newDeviceToken();
    const next = withNextToken(device, deviceTokenHash(token), this.now());
    const saved = await this.deps.store.updateLocalAgentDevice(device.id, {
      set: { nextTokenHash: next.nextTokenHash, nextIssuedAt: next.nextIssuedAt, nextExpiresAt: next.nextExpiresAt },
      when: { nextTokenHash: null },
    });
    return saved ? token : undefined;
  }

  async tokenTaken(deviceId: string): Promise<void> {
    const device = await this.byId(deviceId);
    if (device?.nextTokenHash) await this.promote(device);
  }

  private async promote(device: LocalAgentDeviceMetadata): Promise<void> {
    if (!device.nextTokenHash) return;
    const retired = device.tokenHash;
    const promoted = promotedNext(device);
    const moved = await this.deps.store.updateLocalAgentDevice(device.id, {
      set: { tokenHash: promoted.tokenHash, issuedAt: promoted.issuedAt, expiresAt: promoted.expiresAt },
      unset: ['nextTokenHash', 'nextIssuedAt', 'nextExpiresAt', 'tokenRenewal'],
      when: { nextTokenHash: device.nextTokenHash },
    });
    if (moved && retired) for (const listener of this.retiredListeners) listener(retired);
  }

  async renewalFailed(deviceId: string, reason: string): Promise<void> {
    await this.deps.store.updateLocalAgentDevice(deviceId, { set: { tokenRenewal: { reason: reason.slice(0, 500), failedAt: this.now().toISOString() } } });
  }

  async seen(deviceId: string): Promise<void> {
    await this.deps.store.updateLocalAgentDevice(deviceId, { set: { lastSeenAt: this.now().toISOString() } });
  }

  async recordMeshIp(deviceId: string, raw: unknown): Promise<void> {
    const meshIp = meshAddress(raw);
    if (!meshIp) return;
    const device = await this.byId(deviceId);
    if (!device || device.meshIp === meshIp) return;
    await this.deps.store.updateLocalAgentDevice(device.id, { set: { meshIp } });
    await this.deps.followers.changed(device.ownerId).catch((err: Error) => console.warn(`[machines] ${device.name}'s mesh address is recorded, but its Koala could not be told: ${err.message}`));
  }
}
