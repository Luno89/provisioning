import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { LocalAgentDeviceMetadata, SecretKey } from '../../platform/index.js';
import type { IdentityKeyPair, PlacedKoala, PlacingMachine } from '../../instances/index.js';
import { matchDeviceToken } from '../lib/local-agent-registry.js';
import { deviceTokenHash, newDeviceToken, promotedNext, rotationDue, tokenLifetime, withNextToken, type TokenVia } from '../lib/device-tokens.js';
import { MACHINE_CODE_TTL_SECONDS, hashMachineCode, machineCommand, meshAddress, newMachineCode } from '../lib/machines.js';
import { issueWorkToken } from '../lib/work-tokens.js';
import type { MachinesStore } from '../store.js';

type Store = Pick<MachinesStore, 'getLocalAgentDevices' | 'saveMachineJoinCode' | 'takeMachineJoinCode' | 'saveLocalAgentDevice' | 'updateLocalAgentDevice' | 'deleteLocalAgentDevice'>;

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
  placeKoala?(deviceId: string, placed: PlacedKoala): Promise<boolean>;
  online?(deviceId: string): boolean;
}

export interface KoalaPlacer {
  placeOn(ownerId: string, machine: PlacingMachine, name?: unknown): Promise<Outcome<PlacedKoala>>;
}

export interface MachineFollowers {
  joined(machine: AccountMachine): Promise<void>;
  removed(machine: AccountMachine): Promise<void>;
  changed(ownerId: string): Promise<void>;
}

export interface MachineAccountsDeps {
  store: Store;
  dataKey: SecretKey;
  signing: IdentityKeyPair;
  settings: { url: string; meshLoginServer?: string | undefined; registry?: string | undefined };
  koala: { of(ownerId: string): Promise<KoalaPlace | undefined> };
  followers: MachineFollowers;
  toMachines: MachineMessages;
  placer?: KoalaPlacer | undefined;
  mesh?: {
    createPreAuthKey(ownerId: string, opts?: { reusable?: boolean; expirySeconds?: number }): Promise<{ key: string }>;
    removeNode?(ownerId: string, meshIp: string): Promise<void>;
  } | undefined;
  now?: (() => Date) | undefined;
}

export const meshUsable = (server: string | undefined): server is string => Boolean(server && !/localhost|127\.0\.0\.1/.test(server));

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

  async listOnline(ownerId: string): Promise<Array<AccountMachine & { online: boolean; koalaWanted: boolean }>> {
    return (await this.deps.store.getLocalAgentDevices()).filter((device) => device.ownerId === ownerId)
      .map((device) => ({ ...accountMachineOf(device), online: this.deps.toMachines.online?.(device.id) ?? false, koalaWanted: Boolean(device.koalaWanted) }));
  }

  async createJoinCode(ownerId: string, koalaName?: string): Promise<{ code: string; command: string; expiresAt: string }> {
    const code = newMachineCode();
    const expiresAt = new Date(this.now().getTime() + MACHINE_CODE_TTL_SECONDS * 1000).toISOString();
    await this.deps.store.saveMachineJoinCode({ hash: hashMachineCode(code), ownerId, expiresAt, ...(koalaName ? { koalaName } : {}) });
    return { code, expiresAt, command: machineCommand(this.deps.settings.url, code) };
  }

  async join(code: unknown, machine: { hostname?: unknown; rootDir?: unknown; os?: unknown; replaces?: unknown }): Promise<Outcome<{ deviceId: string; env: Record<string, string> }>> {
    if (typeof code !== 'string' || !code) return { ok: false, status: 400, error: 'send the code from My Machines as "code"' };
    const rootDir = text(machine.rootDir, 500);
    if (!rootDir || !path.isAbsolute(rootDir)) return { ok: false, status: 400, error: 'send the folder Koala may work in as "rootDir", a full path' };
    const mesh = meshUsable(this.deps.settings.meshLoginServer);
    if (mesh && !this.deps.mesh) return { ok: false, status: 503, error: 'this Koala has a mesh address but cannot reach Headscale to let the machine join it' };
    const found = await this.deps.store.takeMachineJoinCode(hashMachineCode(code));
    if (!found || found.expiresAt <= this.now().toISOString()) return { ok: false, status: 401, error: 'that command has expired or was already used: make a new one on My Machines' };

    const replaced = typeof machine.replaces === 'string' && machine.replaces
      ? matchDeviceToken((await this.deps.store.getLocalAgentDevices()).filter((device) => device.ownerId === found.ownerId), machine.replaces, this.deps.dataKey)?.device
      : undefined;
    const id = replaced?.id ?? uuidv4();
    const token = newDeviceToken();
    const name = text(machine.hostname, 80) ?? 'machine';
    const os = text(machine.os, 80);
    const { os: _formerOs, tokenEnc: _formerToken, nextTokenHash: _next, nextIssuedAt: _nextIssued, nextExpiresAt: _nextExpires, ...kept } = replaced ?? { os: undefined, tokenEnc: undefined, nextTokenHash: undefined, nextIssuedAt: undefined, nextExpiresAt: undefined };
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
    if (!replaced) await this.deps.followers.joined(accountMachineOf(device)).catch((err: Error) => console.warn(`[machines] ${name} joined, but its Koala could not be told: ${err.message}`));
    const preAuthKey = mesh ? (await this.deps.mesh!.createPreAuthKey(found.ownerId, { reusable: false, expirySeconds: MACHINE_CODE_TTL_SECONDS })).key : '';
    return {
      ok: true,
      value: {
        deviceId: id,
        env: {
          KOALA_ROOT_URL: this.deps.settings.url,
          KOALA_DEVICE_ID: id,
          KOALA_DEVICE_TOKEN: token,
          KOALA_ROOT_DIR: rootDir,
          MESH_LOGIN_SERVER: mesh ? this.deps.settings.meshLoginServer! : '',
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
    if (!this.deps.placer) return { ok: false, status: 503, error: 'this Koala does not put Koala on machines' };
    await this.deps.store.updateLocalAgentDevice(device.id, { set: { koalaWanted: { name: name ?? device.koalaWanted?.name ?? '' } } });
    return this.deliverKoala(device.id);
  }

  async deliverKoala(deviceId: string): Promise<Outcome<{ placing: boolean }>> {
    const device = await this.byId(deviceId);
    if (!device?.koalaWanted) return { ok: true, value: { placing: false } };
    if (!this.deps.placer) return { ok: false, status: 503, error: 'this Koala does not put Koala on machines' };
    const placed = await this.deps.placer.placeOn(device.ownerId, { id: device.id, name: device.name, ...(device.meshIp ? { meshIp: device.meshIp } : {}) }, device.koalaWanted.name || undefined);
    if (!placed.ok) {
      if (placed.status !== 409 || device.meshIp) await this.deps.store.updateLocalAgentDevice(device.id, { unset: ['koalaWanted'] });
      return placed;
    }
    const taken = await this.deps.toMachines.placeKoala?.(device.id, placed.value) ?? false;
    if (taken) await this.deps.store.updateLocalAgentDevice(device.id, { unset: ['koalaWanted'] });
    return { ok: true, value: { placing: taken } };
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
    this.deps.toMachines.removed(device.id);
    await this.deps.store.deleteLocalAgentDevice(device.id);
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
      unset: ['nextTokenHash', 'nextIssuedAt', 'nextExpiresAt'],
      when: { nextTokenHash: device.nextTokenHash },
    });
    if (moved && retired) for (const listener of this.retiredListeners) listener(retired);
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
